// Data access for the review screen.

import { supabase } from './supabase.ts';
import type { FieldMeta, OcrLayout } from '@engine/types.ts';

export type FormField = 'first_name' | 'last_name' | 'national_id' | 'sender' | 'central_numbers' | 'received_date';

export interface RecordRow {
  id: string;
  form_id: string;
  commitment_number: string | null;
  commitment_meta: Partial<FieldMeta>;
  status: 'pending' | 'approved';
  approved_at: string | null;
}

export interface FormRow {
  id: string;
  batch_id: string;
  page_id: string;
  extra_page_ids: string[];
  form_type: string | null;
  first_name: string | null;
  last_name: string | null;
  national_id: string | null;
  sender: string | null;
  central_numbers: string[];
  received_date: string | null;
  field_meta: Partial<Record<FormField, FieldMeta>>;
  warnings: string[];
  created_at: string;
  records: RecordRow[];
  page: { page_no: number; image_path: string | null; batch: { file_name: string } | null } | null;
}

export async function loadForms(): Promise<FormRow[]> {
  const { data, error } = await supabase.from('forms')
    .select('*, records(*), page:pages!forms_page_id_fkey(page_no, image_path, batch:batches(file_name))')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as any[]).map((f) => ({
    ...f,
    records: [...(f.records ?? [])].sort((a: RecordRow, b: RecordRow) => (a.commitment_number ?? '').localeCompare(b.commitment_number ?? '')),
  }));
}

export async function loadSenders(): Promise<string[]> {
  const { data } = await supabase.from('senders').select('name, kind').order('kind').order('name');
  return (data ?? []).map((s: any) => s.name);
}

function clearedMeta(m: Partial<FieldMeta> | undefined): FieldMeta {
  return {
    confidence: m?.confidence ?? 1,
    quote: m?.quote ?? null,
    verified: m?.verified ?? false,
    flagged: false,
    reasons: [],
    edited: true,
  };
}

export async function updateFormField(form: FormRow, field: FormField, value: string | string[] | null): Promise<void> {
  const field_meta = { ...form.field_meta, [field]: clearedMeta(form.field_meta[field]) };
  const { error } = await supabase.from('forms').update({ [field]: value, field_meta }).eq('id', form.id);
  if (error) throw error;
}

export async function updateCommitment(rec: RecordRow, value: string | null): Promise<void> {
  const { error } = await supabase.from('records')
    .update({ commitment_number: value, commitment_meta: clearedMeta(rec.commitment_meta) }).eq('id', rec.id);
  if (error) throw error;
}

export async function addCommitment(formId: string): Promise<void> {
  const { error } = await supabase.from('records').insert({
    form_id: formId,
    commitment_number: null,
    commitment_meta: { confidence: 0, quote: null, verified: false, flagged: true, reasons: ['נוסף ידנית — יש למלא'] },
  });
  if (error) throw error;
}

export async function deleteRecord(id: string): Promise<void> {
  const { error } = await supabase.from('records').delete().eq('id', id);
  if (error) throw error;
}

export async function setStatus(ids: string[], status: 'pending' | 'approved'): Promise<void> {
  const { data: u } = await supabase.auth.getUser();
  const { error } = await supabase.from('records').update({
    status,
    approved_at: status === 'approved' ? new Date().toISOString() : null,
    approved_by: status === 'approved' ? u.user?.id ?? null : null,
  }).in('id', ids);
  if (error) throw error;
}

// ---- page image + layout for hover crops (cached; fetched only when needed)

const layoutCache = new Map<string, Promise<OcrLayout | null>>();
const urlCache = new Map<string, Promise<string | null>>();

export function pageLayout(pageId: string): Promise<OcrLayout | null> {
  if (!layoutCache.has(pageId)) {
    layoutCache.set(pageId, (async () => {
      const { data } = await supabase.from('pages').select('ocr_layout').eq('id', pageId).single();
      return (data?.ocr_layout as OcrLayout) ?? null;
    })());
  }
  return layoutCache.get(pageId)!;
}

export function pageImageUrl(path: string | null | undefined): Promise<string | null> {
  if (!path) return Promise.resolve(null);
  if (!urlCache.has(path)) {
    urlCache.set(path, (async () => {
      const { data } = await supabase.storage.from('pages').createSignedUrl(path, 3600);
      return data?.signedUrl ?? null;
    })());
  }
  return urlCache.get(path)!;
}

/** Remove source images + OCR of fully-approved forms. Returns how many images were deleted. */
export async function purgeApprovedSources(): Promise<number> {
  const { data, error } = await supabase.rpc('purge_source_data', { p_days: 0 });
  if (error) throw error;
  const paths = ((data ?? []) as unknown[]).map((r) => (typeof r === 'string' ? r : (r as any).purge_source_data)).filter(Boolean);
  if (paths.length) await supabase.storage.from('pages').remove(paths);
  layoutCache.clear();
  urlCache.clear();
  return paths.length;
}

/** Delete every batch with all its rows AND its files in storage (nothing left behind). */
export async function deleteAllData(): Promise<void> {
  const { data: batches, error } = await supabase.from('batches').select('id');
  if (error) throw error;
  for (const b of batches ?? []) {
    const { data: files } = await supabase.storage.from('pages').list(b.id, { limit: 1000 });
    const paths = (files ?? []).map((f) => `${b.id}/${f.name}`);
    for (let i = 0; i < paths.length; i += 100) await supabase.storage.from('pages').remove(paths.slice(i, i + 100));
    await supabase.from('batches').delete().eq('id', b.id);
  }
  layoutCache.clear();
  urlCache.clear();
}
