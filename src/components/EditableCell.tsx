import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

export type CellKind = 'text' | 'date' | 'list' | 'select';

interface Props {
  display: string;
  /** Raw value placed in the editor. */
  editValue: string;
  kind: CellKind;
  options?: string[];
  flagged: boolean;
  approved: boolean;
  title?: string;
  onSave: (v: string) => Promise<void> | void;
  onHover?: (el: HTMLElement | null) => void;
  ltr?: boolean;
  /** Unconfirmed reading shown as a hint; the field stays empty until accepted. */
  suggestion?: string;
}

export default function EditableCell({ display, editValue, kind, options, flagged, approved, title, onSave, onHover, ltr, suggestion }: Props) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(editValue);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLInputElement & HTMLSelectElement>(null);

  const startValue = editValue || (!display && suggestion ? suggestion : '');
  useEffect(() => { if (!editing) setV(startValue); }, [startValue, editing]);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);

  /**
   * confirm = the reviewer pressed Enter. A flagged (orange) cell that she confirms is
   * saved even when the value did not change — saving clears the flag, so it turns white,
   * exactly like accepting a suggestion. Leaving the cell without Enter changes nothing.
   */
  async function commit(confirm = false) {
    const unchanged = v.trim() === editValue.trim();
    const acceptingSuggestion = Boolean(suggestion && !display && v.trim());
    const confirmingFlag = confirm && flagged && !approved && Boolean(v.trim());
    if (unchanged && !acceptingSuggestion && !confirmingFlag) { setEditing(false); return; }
    setSaving(true);
    try { await onSave(v.trim()); setEditing(false); } finally { setSaving(false); }
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    if (e.key === 'Escape') { setV(startValue); setEditing(false); }
  }

  if (editing) {
    return kind === 'select' ? (
      <select ref={ref} className="cell-input" value={v} disabled={saving} onChange={(e) => setV(e.target.value)} onBlur={() => commit()} onKeyDown={onKey}>
        <option value="">— בחרי —</option>
        {(options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    ) : (
      <input
        ref={ref}
        className="cell-input"
        dir={ltr ? 'ltr' : undefined}
        value={v}
        disabled={saving}
        placeholder={kind === 'date' ? 'DD/MM/YYYY' : kind === 'list' ? 'מופרדים בפסיק' : ''}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => commit()}
        onKeyDown={onKey}
      />
    );
  }

  const cls = ['cell', flagged && !approved ? 'flag' : '', !display ? 'empty' : ''].join(' ');
  return (
    <button
      type="button"
      className={cls}
      title={flagged && !approved && display ? `${title ? title + ' · ' : ''}לאישור: לחיצה ואז Enter` : title}
      disabled={approved}
      onClick={() => setEditing(true)}
      onMouseEnter={(e) => onHover?.(e.currentTarget)}
      onMouseLeave={() => onHover?.(null)}
      onFocus={(e) => onHover?.(e.currentTarget)}
      onBlur={() => onHover?.(null)}
      dir={ltr ? 'ltr' : undefined}
    >
      {display || (suggestion ? <span className="suggest">הצעה: {suggestion}</span> : 'חסר')}
    </button>
  );
}
