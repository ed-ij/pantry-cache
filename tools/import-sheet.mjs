/**
 * Imports the hand-kept "Veg in stores" spreadsheet into Pantry Cache.
 *
 *   node tools/import-sheet.mjs "~/Documents/Veg in stores JUlY 2026.xlsx"
 *
 * The original is laid out as one column per store-and-year, one row per bag,
 * with the item name only on the first row of each block and running totals
 * mixed in as formulas. This reads it back into one row per bag, works out
 * whether each cell is a weight or a count, and writes:
 *
 *   dev/data.json        the local dev store, so the app can be checked
 *   dev/import/*.csv     ready to paste into the Google Sheet tabs
 *
 * Nothing here is destructive: the source file is only ever read.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { exportCsv } from './export-csv.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ config */

/** The sheet records a year per column but never a month. */
const MONTH_DAY = '07-01';

/** Column header (row 2) -> store name used in the app. */
/**
 * Chosen to stay clear of the accent blue and warm orange the interface uses
 * everywhere, to stay apart from each other under red-green colour blindness,
 * and to read on white. The dark theme lightens them automatically.
 */
const STORES = [
  { Name: 'Porch', Where: 'Chest store', Colour: '#5F8A20' },
  { Name: 'Utility', Where: 'Upright store', Colour: '#7A3FA2' },
  { Name: 'Shed', Where: 'Shed store', Colour: '#B53464' },
];

/**
 * Column E carries no year or store header of its own, but the sheet's own
 * grand total (D25 = D24 + E24) adds it to the 2026 Shed column, so it is
 * treated as an overflow of that column.
 */
const COLUMNS = {
  B: { store: 'Porch', year: 2025 },
  C: { store: 'Utility', year: 2025 },
  D: { store: 'Shed', year: 2026 },
  E: { store: 'Shed', year: 2026 },
};

const CATEGORIES = {
  Fruit: [
    'Redcurrants', 'Tayberries', 'Blackcurrants', 'Raspberries', 'Mulberries',
    'Gooseberries', 'Sloes', 'Blackberries', 'Figs', 'Cherry plums (cooked)',
    'Pears in syrup', 'Seville oranges', 'Quince bombs',
  ],
  Vegetables: [
    'Broad beans', 'Green beans', 'Runners', 'Sweetcorn', 'Spinach',
    'Chopped red onion', 'Cherry tomatoes', 'Roast pumpkin pieces',
  ],
  Prepared: [
    'Blackcurrant puree', 'Tayberry puree', 'Chickpea & butternut soup',
    'Turkey stock', 'Chicken stock', 'Pumpkin and lentil',
    'Blackbean and pumpkin casserole', 'Pumpkin & tomato', 'Pizza dough',
    'Breadcrumbs', 'Chestnut stuffing', 'Ratatouille', 'Tomato sauce with basil',
    'Chocolate cake aubergine mix', 'Crumble',
  ],
  'Meat & fish': ['Chicken liver', 'Cold turkey', 'Boned stuffed chicken', 'Faggots'],
};

/** Obvious slips in the original, corrected on the way in. */
const RENAME = {
  'breaccrumbs': 'Breadcrumbs',
  'chestunt stuffing': 'Chestnut stuffing',
  'black currant puree': 'Blackcurrant puree',
  'chickpea & butternut soup': 'Chickpea & butternut soup',
  'tom sauce with basil': 'Tomato sauce with basil',
  'green beans': 'Green beans',
  'crumble?': 'Crumble',
  'turkey stock': 'Turkey stock',
  'chicken stock': 'Chicken stock',
  'pumpkin and lentil': 'Pumpkin and lentil',
  'cold turkey': 'Cold turkey',
  'boned stuffed chicken': 'Boned stuffed chicken',
  'seville oranges': 'Seville oranges',
  'cherry tomatoes': 'Cherry tomatoes',
  'chicken liver': 'Chicken liver',
};

/* -------------------------------------------------------------- zip + xml */

/** Minimal reader for the stored/deflated members of a .xlsx (a zip file). */
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip file (no end-of-central-directory record).');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const files = {};

  for (let n = 0; n < count; n++) {
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);

    const start = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    const raw = buf.subarray(start, start + compSize);
    files[name] = method === 0 ? raw : inflateRawSync(raw);

    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const unesc = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
  .replace(/&amp;/g, '&');

function colNumber(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/** Reads the first worksheet into { "B12": { value, formula } }. */
function readSheet(files) {
  const strings = [];
  const ss = files['xl/sharedStrings.xml'];
  if (ss) {
    for (const [, si] of String(ss).matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      strings.push(unesc([...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join('')));
    }
  }

  const xml = String(files['xl/worksheets/sheet1.xml']);
  const cells = {};
  const cellRe = /<c r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;

  for (const m of xml.matchAll(cellRe)) {
    const [, col, row, attrs, body = ''] = m;
    const formula = (body.match(/<f[^>]*>([\s\S]*?)<\/f>/) || [])[1];
    const v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
    const inline = (body.match(/<is>([\s\S]*?)<\/is>/) || [])[1];

    let value = '';
    if (/t="s"/.test(attrs) && v !== undefined) value = strings[Number(v)] ?? '';
    else if (inline) value = unesc([...inline.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(''));
    else if (v !== undefined) value = unesc(v);

    if (String(value).trim() !== '' || formula) {
      cells[col + row] = { col, row: Number(row), value: String(value).trim(), formula: formula ? unesc(formula) : null };
    }
  }
  return cells;
}

/* ------------------------------------------------------- reading the cells */

const warnings = [];

/**
 * Turns one cell into the bags it represents. The sheet mixes plain gram
 * weights with counts of things ("x 6"), volumes ("1 L x 2"), containers
 * ("8 blocks") and the odd sum of two pots ("295+333").
 */
function parseCell(text, where) {
  const t = String(text).trim().replace(/\s+/g, ' ');
  const bag = (o) => [{ weightG: 0, count: 0, unit: '', note: '', ...o }];

  // 295+333 — two pots recorded in one cell.
  if (/^\d+(\s*\+\s*\d+)+$/.test(t)) {
    return t.split('+').map((n) => ({ weightG: Number(n.trim()), count: 0, unit: '', note: '' }));
  }
  // 2 x 500g — several bags of the same weight.
  let m = t.match(/^(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*g$/i);
  if (m) return Array.from({ length: Number(m[1]) }, () => ({ weightG: Math.round(Number(m[2])), count: 0, unit: '', note: '' }));
  // 1 L x 2 — several containers of the same volume.
  m = t.match(/^(\d+(?:\.\d+)?)\s*(?:l|litres?)\s*x\s*(\d+)$/i);
  if (m) return Array.from({ length: Number(m[2]) }, () => ({ weightG: 0, count: Number(m[1]), unit: 'litres', note: '' }));
  // 1L, 1 litre
  m = t.match(/^(\d+(?:\.\d+)?)\s*(?:l|litres?)$/i);
  if (m) return bag({ count: Number(m[1]), unit: 'litres' });
  // x 6
  m = t.match(/^x\s*(\d+)$/i);
  if (m) return bag({ count: Number(m[1]), unit: 'pieces' });
  // 1 box, 2 bags, 8 blocks, 5 small pots
  m = t.match(/^(\d+)\s*(small\s+)?(box|boxes|bag|bags|block|blocks|pot|pots|jar|jars)$/i);
  if (m) {
    const PLURAL = { box: 'boxes', bag: 'bags', block: 'blocks', pot: 'pots', jar: 'jars' };
    const word = m[3].toLowerCase();
    return bag({
      count: Number(m[1]),
      unit: PLURAL[word] || word,
      note: m[2] ? 'small' : '',
    });
  }
  // 1small
  m = t.match(/^(\d+)\s*small$/i);
  if (m) return bag({ count: Number(m[1]), unit: 'pots', note: 'small' });
  // off cob 290g
  m = t.match(/^off cob\s*(\d+)\s*g$/i);
  if (m) return bag({ weightG: Number(m[1]), note: 'off the cob' });
  // 231g, 749 g, 442
  m = t.match(/^(\d+(?:\.\d+)?)\s*g?$/i);
  if (m) {
    const n = Number(m[1]);
    // Nothing in a store weighs under 20 g, so a small bare number is a count.
    return n >= 20 ? bag({ weightG: Math.round(n) }) : bag({ count: n, unit: 'pieces' });
  }

  warnings.push(`${where}: could not read "${t}" — imported as 1 item with the original text kept as a note`);
  return bag({ count: 1, unit: 'pieces', note: t });
}

/* ------------------------------------------------------------------- main */

const source = process.argv[2] || join(process.env.HOME, 'Documents', 'Veg in stores JUlY 2026.xlsx');
const cells = readSheet(unzip(readFileSync(source)));

const maxRow = Math.max(...Object.values(cells).map((c) => c.row));
const titleOf = (raw) => {
  const key = String(raw).trim().replace(/\s+/g, ' ').toLowerCase();
  if (RENAME[key]) return RENAME[key];
  const s = String(raw).trim().replace(/\s+/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
};

const categoryOf = (name) => {
  for (const [cat, names] of Object.entries(CATEGORIES)) {
    if (names.some((n) => n.toLowerCase() === name.toLowerCase())) return cat;
  }
  warnings.push(`No category set for "${name}" — filed under Other`);
  return 'Other';
};

let seq = 0;
const newId = () => 'L' + (Date.now() + seq++ * 37).toString(36).toUpperCase();

const inventory = [];
const perCell = {}; // ref -> grams imported, for reconciling against her totals
let current = '';
let skippedTotals = 0;

for (let row = 3; row <= maxRow; row++) {
  const name = cells['A' + row];
  if (name && name.value) current = titleOf(name.value);
  if (!current) continue;

  for (const [col, meta] of Object.entries(COLUMNS)) {
    const cell = cells[col + row];
    if (!cell || cell.value === '') continue;

    // Her running totals are formulas. A literal sum such as =629+621+506 is
    // three separate jars, so that one is expanded rather than skipped.
    if (cell.formula) {
      if (/^[\d+\s.]+$/.test(cell.formula) && cell.formula.includes('+')) {
        for (const part of cell.formula.split('+')) {
          inventory.push({ item: current, col, row, ...parseCell(part.trim(), col + row)[0] });
        }
      } else {
        skippedTotals++;
      }
      continue;
    }

    const bags = parseCell(cell.value, col + row);
    perCell[col + row] = bags.reduce((t, b) => t + b.weightG, 0);
    for (const b of bags) inventory.push({ item: current, col, row, ...b });
  }
}

/* --- reconcile against the totals she had already worked out in the sheet --- */

const checks = [];
for (const [ref, cell] of Object.entries(cells)) {
  const m = cell.formula && cell.formula.match(/^SUM\(([A-Z]+)(\d+):([A-Z]+)(\d+)\)$/);
  if (!m) continue;
  let mine = 0;
  for (let r = Number(m[2]); r <= Number(m[4]); r++) {
    for (let c = colNumber(m[1]); c <= colNumber(m[3]); c++) {
      mine += perCell[String.fromCharCode(64 + c) + r] || 0;
    }
  }
  checks.push({ ref, formula: cell.formula, hers: Number(cell.value), mine, ok: Math.round(mine) === Math.round(Number(cell.value)) });
}

/* ------------------------------------------------------------ build tables */

const Inventory = inventory.map((b) => ({
  ID: newId(),
  Item: b.item,
  Category: categoryOf(b.item),
  Store: COLUMNS[b.col].store,
  'Weight (g)': b.weightG || '',
  'Date In': `${COLUMNS[b.col].year}-${MONTH_DAY}`,
  Note: b.note || '',
  Count: b.count || '',
  Unit: b.unit || '',
}));

const byItem = new Map();
for (const row of Inventory) {
  if (!byItem.has(row.Item)) byItem.set(row.Item, []);
  byItem.get(row.Item).push(row);
}

const commonest = (list) => {
  const tally = new Map();
  for (const v of list) if (v) tally.set(v, (tally.get(v) || 0) + 1);
  return [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
};

const Items = [...byItem.entries()].map(([item, rows]) => ({
  Item: item,
  Category: rows[0].Category,
  'Typical weight (g)': (() => {
    const weights = rows.map((r) => r['Weight (g)']).filter(Boolean);
    if (!weights.length) return '';
    return Math.round(weights.reduce((t, w) => t + w, 0) / weights.length);
  })(),
  'Typical count': commonest(rows.map((r) => r.Count)) || '',
  Unit: commonest(rows.map((r) => r.Unit)) || '',
}));

/* --------------------------------------------------------------- write out */

const data = { Stores: STORES, Items, Inventory, History: [] };
const dataPath = join(ROOT, 'dev', 'data.json');

// Re-importing throws away anything added in the app since the last import,
// so say so rather than doing it quietly.
if (existsSync(dataPath) && !process.argv.includes('--force')) {
  console.error(
    `\n${dataPath} already exists.\n` +
    'Overwriting it would discard anything added or taken out in the app since\n' +
    'the last import. Re-run with --force if that is what you want, or run\n' +
    '"npm run export" to write the CSVs from the store as it stands.\n',
  );
  process.exit(1);
}

writeFileSync(dataPath, JSON.stringify(data, null, 2));
exportCsv(data);

/* ------------------------------------------------------------------ report */

const weighed = Inventory.filter((r) => r['Weight (g)']);
const counted = Inventory.filter((r) => r.Count);
const totalKg = weighed.reduce((t, r) => t + r['Weight (g)'], 0) / 1000;

console.log(`Read ${source}`);
console.log(`  ${Inventory.length} bags across ${byItem.size} items, ${skippedTotals} total-row formulas skipped`);
console.log(`  ${weighed.length} weighed (${totalKg.toFixed(2)} kg), ${counted.length} counted\n`);

for (const f of STORES.map((x) => x.Name)) {
  const rows = Inventory.filter((r) => r.Store === f);
  const kg = rows.reduce((t, r) => t + (r['Weight (g)'] || 0), 0) / 1000;
  console.log(`  ${f.padEnd(8)} ${String(rows.length).padStart(3)} bags  ${kg.toFixed(2)} kg`);
}

console.log(`\nReconciled against the ${checks.length} SUM totals already in the sheet:`);
for (const c of checks) {
  console.log(`  ${c.ok ? 'ok  ' : 'DIFF'} ${c.ref} =${c.formula}  hers ${c.hers}  imported ${c.mine}`);
}

if (warnings.length) {
  console.log('\nNeeded a judgement call:');
  for (const w of warnings) console.log(`  - ${w}`);
}

console.log('\nWrote dev/data.json and dev/import/{Stores,Items,Inventory}.csv');
