// Grounding checks: is what the model returned actually on the page?

/** Ignore whitespace, separators, quotes and bidi marks so "264 6" matches "2646". */
export function normalizeForMatch(s: string): string {
  return (s ?? '')
    .replace(/[\s   ]/g, '')
    .replace(/[,'"״׳₪$%*()‎‏:;|\\/]/g, '')
    .toLowerCase();
}

/** The value itself appears in the OCR text. */
export function valueInText(value: string | null | undefined, ocrText: string): boolean {
  const v = normalizeForMatch(value ?? '');
  if (v.length < 2) return false;
  return normalizeForMatch(ocrText).includes(v);
}

const MIN_TOKEN = 2;
const MIN_COVERAGE = 0.8;

/** The model's quote is in the OCR text: exact, or ≥80% of its tokens present. */
export function quoteInText(quote: string | null | undefined, ocrText: string): boolean {
  const q = (quote ?? '').trim();
  if (!q) return false;
  if (normalizeForMatch(ocrText).includes(normalizeForMatch(q))) return true;
  const tokens = q.split(/\s+/).map(normalizeForMatch).filter((t) => t.length >= MIN_TOKEN);
  if (tokens.length === 0) return false;
  const src = new Set((ocrText ?? '').split(/\s+/).map(normalizeForMatch));
  const hit = tokens.filter((t) => src.has(t)).length;
  return hit / tokens.length >= MIN_COVERAGE;
}

/** Either the value or the quote is grounded in the OCR text. */
export function isGrounded(value: string | null, quote: string | null | undefined, ocrText: string): boolean {
  if (!ocrText) return false;
  return valueInText(value, ocrText) || quoteInText(quote, ocrText);
}
