import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import EditableCell from '../components/EditableCell.tsx';
import CropPreview, { type CropTarget } from '../components/CropPreview.tsx';
import PageViewer, { type ViewerTarget } from '../components/PageViewer.tsx';
import {
  addCommitment, deleteAllData, deleteRecord, loadForms, loadSenders, purgeApprovedSources,
  setStatus, updateCommitment, updateFormField, type FormField, type FormRow, type RecordRow,
} from '../lib/data.ts';
import { exportCsv, exportJson, exportXlsx } from '../lib/export.ts';
import { isoToDisplay, normalizeCentral, normalizeCommitment, normalizeDate, normalizeNationalId } from '@engine/normalize.ts';
import type { FieldMeta } from '@engine/types.ts';

type StatusFilter = 'all' | 'flagged' | 'pending' | 'approved';

const LABEL: Record<FormField | 'commitment_number', string> = {
  commitment_number: 'מספר התחייבות', first_name: 'שם פרטי', last_name: 'שם משפחה', national_id: 'ת.ז.',
  sender: 'גורם שולח', central_numbers: 'מספר מרכזי', received_date: 'תאריך קבלה',
};

const recFlagged = (f: FormRow, r: RecordRow) =>
  r.status !== 'approved' && (!!r.commitment_meta?.flagged || Object.values(f.field_meta).some((m) => m?.flagged));

/** Strings to look for on the page when anchoring a crop. */
function cropCandidates(field: FormField | 'commitment_number', value: string | null, meta?: Partial<FieldMeta>, list?: string[]): string[] {
  const out: string[] = [];
  if (field === 'central_numbers') out.push(...(list ?? []));
  else if (field === 'received_date' && value) {
    const [y, m, d] = value.split('-');
    const yy = y.slice(2);
    const dn = String(+d), mn = String(+m);
    out.push(`${d}/${m}/${y}`, `${d}.${m}.${y}`, `${d}-${m}-${y}`, `${dn}.${mn}.${yy}`, `${dn}/${mn}/${yy}`, `${d}.${m}.${yy}`, `${d}/${m}/${yy}`);
  } else if (value) out.push(value);
  if (field === 'national_id' && value) out.push(`00${value}`, value.padStart(9, '0'));
  if (meta?.quote) out.push(meta.quote);
  return out.filter(Boolean);
}

export default function Review() {
  const [forms, setForms] = useState<FormRow[]>([]);
  const [senders, setSenders] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [sender, setSender] = useState('');
  const [status, setStatusF] = useState<StatusFilter>('all');
  const [exportOpen, setExportOpen] = useState(false);
  const [openWarn, setOpenWarn] = useState<Record<string, boolean>>({});
  const [crop, setCrop] = useState<CropTarget | null>(null);
  const hoverTimer = useRef<number | undefined>(undefined);
  const hideTimer = useRef<number | undefined>(undefined);
  const [viewer, setViewer] = useState<ViewerTarget | null>(null);
  const busyRef = useRef(false);

  const reload = useCallback(async () => {
    try {
      setForms(await loadForms());
      setErr(null);
    } catch (e: any) {
      setErr(e?.message ?? 'טעינה נכשלה');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
    loadSenders().then(setSenders);
    // light polling so rows appear while a batch is still being processed
    const t = window.setInterval(() => { if (!busyRef.current && document.visibilityState === 'visible') reload(); }, 5000);
    return () => window.clearInterval(t);
  }, [reload]);

  /** Approve, then drop source images/OCR of forms that are now fully approved (data minimisation). */
  async function approve(ids: string[]) {
    await act(async () => {
      await setStatus(ids, 'approved');
      await purgeApprovedSources().catch(() => 0);
    });
  }

  async function wipeAll() {
    if (!window.confirm('למחוק את כל ההרצות, הרשומות וקבצי המקור? פעולה זו אינה הפיכה.')) return;
    await act(() => deleteAllData());
  }

  async function act(fn: () => Promise<unknown>) {
    busyRef.current = true;
    try { await fn(); await reload(); } catch (e: any) { alertError(e); } finally { busyRef.current = false; }
  }
  function alertError(e: any) { setErr(e?.message ?? 'הפעולה נכשלה'); }

  // ---- filtering
  const visible = useMemo(() => {
    const needle = q.trim().replace(/\s+/g, '');
    return forms
      .filter((f) => !sender || f.sender === sender)
      .map((f) => {
        const recs = f.records.filter((r) => {
          if (status === 'approved' && r.status !== 'approved') return false;
          if (status === 'pending' && r.status !== 'pending') return false;
          if (status === 'flagged' && !recFlagged(f, r)) return false;
          if (!needle) return true;
          const hay = [r.commitment_number, f.national_id, ...(f.central_numbers ?? []), f.first_name, f.last_name].join(' ').replace(/\s+/g, '');
          return hay.includes(needle);
        });
        return { ...f, records: recs };
      })
      .filter((f) => f.records.length > 0);
  }, [forms, q, sender, status]);

  const all = forms.flatMap((f) => f.records.map((r) => ({ f, r })));
  const approvedCount = all.filter((x) => x.r.status === 'approved').length;
  const flaggedCount = all.filter((x) => recFlagged(x.f, x.r)).length;
  const senderOptions = [...new Set(forms.map((f) => f.sender).filter(Boolean) as string[])].sort();

  // ---- hover crop
  function hover(el: HTMLElement | null, f: FormRow, field: FormField | 'commitment_number', value: string | null, meta?: Partial<FieldMeta>) {
    window.clearTimeout(hoverTimer.current);
    window.clearTimeout(hideTimer.current);
    // leave a moment to move the mouse onto the card (to open the full page)
    if (!el) { hideTimer.current = window.setTimeout(() => setCrop(null), 250); return; }
    if (field === 'sender') return;
    const cands = cropCandidates(field, value, meta, f.central_numbers);
    hoverTimer.current = window.setTimeout(() => {
      setCrop({ rect: el.getBoundingClientRect(), pageId: f.page_id, imagePath: f.page?.image_path ?? null, candidates: cands, label: LABEL[field], meta });
    }, 250);
  }

  // ---- edits (normalised the same way as the engine)
  async function saveForm(f: FormRow, field: FormField, raw: string) {
    let value: string | string[] | null = raw || null;
    if (field === 'national_id') value = normalizeNationalId(raw);
    if (field === 'central_numbers') value = raw.split(/[,\s]+/).map((x) => normalizeCentral(x).value).filter(Boolean) as string[];
    if (field === 'received_date') {
      if (!raw) value = null;
      else {
        const d = normalizeDate(raw);
        if (!d.iso) { setErr(`תאריך לא תקין: ${raw}`); return; }
        value = d.iso;
      }
    }
    await act(() => updateFormField(f, field, value));
  }
  async function saveCommit(r: RecordRow, raw: string) {
    await act(() => updateCommitment(r, normalizeCommitment(raw).value));
  }

  async function purge() {
    if (!window.confirm('למחוק את תמונות המקור ואת טקסט ה-OCR של כל הטפסים שאושרו במלואם? הרשומות עצמן נשמרות.')) return;
    await act(async () => {
      const n = await purgeApprovedSources();
      window.alert(`נמחקו ${n} תמונות מקור.`);
    });
  }

  function exportAs(kind: 'xlsx' | 'csv' | 'json') {
    setExportOpen(false);
    if (kind === 'xlsx') exportXlsx(visible).catch(alertError);
    if (kind === 'csv') exportCsv(visible);
    if (kind === 'json') exportJson(visible);
  }

  const cellMeta = (f: FormRow, k: FormField) => f.field_meta?.[k];

  return (
    <main className="page">
      <div className="stats">
        <div className="stat"><span>רשומות</span><strong>{all.length}</strong></div>
        <div className="stat"><span>אושרו</span><strong className="ok-text">{approvedCount}</strong></div>
        <div className="stat"><span>ממתינות</span><strong>{all.length - approvedCount}</strong></div>
        <div className="stat warn"><span>רשומות לבדיקה</span><strong>{flaggedCount}</strong></div>
      </div>

      <div className="toolbar">
        <div className="field grow">
          <label htmlFor="q">חיפוש</label>
          <input id="q" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="ת.ז., מספר מרכזי, מספר התחייבות או שם" />
        </div>
        <div className="field">
          <label htmlFor="sender">גורם שולח</label>
          <select id="sender" value={sender} onChange={(e) => setSender(e.target.value)}>
            <option value="">הכול</option>
            {senderOptions.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="pills" role="group" aria-label="סטטוס">
          {([['all', 'הכול'], ['flagged', 'לבדיקה'], ['pending', 'ממתין'], ['approved', 'אושר']] as const).map(([k, l]) => (
            <button key={k} type="button" className={status === k ? 'pill-btn on' : 'pill-btn'} aria-pressed={status === k} onClick={() => setStatusF(k)}>{l}</button>
          ))}
        </div>
        <div className="toolbar-end">
          <div className="menu-wrap">
            <button type="button" className="btn" onClick={() => setExportOpen((o) => !o)} aria-expanded={exportOpen}>ייצוא</button>
            {exportOpen && (
              <div className="menu" role="menu">
                <button type="button" role="menuitem" onClick={() => exportAs('xlsx')}>Excel (.xlsx)</button>
                <button type="button" role="menuitem" onClick={() => exportAs('csv')}>CSV</button>
                <button type="button" role="menuitem" onClick={() => exportAs('json')}>JSON (מבנה ה-API)</button>
                <div className="menu-note">מייצא את השורות שבסינון הנוכחי</div>
              </div>
            )}
          </div>
          <button type="button" className="btn ghost" onClick={purge} title="מחיקת קבצי מקור של טפסים שאושרו">מחיקת מקורות</button>
          <button type="button" className="btn ghost" onClick={wipeAll} title="מחיקת כל הנתונים (לבדיקות ולפני הדגמה)">ניקוי מלא</button>
        </div>
      </div>

      {err && <div className="error" role="alert">{err} <button type="button" className="link-btn" onClick={() => setErr(null)}>סגירה</button></div>}

      <div className="table-box">
        <div className="grid head">
          <div>מספר התחייבות</div><div>שם פרטי</div><div>שם משפחה</div><div>ת.ז.</div><div>גורם שולח</div>
          <div>מספר מרכזי</div><div>תאריך קבלה</div><div>סטטוס</div><div />
        </div>

        {loading && <div className="empty-msg">טוען…</div>}
        {!loading && visible.length === 0 && <div className="empty-msg">אין רשומות להצגה.</div>}

        {visible.map((f) => {
          const pending = f.records.filter((r) => r.status === 'pending').map((r) => r.id);
          return (
            <section key={f.id} className="group" aria-label={`טופס ${f.sender ?? ''}`}>
              <div className="group-head">
                <div className="group-title">
                  <strong>{f.sender ?? 'גורם שולח לא זוהה'}</strong>
                  {f.form_type && <span className="tag">{f.form_type}</span>}
                  <span className="muted">{f.page?.batch?.file_name} · עמוד {f.page?.page_no}{f.extra_page_ids?.length ? ` (+${f.extra_page_ids.length})` : ''}</span>
                  {f.warnings?.length > 0 && (
                    <button type="button" className="link-btn warn-text" onClick={() => setOpenWarn((o) => ({ ...o, [f.id]: !o[f.id] }))} aria-expanded={!!openWarn[f.id]}>
                      אזהרות ({f.warnings.length})
                    </button>
                  )}
                </div>
                <div className="group-actions">
                  <button type="button" className="btn small ghost" onClick={() => act(() => addCommitment(f.id))}>הוספת התחייבות</button>
                  {pending.length > 0 && <button type="button" className="btn small outline" onClick={() => approve(pending)}>אישור הטופס</button>}
                </div>
              </div>
              {openWarn[f.id] && <ul className="warnings">{f.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}

              {f.records.map((r) => {
                const ok = r.status === 'approved';
                const mk = (k: FormField, display: string, edit: string, kind: 'text' | 'date' | 'list' | 'select', ltr = false) => {
                  const m = cellMeta(f, k);
                  return (
                    <EditableCell
                      display={display} editValue={edit} kind={kind} ltr={ltr}
                      options={kind === 'select' ? senders : undefined}
                      flagged={!!m?.flagged} approved={ok}
                      suggestion={m?.suggestion}
                      title={m?.suggestion ? `הצעה מכתב יד: ${m.suggestion} — לחצי כדי לאשר או לתקן` : m?.reasons?.join(' · ')}
                      onSave={(v) => saveForm(f, k, v)}
                      onHover={(el) => hover(el, f, k, k === 'received_date' ? f.received_date : (display || null), m)}
                    />
                  );
                };
                return (
                  <div key={r.id} className={ok ? 'grid row approved' : 'grid row'}>
                    <EditableCell
                      display={r.commitment_number ?? ''} editValue={r.commitment_number ?? ''} kind="text" ltr
                      flagged={!!r.commitment_meta?.flagged} approved={ok}
                      title={r.commitment_meta?.reasons?.join(' · ')}
                      onSave={(v) => saveCommit(r, v)}
                      onHover={(el) => hover(el, f, 'commitment_number', r.commitment_number, r.commitment_meta)}
                    />
                    {mk('first_name', f.first_name ?? '', f.first_name ?? '', 'text')}
                    {mk('last_name', f.last_name ?? '', f.last_name ?? '', 'text')}
                    {mk('national_id', f.national_id ?? '', f.national_id ?? '', 'text', true)}
                    {mk('sender', f.sender ?? '', f.sender ?? '', 'select')}
                    {mk('central_numbers', (f.central_numbers ?? []).join(', '), (f.central_numbers ?? []).join(', '), 'list', true)}
                    {mk('received_date', isoToDisplay(f.received_date), isoToDisplay(f.received_date), 'date', true)}
                    <div className="status-cell"><span className={ok ? 'pill ok' : 'pill'}>{ok ? 'אושר' : 'ממתין'}</span></div>
                    <div className="actions-cell">
                      {ok ? (
                        <button type="button" className="btn small ghost" onClick={() => act(() => setStatus([r.id], 'pending'))}>ביטול אישור</button>
                      ) : (
                        <>
                          <button type="button" className="btn small primary" onClick={() => approve([r.id])}>אישור</button>
                          <button type="button" className="icon-btn" aria-label="מחיקת שורה" title="מחיקת שורה"
                            onClick={() => window.confirm('למחוק את השורה?') && act(() => deleteRecord(r.id))}>
                            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="M6 7l1 13h10l1-13" /><path d="M9 7V4h6v3" /></svg>
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </section>
          );
        })}
      </div>

      {crop && (
        <CropPreview
          target={crop}
          onEnter={() => window.clearTimeout(hideTimer.current)}
          onLeave={() => { hideTimer.current = window.setTimeout(() => setCrop(null), 200); }}
          onOpen={(box) => { setViewer({ pageId: crop.pageId, imagePath: crop.imagePath, box, label: crop.label }); setCrop(null); }}
        />
      )}
      {viewer && <PageViewer target={viewer} onClose={() => setViewer(null)} />}
    </main>
  );
}
