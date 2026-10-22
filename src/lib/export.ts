// Export the rows currently on screen: Excel, CSV (UTF-8 BOM for Hebrew in Excel), JSON.

import type { FormRow, FormField } from './data.ts';
import { isoToDisplay } from '@engine/normalize.ts';

export interface ExportRow {
  commitment_number: string;
  first_name: string;
  last_name: string;
  national_id: string;
  sender: string;
  central_numbers: string;
  received_date: string;
  status: string;
  flagged_fields: string;
  source: string;
}

const HEADERS: Record<keyof ExportRow, string> = {
  commitment_number: 'מספר התחייבות',
  first_name: 'שם פרטי',
  last_name: 'שם משפחה',
  national_id: 'ת.ז.',
  sender: 'גורם שולח',
  central_numbers: 'מספר מרכזי',
  received_date: 'תאריך קבלה',
  status: 'סטטוס',
  flagged_fields: 'שדות לבדיקה',
  source: 'קובץ מקור ועמוד',
};

const FIELD_HE: Record<FormField | 'commitment_number', string> = {
  first_name: 'שם פרטי', last_name: 'שם משפחה', national_id: 'ת.ז.', sender: 'גורם שולח',
  central_numbers: 'מספר מרכזי', received_date: 'תאריך קבלה', commitment_number: 'מספר התחייבות',
};

export function toRows(forms: FormRow[]): ExportRow[] {
  const rows: ExportRow[] = [];
  for (const f of forms) {
    for (const r of f.records) {
      const flagged: string[] = [];
      if (r.status !== 'approved') {
        for (const [k, m] of Object.entries(f.field_meta)) if (m?.flagged) flagged.push(FIELD_HE[k as FormField]);
        if (r.commitment_meta?.flagged) flagged.push(FIELD_HE.commitment_number);
      }
      rows.push({
        commitment_number: r.commitment_number ?? '',
        first_name: f.first_name ?? '',
        last_name: f.last_name ?? '',
        national_id: f.national_id ?? '',
        sender: f.sender ?? '',
        central_numbers: (f.central_numbers ?? []).join(', '),
        received_date: isoToDisplay(f.received_date),
        status: r.status === 'approved' ? 'אושר' : 'ממתין',
        flagged_fields: flagged.join(', '),
        source: `${f.page?.batch?.file_name ?? ''} · עמוד ${f.page?.page_no ?? ''}`,
      });
    }
  }
  return rows;
}

function stamp() {
  return new Date().toISOString().slice(0, 10);
}

function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export function exportCsv(forms: FormRow[]) {
  const rows = toRows(forms);
  const keys = Object.keys(HEADERS) as (keyof ExportRow)[];
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [keys.map((k) => HEADERS[k]).join(','), ...rows.map((r) => keys.map((k) => esc(r[k])).join(','))];
  download(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), `התחייבויות_${stamp()}.csv`);
}

/** Same shape the future lab API would receive. */
export function exportJson(forms: FormRow[]) {
  const records = forms.flatMap((f) => f.records.map((r) => ({
    commitment_number: r.commitment_number,
    first_name: f.first_name,
    last_name: f.last_name,
    national_id: f.national_id,
    sender: f.sender,
    central_numbers: f.central_numbers,
    received_date: f.received_date,
    status: r.status,
    approved_at: r.approved_at,
    source: { file: f.page?.batch?.file_name ?? null, page: f.page?.page_no ?? null },
  })));
  download(new Blob([JSON.stringify({ exported_at: new Date().toISOString(), records }, null, 2)], { type: 'application/json' }), `התחייבויות_${stamp()}.json`);
}

export async function exportXlsx(forms: FormRow[]) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('התחייבויות', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
  const keys = Object.keys(HEADERS) as (keyof ExportRow)[];
  ws.columns = keys.map((k) => ({ header: HEADERS[k], key: k, width: Math.max(12, HEADERS[k].length + 4), style: { numFmt: '@' } }));
  ws.getRow(1).font = { bold: true };
  for (const r of toRows(forms)) {
    const row = ws.addRow(r);
    if (r.flagged_fields) {
      row.getCell('flagged_fields').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE3C2' } };
    }
  }
  ws.columns.forEach((c) => {
    let max = 10;
    c.eachCell?.({ includeEmpty: false }, (cell) => { max = Math.max(max, String(cell.value ?? '').length + 2); });
    c.width = Math.min(48, max);
  });
  const buf = await wb.xlsx.writeBuffer();
  download(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `התחייבויות_${stamp()}.xlsx`);
}
