/**
 * Exercises apps-script/host.js against a fake Sheets API.
 *
 * dev/smoke.mjs tests src/backend.js against an object store, which cannot
 * reproduce the one bug that matters most here: the sheet is a *grid*, read by
 * column position, and constraint 1 invites the user to rearrange it. Insert a
 * column and every read used to shift by one, silently — and ensure() then
 * overwrote row 1 with what it expected, erasing the evidence.
 *
 * So this harness models cells and positions rather than objects, and moves the
 * columns about on purpose.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------- the fake grid */

const calls = { deleteRow: 0, deleteRows: 0 };

function makeSheet(name, grid) {
  const cells = grid.map((r) => r.slice());

  const at = (r, c) => {
    while (cells.length < r) cells.push([]);
    const row = cells[r - 1];
    while (row.length < c) row.push('');
    return row;
  };

  const sheet = {
    getName: () => name,
    getLastRow: () => {
      for (let i = cells.length; i > 0; i--) {
        if (cells[i - 1].some((v) => v !== '' && v !== undefined && v !== null)) return i;
      }
      return 0;
    },
    getLastColumn: () => cells.reduce((m, r) => {
      let last = 0;
      r.forEach((v, i) => { if (v !== '' && v !== undefined && v !== null) last = i + 1; });
      return Math.max(m, last);
    }, 0),
    getMaxRows: () => Math.max(cells.length, 1),
    setFrozenRows: () => sheet,
    autoResizeColumns: () => sheet,
    deleteRow: (r) => { calls.deleteRow++; cells.splice(r - 1, 1); },
    deleteRows: (r, n) => { calls.deleteRows++; cells.splice(r - 1, n); },
    /** The one method that matters: a rectangular window onto the grid. */
    getRange(row, col, numRows = 1, numCols = 1) {
      return {
        getValues() {
          const out = [];
          for (let r = row; r < row + numRows; r++) {
            const line = at(r, col + numCols - 1);
            out.push(line.slice(col - 1, col - 1 + numCols).map((v) => (v === undefined ? '' : v)));
          }
          return out;
        },
        setValues(values) {
          values.forEach((line, i) => {
            const target = at(row + i, col + numCols - 1);
            line.forEach((v, j) => { target[col - 1 + j] = v; });
          });
          return this;
        },
        setValue(v) { at(row, col)[col - 1] = v; return this; },
        setNumberFormat: () => sheet.getRange(row, col, numRows, numCols),
        setFontWeight: () => sheet.getRange(row, col, numRows, numCols),
        setBackground: () => sheet.getRange(row, col, numRows, numCols),
      };
    },
    _cells: cells,
  };
  return sheet;
}

function makeSpreadsheet(sheets) {
  const byName = new Map(Object.entries(sheets).map(([n, g]) => [n, makeSheet(n, g)]));
  return {
    getSheetByName: (n) => byName.get(n) || null,
    insertSheet: (n) => { const sh = makeSheet(n, []); byName.set(n, sh); return sh; },
    getSheets: () => [...byName.values()],
    deleteSheet: (sh) => byName.delete(sh.getName()),
    getId: () => 'FAKE',
    getUrl: () => 'https://example.invalid/sheet',
    getSpreadsheetTimeZone: () => 'Europe/London',
    _sheets: byName,
  };
}

/* ------------------------------------------------------ the fake HtmlService */

/**
 * Strict on purpose.
 *
 * `HtmlService.XFrameOptionsMode.SAMEORIGIN` does not exist. The enum holds
 * ALLOWALL and DEFAULT and nothing else, so that expression was `undefined`,
 * `setXFrameOptionsMode(undefined)` threw "Argument cannot be null: mode", and
 * because it is doGet that throws, the app did not load at all — for everyone,
 * on the first request after the release.
 *
 * Nothing could have caught it: HtmlService was `{}` here and doGet was never
 * called. A lenient fake would not have helped either — it would have accepted
 * the undefined and gone green. So this one carries the real enum members and
 * refuses a missing argument the way Apps Script does.
 */
function makeHtmlService(files) {
  const need = (v, param) => {
    // Apps Script reports an undefined property as a null argument, which is
    // what sent us looking for a null we had never passed.
    if (v === undefined || v === null) throw new Error('Argument cannot be null: ' + param);
    return v;
  };

  const output = (content) => {
    const o = {
      _title: '', _meta: [], _xframe: undefined, _width: 0, _height: 0,
      getContent: () => content,
      setTitle(t) { o._title = need(t, 'title'); return o; },
      setWidth(w) { o._width = need(w, 'width'); return o; },
      setHeight(h) { o._height = need(h, 'height'); return o; },
      setXFrameOptionsMode(m) { o._xframe = need(m, 'mode'); return o; },
      addMetaTag(name, value) { o._meta.push([need(name, 'name'), need(value, 'content')]); return o; },
    };
    return o;
  };

  const read = (name) => {
    const f = files[need(name, 'filename')];
    if (f === undefined) throw new Error('No HTML file named ' + name);
    return f;
  };

  return {
    /* The real enum, whole. Adding to it would defeat the point of the test. */
    XFrameOptionsMode: { ALLOWALL: 'ALLOWALL', DEFAULT: 'DEFAULT' },
    createHtmlOutput: (html) => output(need(html, 'html')),
    createHtmlOutputFromFile: (name) => output(read(name)),
    createTemplateFromFile: (name) => ({
      /* evaluate() runs the scriptlets, which is the only thing include() is for. */
      evaluate: () => output(read(name).replace(
        /<\?!=\s*include\('([^']+)'\);?\s*\?>/g,
        (_, f) => read(f),
      )),
    }),
  };
}

/* --------------------------------------------------- the fake platform */

function load(spreadsheet, opts = {}) {
  const props = new Map();
  const cache = new Map();
  const dialogs = [];

  const globals = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => spreadsheet,
      getUi: () => {
        if (!opts.html) throw new Error('no UI in tests');
        return {
          showModalDialog: (out, title) => dialogs.push({ out, title }),
          alert: () => {},
          createMenu: function menu() {
            const m = { addItem: () => m, addToUi: () => {} };
            return m;
          },
        };
      },
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => props.set(k, v),
      }),
    },
    CacheService: {
      getScriptCache: () => ({
        put: (k, v) => cache.set(k, v),
        get: (k) => (cache.has(k) ? cache.get(k) : null),
        remove: (k) => cache.delete(k),
      }),
    },
    LockService: {
      getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }),
    },
    Utilities: {
      formatDate: (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    },
    ScriptApp: { getService: () => ({ isEnabled: () => false, getUrl: () => '' }) },
    UrlFetchApp: { fetch: () => { throw new Error('no network in tests'); } },
    HtmlService: opts.html ? makeHtmlService(opts.html) : {},
  };

  const host = readFileSync(join(ROOT, 'apps-script', 'host.js'), 'utf8');
  const backend = readFileSync(join(ROOT, 'src', 'backend.js'), 'utf8');
  const names = Object.keys(globals);

  const out = new Function(...names, `
    const BUILD = 'test'; const BUILD_COMMIT = 'test';
    const BUILD_BRANCH = 'test'; const RELEASE_BASE = '';
    ${host}
    ${backend}
    return { DB, TABLES, apiGetState, apiAdd, apiRemove, apiEditLot, apiUndo, toLot,
             doGet, include, onOpen, showSetup, showUpdate };
  `)(...names.map((n) => globals[n]));

  return Object.assign(out, { _dialogs: dialogs });
}

const INV = ['ID', 'Item', 'Category', 'Store', 'Weight (g)', 'Date In', 'Note', 'Count', 'Unit', 'Month only'];

/* ============================ 1. the columns are where they were ======= */
{
  const ss = makeSpreadsheet({
    Inventory: [INV, ['L1', 'Raspberries', 'Fruit', 'Kitchen', 500, '2026-07-01', 'top bed', '', '', '']],
    History: [], Items: [], Stores: [['Name', 'Where', 'Colour'], ['Kitchen', 'indoors', '#5F8A20']],
  });
  const B = load(ss);
  const rows = B.DB.getAll('Inventory');
  assert.equal(rows[0].Item, 'Raspberries');
  assert.equal(rows[0]['Weight (g)'], 500);
  assert.equal(rows[0].Note, 'top bed');
}

/* ============================ 2. a column inserted in the middle ======= */
{
  // She has added her own "Picked by" column at position 3. Every value after
  // it is now one place to the right of where TABLES says it is.
  const shifted = ['ID', 'Item', 'Picked by', 'Category', 'Store', 'Weight (g)', 'Date In', 'Note', 'Count', 'Unit', 'Month only'];
  const ss = makeSpreadsheet({
    Inventory: [shifted, ['L1', 'Raspberries', 'Mum', 'Fruit', 'Kitchen', 500, '2026-07-01', 'top bed', '', '', '']],
    History: [], Items: [], Stores: [['Name', 'Where', 'Colour'], ['Kitchen', 'indoors', '#5F8A20']],
  });
  const B = load(ss);

  const rows = B.DB.getAll('Inventory');
  assert.equal(rows[0].Category, 'Fruit', 'category is read from its real column, not position 3');
  assert.equal(rows[0]['Weight (g)'], 500, 'weight is not read out of the date column');
  assert.equal(rows[0].Note, 'top bed', 'note is not read as a count');
  assert.equal(rows[0]['Picked by'], 'Mum', 'her own column comes through untouched');

  const lot = B.apiGetState().inventory[0];
  assert.equal(lot.weightG, 500);
  assert.equal(lot.dateIn, '2026-07-01');

  // ...and ensure() must leave her column alone rather than "repairing" row 1.
  B.DB.ensure(true);
  const header = ss.getSheetByName('Inventory')._cells[0];
  assert.ok(header.includes('Picked by'), 'ensure() did not delete her column');
  assert.equal(header.indexOf('Picked by'), 2, 'ensure() did not move it');
  assert.equal(
    ss.getSheetByName('Inventory')._cells[1][2], 'Mum',
    'ensure() did not shift the values under it',
  );
}

/* ============================ 3. writing goes under the right header === */
{
  const shifted = ['ID', 'Item', 'Picked by', 'Category', 'Store', 'Weight (g)', 'Date In', 'Note', 'Count', 'Unit', 'Month only'];
  const ss = makeSpreadsheet({
    Inventory: [shifted],
    History: [], Items: [], Stores: [['Name', 'Where', 'Colour'], ['Kitchen', 'indoors', '#5F8A20']],
  });
  const B = load(ss);
  B.apiAdd({
    item: 'Damsons', category: 'Fruit', store: 'Kitchen',
    weightG: 750, qty: 1, dateIn: '2026-08-01', note: 'hedge',
  });
  const row = ss.getSheetByName('Inventory')._cells[1];
  const col = (h) => row[shifted.indexOf(h)];
  assert.equal(col('Item'), 'Damsons');
  assert.equal(col('Weight (g)'), 750, 'the weight landed under Weight (g)');
  assert.equal(col('Note'), 'hedge', 'the note landed under Note');
  assert.equal(col('Picked by'), '', 'her column was left blank, not overwritten');
}

/* ============================ 4. a missing column is appended ========== */
{
  // An older sheet, from before "Month only" existed. Constraint 9 says new
  // columns are appended, so every existing value must stay put.
  const older = ['ID', 'Item', 'Category', 'Store', 'Weight (g)', 'Date In', 'Note', 'Count', 'Unit'];
  const ss = makeSpreadsheet({
    Inventory: [older, ['L1', 'Peas', 'Vegetables', 'Kitchen', 400, '2026-07-01', '', '', '']],
    History: [], Items: [], Stores: [['Name', 'Where', 'Colour'], ['Kitchen', 'indoors', '#5F8A20']],
  });
  const B = load(ss);
  B.DB.ensure(true);
  const header = ss.getSheetByName('Inventory')._cells[0];
  assert.equal(header[header.length - 1], 'Month only', 'the new column went on the end');
  assert.equal(header.indexOf('Note'), 6, 'nothing before it moved');
  const rows = B.DB.getAll('Inventory');
  assert.equal(rows[0]['Weight (g)'], 400, 'the existing row still reads correctly');
  assert.equal(rows[0]['Month only'], '', 'blank means the day is exact');
  assert.equal(B.apiGetState().inventory[0].monthOnly, false);
}

/* ============================ 5. hand-typed values are read or refused = */
{
  const ss = makeSpreadsheet({
    Inventory: [INV,
      ['L1', 'Rhubarb', 'Fruit', 'Kitchen', '1.5kg', '3/9/25', '', '', '', ''],
      ['L2', 'Plums', 'Fruit', 'Kitchen', '2 x 500', '2025-13-45', '', '', '', ''],
    ],
    History: [], Items: [], Stores: [['Name', 'Where', 'Colour'], ['Kitchen', 'indoors', '#5F8A20']],
  });
  const B = load(ss);
  const st = B.apiGetState();
  const rhubarb = st.inventory.find((l) => l.id === 'L1');
  assert.equal(rhubarb.weightG, 1500, '"1.5kg" is 1500 g, not 2 g');
  assert.equal(rhubarb.dateIn, '2025-09-03', '"3/9/25" is 3 September, UK order');

  const plums = st.inventory.find((l) => l.id === 'L2');
  assert.equal(plums.weightG, 0, '"2 x 500" is refused rather than read as 2500');
  assert.equal(plums.dateIn, '', 'an impossible date is refused rather than rolled forward');
  assert.equal(st.problems.length, 2, 'both are reported to the screen');
  assert.ok(st.problems.some((p) => p.field === 'Weight (g)' && p.raw === '2 x 500'));
  assert.ok(st.problems.some((p) => p.field === 'Date In' && p.raw === '2025-13-45'));
}

/* ============================ 6. a bad store colour falls back ======= */
{
  const ss = makeSpreadsheet({
    Inventory: [INV], History: [], Items: [],
    // The hash left off — which the README invites by asking for hex codes.
    Stores: [['Name', 'Where', 'Colour'], ['Kitchen', 'indoors', '2f7fd0'], ['Shed', 'out back', '#B53464']],
  });
  const B = load(ss);
  const fz = B.apiGetState().stores;
  assert.ok(/^#[0-9a-f]{6}$/i.test(fz[0].colour), 'an invalid colour falls back to the palette');
  assert.equal(fz[1].colour, '#B53464', 'a valid one is kept');
}

/* ============================ 7. deletes go out in runs ================ */
{
  const rows = [INV];
  for (let i = 1; i <= 40; i++) {
    rows.push(['L' + i, 'Peas', 'Vegetables', 'Kitchen', 100, '2026-07-01', '', '', '', '']);
  }
  const ss = makeSpreadsheet({
    Inventory: rows, History: [], Items: [],
    Stores: [['Name', 'Where', 'Colour'], ['Kitchen', 'indoors', '#5F8A20']],
  });
  const B = load(ss);
  calls.deleteRow = 0;
  calls.deleteRows = 0;

  // 40 contiguous bags — the shape a multi-select take-out produces.
  B.apiRemove({ ids: rows.slice(1).map((r) => r[0]), dateOut: '2026-08-01' });

  assert.equal(B.DB.getAll('Inventory').length, 0, 'all forty are gone');
  assert.equal(B.DB.getAll('History').length, 40, 'and all forty are in History');
  assert.equal(calls.deleteRow, 0, 'no one-at-a-time deletes');
  assert.ok(calls.deleteRows <= 2, `40 contiguous rows in <=2 calls, got ${calls.deleteRows}`);
}

/* ============================ N. the entry points actually run ========= */
{
  // doGet, include and the two dialogs are the whole of what a browser and the
  // spreadsheet menu touch, and until this block none of them was ever called.
  // The files are the built ones, because those are what gets pasted into the
  // script editor — which also proves Index's scriptlets resolve to files that
  // exist.
  const names = { Index: 'Index.html', Css: 'Css.html', Js: 'Js.html', Setup: 'Setup.html', Update: 'Update.html' };
  const html = {};
  for (const [key, file] of Object.entries(names)) {
    try {
      html[key] = readFileSync(join(ROOT, 'dist', file), 'utf8');
    } catch {
      throw new Error(`dist/${file} is missing — run \`npm run build\` before \`npm test\`.`);
    }
  }

  const ss = makeSpreadsheet({
    Inventory: [INV], History: [], Items: [],
    Stores: [['Name', 'Where', 'Colour'], ['Kitchen', 'indoors', '#5F8A20']],
  });
  const B = load(ss, { html });

  const page = B.doGet();
  const body = page.getContent();

  assert.equal(page._xframe, 'DEFAULT',
    'DEFAULT is the mode that sets the restrictive header; ALLOWALL removes it, ' +
    'and anything else is not a member of the enum');
  assert.ok(page._title, 'the tab needs a name');
  assert.ok(page._meta.some(([n]) => n === 'viewport'), 'tablet-first, so a viewport tag');

  assert.ok(!/<\?!=/.test(body), 'every scriptlet resolved; a stray one ships as visible text');
  assert.ok(body.includes('<style>'), 'Css came through include()');
  assert.ok(body.includes('<script>'), 'Js came through include()');

  assert.ok(B.include('Css').includes('<style>'), 'include() returns a file whole');

  B.showSetup();
  B.showUpdate();
  assert.equal(B._dialogs.length, 2, 'both menu items opened a dialog');

  const setup = B._dialogs[0].out.getContent();
  assert.ok(!setup.includes('__BUILD__'), 'the build stamp was substituted, not left as a placeholder');
  assert.ok(!setup.includes('__APP_URL__'), 'the app URL was substituted too');

  B.onOpen();
}

console.log('All sheet-layout checks passed.');
