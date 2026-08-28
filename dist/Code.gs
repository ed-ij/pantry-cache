/// Built by build.mjs from apps-script/host.js + src/backend.js — do not edit here.

/**
 * Freezer Log — Google Apps Script host.
 *
 * Provides the `DB` adapter that src/backend.js expects, backed by the
 * spreadsheet this script is bound to, plus the web-app entry point.
 * Generated into Code.gs by build.mjs — edit the sources, not the build output.
 */

/** Bumped when the sheet layout changes, to force a one-off re-setup. */
const SETUP_VERSION = '2';

let SS_ = null;

function spreadsheet_() {
  if (SS_) return SS_;
  SS_ = SpreadsheetApp.getActiveSpreadsheet();
  if (!SS_) {
    const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
    if (!id) throw new Error('This script is not attached to a spreadsheet.');
    SS_ = SpreadsheetApp.openById(id);
  }
  return SS_;
}

/** Per-execution cache of sheet contents; cleared whenever we write. */
let CACHE_ = {};

const DB = {
  /**
   * Creates and formats the tabs. Formatting the sheet on every page load would
   * add a second or two to each visit, so once it has been done for this layout
   * version we only check the tabs still exist.
   */
  ensure: function (force) {
    const ss = spreadsheet_();
    const props = PropertiesService.getScriptProperties();
    const names = Object.keys(TABLES);
    const allPresent = names.every(function (n) { return !!ss.getSheetByName(n); });
    if (!force && allPresent && props.getProperty('SETUP_VERSION') === SETUP_VERSION) return;

    let created = false;

    names.forEach(function (name) {
      const headers = TABLES[name];
      let sh = ss.getSheetByName(name);
      if (!sh) {
        sh = ss.insertSheet(name);
        created = true;
      }
      const width = headers.length;
      const current = sh.getLastRow() > 0 ? sh.getRange(1, 1, 1, width).getValues()[0] : [];
      if (current.join(' ') !== headers.join(' ')) {
        sh.getRange(1, 1, 1, width).setValues([headers]);
      }
      sh.getRange(1, 1, 1, width).setFontWeight('bold').setBackground('#e8eef5');
      sh.setFrozenRows(1);

      headers.forEach(function (h, i) {
        const rows = Math.max(sh.getMaxRows() - 1, 1);
        if (DATE_COLUMNS.indexOf(h) >= 0) {
          sh.getRange(2, i + 1, rows, 1).setNumberFormat('dd mmm yyyy');
        }
        if (h === 'Weight (g)' || h === 'Count' || h === 'Typical count') {
          sh.getRange(2, i + 1, rows, 1).setNumberFormat('0');
        }
      });
      sh.autoResizeColumns(1, width);
    });

    // Remove the default "Sheet1" only if it is untouched and we added ours.
    if (created) {
      const stray = ss.getSheetByName('Sheet1');
      if (stray && ss.getSheets().length > 1 && stray.getLastRow() === 0) ss.deleteSheet(stray);
    }

    if (!DB.getAll('Freezers').filter(function (r) { return txt(r.Name); }).length) {
      DB.append('Freezers', SEED_FREEZERS);
    }

    props.setProperty('SETUP_VERSION', SETUP_VERSION);
    props.setProperty('SPREADSHEET_ID', ss.getId());
  },

  today: function () {
    return Utilities.formatDate(new Date(), spreadsheet_().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
  },

  sheetUrl: function () {
    return spreadsheet_().getUrl();
  },

  getAll: function (name) {
    if (CACHE_[name]) return CACHE_[name];
    const sh = sheet_(name);
    const last = sh.getLastRow();
    const headers = TABLES[name];
    if (last < 2) {
      CACHE_[name] = [];
      return CACHE_[name];
    }
    const values = sh.getRange(2, 1, last - 1, headers.length).getValues();
    const tz = spreadsheet_().getSpreadsheetTimeZone();
    CACHE_[name] = values
      .map(function (row) {
        const obj = {};
        headers.forEach(function (h, i) {
          let v = row[i];
          if (v instanceof Date) v = Utilities.formatDate(v, tz, 'yyyy-MM-dd');
          obj[h] = v;
        });
        return obj;
      })
      .filter(function (obj) {
        // Skip rows the user has blanked out in the sheet.
        return headers.some(function (h) { return txt(obj[h]) !== ''; });
      });
    return CACHE_[name];
  },

  append: function (name, objs) {
    if (!objs || !objs.length) return;
    const sh = sheet_(name);
    const headers = TABLES[name];
    const rows = objs.map(function (o) {
      return headers.map(function (h) { return toCell_(h, o[h]); });
    });
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
    CACHE_ = {};
  },

  updateById: function (name, id, patch) {
    const sh = sheet_(name);
    const headers = TABLES[name];
    const rowIndex = findRow_(sh, id);
    if (rowIndex < 0) return;
    Object.keys(patch).forEach(function (h) {
      const col = headers.indexOf(h);
      if (col < 0) return;
      sh.getRange(rowIndex, col + 1).setValue(toCell_(h, patch[h]));
    });
    CACHE_ = {};
  },

  /**
   * Rewrites one column in a single read-modify-write. A rename can touch
   * dozens of rows, and doing that a cell at a time is painfully slow against
   * a spreadsheet. `fn` returns the new value, or undefined to leave it alone.
   */
  updateColumn: function (name, header, fn) {
    const sh = sheet_(name);
    const col = TABLES[name].indexOf(header);
    const last = sh.getLastRow();
    if (col < 0 || last < 2) return 0;

    const range = sh.getRange(2, col + 1, last - 1, 1);
    const values = range.getValues();
    let changed = 0;
    for (let i = 0; i < values.length; i++) {
      const next = fn(values[i][0]);
      if (next !== undefined && next !== values[i][0]) {
        values[i][0] = next;
        changed++;
      }
    }
    if (changed) {
      range.setValues(values);
      CACHE_ = {};
    }
    return changed;
  },

  deleteByIds: function (name, ids) {
    if (!ids || !ids.length) return;
    const sh = sheet_(name);
    const last = sh.getLastRow();
    if (last < 2) return;
    const wanted = {};
    ids.forEach(function (id) { wanted[txt(id)] = true; });

    const col = sh.getRange(2, 1, last - 1, 1).getValues();
    const targets = [];
    for (let i = 0; i < col.length; i++) {
      if (wanted[txt(col[i][0])]) targets.push(i + 2);
    }
    // Delete bottom-up so earlier row numbers stay valid.
    for (let i = targets.length - 1; i >= 0; i--) sh.deleteRow(targets[i]);
    CACHE_ = {};
  },

  lock: function (fn) {
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      return fn();
    } finally {
      CACHE_ = {};
      lock.releaseLock();
    }
  },
};

function sheet_(name) {
  const ss = spreadsheet_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, TABLES[name].length).setValues([TABLES[name]]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function toCell_(header, value) {
  if (value === undefined || value === null || value === '') return '';
  if (DATE_COLUMNS.indexOf(header) >= 0) {
    const iso = normDate(value);
    if (!iso) return '';
    const parts = iso.split('-');
    return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  }
  if (header === 'Weight (g)' || header === 'Count' || header === 'Typical count') {
    return Math.round(num(value));
  }
  return value;
}

function findRow_(sh, id) {
  const last = sh.getLastRow();
  if (last < 2) return -1;
  const col = sh.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < col.length; i++) {
    if (txt(col[i][0]) === txt(id)) return i + 2;
  }
  return -1;
}

/* ------------------------------------------------------------- entry points */

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Freezer Log')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/** Spreadsheet menu, so the sheet itself offers a way in. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Freezer Log')
    .addItem('Open the app / get my link', 'showSetup')
    .addItem('Set up / repair sheets', 'setupSheets')
    .addToUi();
}

function setupSheets() {
  DB.ensure(true);
  showSetup();
}

/**
 * The web app address of this copy, or '' if it has never been deployed.
 * Deliberately forgiving: an undeployed project throws rather than returning
 * nothing, and that is a normal state for a freshly copied spreadsheet.
 */
function appUrl_() {
  try {
    const service = ScriptApp.getService();
    if (!service || !service.isEnabled()) return '';
    return service.getUrl() || '';
  } catch (err) {
    return '';
  }
}

/**
 * Shown from the menu. Publishing a web app is the one step someone copying
 * this spreadsheet cannot reasonably work out alone, so the dialog either walks
 * them through it or hands over the finished link.
 */
function showSetup() {
  DB.ensure();
  const html = HtmlService.createHtmlOutputFromFile('Setup')
    .getContent()
    .split('__APP_URL__').join(appUrl_());

  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(560).setHeight(600),
    'Freezer Log',
  );
}


/**
 * Freezer Log — shared backend logic.
 *
 * This file is the single source of truth for how the data behaves. It runs in
 * two places:
 *   1. Inside Google Apps Script, concatenated into Code.gs by build.mjs.
 *   2. Inside the local dev server (dev/server.mjs), against a JSON file.
 *
 * Its only dependency is a global `DB` adapter, which each host provides.
 * Keep it free of `import`/`export` — Apps Script has no module system.
 */

/**
 * `Count` and `Unit` record how many pieces are in a bag — six cobs of
 * sweetcorn, four portions of soup — which is often what you actually want to
 * know. Either measure will do: a bag needs a weight or a count, not both.
 *
 * New columns are appended at the end rather than slotted in beside the weight,
 * so a sheet that already holds data keeps every existing value under the right
 * header when the layout is refreshed.
 */
const TABLES = {
  Freezers: ['Name', 'Where', 'Colour'],
  Items: ['Item', 'Category', 'Typical weight (g)', 'Typical count', 'Unit'],
  Inventory: ['ID', 'Item', 'Category', 'Freezer', 'Weight (g)', 'Date In', 'Note', 'Count', 'Unit'],
  History: ['ID', 'Item', 'Category', 'Freezer', 'Weight (g)', 'Date In', 'Date Out', 'Note', 'Count', 'Unit'],
};

const DATE_COLUMNS = ['Date In', 'Date Out'];

const DEFAULT_CATEGORIES = ['Fruit', 'Vegetables', 'Herbs', 'Meat & fish', 'Prepared', 'Other'];

const FREEZER_COLOURS = ['#5F8A20', '#7A3FA2', '#B53464', '#1F7A6B', '#8A6A12', '#00699B'];

const SEED_FREEZERS = [
  { Name: 'Kitchen', Where: 'Fridge-freezer indoors', Colour: FREEZER_COLOURS[0] },
  { Name: 'Garage', Where: 'Chest freezer', Colour: FREEZER_COLOURS[1] },
];

/* ------------------------------------------------------------------ helpers */

function newId(prefix) {
  const stamp = Date.now().toString(36).toUpperCase();
  const salt = Math.floor(Math.random() * 46656).toString(36).toUpperCase();
  return prefix + stamp + ('000' + salt).slice(-3);
}

function num(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

function txt(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

/** Accepts 'YYYY-MM-DD', a Date, or common typed-in formats. Returns 'YYYY-MM-DD' or ''. */
function normDate(v) {
  if (!v) return '';
  if (v instanceof Date && !isNaN(v.getTime())) {
    return v.getFullYear() + '-' + pad2(v.getMonth() + 1) + '-' + pad2(v.getDate());
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return m[1] + '-' + pad2(m[2]) + '-' + pad2(m[3]);
  // dd/mm/yyyy — the sheet's locale is UK, so day comes first.
  m = s.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})$/);
  if (m) return m[3] + '-' + pad2(m[2]) + '-' + pad2(m[1]);
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  return '';
}

function pad2(n) {
  return ('0' + n).slice(-2);
}

/** Title-cases loosely so "raspberries" and "Raspberries" don't become two items. */
function cleanName(v) {
  const s = txt(v).replace(/\s+/g, ' ');
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function keyOf(v) {
  return txt(v).toLowerCase();
}

function toLot(r) {
  return {
    id: txt(r.ID),
    item: txt(r.Item),
    category: txt(r.Category) || 'Other',
    freezer: txt(r.Freezer),
    weightG: Math.round(num(r['Weight (g)'])),
    count: Math.round(num(r.Count)),
    unit: txt(r.Unit),
    dateIn: normDate(r['Date In']),
    dateOut: normDate(r['Date Out']),
    note: txt(r.Note),
  };
}

/* ---------------------------------------------------------------- read side */

function apiGetState() {
  DB.ensure();

  const freezers = DB.getAll('Freezers')
    .filter(function (r) { return txt(r.Name); })
    .map(function (r, i) {
      return {
        name: txt(r.Name),
        where: txt(r.Where),
        colour: txt(r.Colour) || FREEZER_COLOURS[i % FREEZER_COLOURS.length],
      };
    });

  const inventory = DB.getAll('Inventory').filter(function (r) { return txt(r.ID); }).map(toLot);
  const history = DB.getAll('History').filter(function (r) { return txt(r.ID); }).map(toLot);

  // The Items sheet drives the type-ahead. Anything that only exists in the
  // inventory (because someone typed straight into the sheet) is folded in too,
  // so suggestions never miss something that is genuinely in a freezer.
  const items = {};
  DB.getAll('Items').filter(function (r) { return txt(r.Item); }).forEach(function (r) {
    const name = cleanName(r.Item);
    items[keyOf(name)] = {
      name: name,
      category: txt(r.Category) || 'Other',
      typicalG: Math.round(num(r['Typical weight (g)'])) || 0,
      typicalCount: Math.round(num(r['Typical count'])) || 0,
      unit: txt(r.Unit),
      uses: 0,
    };
  });
  inventory.concat(history).forEach(function (lot) {
    const k = keyOf(lot.item);
    if (!k) return;
    if (!items[k]) {
      items[k] = {
        name: lot.item, category: lot.category, typicalG: lot.weightG,
        typicalCount: lot.count, unit: lot.unit, uses: 0,
      };
    }
    // A unit typed straight into the sheet should still reach the form.
    if (!items[k].unit && lot.unit) items[k].unit = lot.unit;
    items[k].uses += 1;
  });

  const itemList = Object.keys(items).map(function (k) { return items[k]; });
  itemList.sort(function (a, b) { return b.uses - a.uses || a.name.localeCompare(b.name); });

  const categories = {};
  DEFAULT_CATEGORIES.forEach(function (c) { categories[keyOf(c)] = c; });
  itemList.forEach(function (it) { categories[keyOf(it.category)] = it.category; });

  // History stays in the sheet for later analysis; the app only needs what is
  // currently in the freezers, so it is not sent over the wire.
  return {
    freezers: freezers,
    items: itemList,
    categories: Object.keys(categories).map(function (k) { return categories[k]; }),
    inventory: inventory,
    today: DB.today(),
    sheetUrl: DB.sheetUrl ? DB.sheetUrl() : '',
  };
}

/* --------------------------------------------------------------- write side */

function ensureItemType(name, category, typicalG, typicalCount, unit) {
  const existing = DB.getAll('Items');
  for (let i = 0; i < existing.length; i++) {
    if (keyOf(existing[i].Item) !== keyOf(name)) continue;
    // Known item: only fill in a unit it does not have yet, never overwrite.
    if (unit && !txt(existing[i].Unit)) {
      DB.updateById('Items', existing[i].Item, { Unit: unit, 'Typical count': typicalCount || '' });
    }
    return;
  }
  DB.append('Items', [{
    Item: name,
    Category: category,
    'Typical weight (g)': typicalG || '',
    'Typical count': typicalCount || '',
    Unit: unit || '',
  }]);
}

/**
 * Adds `qty` separate bags of the same thing. Each bag is its own row so it can
 * be taken out individually later.
 */
function apiAdd(p) {
  return DB.lock(function () {
    DB.ensure();
    const item = cleanName(p && p.item);
    if (!item) throw new Error('Please choose what you are freezing.');

    const freezer = txt(p.freezer);
    if (!freezer) throw new Error('Please choose which freezer it is going in.');

    const category = txt(p.category) || 'Other';
    const weightG = Math.max(0, Math.round(num(p.weightG)));
    const count = Math.max(0, Math.round(num(p.count)));
    const unit = count > 0 ? (txt(p.unit) || 'pieces') : '';
    if (weightG <= 0 && count <= 0) {
      throw new Error('Please enter a weight, or how many pieces are in the bag.');
    }

    const qty = Math.max(1, Math.min(99, Math.round(num(p.qty)) || 1));
    const dateIn = normDate(p.dateIn) || DB.today();
    const note = txt(p.note);

    ensureItemType(item, category, weightG, count, unit);

    const rows = [];
    for (let i = 0; i < qty; i++) {
      rows.push({
        ID: newId('L'),
        Item: item,
        Category: category,
        Freezer: freezer,
        'Weight (g)': weightG || '',
        'Date In': dateIn,
        Note: note,
        Count: count || '',
        Unit: unit,
      });
    }
    DB.append('Inventory', rows);

    return {
      lots: rows.map(toLot),
      undo: { type: 'add', ids: rows.map(function (r) { return r.ID; }) },
    };
  });
}

/** Takes whole bags out: moves them from Inventory to History. */
function apiRemove(p) {
  return DB.lock(function () {
    DB.ensure();
    const ids = (p && p.ids) || [];
    if (!ids.length) throw new Error('Nothing selected to take out.');
    const dateOut = normDate(p.dateOut) || DB.today();

    const byId = {};
    DB.getAll('Inventory').forEach(function (r) { byId[txt(r.ID)] = r; });

    const histRows = [];
    const foundIds = [];
    ids.forEach(function (id) {
      const r = byId[txt(id)];
      if (!r) return;
      foundIds.push(txt(id));
      histRows.push({
        ID: txt(r.ID),
        Item: txt(r.Item),
        Category: txt(r.Category),
        Freezer: txt(r.Freezer),
        'Weight (g)': Math.round(num(r['Weight (g)'])) || '',
        'Date In': normDate(r['Date In']),
        'Date Out': dateOut,
        Note: txt(r.Note),
        Count: Math.round(num(r.Count)) || '',
        Unit: txt(r.Unit),
      });
    });
    if (!foundIds.length) throw new Error('Those bags are no longer in the freezer.');

    DB.append('History', histRows);
    DB.deleteByIds('Inventory', foundIds);

    return { removed: histRows.map(toLot), undo: { type: 'remove', ids: foundIds } };
  });
}

/**
 * Takes part of a bag out, leaving the rest in the freezer. A bag that is
 * counted splits by count — two cobs out of six — and its weight follows the
 * same proportion. A bag that is only weighed splits by weight.
 */
function apiRemovePart(p) {
  const id = txt(p && p.id);
  const lot = DB.getAll('Inventory').filter(function (r) { return txt(r.ID) === id; })[0];
  if (!lot) throw new Error('That bag is no longer in the freezer.');

  const haveW = Math.round(num(lot['Weight (g)']));
  const haveC = Math.round(num(lot.Count));

  let takeC = 0;
  let takeW = 0;

  if (haveC > 0) {
    takeC = Math.round(num(p && p.count));
    if (takeC <= 0) throw new Error('Please enter how many you are taking out.');
    if (takeC >= haveC) return apiRemove({ ids: [id], dateOut: p.dateOut });
    takeW = haveW ? Math.round((haveW * takeC) / haveC) : 0;
  } else {
    takeW = Math.round(num(p && p.weightG));
    if (takeW <= 0) throw new Error('Please enter how much you are taking out.');
    if (takeW >= haveW) return apiRemove({ ids: [id], dateOut: p.dateOut });
  }

  return DB.lock(function () {
    const dateOut = normDate(p.dateOut) || DB.today();
    const historyId = newId('L');

    DB.updateById('Inventory', id, {
      'Weight (g)': haveW - takeW || '',
      Count: haveC - takeC || '',
    });
    DB.append('History', [{
      ID: historyId,
      Item: txt(lot.Item),
      Category: txt(lot.Category),
      Freezer: txt(lot.Freezer),
      'Weight (g)': takeW || '',
      'Date In': normDate(lot['Date In']),
      'Date Out': dateOut,
      Note: txt(lot.Note),
      Count: takeC || '',
      Unit: txt(lot.Unit),
    }]);

    return { undo: { type: 'part', id: id, weightG: takeW, count: takeC, historyId: historyId } };
  });
}

/**
 * Changes one bag in place — its freezer, date, size or note. Everything the
 * app can set on the way in can be corrected afterwards, so a mistake never
 * has to be fixed by deleting and re-adding.
 */
function apiEditLot(p) {
  return DB.lock(function () {
    DB.ensure();
    const id = txt(p && p.id);
    const lot = DB.getAll('Inventory').filter(function (r) { return txt(r.ID) === id; })[0];
    if (!lot) throw new Error('That bag is no longer in the freezer.');

    const src = (p && p.patch) || {};
    const patch = {};
    if ('freezer' in src) patch.Freezer = txt(src.freezer);
    if ('weightG' in src) patch['Weight (g)'] = Math.max(0, Math.round(num(src.weightG))) || '';
    if ('count' in src) patch.Count = Math.max(0, Math.round(num(src.count))) || '';
    if ('unit' in src) patch.Unit = txt(src.unit);
    if ('dateIn' in src) patch['Date In'] = normDate(src.dateIn) || normDate(lot['Date In']);
    if ('note' in src) patch.Note = txt(src.note);

    const after = function (key) { return key in patch ? patch[key] : lot[key]; };
    if (num(after('Weight (g)')) <= 0 && num(after('Count')) <= 0) {
      throw new Error('A bag needs a weight, or how many pieces are in it.');
    }
    if (!txt(after('Freezer'))) throw new Error('Please choose which freezer it is in.');

    const before = {};
    Object.keys(patch).forEach(function (k) { before[k] = lot[k]; });

    DB.updateById('Inventory', id, patch);
    return {
      lot: toLot(Object.assign({}, lot, patch)),
      undo: { type: 'edit', id: id, before: before },
    };
  });
}

/**
 * Splits one bag into several. A tub recorded as "8 blocks" becomes eight bags
 * of one block, which is what you want once they are being used one at a time.
 * Weight and count are shared out as evenly as they divide, with any remainder
 * going to the first bags.
 */
function apiSplitLot(p) {
  return DB.lock(function () {
    DB.ensure();
    const id = txt(p && p.id);
    const into = Math.round(num(p && p.into));
    const lot = DB.getAll('Inventory').filter(function (r) { return txt(r.ID) === id; })[0];
    if (!lot) throw new Error('That bag is no longer in the freezer.');
    if (into < 2 || into > 99) throw new Error('Choose between 2 and 99 bags.');

    const haveW = Math.round(num(lot['Weight (g)']));
    const haveC = Math.round(num(lot.Count));
    if (haveC > 0 && haveC < into) {
      throw new Error('There are only ' + haveC + ' to share out.');
    }
    if (haveC <= 0 && haveW < into) throw new Error('That is too small to split that many ways.');

    const share = function (total) {
      const base = Math.floor(total / into);
      const spare = total - base * into;
      const out = [];
      for (let i = 0; i < into; i++) out.push(base + (i < spare ? 1 : 0));
      return out;
    };
    const weights = haveW ? share(haveW) : [];
    const counts = haveC ? share(haveC) : [];

    const rows = [];
    for (let i = 0; i < into; i++) {
      rows.push({
        ID: newId('L'),
        Item: txt(lot.Item),
        Category: txt(lot.Category),
        Freezer: txt(lot.Freezer),
        'Weight (g)': (weights[i] || 0) || '',
        'Date In': normDate(lot['Date In']),
        Note: txt(lot.Note),
        Count: (counts[i] || 0) || '',
        Unit: txt(lot.Unit),
      });
    }

    DB.append('Inventory', rows);
    DB.deleteByIds('Inventory', [id]);

    return {
      lots: rows.map(toLot),
      undo: { type: 'split', ids: rows.map(function (r) { return r.ID; }), original: lot },
    };
  });
}

/** Renames one item everywhere it appears. Unlocked; callers hold the lock. */
function renameItem_(from, to) {
  const matches = function (v) { return keyOf(v) === keyOf(from) ? to : undefined; };
  let n = DB.updateColumn('Inventory', 'Item', matches);
  n += DB.updateColumn('History', 'Item', matches);

  // If the new name is already in the catalogue, merging means dropping the
  // old row rather than creating a second entry under the same name.
  const items = DB.getAll('Items');
  const hasTarget = items.some(function (r) { return keyOf(r.Item) === keyOf(to); });
  const source = items.filter(function (r) { return keyOf(r.Item) === keyOf(from); })[0];
  if (source && hasTarget) DB.deleteByIds('Items', [txt(source.Item)]);
  else DB.updateColumn('Items', 'Item', matches);

  if (!n && !source) throw new Error('Nothing called \u201c' + from + '\u201d to rename.');
  return n;
}

function renameCategory_(from, to) {
  const matches = function (v) { return keyOf(v) === keyOf(from) ? to : undefined; };
  const n = DB.updateColumn('Inventory', 'Category', matches)
    + DB.updateColumn('History', 'Category', matches)
    + DB.updateColumn('Items', 'Category', matches);
  if (!n) throw new Error('Nothing filed under \u201c' + from + '\u201d to rename.');
  return n;
}

function apiRenameItem(p) {
  const from = cleanName(p && p.from);
  const to = cleanName(p && p.to);
  if (!from || !to) throw new Error('Please give the new name.');
  if (from === to) return { renamed: 0, undo: null };
  return DB.lock(function () {
    DB.ensure();
    return { renamed: renameItem_(from, to), undo: { type: 'rename-item', from: to, to: from } };
  });
}

function apiRenameCategory(p) {
  const from = cleanName(p && p.from);
  const to = cleanName(p && p.to);
  if (!from || !to) throw new Error('Please give the new name.');
  if (from === to) return { renamed: 0, undo: null };
  return DB.lock(function () {
    DB.ensure();
    return { renamed: renameCategory_(from, to), undo: { type: 'rename-category', from: to, to: from } };
  });
}

/** Reverses the last action. `token` is the `undo` object returned above. */
function apiUndo(token) {
  return DB.lock(function () {
    DB.ensure();
    if (!token || !token.type) throw new Error('Nothing to undo.');

    if (token.type === 'add') {
      DB.deleteByIds('Inventory', token.ids || []);
      return { ok: true };
    }

    if (token.type === 'remove') {
      const ids = {};
      (token.ids || []).forEach(function (id) { ids[txt(id)] = true; });
      const back = DB.getAll('History').filter(function (r) { return ids[txt(r.ID)]; });
      if (!back.length) throw new Error('That has already been undone.');
      DB.append('Inventory', back.map(function (r) {
        return {
          ID: txt(r.ID),
          Item: txt(r.Item),
          Category: txt(r.Category),
          Freezer: txt(r.Freezer),
          'Weight (g)': Math.round(num(r['Weight (g)'])) || '',
          'Date In': normDate(r['Date In']),
          Note: txt(r.Note),
          Count: Math.round(num(r.Count)) || '',
          Unit: txt(r.Unit),
        };
      }));
      DB.deleteByIds('History', Object.keys(ids));
      return { ok: true };
    }

    if (token.type === 'part') {
      const lot = DB.getAll('Inventory').filter(function (r) { return txt(r.ID) === txt(token.id); })[0];
      if (!lot) throw new Error('That bag is no longer in the freezer.');
      DB.updateById('Inventory', txt(token.id), {
        'Weight (g)': Math.round(num(lot['Weight (g)'])) + Math.round(num(token.weightG)) || '',
        Count: Math.round(num(lot.Count)) + Math.round(num(token.count)) || '',
      });
      DB.deleteByIds('History', [txt(token.historyId)]);
      return { ok: true };
    }

    if (token.type === 'edit') {
      DB.updateById('Inventory', txt(token.id), token.before || {});
      return { ok: true };
    }

    if (token.type === 'split') {
      DB.deleteByIds('Inventory', token.ids || []);
      DB.append('Inventory', [token.original]);
      return { ok: true };
    }

    // Already inside the lock, so the unlocked helpers are used directly.
    if (token.type === 'rename-item') {
      renameItem_(cleanName(token.from), cleanName(token.to));
      return { ok: true };
    }

    if (token.type === 'rename-category') {
      renameCategory_(cleanName(token.from), cleanName(token.to));
      return { ok: true };
    }

    throw new Error('Nothing to undo.');
  });
}
