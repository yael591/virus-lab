// Turn the model's raw JSON into a validated form: normalise, ground, repair, flag.

import type { BuiltCommitment, BuiltForm, FieldMeta, RawExtraction, RawField, RegexHints, Sender } from './types.ts';
import {
  isValidIsraeliId,
  matchSender,
  normalizeCentral,
  normalizeCommitment,
  normalizeDate,
  pageYear,
  normalizeNationalId,
  repairNationalId,
} from './normalize.ts';
import { isGrounded } from './verify.ts';

export const CONFIDENCE_MIN = 0.8;
/** Below this, an ungrounded value is flagged. */
export const GROUNDED_MIN = 0.9;

export interface BuildOptions {
  ocrText: string;
  senders: Sender[];
  hints?: RegexHints;
  /** Sample forms have altered IDs, so a failed check digit is a warning, not a flag, unless strict. */
  strictIdChecksum?: boolean;
  now?: Date;
}

const conf = (f?: RawField) => (typeof f?.confidence === 'number' ? Math.max(0, Math.min(1, f.confidence)) : 0.5);
const val = (f?: RawField) => {
  const v = f?.value;
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s && s.toLowerCase() !== 'null' ? s : null;
};

function meta(value: string | null, f: RawField | undefined, ocrText: string, extraReasons: string[] = []): FieldMeta {
  const confidence = conf(f);
  const quote = f?.quote ? String(f.quote) : null;
  const verified = value ? isGrounded(value, quote, ocrText) : false;
  const reasons = [...extraReasons];
  if (!value) reasons.push('לא נמצא בטופס');
  if (value && confidence < CONFIDENCE_MIN) reasons.push(`ביטחון נמוך (${Math.round(confidence * 100)}%)`);
  if (value && !verified && confidence < GROUNDED_MIN) reasons.push('לא אומת מול טקסט הדף');
  return { confidence, quote, verified, flagged: reasons.length > 0, reasons };
}

/** Validate a model-supplied box: four numbers in 0..1 with x0<x1, y0<y1. */
export function cleanRegion(r: unknown): [number, number, number, number] | undefined {
  if (!Array.isArray(r) || r.length !== 4 || !r.every((n) => typeof n === 'number' && isFinite(n))) return undefined;
  let [x0, y0, x1, y1] = r.map((n) => (n > 1 && n <= 100 ? n / 100 : n)) as number[];
  if (x0 > x1) [x0, x1] = [x1, x0];
  if (y0 > y1) [y0, y1] = [y1, y0];
  if (x0 < 0 || y0 < 0 || x1 > 1 || y1 > 1 || x1 - x0 < 0.005 || y1 - y0 < 0.003) return undefined;
  return [x0, y0, x1, y1];
}

export function buildForm(raw: RawExtraction, opts: BuildOptions): BuiltForm {
  const { ocrText, senders } = opts;
  const warnings: string[] = [];
  const fm: BuiltForm['field_meta'] = {};

  // names
  let first = val(raw.first_name);
  let last = val(raw.last_name);
  fm.first_name = meta(first, raw.first_name, ocrText);
  fm.last_name = meta(last, raw.last_name, ocrText);
  // A handwritten name the OCR cannot confirm is the easiest place for a model to "fill in"
  // a plausible name. Such a reading is kept only as a suggestion: the field stays empty
  // and flagged until a person accepts or types it.
  const asSuggestion = (m: FieldMeta | undefined, v: string | null): string | null => {
    if (!m || !v || m.verified) return v;
    m.suggestion = v;
    m.reasons = ['הצעה מכתב יד — השדה ריק עד שתאשרי'];
    m.flagged = true;
    return null;
  };
  first = asSuggestion(fm.first_name, first);
  last = asSuggestion(fm.last_name, last);

  // national id: normalise → check digit → evidence-based repair
  let nid = normalizeNationalId(val(raw.national_id));
  const idReasons: string[] = [];
  if (nid && !isValidIsraeliId(nid)) {
    const fixed = repairNationalId(nid, ocrText);
    if (fixed) {
      warnings.push(`ת.ז. תוקנה לפי טקסט הדף: ${nid} ← ${fixed}. יש לאמת מול הטופס.`);
      nid = fixed;
    } else if (opts.strictIdChecksum) {
      idReasons.push('ספרת ביקורת לא תקינה');
    } else {
      warnings.push(`ת.ז. ${nid} לא עוברת בדיקת ספרת ביקורת.`);
    }
  }
  if (nid && (nid.length < 7 || nid.length > 9)) idReasons.push('אורך ת.ז. חריג');
  fm.national_id = meta(nid, raw.national_id, ocrText, idReasons);

  // sender: closed list only
  const rawSender = val(raw.sender);
  const sender = matchSender(rawSender, senders);
  const senderReasons: string[] = [];
  if (rawSender && !sender) {
    senderReasons.push('לא ברשימה הסגורה');
    warnings.push(`גורם שולח "${rawSender}" לא נמצא ברשימה — יש לבחור ידנית.`);
  }
  if (sender && opts.hints?.senderGuess && opts.hints.senderGuess !== sender) {
    senderReasons.push(`החיפוש בטקסט הצביע על ${opts.hints.senderGuess}`);
  }
  fm.sender = meta(sender, raw.sender, ocrText, senderReasons);
  if (sender) fm.sender.verified = true; // validated against the closed list

  // central numbers
  const centrals: string[] = [];
  const centralReasons: string[] = [];
  let centralConf = 1;
  let centralVerified = true;
  for (const f of raw.central_numbers ?? []) {
    const { value, valid } = normalizeCentral(val(f));
    if (!value || centrals.includes(value)) continue;
    centrals.push(value);
    centralConf = Math.min(centralConf, conf(f));
    if (!valid) centralReasons.push(`${value}: לא 6 ספרות`);
    if (!isGrounded(value, f.quote, ocrText)) centralVerified = false;
  }
  for (const c of opts.hints?.centralCandidates ?? []) {
    if (!centrals.includes(c)) centralReasons.push(`בטקסט נמצא גם ${c}`);
  }
  fm.central_numbers = {
    confidence: centrals.length ? centralConf : 0,
    quote: (raw.central_numbers ?? []).map((f) => f.quote).filter(Boolean).join(' | ') || null,
    verified: centrals.length > 0 && centralVerified,
    flagged: false,
    reasons: centralReasons,
  };
  if (!centrals.length) fm.central_numbers.reasons.push('לא נמצא בטופס');
  else if (centralConf < CONFIDENCE_MIN) fm.central_numbers.reasons.push(`ביטחון נמוך (${Math.round(centralConf * 100)}%)`);
  else if (!centralVerified && centralConf < GROUNDED_MIN) fm.central_numbers.reasons.push('לא אומת מול טקסט הדף');
  fm.central_numbers.flagged = fm.central_numbers.reasons.length > 0;

  // received date
  const d = normalizeDate(val(raw.received_date), opts.now, pageYear(ocrText, opts.now));
  fm.received_date = meta(d.iso, raw.received_date, ocrText, d.issue && d.issue !== 'חסר' ? [d.issue] : []);
  if (d.iso && !fm.received_date.verified) {
    // the model returns the date as written; ground on its raw text
    fm.received_date.verified = isGrounded(val(raw.received_date), raw.received_date?.quote, ocrText);
    fm.received_date.reasons = fm.received_date.reasons.filter((r) => r !== 'לא אומת מול טקסט הדף' || !fm.received_date!.verified);
    fm.received_date.flagged = fm.received_date.reasons.length > 0;
  }

  // commitments: one record each
  const commitments: BuiltCommitment[] = [];
  const seen = new Set<string>();
  const cRegions = Array.isArray(raw.regions?.commitment_numbers) ? (raw.regions!.commitment_numbers as unknown[]) : [];
  for (const [i, f] of (raw.commitment_numbers ?? []).entries()) {
    const { value, valid } = normalizeCommitment(val(f));
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const m = meta(value, f, ocrText, valid ? [] : ['פורמט לא צפוי']);
    const r = cleanRegion(cRegions[i]);
    if (r) m.region = r;
    commitments.push({ value, meta: m });
  }
  const missed = (opts.hints?.commitmentCandidates ?? []).filter((c) => !seen.has(c));
  if (missed.length) {
    warnings.push(`החיפוש בטקסט מצא מספרי התחייבות שהמודל לא החזיר: ${missed.join(', ')}. בדקי אם חסרה שורה.`);
  }
  if (commitments.length === 0 && raw.is_commitment_form !== false && !raw.continuation_of_previous) {
    const r = cleanRegion(raw.regions?.commitment_number);
    commitments.push({ value: null, meta: { confidence: 0, quote: null, verified: false, flagged: true, reasons: ['לא נמצא מספר התחייבות'], ...(r ? { region: r } : {}) } });
  }

  for (const n of raw.notes ?? []) if (n && String(n).trim()) warnings.push(String(n).trim());

  for (const [k, m] of Object.entries(fm)) {
    const r = cleanRegion((raw.regions as Record<string, unknown> | undefined)?.[k]);
    if (m && r) m.region = r;
  }

  return {
    is_commitment_form: raw.is_commitment_form !== false,
    continuation: !!raw.continuation_of_previous,
    form_type: val({ value: raw.form_type ?? null }),
    first_name: first,
    last_name: last,
    national_id: nid,
    sender,
    central_numbers: centrals,
    received_date: d.iso,
    field_meta: fm,
    commitments,
    warnings,
  };
}
