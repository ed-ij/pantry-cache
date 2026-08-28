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
  Inventory: ['ID', 'Item', 'Category', 'Freezer', 'Weight (g)', 'Date In', 'Note', 'Count', 'Unit', 'Month only'],
  History: ['ID', 'Item', 'Category', 'Freezer', 'Weight (g)', 'Date In', 'Date Out', 'Note', 'Count', 'Unit', 'Month only'],
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
    freezer: txt(r.Freezer),
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

  const freezers = DB.getAll('Freezers')
    .filter(function (r) { return txt(r.Name); })
    .map(function (r, i) {
      return {
        name: txt(r.Name),
        where: txt(r.Where),
        // The colour is handed to CSS as a custom property. `var(--fz, fallback)`
        // only uses its fallback when the property is *unset*, so a cell holding
        // "2f7fd0" — the hash left off, which the README invites by asking for
        // hex codes — set it to something invalid and every dot for that freezer
        // disappeared rather than going grey. This is also the one place sheet
        // data reaches a style context, so it is worth being strict.
        colour: /^#[0-9a-f]{3,8}$/i.test(txt(r.Colour))
          ? txt(r.Colour)
          : FREEZER_COLOURS[i % FREEZER_COLOURS.length],
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
  // currently in the freezers, so it is not sent over the wire.
  return {
    freezers: freezers,
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
        keyOf(r.Unit), keyOf(r.Freezer), normDate(r['Date In']),
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

/** Returns true when it added a new row to the catalogue, false when it did not. */
function ensureItemType(name, category, typicalG, typicalCount, unit) {
  const existing = DB.getAll('Items');
  for (let i = 0; i < existing.length; i++) {
    if (keyOf(existing[i].Item) !== keyOf(name)) continue;
    // Known item: only fill in a unit it does not have yet, never overwrite.
    if (unit && !txt(existing[i].Unit)) {
      DB.updateById('Items', existing[i].Item, { Unit: unit, 'Typical count': typicalCount || '' });
    }
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
    const monthOnly = p.monthOnly ? 'yes' : '';
    const note = txt(p.note);

    const itemCreated = ensureItemType(item, category, weightG, count, unit);

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
      Freezer: txt(r.Freezer),
      'Weight (g)': Math.round(num(r['Weight (g)'])) || '',
      'Date In': normDate(r['Date In']),
      'Date Out': dateOut,
      Note: txt(r.Note),
      Count: Math.round(num(r.Count)) || '',
      Unit: txt(r.Unit),
      'Month only': txt(r['Month only']),
    });
  });
  if (!foundIds.length) throw new Error('Those bags are no longer in the freezer.');

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
    if ('monthOnly' in src) patch['Month only'] = src.monthOnly ? 'yes' : '';
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
          Freezer: txt(r.Freezer),
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
