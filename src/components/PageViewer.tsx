// Full-page viewer with zoom and pan, the extracted value boxed. Opened from the hover card.

import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as RMouseEvent, type WheelEvent } from 'react';
import type { Anchor } from '@engine/types.ts';
import { pageImageUrl } from '../lib/data.ts';

export interface ViewerTarget {
  pageId: string;
  imagePath: string | null;
  box: Anchor | null;
  label: string;
}

const MIN = 0.5;
const MAX = 6;

export default function PageViewer({ target, onClose }: { target: ViewerTarget; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const centred = useRef(false);

  useEffect(() => { pageImageUrl(target.imagePath).then(setUrl); }, [target.imagePath]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === '+' || e.key === '=') setZoom((z) => Math.min(MAX, z * 1.25));
      if (e.key === '-') setZoom((z) => Math.max(MIN, z / 1.25));
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  // width that fits the window at zoom 1
  const fitW = natural ? Math.min(natural.w, (scrollRef.current?.clientWidth ?? 1000) - 48) : 0;
  const width = fitW * zoom;
  const height = natural ? (width * natural.h) / natural.w : 0;

  // first open with a box: zoom in and centre on it
  useLayoutEffect(() => {
    if (!natural || centred.current) return;
    centred.current = true;
    if (target.box) setZoom(Math.min(MAX, Math.max(2, 0.35 / Math.max(0.05, target.box.x1 - target.box.x0))));
  }, [natural, target.box]);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !natural || !target.box) return;
    const cx = ((target.box.x0 + target.box.x1) / 2) * width + Math.max(0, (el.scrollWidth - width) / 2);
    const cy = ((target.box.y0 + target.box.y1) / 2) * height + 24;
    el.scrollLeft = cx - el.clientWidth / 2;
    el.scrollTop = cy - el.clientHeight / 2;
  }, [zoom, natural]); // eslint-disable-line react-hooks/exhaustive-deps

  function onWheel(e: WheelEvent) {
    if (!e.ctrlKey) return; // plain wheel scrolls; Ctrl+wheel zooms
    e.preventDefault();
    setZoom((z) => Math.max(MIN, Math.min(MAX, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15))));
  }
  function down(e: RMouseEvent) {
    const el = scrollRef.current!;
    drag.current = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop };
    setDragging(true);
  }
  function move(e: RMouseEvent) {
    if (!drag.current) return;
    const el = scrollRef.current!;
    el.scrollLeft = drag.current.sl - (e.clientX - drag.current.x);
    el.scrollTop = drag.current.st - (e.clientY - drag.current.y);
  }
  const up = () => { drag.current = null; setDragging(false); };

  return (
    <div className="viewer-backdrop" role="dialog" aria-modal="true" aria-label={`המסמך המלא: ${target.label}`}>
      <div className="viewer-bar">
        <strong>{target.label}</strong>
        <span className="spacer" />
        <button type="button" className="btn small" aria-label="הקטנה" onClick={() => setZoom((z) => Math.max(MIN, z / 1.25))}>−</button>
        <span className="zoom-val">{Math.round(zoom * 100)}%</span>
        <button type="button" className="btn small" aria-label="הגדלה" onClick={() => setZoom((z) => Math.min(MAX, z * 1.25))}>+</button>
        <button type="button" className="btn small ghost" onClick={() => setZoom(1)}>התאמה למסך</button>
        <button type="button" className="btn small primary" onClick={onClose}>סגירה</button>
      </div>
      <div
        ref={scrollRef}
        dir="ltr"
        className={dragging ? 'viewer-scroll dragging' : 'viewer-scroll'}
        onWheel={onWheel}
        onMouseDown={down}
        onMouseMove={move}
        onMouseUp={up}
        onMouseLeave={up}
      >
        {!url ? (
          <div className="center-msg" style={{ color: '#fff' }}>טוען…</div>
        ) : (
          <div className="viewer-page" style={natural ? { width, height } : undefined}>
            <img src={url} alt="עמוד הטופס" draggable={false} onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
            {natural && target.box && (
              <div
                className="viewer-box"
                style={{
                  left: target.box.x0 * width - 4,
                  top: target.box.y0 * height - 4,
                  width: (target.box.x1 - target.box.x0) * width + 8,
                  height: (target.box.y1 - target.box.y0) * height + 8,
                }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
