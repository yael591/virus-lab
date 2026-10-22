// extract — one page image + its OCR text → validated form + one record per commitment.
// Called by the browser after it has OCR'd the page and uploaded the image.
// Auth: the caller's JWT (RLS applies). The Anthropic key never leaves the server.

import { createClient } from 'npm:@supabase/supabase-js@2.75.0';
import { buildForm } from '../_shared/engine/build.ts';
import { parseModelJson } from '../_shared/engine/parse.ts';
import { buildSystemPrompt, buildUserText } from '../_shared/engine/prompt.ts';
import { runRegexHints } from '../_shared/engine/regex-profiles.ts';
import type { OcrLayout, RawExtraction, Sender } from '../_shared/engine/types.ts';
import { regionHasWords } from '../_shared/engine/anchor.ts';
import { zoomRequests } from '../_shared/engine/zoom.ts';
import { callModel, STRICT_ID, toBase64, type Img } from '../_shared/anthropic.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const t0 = Date.now();
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });

  let pageId = '';
  try {
    const body = await req.json();
    pageId = body.page_id;
    const allowRotate = body.allow_rotate !== false;
    // allow_defer: the browser runs pages in parallel; a continuation page whose previous
    // page is not finished yet is sent back and re-extracted after the parallel pass.
    const allowDefer = body.allow_defer === true;
    if (!pageId) return json({ ok: false, error: 'page_id required' }, 400);

    const { data: page, error: pErr } = await supabase.from('pages')
      .select('id, batch_id, page_no, image_path, tile_paths, ocr_text, ocr_layout').eq('id', pageId).single();
    if (pErr || !page) return json({ ok: false, error: 'page not found' }, 404);
    if (!page.image_path) return json({ ok: false, error: 'page has no image' }, 400);

    // Re-run safety: never touch a form that already has approved rows.
    const { data: existing } = await supabase.from('forms').select('id, records(status)').eq('page_id', pageId);
    if ((existing ?? []).some((f: any) => (f.records ?? []).some((r: any) => r.status === 'approved'))) {
      return json({ ok: true, skipped: 'approved' });
    }

    await supabase.from('pages').update({ status: 'extracting', error: null }).eq('id', pageId);

    const tilePaths: string[] = page.tile_paths ?? [];
    const [{ data: blob, error: dErr }, { data: senderRows }, ...tileRes] = await Promise.all([
      supabase.storage.from('pages').download(page.image_path),
      supabase.from('senders').select('name, kind, aliases'),
      ...tilePaths.map((tp) => supabase.storage.from('pages').download(tp)),
    ]);
    if (dErr || !blob) throw new Error('image download failed');
    const senders = (senderRows ?? []) as Sender[];
    const images: Img[] = [{ b64: toBase64(new Uint8Array(await blob.arrayBuffer())), caption: 'תמונה 1: העמוד המלא.' }];
    for (const [k, r] of tileRes.entries()) {
      const tb = (r as any).data as Blob | null;
      if (!tb) continue;
      images.push({
        b64: toBase64(new Uint8Array(await tb.arrayBuffer())),
        caption: `תמונה ${images.length + 1}: ${k === 0 ? 'החלק הראשון' : 'החלק השני'} של אותו עמוד, מוגדל ברזולוציה גבוהה — לקריאת כתב יד ומספרים קטנים.`,
      });
    }

    const ocrText = page.ocr_text ?? '';
    const hints = runRegexHints(ocrText);
    const reply = await callModel(buildSystemPrompt(senders.map((s) => s.name)), images, buildUserText(ocrText, hints, images.length > 1));
    const { value: raw, repaired } = parseModelJson<RawExtraction>(reply);
    if (!raw) throw new Error(`model reply was not valid JSON: ${reply.replace(/\s+/g, ' ').slice(0, 350) || '(empty reply)'}`);

    // Sideways/upside-down page: ask the browser to rotate, re-OCR and call again,
    // so the stored image, OCR boxes, crops and field regions all share one upright geometry.
    const rot = [90, 180, 270].includes(Number(raw.page_rotation)) ? Number(raw.page_rotation) : 0;
    if (allowRotate && rot) {
      await supabase.from('pages').update({ status: 'pending' }).eq('id', pageId);
      return json({ ok: true, rotate: rot });
    }

    const form = buildForm(raw, { ocrText, senders, hints, strictIdChecksum: STRICT_ID });
    // drop field locations that point at empty paper (misplaced by the model).
    // Handwritten fields are NOT checked: Tesseract does not read Hebrew handwriting, so
    // a real name/ID area often has no OCR words — dropping it would cancel the zoom re-read.
    const HANDWRITTEN = new Set(['first_name', 'last_name', 'national_id']);
    const layout = page.ocr_layout as OcrLayout | null;
    if (layout) {
      for (const [k, m] of Object.entries(form.field_meta)) {
        if (m?.region && !HANDWRITTEN.has(k) && !regionHasWords(layout, m.region)) delete m.region;
      }
      for (const c of form.commitments) {
        if (c.meta?.region && !regionHasWords(layout, c.meta.region)) delete c.meta.region;
      }
    }
    if (repaired) form.warnings.unshift('תשובת המודל נחתכה ותוקנה — ייתכן שחסרים שדות. בדקי ידנית.');

    if (!form.is_commitment_form) {
      await supabase.from('pages').update({ status: 'skipped', form_type: form.form_type, processed_ms: Date.now() - t0 }).eq('id', pageId);
      return json({ ok: true, skipped: 'not_a_form' });
    }

    // Continuation page → merge into the previous page's form.
    if (form.continuation && page.page_no > 1) {
      const { data: prev } = await supabase.from('pages').select('id, status').eq('batch_id', page.batch_id).eq('page_no', page.page_no - 1).maybeSingle();
      const { data: prevForm } = prev
        ? await supabase.from('forms').select('id, extra_page_ids, warnings, records(commitment_number)')
            .or(`page_id.eq.${prev.id},extra_page_ids.cs.{${prev.id}}`).limit(1).maybeSingle()
        : { data: null };
      if (prevForm) {
        const have = new Set((prevForm.records ?? []).map((r: any) => r.commitment_number));
        const add = form.commitments.filter((c) => c.value && !have.has(c.value));
        if (add.length) {
          await supabase.from('records').insert(add.map((c) => ({ form_id: prevForm.id, commitment_number: c.value, commitment_meta: c.meta })));
        }
        await supabase.from('forms').update({
          extra_page_ids: [...(prevForm.extra_page_ids ?? []), pageId],
          warnings: [...(prevForm.warnings ?? []), `עמוד ${page.page_no} זוהה כהמשך של הטופס ואוחד אליו.`, ...form.warnings],
        }).eq('id', prevForm.id);
        await supabase.from('pages').update({ status: 'done', continuation: true, form_type: form.form_type, processed_ms: Date.now() - t0 }).eq('id', pageId);
        return json({ ok: true, merged_into: prevForm.id, added: add.length });
      }
      // previous page still in flight (parallel upload) → come back later, write nothing now
      const prevBusy = !prev || !['done', 'skipped', 'error'].includes((prev as any).status);
      if (allowDefer && prevBusy) {
        await supabase.from('pages').update({ status: 'pending' }).eq('id', pageId);
        return json({ ok: true, defer: true });
      }
    }

    // Fresh (re)extraction: replace any pending form of this page.
    if ((existing ?? []).length) await supabase.from('forms').delete().eq('page_id', pageId);

    const { data: inserted, error: fErr } = await supabase.from('forms').insert({
      batch_id: page.batch_id,
      page_id: pageId,
      form_type: form.form_type,
      first_name: form.first_name,
      last_name: form.last_name,
      national_id: form.national_id,
      sender: form.sender,
      central_numbers: form.central_numbers,
      received_date: form.received_date,
      field_meta: form.field_meta,
      warnings: form.warnings,
    }).select('id').single();
    if (fErr || !inserted) throw new Error(`form insert failed: ${fErr?.message}`);

    const { data: recRows, error: rErr } = await supabase.from('records').insert(
      form.commitments.map((c) => ({ form_id: inserted.id, commitment_number: c.value, commitment_meta: c.meta })),
    ).select('id');
    if (rErr) throw new Error(`records insert failed: ${rErr.message}`);

    await supabase.from('pages').update({ status: 'done', form_type: form.form_type, processed_ms: Date.now() - t0 }).eq('id', pageId);
    const recs = form.commitments.map((c, i) => ({ id: (recRows ?? [])[i]?.id as string, value: c.value, meta: c.meta })).filter((r) => r.id);
    const zoom = zoomRequests(form.field_meta, form as unknown as Record<string, unknown>, recs);
    return json({ ok: true, form_id: inserted.id, records: form.commitments.length, zoom });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (pageId) await supabase.from('pages').update({ status: 'error', error: msg.slice(0, 500) }).eq('id', pageId);
    return json({ ok: false, error: msg }, 500);
  }
});
