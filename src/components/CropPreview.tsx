// Hover card: the piece of the original page where the value was read, with the value boxed.
// Position comes from OCR word boxes (anchor.ts). If the value can't be located, the whole
// page is shown instead — a position is never guessed.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { findAnchor, indexLayout, regionHasWords } from '@engine/anchor.ts';
import type { Anchor, FieldMeta, OcrLayout } from '@engine/types.ts';
import { pageImageUrl, pageLayout } from '../lib/data.ts';

const W = 320;
const MAX_H = 200;

export interface CropTarget {
  rect: DOMRect;
  pageId: string;
  imagePath: string | null;
  candidates: string[];
  label: string;
  meta?: Partial<FieldMeta>;
}

interface Props {
  target: CropTarget;
  onEnter?: () => void;
  onLeave?: () => void;
  /** Open the full page, optionally focused on a 0..1 box. */
  onOpen?: (box: Anchor | null) => void;
}

export default function CropPreview({ target, onEnter, onLeave, onOpen }: Props) {
  const [layout, setLayout] = useState<OcrLayout | null | undefined>(undefined);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([pageLayout(target.pageId), pageImageUrl(target.imagePath)]).then(([l, u]) => {
      if (live) { setLayout(l); setUrl(u); }
    });
    return () => { live = false; };
  }, [target.pageId, target.imagePath]);

  let anchor: Anchor | null = null;
  if (layout) {
    const idx = indexLayout(layout);
    for (const c of target.candidates) {
      anchor = findAnchor(layout, c, idx);
      if (anchor) break;
    }
  }

  // Fallback: the model's approximate region (handwriting the OCR could not read).
  let approximate = false;
  const reg = target.meta?.region;
  // Handwriting is not in the OCR words (Tesseract reads print only), so a name/ID region
  // is shown even over "empty" paper; other fields still need words under the region.
  const handwritten = /שם|ת\.?ז/.test(target.label);
  if (!anchor && layout && reg && (handwritten || regionHasWords(layout, reg))) {
    anchor = { x0: reg[0], y0: reg[1], x1: reg[2], y1: reg[3], quote: '' };
    approximate = true;
  }

  // Float above the row; drop below only when there is no room above.
  const cardRef = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(-9999);
  useLayoutEffect(() => {
    const h = cardRef.current?.offsetHeight ?? 0;
    const above = target.rect.top - h - 8;
    const below = target.rect.bottom + 8;
    setTop(above >= 8 ? above : Math.min(below, window.innerHeight - h - 8));
  });
  const left = Math.max(8, Math.min(target.rect.left + target.rect.width / 2 - (W + 24) / 2, window.innerWidth - W - 40));
  const m = target.meta;

  return (
    <div ref={cardRef} className="crop-card" style={{ top, left, width: W + 24 }} role="dialog" aria-label={`מקור: ${target.label}`}
      onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <div className="crop-head">
        <span>{target.label}</span>
        {m?.confidence !== undefined && !m.edited && (
          <span className={m.flagged ? 'bad-text' : 'muted'}>ביטחון {Math.round((m.confidence ?? 0) * 100)}%</span>
        )}
        {m?.edited && <span className="muted">תוקן ידנית</span>}
      </div>
      {layout === undefined || !url ? (
        <div className="crop-empty muted">{layout === null || (!url && layout !== undefined) ? 'קובץ המקור נמחק או לא זמין' : 'טוען…'}</div>
      ) : anchor ? (
        <>
          <Crop url={url} layout={layout!} a={anchor} wide={approximate} />
          {approximate && <div className="muted small">מיקום משוער (כתב יד) — לפרטים: פתיחת המסמך המלא</div>}
        </>
      ) : (
        <>
          <img src={url} alt="העמוד המלא" style={{ width: W, maxHeight: 260, objectFit: 'contain', borderRadius: 6, border: '1px solid var(--line)' }} />
          <div className="muted small">המיקום לא אותר בטקסט הדף — מוצג העמוד המלא</div>
        </>
      )}
      {m?.reasons && m.reasons.length > 0 && !m.edited && (
        <ul className="crop-reasons">{m.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
      )}
      {url && onOpen && (
        <button type="button" className="btn small outline" onClick={() => onOpen(anchor)}>
          פתיחת המסמך המלא והגדלה
        </button>
      )}
    </div>
  );
}

function Crop({ url, layout, a, wide = false }: { url: string; layout: OcrLayout; a: Anchor; wide?: boolean }) {
  const bw = a.x1 - a.x0;
  const bh = a.y1 - a.y0;
  // an approximate (model) location gets much more context: less zoom, so the field is in view even if the box is off
  const px = wide ? Math.max(0.3, bw * 2.5) : Math.max(0.12, bw * 1.2);
  const py = wide ? Math.max(0.12, bh * 4) : Math.max(0.04, bh * 2.5);
  const rx0 = Math.max(0, a.x0 - px);
  const rx1 = Math.min(1, a.x1 + px);
  const ry0 = Math.max(0, a.y0 - py);
  const ry1 = Math.min(1, a.y1 + py);
  const scale = Math.min(W / ((rx1 - rx0) * layout.width), MAX_H / ((ry1 - ry0) * layout.height));
  const w = (rx1 - rx0) * layout.width * scale;
  const h = (ry1 - ry0) * layout.height * scale;
  return (
    <div
      className="crop-img"
      style={{
        width: w,
        height: h,
        alignSelf: 'center',
        backgroundImage: `url("${url}")`,
        backgroundSize: `${layout.width * scale}px auto`,
        backgroundPosition: `${-rx0 * layout.width * scale}px ${-ry0 * layout.height * scale}px`,
      }}
    >
      <div
        className={wide ? 'crop-box approx' : 'crop-box'}
        style={{
          left: (a.x0 - rx0) * layout.width * scale - 3,
          top: (a.y0 - ry0) * layout.height * scale - 3,
          width: bw * layout.width * scale + 6,
          height: bh * layout.height * scale + 6,
        }}
      />
    </div>
  );
}
