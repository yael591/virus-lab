// Value → position on the page, from positional OCR. Zero AI.
// A value that cannot be located returns null: a position is never invented.

import type { Anchor, OcrLayout } from './types.ts';
import { normalizeForMatch } from './verify.ts';

const MAX_WORDS = 8;
const MIN_LEN = 2;

interface IndexedWord {
  n: string;
  t: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function indexLayout(layout: OcrLayout): IndexedWord[] {
  return (layout?.words ?? [])
    .map((w) => ({ n: normalizeForMatch(w.t), t: w.t, x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 }))
    .filter((w) => w.n.length > 0);
}

function boxOf(layout: OcrLayout, words: IndexedWord[], from: number, to: number): Anchor | null {
  if (!layout.width || !layout.height) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const parts: string[] = [];
  for (let i = from; i <= to; i++) {
    const w = words[i];
    x0 = Math.min(x0, w.x0); y0 = Math.min(y0, w.y0);
    x1 = Math.max(x1, w.x1); y1 = Math.max(y1, w.y1);
    parts.push(w.t);
  }
  const c = (v: number) => Math.max(0, Math.min(1, v));
  return { x0: c(x0 / layout.width), y0: c(y0 / layout.height), x1: c(x1 / layout.width), y1: c(y1 / layout.height), quote: parts.join(' ') };
}

/**
 * Slide a window over consecutive OCR words. An exact match of a word run wins
 * immediately; otherwise the shortest run that contains the value is used.
 * Words are tried in both orders because Hebrew OCR may emit mixed-direction runs reversed.
 */
export function findAnchor(layout: OcrLayout | null | undefined, value: string | null | undefined, index?: IndexedWord[]): Anchor | null {
  if (!layout || value == null) return null;
  const target = normalizeForMatch(String(value));
  if (target.length < MIN_LEN) return null;
  const words = index ?? indexLayout(layout);
  let contained: Anchor | null = null;
  for (let i = 0; i < words.length; i++) {
    let fwd = '';
    let rev = '';
    for (let j = i; j < words.length && j - i < MAX_WORDS; j++) {
      fwd += words[j].n;
      rev = words[j].n + rev;
      if (fwd === target || rev === target) return boxOf(layout, words, i, j);
      if (fwd.includes(target) || rev.includes(target)) {
        if (!contained) contained = boxOf(layout, words, i, j);
        break;
      }
      if (fwd.length > target.length + 12) break;
    }
  }
  return contained;
}

/**
 * Sanity check for a model-supplied region: it should cover at least one OCR word box
 * (handwriting usually still yields some word boxes, even garbled). A region over empty
 * paper is almost certainly misplaced and is dropped rather than shown.
 */
export function regionHasWords(layout: OcrLayout | null | undefined, r: [number, number, number, number] | undefined, pad = 0.01): boolean {
  if (!layout || !r || !layout.width || !layout.height) return false;
  const [x0, y0, x1, y1] = [r[0] - pad, r[1] - pad, r[2] + pad, r[3] + pad];
  for (const w of layout.words ?? []) {
    const wx0 = w.x0 / layout.width, wx1 = w.x1 / layout.width;
    const wy0 = w.y0 / layout.height, wy1 = w.y1 / layout.height;
    if (wx1 >= x0 && wx0 <= x1 && wy1 >= y0 && wy0 <= y1) return true;
  }
  return false;
}
