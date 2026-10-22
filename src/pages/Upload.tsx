import { useRef, useState, type DragEvent } from 'react';
import { processFile, type FileProgress } from '../lib/pipeline.ts';

const ACCEPT = /\.(pdf|jpe?g|png|webp|bmp|tiff?|heic)$/i;

export default function Upload({ onGoReview }: { onGoReview: () => void }) {
  const [items, setItems] = useState<FileProgress[]>([]);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function run(files: File[]) {
    const list = files.filter((f) => ACCEPT.test(f.name));
    if (!list.length) return;
    setBusy(true);
    const base = items.length;
    setItems((prev) => [...prev, ...list.map((f) => ({ fileName: f.name, total: 0, pages: [], records: 0, startedAt: Date.now() }))]);
    for (let k = 0; k < list.length; k++) {
      await processFile(list[k], (p) => setItems((prev) => prev.map((it, idx) => (idx === base + k ? p : it))));
    }
    setBusy(false);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setOver(false);
    run(Array.from(e.dataTransfer.files));
  }

  const totalRecords = items.reduce((s, i) => s + i.records, 0);
  const first = items[0]?.startedAt;
  const last = items.every((i) => i.finishedAt) ? Math.max(...items.map((i) => i.finishedAt ?? 0)) : null;

  return (
    <main className="page narrow">
      <div className="page-head">
        <h1>העלאת טפסי התחייבות</h1>
        <p className="muted">PDF או תמונות (גם צילומי טלפון). כל עמוד מעובד בנפרד, ונוצרת רשומה לכל מספר התחייבות.</p>
      </div>

      <label
        htmlFor="files"
        className={over ? 'drop over' : 'drop'}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <svg aria-hidden="true" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V4" /><path d="m7 9 5-5 5 5" /><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></svg>
        <span className="drop-title">גררי קבצים לכאן</span>
        <span className="muted">או <u className="link">בחרי מהמחשב</u> · PDF, JPG, PNG</span>
        <input
          id="files"
          ref={inputRef}
          type="file"
          multiple
          accept=".pdf,image/*"
          className="sr-only"
          onChange={(e) => { run(Array.from(e.target.files ?? [])); if (inputRef.current) inputRef.current.value = ''; }}
        />
      </label>

      {items.length > 0 && (
        <section className="card files" aria-label="קבצים בעיבוד">
          {items.map((it, idx) => {
            const done = it.pages.filter((p) => p === 'done' || p === 'skipped' || p === 'error').length;
            const errors = it.pages.filter((p) => p === 'error').length;
            const pct = it.total ? Math.round((done / it.total) * 100) : 0;
            const current = it.pages.findIndex((p) => p === 'ocr');
            return (
              <div className="file-row" key={idx}>
                <div className="file-line">
                  <strong>{it.fileName}</strong>
                  <span className="muted">{it.total ? `${it.total} עמודים` : 'טוען…'}</span>
                  <span className="spacer" />
                  {it.error ? (
                    <span className="pill bad">שגיאה: {it.error}</span>
                  ) : it.finishedAt ? (
                    <span className="pill ok">הושלם · {it.records} רשומות{errors ? ` · ${errors} עמודים נכשלו` : ''}</span>
                  ) : (
                    <span className="accent-text">
                      {current >= 0 ? `קורא עמוד ${current + 1}` : it.pages.includes('rotating') ? 'מיישר דף מסובב' : it.pages.includes('zoom') ? 'מגדיל אזורים לא ברורים' : 'מחלץ'} · {done}/{it.total}
                    </span>
                  )}
                </div>
                <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                  <div className={it.finishedAt ? 'bar-fill ok' : 'bar-fill'} style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
        </section>
      )}

      {items.length > 0 && (
        <div className="row-between">
          <span className="muted">
            {totalRecords} רשומות
            {first && last ? ` · זמן עיבוד ${Math.round((last - first) / 1000)} שניות` : ''}
            {busy ? ' · אפשר כבר להתחיל לבדוק' : ''}
          </span>
          <button className="btn primary" type="button" onClick={onGoReview}>למסך הבדיקה</button>
        </div>
      )}
    </main>
  );
}
