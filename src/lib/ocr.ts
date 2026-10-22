// In-browser OCR (Tesseract, Hebrew + English). Page text never goes to an extra
// external service: it is computed here and stored only in our own database.
//
// SPEED: a small pool of Tesseract workers (scheduler) so several pages OCR in
// parallel, and the 4-rotation retry runs only for truly unreadable pages
// (sideways scans). Handwritten pages read at ~30-50% confidence upright; they no
// longer pay for three extra full-page OCR passes — the model's page_rotation
// still catches a sideways page.

import { createScheduler, createWorker, type Scheduler } from 'tesseract.js';
import type { OcrLayout } from '@engine/types.ts';
import { enhanced, free, rotate, toJpeg } from './render.ts';

/** Parallel OCR workers. Each heb+eng worker costs memory, so keep it small. */
export const OCR_WORKERS = Math.max(1, Math.min(3, (navigator.hardwareConcurrency ?? 4) - 1));

let schedP: Promise<Scheduler> | null = null;
function scheduler(): Promise<Scheduler> {
  if (!schedP) {
    schedP = (async () => {
      const s = createScheduler();
      const workers = await Promise.all(Array.from({ length: OCR_WORKERS }, () => createWorker('heb+eng')));
      for (const w of workers) s.addWorker(w);
      return s;
    })();
  }
  return schedP;
}

export interface OcrResult {
  text: string;
  layout: OcrLayout;
  confidence: number;
}

async function recognize(canvas: HTMLCanvasElement): Promise<OcrResult> {
  const s = await scheduler();
  const e = enhanced(canvas);
  let data: any;
  try {
    ({ data } = (await s.addJob('recognize', e)) as any);
  } catch {
    // some browsers fail to hand a canvas to the worker under memory pressure — retry as a JPEG blob
    ({ data } = (await s.addJob('recognize', await toJpeg(e, 0.92))) as any);
  } finally {
    free(e);
  }
  return {
    text: data.text ?? '',
    confidence: data.confidence ?? 0,
    layout: {
      width: canvas.width,
      height: canvas.height,
      words: ((data.words ?? []) as any[])
        .filter((wd) => wd.text?.trim())
        .map((wd) => ({ t: wd.text, x0: wd.bbox.x0, y0: wd.bbox.y0, x1: wd.bbox.x1, y1: wd.bbox.y1 })),
    },
  };
}

/** Below this the page is probably sideways/upside-down → try other rotations. */
const RETRY_BELOW = 25;
/** Stop trying rotations once a read is this good. */
const GOOD_ENOUGH = 55;

/**
 * OCR with orientation recovery: only if the upright read is very poor, try the other
 * three rotations and keep the best. Returns the canvas actually used, so stored image,
 * word boxes and crops all share one geometry.
 */
export async function ocrPage(canvas: HTMLCanvasElement, force?: 0 | 90 | 180 | 270): Promise<OcrResult & { canvas: HTMLCanvasElement; rotation: number }> {
  if (force !== undefined) {
    const c = rotate(canvas, force);
    return { ...(await recognize(c)), canvas: c, rotation: force };
  }
  let best = { ...(await recognize(canvas)), canvas, rotation: 0 };
  if (best.confidence >= RETRY_BELOW) return best;
  for (const deg of [180, 90, 270] as const) {
    const c = rotate(canvas, deg);
    const r = await recognize(c);
    if (r.confidence > best.confidence + 5) {
      if (best.canvas !== canvas) free(best.canvas);
      best = { ...r, canvas: c, rotation: deg };
    } else free(c);
    if (best.confidence >= GOOD_ENOUGH) break;
  }
  return best;
}
