// Upload pipeline: render → OCR (browser) → store image → extract (edge function) → zoom re-read.
//
// SPEED: pages run in parallel (PAGE_CONCURRENCY). A continuation page whose previous
// page is not finished yet is "deferred" by the server and re-extracted in page order
// after the parallel pass, so continuation merging stays correct. Zoom re-reads no
// longer block the next page — they run in the background and are awaited at the end.
//
// NAMES: a field drawn sideways (tall crop) is sent to the re-read as one image holding
// both 90° rotations, so the model always has an upright copy of the handwriting.

import { supabase } from './supabase.ts';
import { free, pagesOf, rotate, tiles, toJpeg, TILE_SOURCE_LONG_SIDE, type PageSource } from './render.ts';
import { ocrPage, OCR_WORKERS } from './ocr.ts';
import type { ZoomRequest } from '@engine/zoom.ts';
import type { OcrLayout } from '@engine/types.ts';

export type PageState = 'waiting' | 'ocr' | 'extracting' | 'rotating' | 'zoom' | 'done' | 'skipped' | 'error';
type Deg = 0 | 90 | 180 | 270;

export interface FileProgress {
  fileName: string;
  total: number;
  pages: PageState[];
  records: number;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

interface Prepared {
  path: string;
  rotation: Deg;
  row: Record<string, unknown>;
}

/** Pages processed at the same time (OCR + model call). */
const PAGE_CONCURRENCY = Math.max(2, OCR_WORKERS + 1);
/** Zoom re-reads render at 4200px — keep few in flight to spare canvas memory. */
const ZOOM_CONCURRENCY = 2;

/** Tiny promise pool (no dependency). */
function pool(n: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => { active--; queue.shift()?.(); };
  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = () => { active++; fn().then(resolve, reject).finally(next); };
      if (active < n) run(); else queue.push(run);
    });
}

/** Render, OCR (optionally at a forced rotation), upload page image + zoom tiles. */
async function preparePage(batchId: string, src: PageSource, force?: Deg): Promise<Prepared> {
  const raw = await src.render();
  const ocr = await ocrPage(raw, force);
  if (ocr.canvas !== raw) free(raw);
  const rotation = ocr.rotation as Deg;
  const path = `${batchId}/${String(src.pageNo).padStart(3, '0')}.jpg`;
  const { error: upErr } = await supabase.storage.from('pages')
    .upload(path, await toJpeg(ocr.canvas), { contentType: 'image/jpeg', upsert: true });
  free(ocr.canvas);
  if (upErr) throw new Error(upErr.message);

  // zoom tiles are best effort: a failure here must not lose the page
  const tilePaths: string[] = [];
  try {
    const big = await src.render(TILE_SOURCE_LONG_SIDE);
    const hi = rotate(big, rotation);
    if (hi !== big) free(big);
    const ts = tiles(hi);
    free(hi);
    // upload both tiles in parallel
    const ups = await Promise.all(ts.map(async (t, k) => {
      const tp = path.replace(/\.jpg$/, `-t${k + 1}.jpg`);
      const blob = await toJpeg(t, 0.9);
      free(t);
      const { error } = await supabase.storage.from('pages').upload(tp, blob, { contentType: 'image/jpeg', upsert: true });
      return error ? null : tp;
    }));
    for (const tp of ups) if (tp) tilePaths.push(tp);
  } catch (e) {
    console.warn('tiles skipped', e);
  }
  return {
    path,
    rotation,
    row: {
      image_path: path,
      tile_paths: tilePaths,
      rotation,
      ocr_text: ocr.text,
      ocr_layout: ocr.layout,
      ocr_confidence: ocr.confidence,
    },
  };
}

interface PageCtx {
  src: PageSource;
  i: number;
  pageId: string;
  prep: Prepared;
}

export async function processFile(file: File, onProgress: (p: FileProgress) => void): Promise<void> {
  const prog: FileProgress = { fileName: file.name, total: 0, pages: [], records: 0, startedAt: Date.now() };
  const emit = () => onProgress({ ...prog, pages: [...prog.pages] });

  try {
    const sources = await pagesOf(file);
    prog.total = sources.length;
    prog.pages = sources.map(() => 'waiting');
    emit();

    const { data: batch, error: bErr } = await supabase.from('batches')
      .insert({ file_name: file.name, page_count: sources.length }).select('id').single();
    if (bErr || !batch) throw new Error(bErr?.message ?? 'batch insert failed');

    const pageLimit = pool(PAGE_CONCURRENCY);
    const zoomLimit = pool(ZOOM_CONCURRENCY);
    const zoomJobs: Promise<void>[] = [];
    const deferred: PageCtx[] = [];

    /** Extract one page; handles rotation and schedules the zoom re-read. */
    const runExtract = async (ctx: PageCtx, allowDefer: boolean): Promise<'deferred' | 'finished'> => {
      const { src, i, pageId } = ctx;
      prog.pages[i] = 'extracting';
      emit();
      let res = await extractPage(pageId, true, allowDefer);
      if (res.deferred) return 'deferred';
      if (res.rotate) {
        // the model saw a sideways page: rotate, re-OCR, re-extract once
        prog.pages[i] = 'rotating';
        emit();
        const deg = ((ctx.prep.rotation + res.rotate) % 360) as Deg;
        ctx.prep = await preparePage(batch.id, src, deg);
        await supabase.from('pages').update(ctx.prep.row).eq('id', pageId);
        res = await extractPage(pageId, false, allowDefer);
        if (res.deferred) return 'deferred';
      }
      prog.records += res.records;
      // the model is bad at coordinates: for the patient name, crop from the printed label
      // that Tesseract found ("שם המבוטח", "שם משפחה"...) instead of the model's guess
      if (res.formId) res.zoom = anchorNameZoom(res.zoom, ctx.prep.row.ocr_layout as OcrLayout | null);
      if (res.formId && res.zoom.length) {
        prog.pages[i] = 'zoom';
        emit();
        const rot = ctx.prep.rotation;
        const formId = res.formId;
        const zoom = res.zoom;
        const finalState = res.state;
        // background: does not hold up the next page
        zoomJobs.push(zoomLimit(async () => {
          await zoomReread(formId, ctx.prep.path, zoom, ctx.prep.row.ocr_layout as OcrLayout | null, () => src.render(ZOOM_LONG_SIDE).then((c) => {
            const r = rotate(c, rot);
            if (r !== c) free(c);
            return r;
          }));
          prog.pages[i] = finalState;
          emit();
        }));
      } else {
        prog.pages[i] = res.state;
        emit();
      }
      return 'finished';
    };

    // ---- pass 1: all pages in parallel
    await Promise.all(sources.map((src) => pageLimit(async () => {
      const i = src.pageNo - 1;
      prog.pages[i] = 'ocr';
      emit();
      let ctx: PageCtx;
      try {
        const prep = await preparePage(batch.id, src);
        const { data, error: pErr } = await supabase.from('pages')
          .insert({ batch_id: batch.id, page_no: src.pageNo, status: 'pending', ...prep.row }).select('id').single();
        if (pErr || !data) throw new Error(pErr?.message ?? 'page insert failed');
        ctx = { src, i, pageId: data.id, prep };
      } catch (e) {
        // one bad page must not stop the file
        console.error(`page ${src.pageNo} failed`, e);
        prog.pages[i] = 'error';
        emit();
        return;
      }
      try {
        if ((await runExtract(ctx, true)) === 'deferred') {
          prog.pages[i] = 'waiting';
          emit();
          deferred.push(ctx);
        }
      } catch (e) {
        console.error(`page ${src.pageNo} extraction failed`, e);
        prog.pages[i] = 'error';
        emit();
      }
    })));

    // ---- pass 2: deferred continuation pages, in page order (previous pages are done now)
    deferred.sort((a, b) => a.src.pageNo - b.src.pageNo);
    for (const ctx of deferred) {
      try {
        await runExtract(ctx, false);
      } catch (e) {
        console.error(`page ${ctx.src.pageNo} extraction failed`, e);
        prog.pages[ctx.i] = 'error';
        emit();
      }
    }

    await Promise.all(zoomJobs);
  } catch (e) {
    prog.error = e instanceof Error ? e.message : String(e);
  }
  prog.finishedAt = Date.now();
  emit();
}

export interface ExtractResult {
  state: PageState;
  records: number;
  formId: string | null;
  zoom: ZoomRequest[];
  rotate?: number;
  deferred?: boolean;
}

export async function extractPage(pageId: string, allowRotate = true, allowDefer = false): Promise<ExtractResult> {
  const { data, error } = await supabase.functions.invoke('extract', {
    body: { page_id: pageId, allow_rotate: allowRotate, allow_defer: allowDefer },
  });
  if (error || !data?.ok) return { state: 'error', records: 0, formId: null, zoom: [] };
  if (data.defer) return { state: 'waiting', records: 0, formId: null, zoom: [], deferred: true };
  if (data.rotate) return { state: 'extracting', records: 0, formId: null, zoom: [], rotate: data.rotate };
  if (data.skipped) return { state: 'skipped', records: 0, formId: null, zoom: [] };
  return { state: 'done', records: data.records ?? data.added ?? 0, formId: data.form_id ?? null, zoom: data.zoom ?? [] };
}

// ---------------------------------------------------------------- name crop from printed label

const NAME_FIELDS = ['first_name', 'last_name'] as const;
const NAME_LABEL = /שם\s*:?\s*(ה?מבוטח|ה?מטופל|ה?חולה|ה?נבדק|משפחה|פרטי)|(^|\s)שם\s*:|פרטי\s*ה?מבוטח/;
const NOT_PATIENT = /בית\s*ה?חולים|רופא|מחלקה|מעבדה|מוסד|שולח|קופ/;

type Word = { t: string; x0: number; y0: number; x1: number; y1: number };

/** Group OCR words into text lines (by vertical overlap). */
function lines(words: Word[]): Word[][] {
  const sorted = [...words].sort((a, b) => a.y0 - b.y0);
  const out: Word[][] = [];
  for (const w of sorted) {
    const h = w.y1 - w.y0;
    const line = out.find((l) => {
      const ly0 = Math.min(...l.map((x) => x.y0)), ly1 = Math.max(...l.map((x) => x.y1));
      const overlap = Math.min(ly1, w.y1) - Math.max(ly0, w.y0);
      return overlap > h * 0.5;
    });
    if (line) line.push(w); else out.push([w]);
  }
  return out;
}

/**
 * Box around the printed patient-name label and the whole row beside it (where the
 * handwriting is), with room above and below for writing that leaves the line.
 * Normalized 0..1. Null when no such label was read.
 */
export function nameLabelBox(layout: OcrLayout | null | undefined): [number, number, number, number] | null {
  const L = layout as unknown as { width: number; height: number; words: Word[] } | null;
  if (!L?.words?.length || !L.width || !L.height) return null;
  for (const line of lines(L.words)) {
    const rtl = [...line].sort((a, b) => b.x1 - a.x1); // Hebrew reads right → left
    const text = rtl.map((w) => w.t).join(' ').replace(/["'״׳.,]/g, '');
    if (!NAME_LABEL.test(text) || NOT_PATIENT.test(text)) continue;
    const y0 = Math.min(...line.map((w) => w.y0)), y1 = Math.max(...line.map((w) => w.y1));
    const x1 = Math.max(...line.map((w) => w.x1));
    const h = y1 - y0;
    return [
      0.01,
      Math.max(0, (y0 - 1.5 * h) / L.height),
      Math.min(1, x1 / L.width + 0.02),
      Math.min(1, (y1 + 1.2 * h) / L.height),
    ];
  }
  return null;
}

/**
 * Name zoom requests: with a printed "שם" label, crop around it. Without one, mark the
 * request for an ink search (handwriting found on the page itself, any pen colour).
 * Only names that already need a re-read are touched.
 */
function anchorNameZoom(zoom: ZoomRequest[], layout: OcrLayout | null): ZoomRequest[] {
  const box = nameLabelBox(layout);
  return zoom.map((z) => {
    if (!(NAME_FIELDS as readonly string[]).includes(z.field)) return z;
    return box ? { ...z, box } : ({ ...z, ink: true } as ZoomRequest);
  });
}

// ---------------------------------------------------------------- handwriting by ink

type Box = [number, number, number, number];

/**
 * Areas of the page that hold handwriting, found from the pixels — no AI, any pen colour:
 *  - coloured ink (blue, red, green, purple…): saturated pixels, yellow highlighter excluded;
 *  - dark ink (black pen): dark pixels that are NOT inside a word Tesseract recognised
 *    (Tesseract reads print, not Hebrew handwriting — so dark ink it could not explain is
 *    handwriting, a stamp or a signature).
 * Ink is gathered into cells, cells are joined into word-sized blobs, and blobs the size of
 * a word or two are returned (coloured first). Normalized 0..1 boxes.
 */
export function inkCandidates(page: HTMLCanvasElement, layout: OcrLayout | null, max = 6): Box[] {
  const LONG = 1200, CELL = 6;
  const scale = LONG / Math.max(page.width, page.height);
  const w = Math.max(1, Math.round(page.width * scale)), h = Math.max(1, Math.round(page.height * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const cx = c.getContext('2d', { willReadFrequently: true })!;
  cx.drawImage(page, 0, 0, w, h);
  const px = cx.getImageData(0, 0, w, h).data;
  free(c);

  const gw = Math.ceil(w / CELL), gh = Math.ceil(h / CELL);
  const colorCnt = new Uint16Array(gw * gh), darkCnt = new Uint16Array(gw * gh);

  // cells covered by printed words Tesseract recognised
  const printed = new Uint8Array(gw * gh);
  const L = layout as unknown as { width: number; height: number; words: Word[] } | null;
  if (L?.words?.length && L.width && L.height) {
    for (const wd of L.words) {
      const x0 = Math.max(0, Math.floor((wd.x0 / L.width) * w / CELL) - 1);
      const x1 = Math.min(gw - 1, Math.ceil((wd.x1 / L.width) * w / CELL) + 1);
      const y0 = Math.max(0, Math.floor((wd.y0 / L.height) * h / CELL) - 1);
      const y1 = Math.min(gh - 1, Math.ceil((wd.y1 / L.height) * h / CELL) + 1);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) printed[y * gw + x] = 1;
    }
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = px[i], g = px[i + 1], b = px[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const cell = ((y / CELL) | 0) * gw + ((x / CELL) | 0);
      const sat = mx ? (mx - mn) / mx : 0;
      if (sat > 0.35 && mx > 40 && mx < 235) {
        let hue = 0;
        const d = mx - mn;
        if (mx === r) hue = 60 * (((g - b) / d) % 6);
        else if (mx === g) hue = 60 * ((b - r) / d + 2);
        else hue = 60 * ((r - g) / d + 4);
        if (hue < 0) hue += 360;
        if (hue < 40 || hue > 75) { colorCnt[cell]++; continue; } // yellow = highlighter
      }
      if (mx < 110) darkCnt[cell]++;
    }
  }

  // active cells: 1 = dark handwriting, 2 = coloured ink
  const active = new Uint8Array(gw * gh);
  for (let k = 0; k < gw * gh; k++) {
    if (colorCnt[k] >= 3) active[k] = 2;
    else if (darkCnt[k] >= 4 && !printed[k]) active[k] = 1;
  }

  // join letters into words: neighbours up to 2 cells sideways, 1 up/down
  const seen = new Uint8Array(gw * gh);
  const boxes: { box: Box; colored: boolean; cells: number }[] = [];
  for (let k = 0; k < gw * gh; k++) {
    if (!active[k] || seen[k]) continue;
    const stack = [k];
    seen[k] = 1;
    let x0 = gw, y0 = gh, x1 = 0, y1 = 0, cells = 0, colored = 0;
    while (stack.length) {
      const q = stack.pop()!;
      const qx = q % gw, qy = (q / gw) | 0;
      cells++;
      if (active[q] === 2) colored++;
      if (qx < x0) x0 = qx; if (qx > x1) x1 = qx;
      if (qy < y0) y0 = qy; if (qy > y1) y1 = qy;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -2; dx <= 2; dx++) {
        const nx = qx + dx, ny = qy + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const n = ny * gw + nx;
        if (active[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
      }
    }
    const bw = ((x1 - x0 + 1) * CELL) / w, bh = ((y1 - y0 + 1) * CELL) / h;
    // a word or two: not a dot, not a form line, not a whole table/stamp block
    if (cells < 4 || bw > 0.6 || bh > 0.15 || (bw < 0.03 && bh < 0.03) || bh < 0.01) continue;
    const pad = 0.012;
    boxes.push({
      box: [
        Math.max(0, (x0 * CELL) / w - pad), Math.max(0, (y0 * CELL) / h - pad),
        Math.min(1, ((x1 + 1) * CELL) / w + pad), Math.min(1, ((y1 + 1) * CELL) / h + pad),
      ],
      colored: colored > cells / 2,
      cells,
    });
  }
  boxes.sort((a, b) => (Number(b.colored) - Number(a.colored)) || b.cells - a.cells);
  return boxes.slice(0, max).map((b) => b.box);
}

/** Crop a normalized box from the high-res page, with the same ink-sharpening filter. */
function cropBox(hi: HTMLCanvasElement, box: Box, maxSide = 1500): HTMLCanvasElement | null {
  const [x0, y0, x1, y1] = box;
  const sx = Math.round(x0 * hi.width), sy = Math.round(y0 * hi.height);
  const sw = Math.round((x1 - x0) * hi.width), sh = Math.round((y1 - y0) * hi.height);
  if (sw < 20 || sh < 20) return null;
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const c = document.createElement('canvas');
  c.width = Math.round(sw * scale);
  c.height = Math.round(sh * scale);
  const ctx = c.getContext('2d')!;
  ctx.filter = 'contrast(1.35) saturate(1.4)';
  ctx.drawImage(hi, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}

/** Several candidate crops stacked into one numbered sheet (one image per re-read key). */
function candidateSheet(hi: HTMLCanvasElement, boxes: Box[]): HTMLCanvasElement | null {
  const crops: HTMLCanvasElement[] = [];
  for (const b of boxes) {
    let c = cropBox(hi, b, 1100);
    if (!c) continue;
    if (c.height > c.width * 1.3) { const up = uprightCandidates(c); free(c); c = up; } // sideways writing
    crops.push(c);
  }
  if (!crops.length) return null;
  const GUT = 70, GAP = 16;
  const out = document.createElement('canvas');
  out.width = GUT + Math.max(...crops.map((c) => c.width));
  out.height = crops.reduce((s, c) => s + c.height + GAP, GAP);
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  let y = GAP;
  crops.forEach((c, k) => {
    ctx.fillStyle = '#000';
    ctx.font = 'bold 40px sans-serif';
    ctx.fillText(String(k + 1), 14, y + Math.min(c.height, 60) / 2 + 14);
    ctx.drawImage(c, GUT, y);
    y += c.height + GAP;
    ctx.fillStyle = '#888';
    ctx.fillRect(0, y - GAP / 2 - 1, out.width, 2);
    free(c);
  });
  return out;
}

/** Long side of the render used for zoom crops: high enough that a name line is hundreds of px wide. */
const ZOOM_LONG_SIDE = 4200;

/** Fields that are usually handwritten and may be written sideways on the form. */
const SIDEWAYS_FIELDS = new Set(['first_name', 'last_name', 'national_id']);

/**
 * A tall crop holds text written sideways. Put both 90° rotations in one image
 * (one above the other) so the model always has an upright copy, whichever way it was written.
 */
function uprightCandidates(c: HTMLCanvasElement): HTMLCanvasElement {
  const a = rotate(c, 90);
  const b = rotate(c, 270);
  const gap = 24;
  const out = document.createElement('canvas');
  out.width = Math.max(a.width, b.width);
  out.height = a.height + gap + b.height;
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(a, 0, 0);
  ctx.fillStyle = '#888';
  ctx.fillRect(0, a.height + gap / 2 - 1, out.width, 2);
  ctx.drawImage(b, 0, a.height + gap);
  free(a, b);
  return out;
}

/**
 * Crop each uncertain field's area from a fresh high-resolution render and ask for a
 * focused re-read. Best effort: any failure leaves the first-pass result as it is.
 */
async function zoomReread(formId: string, pagePath: string, zoom: ZoomRequest[], layout: OcrLayout | null, renderHi: () => Promise<HTMLCanvasElement>) {
  try {
    const hi = await renderHi();
    const prepared: { field: string; path: string; record_id?: string; blob: Blob }[] = [];
    let inkSheet: Blob | null | undefined; // built once per page, shared by first/last name
    for (const z of zoom) {
      if ((z as any).ink) {
        if (inkSheet === undefined) {
          const cands = inkCandidates(hi, layout);
          const model = z.box as Box;
          // the model's own box stays as one candidate, unless it is the whole page
          const all = model && (model[2] - model[0]) * (model[3] - model[1]) < 0.5 ? [model, ...cands] : cands;
          const sheet = all.length ? candidateSheet(hi, all) : null;
          inkSheet = sheet ? await toJpeg(sheet, 0.9) : null;
          free(sheet);
        }
        if (inkSheet) {
          const p = pagePath.replace(/\.jpg$/, `-z-${z.field}.jpg`);
          prepared.push({ field: z.field, path: p, blob: inkSheet });
          continue;
        }
        // no ink found → fall through to the model's box
      }
      const [x0, y0, x1, y1] = z.box;
      const sx = Math.round(x0 * hi.width), sy = Math.round(y0 * hi.height);
      const sw = Math.round((x1 - x0) * hi.width), sh = Math.round((y1 - y0) * hi.height);
      if (sw < 20 || sh < 20) continue;
      const scale = Math.min(1, 1500 / Math.max(sw, sh));
      let c = document.createElement('canvas');
      c.width = Math.round(sw * scale);
      c.height = Math.round(sh * scale);
      const ctx = c.getContext('2d')!;
      // sharpen faint pen: more contrast and colour, keeps blue ink distinct from print
      ctx.filter = 'contrast(1.35) saturate(1.4)';
      ctx.drawImage(hi, sx, sy, sw, sh, 0, 0, c.width, c.height);
      // sideways handwriting (tall, narrow box) → send an upright copy
      if (SIDEWAYS_FIELDS.has(z.field) && sh > sw * 1.3) {
        const up = uprightCandidates(c);
        free(c);
        c = up;
      }
      const p = pagePath.replace(/\.jpg$/, `-z-${z.field}${z.record_id ? '-' + z.record_id.slice(0, 8) : ''}.jpg`);
      prepared.push({ field: z.field, path: p, record_id: z.record_id, blob: await toJpeg(c, 0.92) });
      free(c);
    }
    free(hi);
    // upload all crops in parallel
    const ups = await Promise.all(prepared.map(async (x) => {
      const { error } = await supabase.storage.from('pages').upload(x.path, x.blob, { contentType: 'image/jpeg', upsert: true });
      return error ? null : { field: x.field, path: x.path, record_id: x.record_id };
    }));
    const crops = ups.filter((x): x is { field: string; path: string; record_id: string | undefined } => !!x);
    if (crops.length) await supabase.functions.invoke('reread', { body: { form_id: formId, crops } });
  } catch (e) {
    console.warn('zoom re-read skipped', e);
  }
}
