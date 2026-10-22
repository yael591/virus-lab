// File → page canvases. PDFs are rasterised with pdf.js; photos keep their EXIF orientation.

import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Long side of a rendered page, in px. Enough for OCR of small print; ~300–500 KB as JPEG. */
const TARGET_LONG_SIDE = 2000;

/** Long side used for the zoomed tiles sent to the model. */
export const TILE_SOURCE_LONG_SIDE = 3000;

export interface PageSource {
  pageNo: number;
  render: (longSide?: number) => Promise<HTMLCanvasElement>;
}

export async function pagesOf(file: File): Promise<PageSource[]> {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (!isPdf) {
    return [{ pageNo: 1, render: (longSide = TARGET_LONG_SIDE) => imageToCanvas(file, longSide) }];
  }
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  return Array.from({ length: doc.numPages }, (_, i) => ({
    pageNo: i + 1,
    render: async (longSide = TARGET_LONG_SIDE) => {
      const page = await doc.getPage(i + 1);
      const base = page.getViewport({ scale: 1 });
      const scale = longSide / Math.max(base.width, base.height);
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      return canvas;
    },
  }));
}

async function imageToCanvas(file: File, longSide: number): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
  const scale = Math.min(1, longSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return canvas;
}

export function rotate(src: HTMLCanvasElement, deg: 0 | 90 | 180 | 270): HTMLCanvasElement {
  if (deg === 0) return src;
  const c = document.createElement('canvas');
  const swap = deg === 90 || deg === 270;
  c.width = swap ? src.height : src.width;
  c.height = swap ? src.width : src.height;
  const ctx = c.getContext('2d')!;
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

/** Greyscale + contrast copy for OCR only (helps dark or faded scans). Same geometry. */
export function enhanced(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext('2d')!;
  ctx.filter = 'grayscale(1) contrast(1.35) brightness(1.05)';
  ctx.drawImage(src, 0, 0);
  return c;
}

/**
 * Two overlapping halves along the long axis. Each half reaches the model at close to
 * its own size, so handwriting and small digits keep roughly twice the detail of the full page.
 */
export function tiles(src: HTMLCanvasElement, overlap = 0.12): HTMLCanvasElement[] {
  const vertical = src.height >= src.width;
  const long = vertical ? src.height : src.width;
  const size = Math.round(long * (0.5 + overlap / 2));
  return [0, long - size].map((start) => {
    const c = document.createElement('canvas');
    c.width = vertical ? src.width : size;
    c.height = vertical ? size : src.height;
    const ctx = c.getContext('2d')!;
    if (vertical) ctx.drawImage(src, 0, start, src.width, size, 0, 0, src.width, size);
    else ctx.drawImage(src, start, 0, size, src.height, 0, 0, size, src.height);
    return c;
  });
}

export function toJpeg(canvas: HTMLCanvasElement, quality = 0.85): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', quality),
  );
}

/** Release a canvas' pixel memory right away (browsers cap total canvas memory). */
export function free(...cs: (HTMLCanvasElement | null | undefined)[]) {
  for (const c of cs) if (c) { c.width = 0; c.height = 0; }
}
