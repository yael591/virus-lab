import { describe, expect, it } from 'vitest';
import {
  isValidIsraeliId, matchSender, normalizeCommitment, normalizeDate, normalizeNationalId, pageYear, repairNationalId,
} from '../../supabase/functions/_shared/engine/normalize.ts';
import { parseModelJson } from '../../supabase/functions/_shared/engine/parse.ts';
import { isGrounded, quoteInText } from '../../supabase/functions/_shared/engine/verify.ts';
import { findAnchor } from '../../supabase/functions/_shared/engine/anchor.ts';
import { runRegexHints } from '../../supabase/functions/_shared/engine/regex-profiles.ts';
import { buildForm } from '../../supabase/functions/_shared/engine/build.ts';
import type { Sender } from '../../supabase/functions/_shared/engine/types.ts';

const senders: Sender[] = [
  { name: 'מאוחדת', kind: 'kupa', aliases: ['קופת חולים מאוחדת'] },
  { name: 'לאומית', kind: 'kupa', aliases: [] },
  { name: 'שמיר (אסף הרופא)', kind: 'hospital', aliases: ['אסף הרופא', 'שמיר'] },
  { name: 'רמב"ם', kind: 'hospital', aliases: ['רמבם', 'רמב״ם'] },
];

describe('national id', () => {
  it('strips extra leading zeros, never pads', () => {
    expect(normalizeNationalId('0011223344')).toBe('011223344');
    expect(normalizeNationalId('1 2345678 2')).toBe('123456782');
    expect(normalizeNationalId('12345678')).toBe('12345678');
  });
  it('validates check digit', () => {
    expect(isValidIsraeliId('123456782')).toBe(true);
    expect(isValidIsraeliId('123456789')).toBe(false);
  });
  it('repairs one misread digit from OCR evidence only', () => {
    expect(repairNationalId('123456789', 'ת.ז 1 2345678 2 שם')).toBe('123456782');
    expect(repairNationalId('123456789', 'מספר 987654324')).toBeNull(); // too far → no repair
    expect(repairNationalId('23456782', 'ת"ז 123456782')).toBe('123456782'); // dropped first digit
  });
});

describe('dates', () => {
  const now = new Date('2026-10-20T12:00:00Z');
  it('parses common formats', () => {
    expect(normalizeDate('27.8.26', now).iso).toBe('2026-08-27');
    expect(normalizeDate('31-08-2026', now).iso).toBe('2026-08-31');
    expect(normalizeDate('התקבל 27/08/26', now).iso).toBe('2026-08-27');
  });
  it('completes a year-less date from the page and flags it', () => {
    const r = normalizeDate('25.8', now, pageYear('תאריך 25.08.2026 ביק.ראש. 25.08.2026', now));
    expect(r.iso).toBe('2026-08-25');
    expect(r.issue).toContain('הושלמה');
  });
  it('flags impossible and future dates', () => {
    expect(normalizeDate('31.02.26', now).iso).toBeNull();
    expect(normalizeDate('01.12.26', now).issue).toBe('תאריך עתידי');
  });
});

describe('sender closed list', () => {
  it('maps aliases and rejects unknowns', () => {
    expect(matchSender('בית החולים אסף הרופא', senders)).toBe('שמיר (אסף הרופא)');
    expect(matchSender('רמב״ם', senders)).toBe('רמב"ם');
    expect(matchSender('בית חולים דמיוני', senders)).toBeNull();
  });
});

describe('commitment number', () => {
  it('keeps a leading letter', () => {
    expect(normalizeCommitment('x 132767')).toEqual({ value: 'X132767', valid: true });
    expect(normalizeCommitment('12').valid).toBe(false);
  });
});

describe('parse', () => {
  it('handles fences and truncation', () => {
    expect(parseModelJson('```json\n{"a":1}\n```').value).toEqual({ a: 1 });
    const r = parseModelJson<any>('{"a":{"value":"1"},"b":[{"value":"2"},{"value":"3"');
    expect(r.repaired).toBe(true);
    expect(r.value.a.value).toBe('1');
  });
});

describe('grounding', () => {
  it('matches values despite spacing and bidi marks', () => {
    expect(isGrounded('730578626', null, 'התחייבות מספר ‏730 578 626')).toBe(true);
    expect(isGrounded('730578699', null, 'התחייבות מספר 730578626')).toBe(false);
    expect(quoteInText('מספר התחייבות 2646', 'מספר  התחייבות: 2646')).toBe(true);
  });
});

describe('anchor', () => {
  const layout = {
    width: 1000, height: 2000,
    words: [
      { t: 'התחייבות', x0: 600, y0: 100, x1: 700, y1: 130 },
      { t: 'מספר', x0: 520, y0: 100, x1: 590, y1: 130 },
      { t: '730', x0: 400, y0: 100, x1: 450, y1: 130 },
      { t: '578626', x0: 300, y0: 100, x1: 395, y1: 130 },
    ],
  };
  it('unions split words into one box', () => {
    const a = findAnchor(layout, '730578626')!;
    expect(a).not.toBeNull();
    expect(a.x0).toBeCloseTo(0.3);
    expect(a.x1).toBeCloseTo(0.45);
  });
  it('returns null when not on the page', () => {
    expect(findAnchor(layout, '999999')).toBeNull();
  });
});

describe('regex hints', () => {
  it('finds commitment and central numbers', () => {
    const h = runRegexHints('קופת חולים מאוחדת\nהתחייבות מספר 730578626\nמרכזי 947512');
    expect(h.senderGuess).toBe('מאוחדת');
    expect(h.commitmentCandidates).toContain('730578626');
    expect(h.centralCandidates).toContain('947512');
  });
});

describe('buildForm', () => {
  const ocr = 'מאוחדת התחייבות מספר 730578626 730578627 מרכזי 947512 התקבל 27.8.26 כהן רחל';
  it('one record per commitment, empty when missing, flags low confidence', () => {
    const f = buildForm({
      sender: { value: 'מאוחדת', confidence: 0.99 },
      first_name: { value: 'רחל', confidence: 0.6 },
      last_name: { value: 'כהן', confidence: 0.95 },
      national_id: { value: null },
      central_numbers: [{ value: '947512', confidence: 0.97 }],
      received_date: { value: '27.8.26', confidence: 0.9 },
      commitment_numbers: [{ value: '730578626', confidence: 0.98 }, { value: '730578627', confidence: 0.98 }],
    }, { ocrText: ocr, senders, now: new Date('2026-10-20') });
    expect(f.commitments.map((c) => c.value)).toEqual(['730578626', '730578627']);
    expect(f.received_date).toBe('2026-08-27');
    expect(f.field_meta.first_name?.flagged).toBe(true);
    expect(f.field_meta.last_name?.flagged).toBe(false);
    expect(f.last_name).toBe('כהן'); // grounded in OCR text → kept
    expect(f.national_id).toBeNull();
    expect(f.field_meta.national_id?.flagged).toBe(true);
  });
  it('keeps an unconfirmed handwritten name as a suggestion, not a value', () => {
    const f = buildForm({ first_name: { value: 'ישראל', confidence: 0.5 } }, { ocrText: 'מין מקרה', senders });
    expect(f.first_name).toBeNull();
    expect(f.field_meta.first_name?.suggestion).toBe('ישראל');
    expect(f.field_meta.first_name?.flagged).toBe(true);
  });
  it('adds an empty flagged row when no commitment is found', () => {
    const f = buildForm({ commitment_numbers: [] }, { ocrText: '', senders });
    expect(f.commitments).toHaveLength(1);
    expect(f.commitments[0].value).toBeNull();
    expect(f.commitments[0].meta.flagged).toBe(true);
  });
  it('warns when regex saw a commitment the model missed', () => {
    const f = buildForm({ commitment_numbers: [{ value: '730578626', confidence: 0.99 }] }, {
      ocrText: ocr, senders, hints: { senderGuess: 'מאוחדת', commitmentCandidates: ['730578626', '730578627'], centralCandidates: [] },
    });
    expect(f.warnings.join(' ')).toContain('730578627');
  });
  it('sender outside the closed list stays empty and flagged', () => {
    const f = buildForm({ sender: { value: 'מרפאה פרטית', confidence: 0.9 } }, { ocrText: 'מרפאה פרטית', senders });
    expect(f.sender).toBeNull();
    expect(f.field_meta.sender?.flagged).toBe(true);
  });
});

import { cleanRegion } from '../../supabase/functions/_shared/engine/build.ts';
import { mergeCommitmentZoom, mergeZoom, padBox, zoomRequests } from '../../supabase/functions/_shared/engine/zoom.ts';

describe('zoom', () => {
  it('validates regions', () => {
    expect(cleanRegion([0.5, 0.7, 0.9, 0.75])).toEqual([0.5, 0.7, 0.9, 0.75]);
    expect(cleanRegion([50, 70, 90, 75])).toEqual([0.5, 0.7, 0.9, 0.75]);
    expect(cleanRegion([0.5, 0.7])).toBeUndefined();
  });
  it('asks to zoom only empty/uncertain fields with a region', () => {
    const base = { confidence: 0.95, quote: null, verified: true, flagged: false, reasons: [] };
    const reqs = zoomRequests(
      { first_name: { ...base, confidence: 0.4, flagged: true, region: [0.5, 0.7, 0.9, 0.75] }, national_id: { ...base, region: [0.5, 0.6, 0.9, 0.65] }, last_name: { ...base, flagged: true } },
      { first_name: 'x', national_id: '011223344', last_name: null },
    );
    expect(reqs.map((r) => r.field)).toEqual(['first_name']);
    const b = padBox([0.5, 0.7, 0.9, 0.75]);
    expect(b[0]).toBeLessThan(0.5);
    expect(b[3]).toBeGreaterThan(0.75);
  });
  it('merges only better readings', () => {
    const m = (c: number) => ({ confidence: c, quote: null, verified: false, flagged: true, reasons: [], region: [0, 0, 1, 1] as [number, number, number, number] });
    const r = mergeZoom(
      { first_name: null, national_id: '011223344', received_date: '2026-06-18' },
      { first_name: m(0), national_id: m(0.9), received_date: m(0.6) },
      { first_name: { value: 'ישראל', confidence: 0.7 }, national_id: { value: '011223355', confidence: 0.6 }, received_date: { value: '18.06.26', confidence: 0.95 } },
      '',
    );
    expect('first_name' in r.updates).toBe(false); // handwritten name never fills the field…
    expect(r.meta.first_name.suggestion).toBe('ישראל'); // …it is offered as a suggestion
    expect(r.meta.first_name.flagged).toBe(true);
    expect('national_id' in r.updates).toBe(false); // lower confidence → first reading kept…
    expect(r.meta.national_id.reasons.join()).toContain('011223355'); // …but the disagreement is flagged
    expect('received_date' in r.updates).toBe(false); // same date read again…
    expect(r.meta.received_date.confidence).toBe(0.95); // …raises trust
  });
  it('commitment zoom: replaces only with a better, well-formed reading', () => {
    const old = { confidence: 0.6, quote: null, verified: false, flagged: true, reasons: ['ביטחון נמוך (60%)'], region: [0, 0, 1, 1] as [number, number, number, number] };
    expect(mergeCommitmentZoom('2646', old, { value: '2648', confidence: 0.9 }, '')!.value).toBe('2648');
    expect(mergeCommitmentZoom('2646', old, { value: '2648', confidence: 0.6 }, '')).toBeNull();
    expect(mergeCommitmentZoom('2646', old, { value: '12', confidence: 0.99 }, '')).toBeNull();
    expect(mergeCommitmentZoom('2646', old, { value: '2646', confidence: 0.92 }, '')!.meta.flagged).toBe(false);
  });
});

import { regionHasWords } from '../../supabase/functions/_shared/engine/anchor.ts';
describe('region sanity', () => {
  const layout = { width: 1000, height: 1000, words: [{ t: 'שם', x0: 600, y0: 100, x1: 650, y1: 130 }] };
  it('keeps a region over words, drops one over empty paper', () => {
    expect(regionHasWords(layout, [0.55, 0.08, 0.7, 0.15])).toBe(true);
    expect(regionHasWords(layout, [0.9, 0.6, 0.98, 0.7])).toBe(false);
  });
});
