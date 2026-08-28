/**
 * Writes the current dev store out as one CSV per Google Sheet tab.
 *
 *   npm run export
 *
 * Run this after adding or taking things out in the local app, so the CSVs
 * ready for the real spreadsheet match what you have just checked on screen.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Column order per tab, matching TABLES in src/backend.js. */
const TABS = {
  Freezers: ['Name', 'Where', 'Colour'],
  Items: ['Item', 'Category', 'Typical weight (g)', 'Typical count', 'Unit'],
  Inventory: ['ID', 'Item', 'Category', 'Freezer', 'Weight (g)', 'Date In', 'Note', 'Count', 'Unit'],
  History: ['ID', 'Item', 'Category', 'Freezer', 'Weight (g)', 'Date In', 'Date Out', 'Note', 'Count', 'Unit'],
};

function toCsv(headers, rows) {
  const cell = (v) => {
    const s = v === undefined || v === null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...rows.map((r) => headers.map((h) => cell(r[h])).join(','))].join('\n') + '\n';
}

export function exportCsv(store, outDir = join(ROOT, 'dev', 'import')) {
  mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const [tab, headers] of Object.entries(TABS)) {
    const rows = store[tab] || [];
    writeFileSync(join(outDir, `${tab}.csv`), toCsv(headers, rows));
    written.push({ tab, rows: rows.length });
  }
  return written;
}

/* Run directly: read the dev store and write the CSVs beside it. */
if (process.argv[1] && process.argv[1].endsWith('export-csv.mjs')) {
  const dataPath = join(ROOT, 'dev', 'data.json');
  let store;
  try {
    store = JSON.parse(readFileSync(dataPath, 'utf8'));
  } catch {
    console.error(`No dev store at ${dataPath}. Start the app with "npm run dev" first.`);
    process.exit(1);
  }

  const written = exportCsv(store);
  console.log('Wrote dev/import/');
  for (const { tab, rows } of written) {
    console.log(`  ${tab.padEnd(10)} ${String(rows).padStart(4)} rows`);
  }

  const inv = store.Inventory || [];
  const kg = inv.reduce((t, r) => t + (Number(r['Weight (g)']) || 0), 0) / 1000;
  const items = new Set(inv.map((r) => r.Item)).size;
  console.log(`\n  ${inv.length} bags, ${items} items, ${kg.toFixed(2)} kg in the freezers`);
}
