// Focused re-read: which fields deserve a zoomed second look, and how to merge the result.

import type { BuiltForm, FieldMeta, RawField, Sender } from './types.ts';
import { CONFIDENCE_MIN } from './build.ts';
import { isValidIsraeliId, normalizeCentral, normalizeCommitment, normalizeDate, normalizeNationalId, pageYear } from './normalize.ts';
import { isGrounded } from './verify.ts';

export const ZOOM_FIELDS = ['first_name', 'last_name', 'national_id', 'central_numbers', 'received_date'] as const;
export type ZoomField = (typeof ZOOM_FIELDS)[number];

export interface ZoomRequest {
  field: ZoomField | 'commitment_number';
  /** Padded crop box on the page, 0..1. */
  box: [number, number, number, number];
  /** For commitment numbers: the record to update. */
  record_id?: string;
}

/** Upper bound on zoomed crops per page (cost control). */
export const MAX_ZOOMS = 7;

/**
 * Generous padding: model boxes are approximate and often cover only part of a
 * handwritten word (or the barcode next to it). A wider crop = less zoom, but the
 * whole field is in view. Tunable without code changes via env vars.
 */
const env = (k: string, d: number) => {
  try { const v = Number((globalThis as any).Deno?.env.get(k)); return isFinite(v) && v > 0 ? v : d; } catch { return d; }
};
export const ZOOM_PAD_X = env('ZOOM_PAD_X', 3);      // crop width  = box width  × this (was 1.8)
export const ZOOM_PAD_Y = env('ZOOM_PAD_Y', 4);      // crop height = box height × this (was 2.6)
export const ZOOM_MIN_W = env('ZOOM_MIN_W', 0.3);    // never narrower than 30% of the page (was 12%)
export const ZOOM_MIN_H = env('ZOOM_MIN_H', 0.08);   // never shorter than 8% of the page (was 3%)
export const ZOOM_MAX_W = env('ZOOM_MAX_W', 0.7);    // ...but not wider than 70% (still a real zoom)
export const ZOOM_MAX_H = env('ZOOM_MAX_H', 0.35);

export function padBox(r: [number, number, number, number]): [number, number, number, number] {
  const [x0, y0, x1, y1] = r;
  const w = x1 - x0;
  const h = y1 - y0;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const W = Math.min(Math.max(ZOOM_MAX_W, w), Math.max(w * ZOOM_PAD_X, ZOOM_MIN_W));
  const H = Math.min(Math.max(ZOOM_MAX_H, h), Math.max(h * ZOOM_PAD_Y, ZOOM_MIN_H));
  const bx = Math.max(0, Math.min(cx - W / 2, 1 - W));
  const by = Math.max(0, Math.min(cy - H / 2, 1 - H));
  return [bx, by, bx + W, by + H];
}

/**
 * Fields worth a zoomed second look: empty, uncertain, flagged, or confident but NOT
 * confirmed by the OCR text (typically handwriting — where the model can be "sure" and wrong).
 */
export function zoomRequests(
  fm: BuiltForm['field_meta'] | Record<string, FieldMeta | undefined>,
  values: Record<string, unknown>,
  commitments: { id: string; value: string | null; meta: FieldMeta }[] = [],
): ZoomRequest[] {
  const out: ZoomRequest[] = [];
  for (const c of commitments) {
    const m = c.meta;
    if (!m?.region || m.edited || m.zoomed) continue;
    if (!c.value || !m.verified || m.confidence < 0.9 || m.flagged) out.push({ field: 'commitment_number', box: padBox(m.region), record_id: c.id });
  }
  for (const f of ZOOM_FIELDS) {
    const m = (fm as Record<string, FieldMeta | undefined>)[f];
    if (!m?.region || m.edited || m.zoomed) continue;
    const v = values[f];
    const empty = v == null || (Array.isArray(v) && v.length === 0) || v === '';
    if (empty || m.confidence < CONFIDENCE_MIN || m.flagged || !m.verified || m.suggestion) out.push({ field: f, box: padBox(m.region) });
  }
  return out.slice(0, MAX_ZOOMS);
}

/** Zoomed reading of a commitment number: taken only if better and well-formed. */
export function mergeCommitmentZoom(oldValue: string | null, old: FieldMeta | undefined, r: RawField | undefined, ocrText: string): { value: string; meta: FieldMeta } | null {
  if (!r || old?.edited) return null;
  const { value, valid } = normalizeCommitment(r.value ?? null);
  if (!value || !valid) return null;
  const c = conf(r);
  const oldConf = old?.confidence ?? 0;
  if (value === oldValue) {
    // same reading from a closer look → more trust, never less
    const m: FieldMeta = { ...(old as FieldMeta), confidence: Math.max(oldConf, c), zoomed: true };
    m.reasons = (m.reasons ?? []).filter((x) => !x.startsWith('ביטחון נמוך'));
    if (m.confidence < CONFIDENCE_MIN) m.reasons.push(`ביטחון נמוך (${Math.round(m.confidence * 100)}%)`);
    m.flagged = m.reasons.length > 0;
    return { value, meta: m };
  }
  if (oldValue && c <= oldConf + 0.05) return null;
  const verified = isGrounded(value, r.quote, ocrText);
  const reasons = ['נקרא מהגדלה של האזור'];
  if (oldValue) reasons.push(`הקריאה הראשונה הייתה ${oldValue}`);
  if (c < CONFIDENCE_MIN) reasons.push(`ביטחון נמוך (${Math.round(c * 100)}%)`);
  return { value, meta: { confidence: c, quote: r.quote ?? null, verified, flagged: reasons.length > 1, reasons, region: old?.region, zoomed: true } };
}

export interface MergeResult {
  updates: Record<string, unknown>;
  meta: Record<string, FieldMeta>;
  notes: string[];
}

const conf = (f?: RawField) => (typeof f?.confidence === 'number' ? Math.max(0, Math.min(1, f.confidence)) : 0.5);

/**
 * Take a zoomed reading only when it is better: the old value was empty, or the new one
 * is more confident and passes validation. Every replacement is reported to the reviewer.
 */
export function mergeZoom(
  current: Record<string, unknown>,
  currentMeta: Record<string, FieldMeta | undefined>,
  reread: Record<string, RawField | RawField[] | undefined>,
  ocrText: string,
  _senders: Sender[] = [],
): MergeResult {
  const updates: Record<string, unknown> = {};
  const meta: Record<string, FieldMeta> = {};
  const notes: string[] = [];

  for (const f of ZOOM_FIELDS) {
    const r = reread[f];
    const old = currentMeta[f];
    if (!r || !old || old.edited) continue;

    let value: unknown = null;
    let c = 0;
    let quote: string | null = null;
    const reasons: string[] = [];

    if (f === 'central_numbers') {
      const list = (Array.isArray(r) ? r : [r]).map((x) => ({ n: normalizeCentral(x?.value ?? null), c: conf(x), q: x?.quote ?? null }));
      const vals = list.filter((x) => x.n.value).map((x) => x.n.value!) ;
      if (!vals.length) continue;
      if (list.some((x) => x.n.value && !x.n.valid)) reasons.push('לא 6 ספרות');
      value = [...new Set(vals)];
      c = Math.min(...list.filter((x) => x.n.value).map((x) => x.c));
      quote = list.map((x) => x.q).filter(Boolean).join(' | ') || null;
    } else {
      const one = Array.isArray(r) ? r[0] : r;
      const raw = one?.value != null ? String(one.value).trim() : '';
      if (!raw || raw.toLowerCase() === 'null') continue;
      c = conf(one);
      quote = one?.quote ?? null;
      if (f === 'national_id') {
        value = normalizeNationalId(raw);
        if (value && !isValidIsraeliId(value as string)) reasons.push('ספרת ביקורת לא תקינה');
      } else if (f === 'received_date') {
        const d = normalizeDate(raw, new Date(), pageYear(ocrText));
        if (!d.iso) continue;
        value = d.iso;
        if (d.issue) reasons.push(d.issue);
      } else {
        value = raw;
      }
    }

    const oldVal = current[f];
    const oldEmpty = oldVal == null || oldVal === '' || (Array.isArray(oldVal) && oldVal.length === 0);
    const same = !oldEmpty && JSON.stringify(oldVal) === JSON.stringify(value);
    if (same) {
      // a closer look agrees → raise trust (never lower it)
      const m: FieldMeta = { ...old, confidence: Math.max(old.confidence, c), zoomed: true };
      m.reasons = m.reasons.filter((x) => !x.startsWith('ביטחון נמוך') && x !== 'לא אומת מול טקסט הדף');
      if (m.confidence < CONFIDENCE_MIN) m.reasons.push(`ביטחון נמוך (${Math.round(m.confidence * 100)}%)`);
      if (m.reasons.length === 0) m.reasons = [];
      m.flagged = m.reasons.length > 0 || !!m.suggestion;
      meta[f] = m;
      continue;
    }
    const better = oldEmpty || (c > old.confidence + 0.05 && reasons.length === 0);
    if (!better) {
      // disagreement between the two readings → keep the first, but send to the reviewer
      if (!oldEmpty) {
        const show = (v: unknown) => (Array.isArray(v) ? v.join(', ') : String(v));
        meta[f] = { ...old, zoomed: true, flagged: true, reasons: [...old.reasons.filter((x) => !x.startsWith('בהגדלה נקרא')), `בהגדלה נקרא ${show(value)}`] };
      }
      continue;
    }

    const verified = isGrounded(Array.isArray(value) ? (value as string[])[0] : (value as string), quote, ocrText);
    if ((f === 'first_name' || f === 'last_name') && !verified) {
      // unconfirmed handwritten name → suggestion only, field stays empty
      if (old.suggestion === value) continue;
      meta[f] = { ...old, confidence: c, quote, suggestion: value as string, zoomed: true, flagged: true, reasons: ['הצעה מכתב יד (מהגדלה) — השדה ריק עד שתאשרי'] };
      notes.push(`${f}: הצעה מהגדלה — ${value}`);
      continue;
    }
    if (c < CONFIDENCE_MIN) reasons.push(`ביטחון נמוך (${Math.round(c * 100)}%)`);
    reasons.push('נקרא מהגדלה של האזור');

    updates[f] = value;
    meta[f] = { confidence: c, quote, verified, flagged: reasons.length > 1, reasons, region: old.region, zoomed: true };
    const show = (v: unknown) => (Array.isArray(v) ? v.join(', ') : v ?? 'ריק');
    notes.push(`${f}: נקרא מחדש מהגדלה — ${show(oldVal)} ← ${show(value)}`);
  }
  return { updates, meta, notes };
}
