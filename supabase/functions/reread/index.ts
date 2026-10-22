// reread — focused second look at uncertain fields.
// The browser crops each field's area from a high-resolution render of the page and
// uploads it; this function asks the model to read only those crops and merges a
// reading only when it is better than the first pass (or flags a disagreement).

import { createClient } from 'npm:@supabase/supabase-js@2.75.0';
import { parseModelJson } from '../_shared/engine/parse.ts';
import { buildRereadPrompt, type RereadItem } from '../_shared/engine/prompt.ts';
import { mergeCommitmentZoom, mergeZoom, ZOOM_FIELDS } from '../_shared/engine/zoom.ts';
import type { FieldMeta, RawField } from '../_shared/engine/types.ts';
import { callModel, REREAD_MODEL, toBase64, type Img } from '../_shared/anthropic.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

interface Crop { field: string; path: string; record_id?: string }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });
  let paths: string[] = [];
  try {
    const { form_id, crops } = (await req.json()) as { form_id: string; crops: Crop[] };
    const okField = (f: string) => (ZOOM_FIELDS as readonly string[]).includes(f) || f === 'commitment_number';
    const valid = (crops ?? []).filter((c) => okField(c.field) && c.path && (c.field !== 'commitment_number' || c.record_id));
    paths = valid.map((c) => c.path);
    if (!form_id || !valid.length) return json({ ok: false, error: 'form_id and crops required' }, 400);

    const { data: form, error } = await supabase.from('forms')
      .select('id, first_name, last_name, national_id, central_numbers, received_date, field_meta, warnings, records(id, status, commitment_number, commitment_meta), page:pages!forms_page_id_fkey(ocr_text)')
      .eq('id', form_id).single();
    if (error || !form) return json({ ok: false, error: 'form not found' }, 404);
    if ((form.records ?? []).some((r: any) => r.status === 'approved')) return json({ ok: true, skipped: 'approved' });

    const images: Img[] = [];
    const items: (RereadItem & { record_id?: string })[] = [];
    let n = 0;
    for (const c of valid) {
      const { data: blob } = await supabase.storage.from('pages').download(c.path);
      if (!blob) continue;
      const key = c.field === 'commitment_number' ? `commitment_number__${++n}` : c.field;
      images.push({ b64: toBase64(new Uint8Array(await blob.arrayBuffer())), caption: `תמונה ${images.length + 1} — מפתח: ${key}` });
      items.push({ key, field: c.field, record_id: c.record_id });
    }
    if (!images.length) return json({ ok: false, error: 'no crops downloaded' }, 400);

    const reply = await callModel('את קוראת שדות בודדים מהגדלות של טפסים רפואיים. JSON בלבד.', images, buildRereadPrompt(items), REREAD_MODEL);
    const { value } = parseModelJson<Record<string, RawField | RawField[]>>(reply);
    if (!value) throw new Error(`reread reply was not valid JSON: ${reply.replace(/\s+/g, ' ').slice(0, 350) || '(empty reply)'}`);
    const ocrText = (form as any).page?.ocr_text ?? '';

    // form-level fields
    const res = mergeZoom(form as unknown as Record<string, unknown>, form.field_meta as Record<string, FieldMeta>, value, ocrText);
    const notes = [...res.notes];

    // commitment numbers (one record each)
    let recUpdates = 0;
    for (const it of items.filter((x) => x.field === 'commitment_number')) {
      const rec = (form.records ?? []).find((r: any) => r.id === it.record_id) as any;
      if (!rec) continue;
      const raw = value[it.key];
      const m = mergeCommitmentZoom(rec.commitment_number, rec.commitment_meta, Array.isArray(raw) ? raw[0] : raw, ocrText);
      if (!m) continue;
      await supabase.from('records').update({ commitment_number: m.value, commitment_meta: m.meta }).eq('id', rec.id);
      recUpdates++;
      if (m.value !== rec.commitment_number) notes.push(`מספר התחייבות נקרא מחדש מהגדלה: ${rec.commitment_number ?? 'ריק'} ← ${m.value}`);
    }

    if (Object.keys(res.updates).length || Object.keys(res.meta).length || notes.length) {
      const { error: uErr } = await supabase.from('forms').update({
        ...res.updates,
        field_meta: { ...(form.field_meta as object), ...res.meta },
        warnings: [...(form.warnings ?? []), ...notes],
      }).eq('id', form_id);
      if (uErr) throw new Error(uErr.message);
    }
    return json({ ok: true, improved: Object.keys(res.updates).length + recUpdates });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  } finally {
    // crops are temporary
    if (paths.length) await supabase.storage.from('pages').remove(paths);
  }
});
