/**
 * Pantry Cache — shared backend logic.
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
  Stores: ['Name', 'Where', 'Colour'],
  Items: ['Item', 'Category', 'Typical weight (g)', 'Typical count', 'Unit'],
  Inventory: ['ID', 'Item', 'Category', 'Store', 'Weight (g)', 'Date In', 'Note', 'Count', 'Unit', 'Month only'],
  History: ['ID', 'Item', 'Category', 'Store', 'Weight (g)', 'Date In', 'Date Out', 'Note', 'Count', 'Unit', 'Month only'],
};

const DATE_COLUMNS = ['Date In', 'Date Out'];

const DEFAULT_CATEGORIES = ['Fruit', 'Vegetables', 'Herbs', 'Meat & fish', 'Prepared', 'Other'];

const STORE_COLOURS = ['#5F8A20', '#7A3FA2', '#B53464', '#1F7A6B', '#8A6A12', '#00699B'];

/**
 * Offered on the first-run screen as one-tap starting points, never written
 * without being asked for. Setup used to append Kitchen and Garage to every new
 * sheet, which meant nobody ever saw an empty store list — and everybody who
 * did not happen to have a garage started by deleting a place they had never
 * named, in a spreadsheet, before they could use the app at all.
 */
const SUGGESTED_STORES = ['Kitchen', 'Garage', 'Pantry', 'Utility', 'Shed', 'Cellar'];

/* ------------------------------------------------------------------ helpers */

/**
 * A batch of bags is minted in one tight loop, in the same millisecond, so the
 * timestamp does not separate them and three random characters is a birthday
 * problem against 46,656 — at the 99 the quantity stepper offers, roughly one
 * batch in twelve contained a duplicate. A duplicate ID is not cosmetic:
 * deleteByIds and findRow_ both match on the string, so taking one of the twins
 * out of the store removes both.
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

function txt(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

/**
 * Constraint 1 invites her to open the spreadsheet and correct it, so these two
 * functions are the ones that read whatever she writes. They used to have no
 * failure mode: num() stripped every character that was not a digit, a dot or a
 * minus and took what was left, so "1.5kg" in a column headed Weight (g)
 * became 2 grams and "2 x 500" became 2500 — five times the truth, silently.
 *
 * Now they either read a value or say they could not, and apiGetState passes
 * what it could not read back to the screen. Constraint 3 says errors are
 * written in English; a quietly wrong number is worse than an error.
 */
const WEIGHT_UNITS = {
  g: 1, gs: 1, gram: 1, grams: 1, gramme: 1, grammes: 1,
  kg: 1000, kgs: 1000, kilo: 1000, kilos: 1000, kilogram: 1000, kilograms: 1000,
  oz: 28.349523125, ozs: 28.349523125, ounce: 28.349523125, ounces: 28.349523125,
  lb: 453.59237, lbs: 453.59237, pound: 453.59237, pounds: 453.59237,
};

/** { value, ok, suffix } — `ok` false means the cell held something unreadable. */
function parseNum(v) {
  if (v === null || v === undefined || v === '') return { value: 0, ok: true };
  if (typeof v === 'number') {
    return isFinite(v) ? { value: v, ok: true } : { value: 0, ok: false, raw: String(v) };
  }
  const raw = txt(v);
  const s = raw.toLowerCase().replace(/,/g, '').replace(/\s+/g, '');
  if (!s) return { value: 0, ok: true };
  const m = s.match(/^(-?\d+(?:\.\d+)?)([a-z]*)$/);
  if (!m) return { value: 0, ok: false, raw: raw };
  const n = Number(m[1]);
  if (!isFinite(n)) return { value: 0, ok: false, raw: raw };
  return { value: n, ok: true, suffix: m[2] };
}

/** The same, in grams, honouring kg / oz / lb rather than discarding them. */
function parseGrams(v) {
  const p = parseNum(v);
  if (!p.ok || !p.suffix) return p;
  const factor = WEIGHT_UNITS[p.suffix];
  if (!factor) return { value: 0, ok: false, raw: txt(v) };
  return { value: p.value * factor, ok: true };
}

function num(v) { return parseNum(v).value; }
function grams(v) { return parseGrams(v).value; }

function validYMD_(y, mo, d, raw) {
  if (y < 1900 || y > 2200 || mo < 1 || mo > 12 || d < 1 || d > 31) {
    return { value: '', ok: false, raw: raw };
  }
  // Catches 31 April and 29 February in a common year, which JavaScript would
  // otherwise roll silently forward into the next month.
  const probe = new Date(y, mo - 1, d);
  if (probe.getFullYear() !== y || probe.getMonth() !== mo - 1 || probe.getDate() !== d) {
    return { value: '', ok: false, raw: raw };
  }
  return { value: y + '-' + pad2(mo) + '-' + pad2(d), ok: true };
}

/**
 * Accepts 'YYYY-MM-DD', a Date, or dd/mm/yy(yy). The UK order is deliberate —
 * it is the sheet's locale — and it now covers two-digit years, which used to
 * fall through to `new Date(s)`, the one US-first path in the file. "3/9/25"
 * came back as 9 March. That fallback is gone rather than fixed: there is no
 * format it is the right answer for here.
 */
function parseDate(v) {
  if (v === null || v === undefined || v === '') return { value: '', ok: true };
  if (v instanceof Date) {
    return isNaN(v.getTime())
      ? { value: '', ok: false, raw: String(v) }
      : { value: v.getFullYear() + '-' + pad2(v.getMonth() + 1) + '-' + pad2(v.getDate()), ok: true };
  }
  const s = txt(v);
  if (!s) return { value: '', ok: true };

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/);
  if (m) return validYMD_(Number(m[1]), Number(m[2]), Number(m[3]), s);

  m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})$/);
  if (m) {
    let y = Number(m[3]);
    if (m[3].length === 2) y += y < 70 ? 2000 : 1900;
    return validYMD_(y, Number(m[2]), Number(m[1]), s);
  }

  return { value: '', ok: false, raw: s };
}

function normDate(v) { return parseDate(v).value; }

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
  const w = parseGrams(r['Weight (g)']);
  const c = parseNum(r.Count);
  const din = parseDate(r['Date In']);
  return {
    id: txt(r.ID),
    item: txt(r.Item),
    category: txt(r.Category) || 'Other',
    store: txt(r.Store),
    weightG: Math.round(w.value),
    count: Math.round(c.value),
    unit: txt(r.Unit),
    dateIn: din.value,
    dateOut: normDate(r['Date Out']),
    note: txt(r.Note),
    // Constraint 5 says the month is what matters and the day is a bonus.
    // Without somewhere to record that, backdating to a month had to invent
    // the 1st and every screen then showed it as a day she had chosen.
    monthOnly: keyOf(r['Month only']) === 'yes',
    // What could not be read, so the screen can say so instead of guessing.
    unreadable: [
      w.ok ? null : { field: 'Weight (g)', raw: w.raw },
      c.ok ? null : { field: 'Count', raw: c.raw },
      din.ok ? null : { field: 'Date In', raw: din.raw },
    ].filter(Boolean),
  };
}

/* ---------------------------------------------------------------- read side */

function apiGetState() {
  DB.ensure();

  const stores = DB.getAll('Stores')
    .filter(function (r) { return txt(r.Name); })
    .map(function (r, i) {
      return {
        name: txt(r.Name),
        where: txt(r.Where),
        // The colour is handed to CSS as a custom property. `var(--fz, fallback)`
        // only uses its fallback when the property is *unset*, so a cell holding
        // "2f7fd0" — the hash left off, which the README invites by asking for
        // hex codes — set it to something invalid and every dot for that store
        // disappeared rather than going grey. This is also the one place sheet
        // data reaches a style context, so it is worth being strict.
        colour: /^#[0-9a-f]{3,8}$/i.test(txt(r.Colour))
          ? txt(r.Colour)
          : STORE_COLOURS[i % STORE_COLOURS.length],
      };
    });

  const inventory = DB.getAll('Inventory').filter(function (r) { return txt(r.ID); }).map(toLot);

  // History is read only to keep things that are no longer in a store in the
  // type-ahead, and it is never pruned — so the app's slowest path was paying,
  // on every load and again after every rename and undo, for its least
  // important feature. Only the four columns that matter are kept, and the
  // rows are not converted to lots.
  const history = DB.getAll('History')
    .filter(function (r) { return txt(r.ID); })
    .map(function (r) {
      return {
        item: txt(r.Item),
        category: txt(r.Category) || 'Other',
        unit: txt(r.Unit),
        dateOut: normDate(r['Date Out']),
      };
    });

  // The Items sheet drives the type-ahead. Anything that only exists in the
  // inventory (because someone typed straight into the sheet) is folded in too,
  // so suggestions never miss something that is genuinely in a store.
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
      // Whether anything has ever been kept under this name. Removing the
      // catalogue row of something that has been stored is close to a no-op —
      // the type-ahead reads History too, so it carries on suggesting it — and
      // a control that appears to do nothing is worse than no control.
      everStored: false,
    };
  });
  // How recently something was used, not only how often. `uses` counted every
  // appearance in an unpruned History for ever, so an item put in heavily three
  // years ago outranked this season's — and the Put in grid shows six tiles per
  // category, so that decided what she sees without tapping "+ 9 more".
  const today = DB.today();
  const cutoff = (Number(today.slice(0, 4)) - 1) + today.slice(4);

  const score = function (lot, inStore) {
    if (inStore) return 1;                       // in a store now: full weight
    if (!lot.dateOut || lot.dateOut >= cutoff) return 1;  // used within the year
    return 0.25;                                   // older than that: a quarter
  };

  inventory.forEach(function (lot) { tally(lot, true); });
  history.forEach(function (lot) { tally(lot, false); });

  function tally(lot, inStore) {
    const k = keyOf(lot.item);
    if (!k) return;
    if (!items[k]) {
      items[k] = {
        name: lot.item, category: lot.category,
        typicalG: lot.weightG || 0, typicalCount: lot.count || 0,
        unit: lot.unit, uses: 0, everStored: false,
      };
    }
    items[k].everStored = true;
    // A unit typed straight into the sheet should still reach the form.
    if (!items[k].unit && lot.unit) items[k].unit = lot.unit;
    items[k].uses += score(lot, inStore);
  }

  const itemList = Object.keys(items).map(function (k) { return items[k]; });
  itemList.sort(function (a, b) { return b.uses - a.uses || a.name.localeCompare(b.name); });

  const categories = {};
  DEFAULT_CATEGORIES.forEach(function (c) { categories[keyOf(c)] = c; });
  itemList.forEach(function (it) { categories[keyOf(it.category)] = it.category; });

  // Anything the parsers refused, so the screen can name it rather than
  // reporting a confident 0 g. Capped, because the point is to prompt a look at
  // the spreadsheet, not to reproduce it.
  const problems = [];
  inventory.forEach(function (lot) {
    lot.unreadable.forEach(function (u) {
      if (problems.length < 20) {
        problems.push({ id: lot.id, item: lot.item, field: u.field, raw: u.raw });
      }
    });
  });

  // History stays in the sheet for later analysis; the app only needs what is
  // currently in the stores, so it is not sent over the wire.
  return {
    stores: stores,
    // Only of use when `stores` is empty, but sent always: asking for them in a
    // second call would mean the first-run screen renders once without its
    // suggestions and again with them.
    suggestedStores: SUGGESTED_STORES,
    storeColours: STORE_COLOURS,
    items: itemList,
    categories: Object.keys(categories).map(function (k) { return categories[k]; }),
    inventory: inventory,
    problems: problems,
    today: DB.today(),
    sheetUrl: DB.sheetUrl ? DB.sheetUrl() : '',
  };
}

/* -------------------------------------------------------------- undo tokens */

/**
 * Undo is what constraint 3 offers instead of confirmation dialogs, so it has
 * to be worth relying on. It was not.
 *
 * Tokens used to be minted by the server, handed to the browser, and accepted
 * back as authority to act — so a hand-written {type:'add', ids:[...]} would
 * hard-delete rows with no History entry, which is the only unlogged
 * destructive path in the application. And nothing checked whether the world
 * had moved on, so undoing an add whose bags had since been split matched
 * nothing and cheerfully reported "Undone."
 *
 * Now the server keeps the token and hands out a random handle. A handle is
 * accepted once, then burned, and it expires. Each token carries a fingerprint
 * of the rows it affects, taken when it was issued; if they have changed since,
 * the undo refuses in English instead of doing something surprising.
 */
const UNDO_TTL_SECONDS = 900;

/**
 * A stable summary of the rows an action touched. Any later edit, split, part
 * removal or rename changes it, which is exactly when an undo stops being safe.
 */
function fingerprint_(table, ids) {
  const want = {};
  (ids || []).forEach(function (id) { want[txt(id)] = true; });
  return DB.getAll(table)
    .filter(function (r) { return want[txt(r.ID)]; })
    .map(function (r) {
      return [
        txt(r.ID), Math.round(num(r['Weight (g)'])), Math.round(num(r.Count)),
        keyOf(r.Unit), keyOf(r.Store), normDate(r['Date In']),
        keyOf(r.Item), keyOf(r.Category), txt(r.Note), normDate(r['Date Out']),
      ].join('\u0001');
    })
    .sort()
    .join('\u0002');
}

/**
 * Stores the token and returns the handle the client should hold. `check`
 * names the rows whose state the undo depends on; pass null where there is
 * nothing meaningful to compare (an add has not created its rows yet).
 */
function issueUndo_(token, check) {
  if (!token) return null;
  if (check) {
    token.check = {
      table: check.table,
      ids: check.ids,
      print: fingerprint_(check.table, check.ids),
    };
  }
  const handle = newId('U');
  DB.tokens.put(handle, token, UNDO_TTL_SECONDS);
  return handle;
}

function verifyUndo_(token) {
  if (!token.check) return;
  if (fingerprint_(token.check.table, token.check.ids) !== token.check.print) {
    throw new Error('That has changed since, so this cannot be undone.');
  }
}

/* --------------------------------------------------------------- write side */

/**
 * Returns true when it added a new row to the catalogue, false when it did not.
 *
 * The typical values are what the Put in form pre-fills next time, and they
 * used to be written once, on the very first bag, and never revisited — so an
 * unusual first bag of raspberries suggested that weight for ever, with no way
 * to correct it except editing the sheet. They now follow the most recent bag,
 * which is what "typical" should mean for something picked in season.
 */
function ensureItemType(name, category, typicalG, typicalCount, unit) {
  const existing = DB.getAll('Items');
  for (let i = 0; i < existing.length; i++) {
    if (keyOf(existing[i].Item) !== keyOf(name)) continue;
    const patch = {};
    if (typicalG > 0) patch['Typical weight (g)'] = Math.round(typicalG);
    if (typicalCount > 0) patch['Typical count'] = Math.round(typicalCount);
    // A unit is only ever filled in, never overwritten: it is a name for the
    // thing, not a measurement of this bag.
    if (unit && !txt(existing[i].Unit)) patch.Unit = unit;
    if (Object.keys(patch).length) DB.updateById('Items', existing[i].Item, patch);
    return false;
  }
  DB.append('Items', [{
    Item: name,
    Category: category,
    'Typical weight (g)': typicalG || '',
    'Typical count': typicalCount || '',
    Unit: unit || '',
  }]);
  return true;
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

    const store = txt(p.store);
    if (!store) throw new Error('Please choose which store it is going in.');

    const category = txt(p.category) || 'Other';
    const weightG = Math.max(0, Math.round(num(p.weightG)));
    const count = Math.max(0, Math.round(num(p.count)));
    const unit = count > 0 ? (txt(p.unit) || 'pieces') : '';
    if (weightG <= 0 && count <= 0) {
      throw new Error('Please enter a weight, or how many pieces are in the bag.');
    }

    const qty = Math.max(1, Math.min(99, Math.round(num(p.qty)) || 1));
    const dateIn = normDate(p.dateIn) || DB.today();
    const monthOnly = p.monthOnly ? 'yes' : '';
    const note = txt(p.note);

    const itemCreated = ensureItemType(item, category, weightG, count, unit);

    const rows = [];
    for (let i = 0; i < qty; i++) {
      rows.push({
        ID: newId('L'),
        Item: item,
        Category: category,
        Store: store,
        'Weight (g)': weightG || '',
        'Date In': dateIn,
        Note: note,
        Count: count || '',
        Unit: unit,
        'Month only': monthOnly,
      });
    }
    DB.append('Inventory', rows);

    const ids = rows.map(function (r) { return r.ID; });
    return {
      lots: rows.map(toLot),
      // itemCreated: undoing an add used to leave behind the Items row it had
      // just created, so a typo added and immediately undone stayed in the
      // catalogue for ever — as a tile with no bags, which the app gives no
      // way to rename or remove.
      undo: issueUndo_(
        { type: 'add', ids: ids, itemCreated: itemCreated ? item : null },
        { table: 'Inventory', ids: ids },
      ),
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
      Store: txt(r.Store),
      'Weight (g)': Math.round(num(r['Weight (g)'])) || '',
      'Date In': normDate(r['Date In']),
      'Date Out': dateOut,
      Note: txt(r.Note),
      Count: Math.round(num(r.Count)) || '',
      Unit: txt(r.Unit),
      'Month only': txt(r['Month only']),
    });
  });
  if (!foundIds.length) throw new Error('Those bags are no longer in the store.');

  DB.append('History', histRows);
  DB.deleteByIds('Inventory', foundIds);

  return {
    removed: histRows.map(toLot),
    undo: issueUndo_({ type: 'remove', ids: foundIds }, { table: 'History', ids: foundIds }),
  };
}

/** Takes whole bags out: moves them from Inventory to History. */
function apiRemove(p) {
  return DB.lock(function () {
    DB.ensure();
    return removeWhole_((p && p.ids) || [], p && p.dateOut);
  });
}

/**
 * Takes part of a bag out, leaving the rest in the store. A bag that is
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
    if (!lot) throw new Error('That bag is no longer in the store.');

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
      Store: txt(lot.Store),
      'Weight (g)': takeW || '',
      'Date In': normDate(lot['Date In']),
      'Date Out': dateOut,
      Note: txt(lot.Note),
      Count: takeC || '',
      Unit: txt(lot.Unit),
      'Month only': txt(lot['Month only']),
    }]);
    DB.updateById('Inventory', id, {
      'Weight (g)': haveW - takeW || '',
      Count: haveC - takeC || '',
    });

    return {
      undo: issueUndo_(
        { type: 'part', id: id, weightG: takeW, count: takeC, historyId: historyId },
        { table: 'Inventory', ids: [id] },
      ),
    };
  });
}

/**
 * Changes one bag in place — its store, date, size or note. Everything the
 * app can set on the way in can be corrected afterwards, so a mistake never
 * has to be fixed by deleting and re-adding.
 */
function apiEditLot(p) {
  return DB.lock(function () {
    DB.ensure();
    const id = txt(p && p.id);
    const lot = DB.getAll('Inventory').filter(function (r) { return txt(r.ID) === id; })[0];
    if (!lot) throw new Error('That bag is no longer in the store.');

    const src = (p && p.patch) || {};
    const patch = {};
    if ('store' in src) patch.Store = txt(src.store);
    if ('weightG' in src) patch['Weight (g)'] = Math.max(0, Math.round(num(src.weightG))) || '';
    if ('count' in src) patch.Count = Math.max(0, Math.round(num(src.count))) || '';
    if ('unit' in src) patch.Unit = txt(src.unit);
    if ('dateIn' in src) patch['Date In'] = normDate(src.dateIn) || normDate(lot['Date In']);
    if ('monthOnly' in src) patch['Month only'] = src.monthOnly ? 'yes' : '';
    if ('note' in src) patch.Note = txt(src.note);

    const after = function (key) { return key in patch ? patch[key] : lot[key]; };
    if (num(after('Weight (g)')) <= 0 && num(after('Count')) <= 0) {
      throw new Error('A bag needs a weight, or how many pieces are in it.');
    }
    if (!txt(after('Store'))) throw new Error('Please choose which store it is in.');

    const before = {};
    Object.keys(patch).forEach(function (k) { before[k] = lot[k]; });

    DB.updateById('Inventory', id, patch);
    return {
      lot: toLot(Object.assign({}, lot, patch)),
      undo: issueUndo_({ type: 'edit', id: id, before: before }, { table: 'Inventory', ids: [id] }),
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
    if (!lot) throw new Error('That bag is no longer in the store.');
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
        Store: txt(lot.Store),
        'Weight (g)': (weights[i] || 0) || '',
        'Date In': normDate(lot['Date In']),
        Note: txt(lot.Note),
        Count: (counts[i] || 0) || '',
        Unit: txt(lot.Unit),
        'Month only': txt(lot['Month only']),
      });
    }

    DB.append('Inventory', rows);
    DB.deleteByIds('Inventory', [id]);

    const childIds = rows.map(function (r) { return r.ID; });
    return {
      lots: rows.map(toLot),
      undo: issueUndo_(
        { type: 'split', ids: childIds, original: lot },
        { table: 'Inventory', ids: childIds },
      ),
    };
  });
}

/**
 * Renames one item everywhere it appears. Unlocked; callers hold the lock.
 *
 * Returns the rows it actually changed. That is the whole point: renaming
 * "French beans" onto an existing "Runner beans" merges them, and an undo that
 * knew only the two names would rename *every* Runner beans back — including
 * the bags that were always called that.
 */
function renameItem_(from, to) {
  const touched = { Inventory: [], History: [] };

  const rename = function (table) {
    return function (v, id) {
      if (keyOf(v) !== keyOf(from)) return undefined;
      touched[table].push(id);
      return to;
    };
  };

  let n = DB.updateColumn('Inventory', 'Item', rename('Inventory'));
  n += DB.updateColumn('History', 'Item', rename('History'));

  // If the new name is already in the catalogue, merging means dropping the
  // old row rather than creating a second entry under the same name. Keep the
  // dropped row so an undo can put it back.
  const items = DB.getAll('Items');
  const hasTarget = items.some(function (r) { return keyOf(r.Item) === keyOf(to); });
  const source = items.filter(function (r) { return keyOf(r.Item) === keyOf(from); })[0];
  let dropped = null;
  if (source && hasTarget) {
    dropped = source;
    DB.deleteByIds('Items', [txt(source.Item)]);
  } else if (source) {
    DB.updateColumn('Items', 'Item', function (v) {
      return keyOf(v) === keyOf(from) ? to : undefined;
    });
  }

  if (!n && !source) throw new Error('Nothing called \u201c' + from + '\u201d to rename.');
  return { renamed: n, touched: touched, dropped: dropped, merged: !!dropped };
}

/** Puts back exactly the rows a rename touched, and nothing else. */
function undoRenameItem_(token) {
  ['Inventory', 'History'].forEach(function (table) {
    const only = {};
    (token.touched[table] || []).forEach(function (id) { only[txt(id)] = true; });
    if (!Object.keys(only).length) return;
    DB.updateColumn(table, 'Item', function (v, id) {
      return only[txt(id)] ? token.back : undefined;
    });
  });

  if (token.dropped) {
    DB.append('Items', [token.dropped]);
  } else {
    DB.updateColumn('Items', 'Item', function (v) {
      return keyOf(v) === keyOf(token.forward) ? token.back : undefined;
    });
  }
}

function renameCategory_(from, to) {
  const touched = { Inventory: [], History: [], Items: [] };

  const rename = function (table) {
    return function (v, id) {
      if (keyOf(v) !== keyOf(from)) return undefined;
      touched[table].push(id);
      return to;
    };
  };

  const n = DB.updateColumn('Inventory', 'Category', rename('Inventory'))
    + DB.updateColumn('History', 'Category', rename('History'))
    + DB.updateColumn('Items', 'Category', rename('Items'));
  if (!n) throw new Error('Nothing filed under \u201c' + from + '\u201d to rename.');
  return { renamed: n, touched: touched };
}

function undoRenameCategory_(token) {
  ['Inventory', 'History', 'Items'].forEach(function (table) {
    const only = {};
    (token.touched[table] || []).forEach(function (id) { only[txt(id)] = true; });
    if (!Object.keys(only).length) return;
    DB.updateColumn(table, 'Category', function (v, id) {
      return only[txt(id)] ? token.back : undefined;
    });
  });
}

/**
 * Records the places things are kept. Until now the only way to do this was to
 * open the spreadsheet and type into the `Stores` tab, which is a fine escape
 * hatch and a poor front door — constraint 1 wants the sheet to stay editable,
 * not to be the only way in.
 *
 * Appends, never replaces, so this is equally the first-run screen and the
 * "add the new shed" case, and no existing row can be lost to it.
 */
function apiSaveStores(p) {
  const wanted = (p && p.stores) || [];
  if (!wanted.length) throw new Error('Please add at least one place before saving.');

  return DB.lock(function () {
    DB.ensure();

    const existing = DB.getAll('Stores')
      .map(function (r) { return keyOf(txt(r.Name)); })
      .filter(Boolean);

    const seen = {};
    const rows = [];

    wanted.forEach(function (s, i) {
      const name = cleanName(s && s.name);
      if (!name) throw new Error('Every place needs a name.');

      const key = keyOf(name);
      if (existing.indexOf(key) >= 0) {
        throw new Error('There is already a place called ' + name + '.');
      }
      if (seen[key]) throw new Error('You have listed ' + name + ' twice.');
      seen[key] = true;

      // Same strictness as reading: this value reaches a CSS custom property,
      // so an unvalidated one silently breaks every dot for that store.
      const colour = /^#[0-9a-f]{3,8}$/i.test(txt(s && s.colour))
        ? txt(s.colour)
        : STORE_COLOURS[(existing.length + i) % STORE_COLOURS.length];

      rows.push({ Name: name, Where: cleanName(s && s.where), Colour: colour });
    });

    DB.append('Stores', rows);
    return { added: rows.length };
  });
}

/**
 * Removes an item from the catalogue — the list the type-ahead suggests from —
 * not any bags. Undoing an add already takes its Items row back out, but a
 * catalogue entry that has outlived its stock had no way out of the app at all:
 * the rename control lives inside an expanded item row, which needs bags to
 * exist, so a typo with nothing under it could only be fixed in the sheet.
 *
 * Refuses while anything is still stored under the name. Deleting the catalogue
 * entry would not remove those bags, it would only make the thing they are
 * called unsuggestable — so the honest answer is to ask for the bags to go
 * first, rather than to quietly do half of what was meant.
 *
 * Removes the catalogue row and the defaults it carries. An item that also
 * appears in History stays suggestable, because the type-ahead reads both — and
 * History is the permanent record, so it is not this call's to edit.
 */
function apiDeleteItem(p) {
  const name = cleanName(p && p.name);
  if (!name) throw new Error('Which item should be removed?');

  return DB.lock(function () {
    DB.ensure();

    const held = DB.getAll('Inventory').filter(function (r) {
      return keyOf(txt(r.Item)) === keyOf(name);
    }).length;
    if (held) {
      throw new Error(
        'There ' + (held === 1 ? 'is still 1 bag' : 'are still ' + held + ' bags') +
        ' of ' + name + ' in a store. Take ' + (held === 1 ? 'it' : 'them') +
        ' out first, then this can be removed.');
    }

    const row = DB.getAll('Items').filter(function (r) {
      return keyOf(txt(r.Item)) === keyOf(name);
    })[0];
    if (!row) throw new Error('There is no item called ' + name + '.');

    DB.deleteByIds('Items', [txt(row.Item)]);
    return {
      removed: txt(row.Item),
      undo: issueUndo_({ type: 'delete-item', row: row }),
    };
  });
}

/**
 * Moves every reference to a place, in step. The name is the join between the
 * Stores tab and the Store column of both Inventory and History, so renaming
 * one by hand means a find-and-replace that cannot tell a place called "Shed"
 * from an item, a note or a category that happens to say the same word — and
 * that gets less safe the more rows there are.
 *
 * `touched` records the exact rows moved, which is what lets an undo put back
 * what this call did and nothing else.
 */
function renameStore_(from, to) {
  const touched = { Inventory: [], History: [] };

  const rename = function (table) {
    return function (v, id) {
      if (keyOf(v) !== keyOf(from)) return undefined;
      touched[table].push(id);
      return to;
    };
  };

  let n = DB.updateColumn('Inventory', 'Store', rename('Inventory'));
  n += DB.updateColumn('History', 'Store', rename('History'));
  return { renamed: n, touched: touched };
}

/** Puts back exactly the rows the rename moved, and the row's own values. */
function undoEditStore_(token) {
  ['Inventory', 'History'].forEach(function (table) {
    const only = {};
    (token.touched[table] || []).forEach(function (id) { only[txt(id)] = true; });
    if (!Object.keys(only).length) return;
    // By id, not by name. A row can name a place that is not in the Stores tab
    // at all — somebody typed it — and if that name is the one just renamed to,
    // matching on the name would drag the stranger back with them.
    DB.updateColumn(table, 'Store', function (v, id) {
      return only[txt(id)] ? token.before.Name : undefined;
    });
  });

  DB.updateById('Stores', token.forward, {
    Name: token.before.Name,
    Where: token.before.Where,
    Colour: token.before.Colour,
  });
}

/**
 * Renames, recolours or re-describes one place. The colour and the description
 * live in a single cell each and are cheap; the name is the hard one, which is
 * why it goes through renameStore_ above.
 */
function apiEditStore(p) {
  const from = cleanName(p && p.from);
  if (!from) throw new Error('Which place should be changed?');

  const wantsName = !!(p && p.to !== undefined && p.to !== null);
  const to = wantsName ? cleanName(p.to) : '';
  if (wantsName && !to) throw new Error('Every place needs a name.');

  return DB.lock(function () {
    DB.ensure();

    const rows = DB.getAll('Stores');
    const row = rows.filter(function (r) { return keyOf(txt(r.Name)) === keyOf(from); })[0];
    if (!row) throw new Error('There is no place called ' + from + '.');

    const was = txt(row.Name);
    // Compared exactly, not by key: "Shed" to "SHED" is the same place to every
    // lookup in the app and still a change the user asked for and should see.
    const renaming = wantsName && to !== was;

    // Only a different place can be collided with — a case change cannot.
    if (renaming && keyOf(to) !== keyOf(from)) {
      const clash = rows.some(function (r) { return keyOf(txt(r.Name)) === keyOf(to); });
      if (clash) {
        throw new Error(
          'There is already a place called ' + to + '. Two places cannot be ' +
          'merged by renaming one onto the other — move the bags across first.');
      }
    }

    const before = { Name: was, Where: txt(row.Where), Colour: txt(row.Colour) };

    const patch = {};
    if (renaming) patch.Name = to;
    if (p.where !== undefined) patch.Where = cleanName(p.where);
    if (p.colour !== undefined) {
      // Same strictness as reading it: this value ends up in a CSS custom
      // property either way.
      patch.Colour = /^#[0-9a-f]{3,8}$/i.test(txt(p.colour))
        ? txt(p.colour)
        : before.Colour || STORE_COLOURS[0];
    }

    const moved = renaming
      ? renameStore_(was, to)
      : { renamed: 0, touched: { Inventory: [], History: [] } };

    // Keyed by the old name: renameStore_ deliberately does not touch Stores.
    if (Object.keys(patch).length) DB.updateById('Stores', was, patch);

    return {
      renamed: moved.renamed,
      name: renaming ? to : was,
      undo: issueUndo_({
        type: 'edit-store',
        before: before,
        forward: renaming ? to : was,
        touched: moved.touched,
      }),
    };
  });
}

/**
 * Moves bags from wherever they are into one place. The freezer filled up and
 * half of it went out to the garage: that is one action about several bags, and
 * doing it a bag at a time through the edit dialog is the sort of errand people
 * stop doing, after which the app is wrong about where things are.
 *
 * History is deliberately untouched. It records what was taken out of where,
 * and a bag that is still in a store has not been taken out of anywhere — so
 * moving it now says nothing about what happened then.
 */
function apiMoveBags(p) {
  const ids = (p && p.ids) || [];
  const to = cleanName(p && p.to);
  if (!ids.length) throw new Error('Choose some bags to move first.');
  if (!to) throw new Error('Which place are they going to?');

  return DB.lock(function () {
    DB.ensure();

    const place = DB.getAll('Stores').filter(function (r) {
      return keyOf(txt(r.Name)) === keyOf(to);
    })[0];
    if (!place) throw new Error('There is no place called ' + to + '.');
    const target = txt(place.Name);

    // Read and check everything before writing anything: a selection made on a
    // screen that has since gone stale should be refused whole rather than
    // applied to whichever half is still there.
    const byId = {};
    DB.getAll('Inventory').forEach(function (r) { byId[txt(r.ID)] = r; });

    const from = {};
    ids.forEach(function (id) {
      const row = byId[txt(id)];
      if (!row) {
        throw new Error(
          'Some of those bags are no longer in a store. Nothing has been moved ' +
          '\u2014 the list will refresh so you can choose again.');
      }
      // Each bag's own place, so an undo can put a mixed selection back where
      // each one came from rather than gathering them all in the first.
      from[txt(id)] = txt(row.Store);
    });

    const want = {};
    ids.forEach(function (id) { want[txt(id)] = true; });

    const moved = DB.updateColumn('Inventory', 'Store', function (v, id) {
      return want[txt(id)] ? target : undefined;
    });

    return {
      moved: moved,
      to: target,
      undo: issueUndo_({ type: 'move-bags', from: from, to: target }),
    };
  });
}

function apiRenameItem(p) {
  const from = cleanName(p && p.from);
  const to = cleanName(p && p.to);
  if (!from || !to) throw new Error('Please give the new name.');
  if (keyOf(from) === keyOf(to)) {
    // "Raspberries" -> "raspberries" is the same name once cleaned. Say so,
    // rather than reloading and reporting a rename that did not happen.
    throw new Error('That is already its name.');
  }
  return DB.lock(function () {
    DB.ensure();
    const res = renameItem_(from, to);
    return {
      renamed: res.renamed,
      merged: res.merged,
      undo: issueUndo_(
        {
          type: 'rename-item', forward: to, back: from,
          touched: res.touched, dropped: res.dropped,
        },
        { table: 'Inventory', ids: res.touched.Inventory },
      ),
    };
  });
}

function apiRenameCategory(p) {
  const from = cleanName(p && p.from);
  const to = cleanName(p && p.to);
  if (!from || !to) throw new Error('Please give the new name.');
  if (keyOf(from) === keyOf(to)) throw new Error('That is already its name.');
  return DB.lock(function () {
    DB.ensure();
    const res = renameCategory_(from, to);
    return {
      renamed: res.renamed,
      undo: issueUndo_(
        { type: 'rename-category', forward: to, back: from, touched: res.touched },
        { table: 'Inventory', ids: res.touched.Inventory },
      ),
    };
  });
}

/**
 * Reverses one action. `handle` is the opaque string the mutating call returned
 * — the token itself never leaves the server, and a handle works exactly once.
 */
function apiUndo(handle) {
  return DB.lock(function () {
    DB.ensure();

    const token = DB.tokens.take(txt(handle));
    if (!token || !token.type) {
      // Covers all three ways this happens — expired, already used, or never
      // issued — without accusing anyone of the third.
      throw new Error('That can no longer be undone.');
    }
    verifyUndo_(token);

    if (token.type === 'add') {
      DB.deleteByIds('Inventory', token.ids || []);
      // An add that introduced a new item also created its catalogue row.
      // Leaving that behind is how a typo becomes permanent.
      if (token.itemCreated) {
        const stillUsed = DB.getAll('Inventory').concat(DB.getAll('History'))
          .some(function (r) { return keyOf(r.Item) === keyOf(token.itemCreated); });
        if (!stillUsed) DB.deleteByIds('Items', [token.itemCreated]);
      }
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
          Store: txt(r.Store),
          'Weight (g)': Math.round(num(r['Weight (g)'])) || '',
          'Date In': normDate(r['Date In']),
          Note: txt(r.Note),
          Count: Math.round(num(r.Count)) || '',
          Unit: txt(r.Unit),
          'Month only': txt(r['Month only']),
        };
      }));
      DB.deleteByIds('History', Object.keys(ids));
      return { ok: true };
    }

    if (token.type === 'part') {
      const lot = DB.getAll('Inventory').filter(function (r) { return txt(r.ID) === txt(token.id); })[0];
      if (!lot) throw new Error('That bag is no longer in the store.');
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
    if (token.type === 'delete-item') {
      DB.append('Items', [token.row]);
      return { undone: 'delete-item' };
    }

    if (token.type === 'move-bags') {
      DB.updateColumn('Inventory', 'Store', function (v, id) {
        const back = token.from[txt(id)];
        return back === undefined ? undefined : back;
      });
      return { ok: true };
    }

    if (token.type === 'edit-store') {
      undoEditStore_(token);
      return { ok: true };
    }

    if (token.type === 'rename-item') {
      undoRenameItem_(token);
      return { ok: true };
    }

    if (token.type === 'rename-category') {
      undoRenameCategory_(token);
      return { ok: true };
    }

    throw new Error('That can no longer be undone.');
  });
}
