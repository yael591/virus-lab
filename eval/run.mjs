#!/usr/bin/env node
// Accuracy report: compare the app's JSON export with a hand-made truth table.
// Usage: node eval/run.mjs eval/truth.json path/to/export.json
// Truth rows are matched to exported rows by (file, page, commitment_number);
// a truth row with no match counts as wrong on every field.

import { readFileSync } from 'node:fs';

const [truthPath, exportPath] = process.argv.slice(2);
if (!truthPath || !exportPath) {
  console.error('usage: node eval/run.mjs <truth.json> <export.json>');
  process.exit(1);
}
const truth = JSON.parse(readFileSync(truthPath, 'utf8'));
const exp = JSON.parse(readFileSync(exportPath, 'utf8')).records ?? [];

const FIELDS = ['commitment_number', 'first_name', 'last_name', 'national_id', 'sender', 'central_numbers', 'received_date'];
const norm = (f, v) => {
  if (v == null) return '';
  if (f === 'central_numbers') return [...(Array.isArray(v) ? v : String(v).split(/[,\s]+/))].map(String).filter(Boolean).sort().join(',');
  if (f === 'national_id') return String(v).replace(/\D/g, '').replace(/^0+/, '');
  return String(v).replace(/["'״׳\s]/g, '').toUpperCase();
};

const byKey = new Map();
for (const r of exp) byKey.set(`${r.source?.file}|${r.source?.page}|${norm('commitment_number', r.commitment_number)}`, r);
const byPage = new Map();
for (const r of exp) {
  const k = `${r.source?.file}|${r.source?.page}`;
  if (!byPage.has(k)) byPage.set(k, []);
  byPage.get(k).push(r);
}

const tally = Object.fromEntries(FIELDS.map((f) => [f, { ok: 0, n: 0 }]));
const bySender = {};
const misses = [];

for (const t of truth) {
  const key = `${t.file}|${t.page}|${norm('commitment_number', t.commitment_number)}`;
  // fall back to the only row of that page when the commitment number itself was misread
  const pageRows = byPage.get(`${t.file}|${t.page}`) ?? [];
  const got = byKey.get(key) ?? (pageRows.length === 1 ? pageRows[0] : null);
  const s = (bySender[t.sender] ??= { ok: 0, n: 0 });
  for (const f of FIELDS) {
    const ok = !!got && norm(f, got[f]) === norm(f, t[f]);
    tally[f].n++; s.n++;
    if (ok) { tally[f].ok++; s.ok++; }
    else misses.push(`${t.file} p${t.page} · ${f}: expected "${t[f] ?? ''}" got "${got ? (got[f] ?? '') : '(no row)'}"`);
  }
}

const pct = (o) => (o.n ? `${Math.round((o.ok / o.n) * 100)}%` : '-');
console.log('\nAccuracy by field');
for (const f of FIELDS) console.log(`  ${f.padEnd(18)} ${pct(tally[f]).padStart(5)}  (${tally[f].ok}/${tally[f].n})`);
const tot = Object.values(tally).reduce((a, b) => ({ ok: a.ok + b.ok, n: a.n + b.n }), { ok: 0, n: 0 });
console.log(`  ${'ALL FIELDS'.padEnd(18)} ${pct(tot).padStart(5)}  (${tot.ok}/${tot.n})`);
console.log('\nAccuracy by sender');
for (const [k, v] of Object.entries(bySender)) console.log(`  ${k.padEnd(22)} ${pct(v).padStart(5)}`);
console.log(`\nRows in truth: ${truth.length} · rows exported: ${exp.length}`);
if (misses.length) {
  console.log('\nMisses');
  for (const m of misses) console.log('  ' + m);
}
