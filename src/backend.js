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

/**
 * A batch of bags is minted in one tight loop, in the same millisecond, so the
 * timestamp does not separate them and three random characters is a birthday
 * problem against 46,656 — at the 99 the quantity stepper offers, roughly one
 * batch in twelve contained a duplicate. A duplicate ID is not cosmetic:
 * deleteByIds and findRow_ both match on the string, so taking one of the twins
 * out of the freezer removes both.
 *
 * The counter makes a collision within one batch impossible. It starts at a
 * random offset so that two executions landing in the same millisecond do not
 * both begin at zero.
 */
let idSeq_ = Math.floor(Math.random() * 1296);

function newId(prefix) {
  const stamp = Date.now().toString(36).toUpperCase();
  idSeq_ = (idSeq_ + 1) % 1296;
  const seq = idSeq_.toString(36).toUpperCase();
  const salt = Math.floor(Math.random() * 46656).toString(36).toUpperCase();
  return prefix + stamp + ('00' + seq).slice(-2) + ('000' + salt).slice(-3);
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

/**
 * Moves whole bags from Inventory to History. Unlocked; callers hold the lock —
 * the same convention as renameItem_, so apiRemovePart can finish a full
 * removal without taking the lock a second time.
 *
 * The append comes before the delete deliberately. Apps Script has no
 * transactions, so the only lever a two-table write has is which half survives
 * a failure between them: appending first can leave a bag recorded twice, which
 * is visible and repairable, where deleting first would lose it outright.
 */
function removeWhole_(ids, dateOutRaw) {
  if (!ids.length) throw new Error('Nothing selected to take out.');
  const dateOut = normDate(dateOutRaw) || DB.today();

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
}

/** Takes whole bags out: moves them from Inventory to History. */
function apiRemove(p) {
  return DB.lock(function () {
    DB.ensure();
    return removeWhole_((p && p.ids) || [], p && p.dateOut);
  });
}

/**
 * Takes part of a bag out, leaving the rest in the freezer. A bag that is
 * counted splits by count — two cobs out of six — and its weight follows the
 * same proportion. A bag that is only weighed splits by weight.
 */
function apiRemovePart(p) {
  return DB.lock(function () {
    DB.ensure();

    // The read has to sit inside the lock with the write that depends on it.
    // Read it outside and two overlapping part-removals both see 900 g, each
    // subtract 300, and the second write puts 300 g back that is not there.
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
      if (takeC >= haveC) return removeWhole_([id], p && p.dateOut);
      takeW = haveW ? Math.round((haveW * takeC) / haveC) : 0;
    } else {
      takeW = Math.round(num(p && p.weightG));
      if (takeW <= 0) throw new Error('Please enter how much you are taking out.');
      if (takeW >= haveW) return removeWhole_([id], p && p.dateOut);
    }

    const dateOut = normDate(p && p.dateOut) || DB.today();
    const historyId = newId('L');

    // History first, then the decrement — see removeWhole_ for why the
    // additive write always goes first.
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
    DB.updateById('Inventory', id, {
      'Weight (g)': haveW - takeW || '',
      Count: haveC - takeC || '',
    });

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
