// Deterministic normalisation and validation. The model reads; this code decides.

import type { Sender } from './types.ts';

export const digitsOnly = (s: string | null | undefined): string => (s ?? '').replace(/\D+/g, '');

// ---------------------------------------------------------------- Israeli ID

/**
 * Strip formatting. Never pads: a short value usually means a dropped digit,
 * and padding would hide that. Extra leading zeros beyond 9 digits
 * (forms print "0011223344") are removed.
 */
export function normalizeNationalId(raw: string | null | undefined): string | null {
  let d = digitsOnly(raw);
  while (d.length > 9 && d.startsWith('0')) d = d.slice(1);
  return d || null;
}

/** Israeli ID check digit. Shorter IDs are validated as if left-padded with zeros. */
export function isValidIsraeliId(id: string | null | undefined): boolean {
  const d = digitsOnly(id);
  if (d.length < 5 || d.length > 9) return false;
  const p = d.padStart(9, '0');
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let n = Number(p[i]) * ((i % 2) + 1);
    if (n > 9) n -= 9;
    sum += n;
  }
  return sum % 10 === 0;
}

const SP = '[\\s\\u00A0\\u2009\\u2007]';

/** 9-digit ID candidates in raw OCR text, including the spaced "1 2345678 9" print style. */
export function findIdCandidates(text: string): string[] {
  const out = new Set<string>();
  if (!text) return [];
  const patterns = [
    /(?<!\d)\d{9}(?!\d)/g,
    new RegExp(`(?<!\\d)\\d${SP}\\d{7}${SP}\\d(?!\\d)`, 'g'),
    new RegExp(`(?<!\\d)\\d${SP}\\d{8}(?!\\d)`, 'g'),
    new RegExp(`(?<!\\d)\\d{8}${SP}\\d(?!\\d)`, 'g'),
    /(?<!\d)00\d{9}(?!\d)/g, // "00" + 9 digits, as printed on some lab labels
  ];
  for (const re of patterns) for (const m of text.matchAll(re)) {
    const n = normalizeNationalId(m[0]);
    if (n && n.length === 9) out.add(n);
  }
  return [...out];
}

function hamming(a: string, b: string): number {
  if (a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

function isSubsequence(short: string, long: string): boolean {
  if (short.length >= long.length) return false;
  let i = 0;
  for (let j = 0; j < long.length && i < short.length; j++) if (long[j] === short[i]) i++;
  return i === short.length;
}

/**
 * Evidence-based repair: return a checksum-valid ID from the OCR text ONLY if it is
 * provably a variant of the model's value (one misread digit, or one dropped digit).
 * Anything looser risks putting another person's number in the record.
 */
export function repairNationalId(current: string | null, ocrText: string): string | null {
  const cur = digitsOnly(current);
  if (!cur || isValidIsraeliId(cur)) return null;
  for (const c of findIdCandidates(ocrText)) {
    if (!isValidIsraeliId(c) || c === cur) continue;
    const ok = cur.length === 9 ? hamming(c, cur) <= 1 : cur.length === 8 && isSubsequence(cur, c);
    if (ok) return c;
  }
  return null;
}

// ---------------------------------------------------------------- dates

export interface DateResult {
  iso: string | null;
  issue: string | null;
}

/** "27.8.26", "27/08/2026", "31-08-2026", "2026-08-27" → ISO. Never guesses day/month order. */
/**
 * The year that appears most on the page (printed dates like 25.08.2026), used to complete
 * a hand-written "25.8" that has no year. Null when the page shows no plausible year.
 */
export function pageYear(text: string, now: Date = new Date()): number | null {
  const counts = new Map<number, number>();
  for (const m of (text ?? '').matchAll(/(?<!\d)\d{1,2}[./-]\d{1,2}[./-](20\d{2})(?!\d)/g)) {
    const y = +m[1];
    if (y >= 2020 && y <= now.getUTCFullYear() + 1) counts.set(y, (counts.get(y) ?? 0) + 1);
  }
  let best: number | null = null;
  for (const [y, c] of counts) if (best === null || c > counts.get(best)!) best = y;
  return best;
}

export function normalizeDate(raw: string | null | undefined, now: Date = new Date(), refYear?: number | null): DateResult {
  const s = (raw ?? '').trim();
  if (!s) return { iso: null, issue: 'חסר' };
  let d: number, m: number, y: number;
  let completed = false;
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const dmy = s.match(/(\d{1,2})\s*[./\-\\]\s*(\d{1,2})\s*[./\-\\]\s*(\d{2,4})/);
  const dm = s.match(/(?<!\d)(\d{1,2})\s*[./\\]\s*(\d{1,2})(?![\d./\\])/);
  if (iso) {
    y = +iso[1]; m = +iso[2]; d = +iso[3];
  } else if (dmy) {
    d = +dmy[1]; m = +dmy[2]; y = +dmy[3];
    if (dmy[3].length === 2) y += 2000;
    else if (dmy[3].length === 3) return { iso: null, issue: 'שנה לא תקינה' };
  } else if (dm) {
    // lab staff often write only day.month ("25.8"): take the year printed on the page
    d = +dm[1]; m = +dm[2];
    y = refYear ?? now.getUTCFullYear();
    if (!refYear && new Date(Date.UTC(y, m - 1, d)) > new Date(now.getTime() + 86_400_000)) y -= 1;
    completed = true;
  } else {
    return { iso: null, issue: 'פורמט תאריך לא מזוהה' };
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return { iso: null, issue: 'תאריך לא קיים' };
  }
  const out = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const tomorrow = new Date(now.getTime() + 86_400_000);
  if (dt > tomorrow) return { iso: out, issue: 'תאריך עתידי' };
  if (y < 2020) return { iso: out, issue: 'תאריך ישן מהצפוי' };
  if (completed) return { iso: out, issue: `נכתב בלי שנה — הושלמה ${y}` };
  return { iso: out, issue: null };
}

export function isoToDisplay(iso: string | null | undefined): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

// ---------------------------------------------------------------- numbers

/** Central lab number: 6 digits on the "מרכזי" sticker. */
export function normalizeCentral(raw: string | null | undefined): { value: string | null; valid: boolean } {
  const d = digitsOnly(raw);
  if (!d) return { value: null, valid: false };
  return { value: d, valid: /^\d{6}$/.test(d) };
}

/** Commitment number: digits, optionally one leading Latin letter (e.g. Laniado "X132767"). */
export function normalizeCommitment(raw: string | null | undefined): { value: string | null; valid: boolean } {
  const s = (raw ?? '').toUpperCase().replace(/[\s\-–_.]/g, '');
  if (!s) return { value: null, valid: false };
  return { value: s, valid: /^[A-Z]?\d{4,12}$/.test(s) };
}

// ---------------------------------------------------------------- sender (closed list)

function normHeb(s: string): string {
  return s
    .replace(/["'״׳`]/g, '')
    .replace(/(בית\s*החולים|בית\s*חולים|ביה\s*ח|בי\s*ח|המרכז\s*הרפואי|מרכז\s*רפואי|ע\s*ש|על\s*שם)/g, ' ')
    .replace(/[()\-–,.]/g, ' ')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/** Map free text to a name from the closed list, or null (never invents a sender). */
export function matchSender(raw: string | null | undefined, senders: Sender[]): string | null {
  const q = normHeb(raw ?? '');
  if (q.length < 2) return null;
  // exact on name or alias
  for (const s of senders) {
    if (normHeb(s.name) === q || s.aliases.some((a) => normHeb(a) === q)) return s.name;
  }
  // containment (longest alias wins, min 3 chars to avoid noise)
  let best: { name: string; len: number } | null = null;
  for (const s of senders) {
    for (const a of [s.name, ...s.aliases]) {
      const n = normHeb(a);
      if (n.length < 3) continue;
      if ((q.includes(n) || n.includes(q)) && (!best || n.length > best.len)) best = { name: s.name, len: n.length };
    }
  }
  return best?.name ?? null;
}
