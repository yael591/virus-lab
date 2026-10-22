// Deterministic pre-pass over the OCR text. Its findings are handed to the model
// as hints, and used afterwards to catch numbers the model missed.

import type { RegexHints } from './types.ts';

interface Profile {
  sender: string;
  detect: RegExp[];
  /** Capture group 1 = commitment number. */
  commitment: RegExp[];
}

const N = '[\\s:.#\\-–]{0,6}';

// Label-before-number and number-before-label (Hebrew OCR line order varies).
const both = (label: string, digits = '\\d{4,12}') => [
  new RegExp(`${label}${N}(?:מס(?:פר|'|׳)?${N})?(${digits})`),
  new RegExp(`(${digits})${N}${label}`),
];

const PROFILES: Profile[] = [
  { sender: 'מאוחדת', detect: [/מאוחדת/], commitment: both('התחייבות(?:\\s*מספר)?') },
  { sender: 'מכבי', detect: [/מכבי/], commitment: [...both('מספר\\s*התחייבות'), ...both('דרישה', '\\d{6,10}')] },
  { sender: 'לאומית', detect: [/לאומית/], commitment: both('דגימה', '\\d{8,10}') },
  { sender: 'כללית', detect: [/כללית/], commitment: [...both('מס.?\\s*הדגימה', '\\d{8,10}'), ...both('מספר', '\\d{9}')] },
  { sender: 'רמב"ם', detect: [/רמב["״']?ם/], commitment: both('מספר\\s*דגימה', '\\d{9}') },
  { sender: 'שערי צדק', detect: [/שערי\s*צדק/], commitment: both('מספר\\s*התחייבות') },
  { sender: 'לניאדו', detect: [/לניאדו/], commitment: [/\b(X\d{5,7})\b/i] },
  { sender: 'צה"ל', detect: [/אסמכתא\s*תקציבית/, /צה["״]?ל/], commitment: both('אסמכתא\\s*תקציבית', '\\d{6,10}') },
  { sender: 'שמיר (אסף הרופא)', detect: [/שמיר/, /אסף\s*הרופא/], commitment: both('מספר\\s*התחייבות', '\\d{3,8}') },
  { sender: 'ברזילי', detect: [/ברזיל/], commitment: both('מס.?\\s*התחייבות', '\\d{3,8}') },
];

const GENERIC: RegExp[] = [
  ...both('מס(?:פר|\'|׳)?\\s*התחייבות'),
  ...both('התחייבות\\s*מספר'),
];

const CENTRAL: RegExp[] = [/מרכזי[\s:]{0,6}(\d{6})(?!\d)/g, /(?<!\d)(\d{6})[\s:]{0,6}מרכזי/g];

function collect(text: string, res: RegExp[], into: Set<string>) {
  for (const re of res) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    for (const m of text.matchAll(g)) if (m[1]) into.add(m[1].toUpperCase());
  }
}

export function runRegexHints(ocrText: string): RegexHints {
  const text = (ocrText ?? '').replace(/[‎‏]/g, '');
  const profile = PROFILES.find((p) => p.detect.some((d) => d.test(text))) ?? null;
  const commitments = new Set<string>();
  collect(text, profile ? profile.commitment : GENERIC, commitments);
  if (!profile) collect(text, GENERIC, commitments);
  const centrals = new Set<string>();
  collect(text, CENTRAL, centrals);
  return {
    senderGuess: profile?.sender ?? null,
    commitmentCandidates: [...commitments],
    centralCandidates: [...centrals],
  };
}
