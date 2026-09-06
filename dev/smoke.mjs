/** Exercises every backend operation against an empty in-memory store. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

let B = null;
const store = {};

// Setup no longer invents places, so the fixture supplies its own. Kept here
// rather than in the backend because these exist for the tests, not for users.
let seedStores = true;

const FIXTURE_STORES = [
  { Name: 'Kitchen', Where: 'Fridge-freezer indoors', Colour: '#5F8A20' },
  { Name: 'Garage', Where: 'Chest freezer', Colour: '#7A3FA2' },
];

const DB = {
  ensure() {
    Object.keys(B.TABLES).forEach((n) => { if (!store[n]) store[n] = []; });
    if (seedStores && !store.Stores.length) DB.append('Stores', FIXTURE_STORES);
  },
  today: () => '2026-08-19',
  sheetUrl: () => '',
  getAll: (n) => (store[n] || []).map((r) => ({ ...r })),
  append(n, objs) {
    store[n] = store[n] || [];
    objs.forEach((o) => {
      const row = {};
      B.TABLES[n].forEach((h) => { row[h] = o[h] === undefined ? '' : o[h]; });
      store[n].push(row);
    });
  },
  updateById(n, id, patch) {
    const key = B.TABLES[n][0];
    const row = (store[n] || []).find((r) => String(r[key]) === String(id));
    if (row) Object.assign(row, patch);
  },
  updateColumn(n, header, fn) {
    const key = B.TABLES[n][0];
    let changed = 0;
    for (const row of store[n] || []) {
      const next = fn(row[header], String(row[key] ?? '').trim());
      if (next !== undefined && next !== row[header]) { row[header] = next; changed++; }
    }
    return changed;
  },
  deleteByIds(n, ids) {
    const key = B.TABLES[n][0];
    const w = new Set(ids.map(String));
    store[n] = (store[n] || []).filter((r) => !w.has(String(r[key])));
  },
  tokens: (() => {
    const held = new Map();
    return {
      put(handle, value, ttlSeconds) {
        held.set(handle, { value: JSON.parse(JSON.stringify(value)), until: Date.now() + ttlSeconds * 1000 });
      },
      take(handle) {
        const row = held.get(handle);
        if (!row) return null;
        held.delete(handle);
        return row.until < Date.now() ? null : row.value;
      },
    };
  })(),

  lock: (fn) => fn(),
};

const code = readFileSync(join(SRC, 'backend.js'), 'utf8');
B = new Function('DB', `${code}
  return { TABLES, SUGGESTED_STORES, apiGetState, apiAdd, apiRemove, apiRemovePart, apiUndo,
           apiEditLot, apiSplitLot, apiRenameItem, apiRenameCategory, apiSaveStores,
           apiDeleteItem, apiEditStore };`)(DB);

const stock = () => B.apiGetState().inventory;
const keyish = (v) => String(v || '').trim().toLowerCase();
const total = () => stock().reduce((t, l) => t + l.weightG, 0);

/* --- empty sheet --- */
let st = B.apiGetState();
assert.equal(st.inventory.length, 0, 'starts empty');
assert.equal(st.stores.length, 2, 'seeds two example stores');
assert.ok(st.categories.includes('Fruit'), 'offers default categories');

/* --- adding --- */
const add = B.apiAdd({ item: 'raspberries', category: 'Fruit', store: 'Garage', weightG: 500, qty: 3, dateIn: '2026-07-04' });
assert.equal(add.lots.length, 3, 'three bags created');
assert.equal(total(), 1500);
assert.equal(store.Items.length, 1, 'new item added to the catalogue');
assert.equal(store.Items[0].Item, 'Raspberries', 'name tidied on the way in');

B.apiAdd({ item: 'Raspberries', category: 'Fruit', store: 'Garage', weightG: 500, qty: 1 });
assert.equal(store.Items.length, 1, 'known item not duplicated in the catalogue');
assert.ok(stock().every((l) => l.dateIn), 'every bag has a date');

/* --- taking a whole bag out --- */
const ids = [stock()[0].id];
const rm = B.apiRemove({ ids, dateOut: '2026-08-19' });
assert.equal(total(), 1500, '2000 - 500');
assert.equal(store.History.length, 1);
assert.equal(store.History[0]['Date Out'], '2026-08-19');

/* --- undoing that --- */
B.apiUndo(rm.undo);
assert.equal(total(), 2000, 'bag is back');
assert.equal(store.History.length, 0, 'history row removed');
// A handle is burned on first use, so the second attempt cannot tell whether
// it was spent, expired or never issued — and says so without guessing.
assert.throws(() => B.apiUndo(rm.undo), /no longer be undone/, 'undoing twice is refused');

/* --- taking part of a bag --- */
const target = stock()[0];
const part = B.apiRemovePart({ id: target.id, weightG: 200, dateOut: '2026-08-19' });
assert.equal(total(), 1800);
assert.equal(stock().find((l) => l.id === target.id).weightG, 300, 'remainder left behind');
assert.equal(store.History[0]['Weight (g)'], 200);

B.apiUndo(part.undo);
assert.equal(total(), 2000, 'partial take-out reversed');
assert.equal(stock().find((l) => l.id === target.id).weightG, 500);
assert.equal(store.History.length, 0);

/* --- asking for more than is there takes the whole bag --- */
const whole = B.apiRemovePart({ id: target.id, weightG: 9999 });
// The token itself no longer leaves the server, so assert the behaviour
// rather than its shape: the bag is gone from Inventory, not decremented.
assert.equal(typeof whole.undo, 'string', 'the undo is an opaque handle');
assert.ok(!stock().some((l) => l.id === target.id), 'falls back to a whole-bag removal');
assert.equal(total(), 1500);
B.apiUndo(whole.undo);

/* --- undoing an add --- */
B.apiUndo(add.undo);
assert.equal(total(), 500, 'the three original bags are gone');

/* --- validation --- */
assert.throws(() => B.apiAdd({ item: '', store: 'Garage', weightG: 100 }), /what you are freezing/);
assert.throws(() => B.apiAdd({ item: 'Peas', store: '', weightG: 100 }), /which store/);
assert.throws(() => B.apiAdd({ item: 'Peas', store: 'Garage', weightG: 0 }), /enter a weight/);
assert.throws(() => B.apiRemove({ ids: [] }), /Nothing selected/);
assert.throws(() => B.apiRemove({ ids: ['nope'] }), /no longer in the store/);

/* --- weights are kept exactly as entered --- */
const odd = B.apiAdd({ item: 'Plums', category: 'Fruit', store: 'Garage', weightG: 447, qty: 1 });
assert.equal(odd.lots[0].weightG, 447, '447 g stays 447 g');

const oddPart = B.apiRemovePart({ id: odd.lots[0].id, weightG: 123 });
assert.equal(stock().find((l) => l.id === odd.lots[0].id).weightG, 324, '447 - 123');
B.apiUndo(oddPart.undo);
B.apiUndo(odd.undo);

/* --- counted bags: sweetcorn on the cob --- */
const corn = B.apiAdd({
  item: 'Sweetcorn', category: 'Vegetables', store: 'Garage',
  weightG: 900, count: 6, unit: 'cobs', qty: 2, dateIn: '2026-08-01',
});
assert.equal(corn.lots[0].count, 6, 'count recorded');
assert.equal(corn.lots[0].unit, 'cobs', 'unit recorded');
assert.equal(store.Items.find((r) => r.Item === 'Sweetcorn').Unit, 'cobs', 'unit remembered for next time');
assert.equal(store.Items.find((r) => r.Item === 'Sweetcorn')['Typical count'], 6);

/* a count with no weight at all */
const noWeigh = B.apiAdd({ item: 'Globe artichokes', category: 'Vegetables', store: 'Garage', count: 4, unit: 'heads' });
assert.equal(noWeigh.lots[0].weightG, 0, 'no weight is fine when there is a count');
assert.equal(noWeigh.lots[0].count, 4);
assert.throws(
  () => B.apiAdd({ item: 'Peas', category: 'Vegetables', store: 'Garage' }),
  /weight, or how many/, 'one measure or the other is required',
);

/* taking some of the cobs splits the weight in the same proportion */
const cornLot = corn.lots[0].id;
const twoCobs = B.apiRemovePart({ id: cornLot, count: 2, dateOut: '2026-08-19' });
const rest = stock().find((l) => l.id === cornLot);
assert.equal(rest.count, 4, '6 cobs less 2');
assert.equal(rest.weightG, 600, '900 g follows the count');
assert.equal(store.History.at(-1)['Weight (g)'], 300, 'the 2 cobs took 300 g with them');
assert.equal(store.History.at(-1).Unit, 'cobs');

B.apiUndo(twoCobs.undo);
const restored = stock().find((l) => l.id === cornLot);
assert.equal(restored.count, 6, 'cobs put back');
assert.equal(restored.weightG, 900, 'weight put back');

/* asking for all of them falls through to a whole-bag removal */
const allCobs = B.apiRemovePart({ id: cornLot, count: 99 });
assert.equal(typeof allCobs.undo, 'string', 'the undo is an opaque handle');
B.apiUndo(allCobs.undo);

B.apiUndo(noWeigh.undo);
B.apiUndo(corn.undo);

/* --- correcting a bag rather than deleting it --- */
const fix = B.apiAdd({ item: 'Kale', category: 'Vegetables', store: 'Garage', weightG: 300, qty: 1, dateIn: '2026-01-05' });
const fixId = fix.lots[0].id;
const edited = B.apiEditLot({ id: fixId, patch: { store: 'Kitchen', dateIn: '2025-11-20', weightG: 320, note: 'top bed' } });
assert.equal(edited.lot.store, 'Kitchen');
assert.equal(edited.lot.dateIn, '2025-11-20');
assert.equal(edited.lot.weightG, 320);
assert.equal(edited.lot.note, 'top bed');

B.apiUndo(edited.undo);
const back = stock().find((l) => l.id === fixId);
assert.equal(back.store, 'Garage', 'edit undone');
assert.equal(back.dateIn, '2026-01-05');
assert.equal(back.weightG, 300);

assert.throws(() => B.apiEditLot({ id: fixId, patch: { weightG: 0 } }), /weight, or how many/);
assert.throws(() => B.apiEditLot({ id: fixId, patch: { store: '' } }), /which store/);
B.apiUndo(fix.undo);

/* --- splitting one tub of blocks into single blocks --- */
const tub = B.apiAdd({ item: 'Ratatouille', category: 'Prepared', store: 'Garage', weightG: 1000, count: 8, unit: 'blocks', qty: 1 });
const tubId = tub.lots[0].id;
const split = B.apiSplitLot({ id: tubId, into: 8 });
assert.equal(split.lots.length, 8, 'eight bags out of one');
assert.ok(split.lots.every((l) => l.count === 1), 'one block each');
assert.equal(split.lots.reduce((t, l) => t + l.weightG, 0), 1000, 'weight is conserved');
assert.deepEqual(split.lots.map((l) => l.weightG), [125, 125, 125, 125, 125, 125, 125, 125]);
assert.ok(!stock().some((l) => l.id === tubId), 'the original is gone');

B.apiUndo(split.undo);
const whole2 = stock().find((l) => l.id === tubId);
assert.equal(whole2.count, 8, 'split undone');
assert.equal(whole2.weightG, 1000);
assert.equal(stock().filter((l) => l.item === 'Ratatouille').length, 1);

/* an odd weight spreads the remainder onto the first bags */
const odd3 = B.apiSplitLot({ id: tubId, into: 3 });
assert.deepEqual(odd3.lots.map((l) => l.weightG), [334, 333, 333]);
assert.deepEqual(odd3.lots.map((l) => l.count), [3, 3, 2]);
B.apiUndo(odd3.undo);

assert.throws(() => B.apiSplitLot({ id: tubId, into: 20 }), /only 8 to share out/);
assert.throws(() => B.apiSplitLot({ id: tubId, into: 1 }), /between 2 and 99/);
B.apiUndo(tub.undo);

/* --- renaming an item everywhere it appears --- */
const fb = B.apiAdd({ item: 'French beans', category: 'Vegetables', store: 'Garage', weightG: 400, qty: 3 });
const gone = B.apiRemove({ ids: [stock().find((l) => l.item === 'French beans').id] });
const ren = B.apiRenameItem({ from: 'French beans', to: 'French beans (green)' });
assert.equal(ren.renamed, 3, 'two in the store and one in history');
assert.equal(stock().filter((l) => l.item === 'French beans (green)').length, 2);
assert.equal(store.History.filter((r) => r.Item === 'French beans (green)').length, 1);
assert.equal(store.Items.filter((r) => r.Item === 'French beans (green)').length, 1, 'catalogue follows');
assert.equal(store.Items.filter((r) => r.Item === 'French beans').length, 0, 'old name gone');

B.apiUndo(ren.undo);
assert.equal(stock().filter((l) => l.item === 'French beans').length, 2, 'rename undone');

/* renaming onto a name that already exists merges the catalogue entries */
B.apiAdd({ item: 'Runner beans', category: 'Vegetables', store: 'Garage', weightG: 400, qty: 1 });
B.apiRenameItem({ from: 'French beans', to: 'Runner beans' });
assert.equal(store.Items.filter((r) => keyish(r.Item) === 'runner beans').length, 1, 'no duplicate catalogue row');
assert.throws(() => B.apiRenameItem({ from: 'Nothing here', to: 'X' }), /to rename/);

/* --- renaming a category --- */
const cat = B.apiRenameCategory({ from: 'Vegetables', to: 'Veg & salad' });
assert.ok(cat.renamed > 0);
assert.ok(stock().filter((l) => l.item === 'Runner beans').every((l) => l.category === 'Veg & salad'));
B.apiUndo(cat.undo);
assert.ok(stock().filter((l) => l.item === 'Runner beans').every((l) => l.category === 'Vegetables'));

B.apiRemove({ ids: stock().filter((l) => l.item === 'Runner beans').map((l) => l.id) });

/* --- hand-edited sheet: a row typed straight in, with a UK date --- */
DB.append('Inventory', [{
  ID: 'HAND1', Item: 'Damsons', Category: 'Fruit', Store: 'Garage',
  'Weight (g)': '750', 'Date In': '03/09/2025', Note: 'from the hedge',
}]);
st = B.apiGetState();
const hand = st.inventory.find((l) => l.id === 'HAND1');
assert.equal(hand.dateIn, '2025-09-03', 'dd/mm/yyyy read correctly');
assert.equal(hand.weightG, 750, 'text weight read as a number');
assert.ok(st.items.some((i) => i.name === 'Damsons'), 'hand-typed item joins the suggestions');

/* ==========================================================================
   "And then something else happened."

   The existing checks above undo every action immediately after performing it,
   which is the shape the code was written in — and is why four Critical
   findings survived to the first review. These do the other thing: perform an
   action, perform a different one, then reach for the first undo.
   ========================================================================== */

const fresh = () => {
  for (const k of Object.keys(store)) delete store[k];
  DB.ensure();
};

/* --- D6: a batch must not mint two rows with the same ID --- */
fresh();
for (let trial = 0; trial < 200; trial++) {
  store.Inventory = [];
  B.apiAdd({
    item: 'Raspberries', category: 'Fruit', store: 'Kitchen',
    weightG: 500, qty: 99, dateIn: '2026-08-01',
  });
  const ids = store.Inventory.map((r) => r.ID);
  assert.equal(new Set(ids).size, ids.length, `D6: duplicate ID in batch on trial ${trial}`);
}

/* --- D4: undoing an add whose bags were since split must refuse, not lie --- */
fresh();
const added2 = B.apiAdd({
  item: 'Blackcurrants', category: 'Fruit', store: 'Kitchen',
  weightG: 800, qty: 1, dateIn: '2026-08-01',
});
B.apiSplitLot({ id: added2.lots[0].id, into: 4 });
assert.equal(stock().length, 4, 'D4: split produced four bags');
assert.throws(
  () => B.apiUndo(added2.undo),
  /no longer be undone|cannot be undone|has changed/i,
  'D4: a stale add-undo must say so rather than reporting success',
);
assert.equal(stock().length, 4, 'D4: nothing was touched by the refused undo');

/* --- D4: undoing a part2-removal after an edit must not add onto the new value --- */
fresh();
const corn2 = B.apiAdd({
  item: 'Sweetcorn', category: 'Vegetables', store: 'Kitchen',
  weightG: 900, count: 6, unit: 'cobs', qty: 1, dateIn: '2026-08-01',
});
const part2 = B.apiRemovePart({ id: corn2.lots[0].id, count: 2, dateOut: '2026-08-10' });
B.apiEditLot({ id: corn2.lots[0].id, patch: { weightG: 100 } });
assert.throws(
  () => B.apiUndo(part2.undo),
  /no longer be undone|cannot be undone|has changed/i,
  'D4: a part2-undo across an edit must refuse',
);
assert.equal(stock()[0].weightG, 100, 'D4: the edit survived the refused undo');

/* --- D5: undoing a merged rename must not rename bags it never touched --- */
fresh();
B.apiAdd({ item: 'French beans', category: 'Vegetables', store: 'Kitchen', weightG: 300, qty: 2, dateIn: '2026-08-01' });
B.apiAdd({ item: 'Runner beans', category: 'Vegetables', store: 'Kitchen', weightG: 300, qty: 3, dateIn: '2026-08-01' });
const merged = B.apiRenameItem({ from: 'French beans', to: 'Runner beans' });
assert.equal(stock().filter((l) => l.item === 'Runner beans').length, 5, 'D5: merge happened');
assert.ok(merged.merged, 'D5: the merge is reported to the caller');
assert.ok(merged.undo, 'D5: a merge is still reversible');
B.apiUndo(merged.undo);
assert.equal(stock().filter((l) => l.item === 'French beans').length, 2, 'D5: only the two merged bags go back');
assert.equal(stock().filter((l) => l.item === 'Runner beans').length, 3, 'D5: the three originals stay put');
assert.ok(
  B.apiGetState().items.some((i) => i.name === 'French beans'),
  'D5: the dropped catalogue row is restored',
);

/* --- a case-only rename is refused rather than reported as a success --- */
assert.throws(
  () => B.apiRenameItem({ from: 'Runner beans', to: 'runner beans' }),
  /already its name/i,
  'a rename that cleanName collapses to the same string must say so',
);

/* --- undoing an add takes the catalogue row it created with it --- */
fresh();
const typo = B.apiAdd({ item: 'Rasberries', category: 'Fruit', store: 'Kitchen', weightG: 500, qty: 1, dateIn: '2026-08-01' });
assert.ok(B.apiGetState().items.some((i) => i.name === 'Rasberries'), 'the typo is in the catalogue');
B.apiUndo(typo.undo);
assert.ok(
  !B.apiGetState().items.some((i) => i.name === 'Rasberries'),
  'undoing the add removes the catalogue row it created',
);

/* --- D3: an undo token the server never issued must be refused --- */
fresh();
const forged = B.apiAdd({ item: 'Figs', category: 'Fruit', store: 'Kitchen', weightG: 400, qty: 2, dateIn: '2026-08-01' });
assert.throws(
  () => B.apiUndo({ type: 'add', ids: stock().map((l) => l.id) }),
  /no longer be undone|cannot be undone/i,
  'D3: a hand-written token must not be accepted as authority to delete',
);
assert.equal(stock().length, 2, 'D3: nothing was deleted by the forged token');

/* --- ...and a real handle works once, then is spent --- */
B.apiUndo(forged.undo);
assert.equal(stock().length, 0, 'a genuine undo still works');
assert.throws(
  () => B.apiUndo(forged.undo),
  /no longer be undone|already/i,
  'a spent handle is refused the second time',
);

/* --- first-run: naming the places from inside the app --- */
seedStores = false;
fresh();
assert.equal(B.apiGetState().stores.length, 0, 'setup no longer invents places');

B.apiSaveStores({ stores: [
  { name: 'Shed', where: 'Chest freezer', colour: '#1F7A6B' },
  { name: 'Pantry', where: '', colour: '' },
] });
const saved = B.apiGetState().stores;
assert.equal(saved.length, 2, 'both places were written');
assert.equal(saved[0].name, 'Shed');
assert.equal(saved[0].colour, '#1F7A6B', 'a chosen colour is kept');
assert.match(saved[1].colour, /^#[0-9a-f]{6}$/i, 'a blank colour falls back to the palette');

/* Appends rather than replaces, so it is also the "add the new shed" case. */
B.apiSaveStores({ stores: [{ name: 'Cellar', where: '', colour: '' }] });
assert.equal(B.apiGetState().stores.length, 3, 'a later save adds rather than replaces');

assert.throws(
  () => B.apiSaveStores({ stores: [{ name: 'shed', where: '', colour: '' }] }),
  /already a place called/i,
  'a name that differs only by case is still the same place',
);
assert.throws(
  () => B.apiSaveStores({ stores: [{ name: '  ', where: '', colour: '' }] }),
  /needs a name/i,
  'a blank name is refused',
);
assert.throws(
  () => B.apiSaveStores({ stores: [
    { name: 'Loft', where: '', colour: '' },
    { name: 'Loft', where: '', colour: '' },
  ] }),
  /twice/i,
  'the same name twice in one save is refused',
);
assert.equal(B.apiGetState().stores.length, 3, 'nothing was written by the refused saves');

/* A colour reaches a CSS custom property, so it is validated on the way in. */
B.apiSaveStores({ stores: [{ name: 'Porch', where: '', colour: 'red; }" onload="' }] });
const porch = B.apiGetState().stores.filter((f) => f.name === 'Porch')[0];
assert.match(porch.colour, /^#[0-9a-f]{6}$/i, 'a colour that is not a hex code never reaches the sheet');

/* --- removing a catalogue entry, and refusing to while it holds stock --- */
seedStores = true;
fresh();
B.apiAdd({ item: 'Rasberries', category: 'Fruit', store: 'Kitchen', weightG: 300, qty: 1, dateIn: '2026-08-01' });
assert.throws(
  () => B.apiDeleteItem({ name: 'Rasberries' }),
  /still 1 bag[\s\S]*Take it out first/i,
  'an item with stock is refused, and says what to do about it',
);
assert.equal(store.Items.filter((r) => r.Item === 'Rasberries').length, 1,
  'the refused delete left the catalogue row alone');

/* The case this exists for: a catalogue row with no bags and no history, which
   until now could only be reached by opening the spreadsheet. */
fresh();
store.Items.push({ Item: 'Rasberries', Category: 'Fruit', 'Typical weight (g)': 300 });
assert.equal(B.apiGetState().items.filter((i) => i.name === 'Rasberries').length, 1,
  'a stray catalogue row is suggested by the type-ahead');

const dropped = B.apiDeleteItem({ name: 'Rasberries' });
assert.equal(store.Items.filter((r) => r.Item === 'Rasberries').length, 0, 'the row is gone');
assert.equal(B.apiGetState().items.filter((i) => i.name === 'Rasberries').length, 0,
  'and it stops being suggested');

/* Constraint 3: everything is undoable, including this. */
B.apiUndo(dropped.undo);
assert.equal(store.Items.filter((r) => r.Item === 'Rasberries').length, 1,
  'undo puts the catalogue row back');

/* everStored is what the settings screen offers Remove on: a catalogue row
   nothing has ever been kept under. Removing one that has been stored would
   leave it suggested from History, so the control is withheld instead. */
fresh();
store.Items.push({ Item: 'Neverused', Category: 'Fruit' });
B.apiAdd({ item: 'Damsons', category: 'Fruit', store: 'Kitchen', weightG: 400, qty: 1, dateIn: '2026-08-01' });
const catalogue = B.apiGetState().items;
assert.equal(catalogue.filter((i) => i.name === 'Neverused')[0].everStored, false,
  'a catalogue row with no bags and no history has never been stored');
assert.equal(catalogue.filter((i) => i.name === 'Damsons')[0].everStored, true,
  'something with bags has been');

assert.throws(
  () => B.apiDeleteItem({ name: 'Never existed' }),
  /no item called/i,
  'removing something that is not there says so',
);

/* ===================================================================
   apiEditStore — renaming a place, which is the change that is genuinely
   hard to do by hand: the name is the join between the Stores tab and
   every row in Inventory and History, and a spreadsheet find-and-replace
   has no idea which columns it is allowed to touch.
   =================================================================== */

const placeFixture = () => {
  seedStores = false;
  fresh();
  DB.append('Stores', [
    { Name: 'Kitchen', Where: 'Fridge-freezer', Colour: '#5F8A20' },
    { Name: 'Shed', Where: 'Down the garden', Colour: '#7A3FA2' },
    { Name: 'Garage', Where: 'Chest freezer', Colour: '#B53464' },
  ]);
  B.apiAdd({ item: 'Plums', category: 'Fruit', store: 'Shed', weightG: 500, qty: 2, dateIn: '2026-07-01' });
  B.apiAdd({ item: 'Peas', category: 'Vegetables', store: 'Kitchen', weightG: 300, qty: 1, dateIn: '2026-07-02' });
  B.apiAdd({ item: 'Beans', category: 'Vegetables', store: 'Shed', weightG: 400, qty: 1, dateIn: '2026-07-03' });
  // one bag through History too, so the rename has to reach both tables
  const out = B.apiGetState().inventory.filter((l) => l.item === 'Beans')[0];
  B.apiRemove({ ids: [out.id] });
};

const placesNamed = (n) => B.apiGetState().stores.filter((f) => f.name === n);
const invIn = (n) => store.Inventory.filter((r) => r.Store === n).length;
const histIn = (n) => store.History.filter((r) => r.Store === n).length;

/* --- the whole point: the name is updated everywhere it is a reference --- */
placeFixture();
assert.equal(invIn('Shed'), 2, 'fixture: two bags in the Shed');
assert.equal(histIn('Shed'), 1, 'fixture: one gone from the Shed');

const moved = B.apiEditStore({ from: 'Shed', to: 'Bottom shed' });
assert.equal(placesNamed('Bottom shed').length, 1, 'the Stores row is renamed');
assert.equal(placesNamed('Shed').length, 0, 'and the old name is gone from Stores');
assert.equal(invIn('Bottom shed'), 2, 'every Inventory row follows the rename');
assert.equal(histIn('Bottom shed'), 1, 'and so does History');
assert.equal(invIn('Shed') + histIn('Shed'), 0, 'nothing is left pointing at the old name');

/* --- and nowhere it is not: the other places must not move --- */
assert.equal(invIn('Kitchen'), 1, 'a different place keeps its bags');
assert.equal(placesNamed('Kitchen').length, 1, 'and its Stores row');
assert.equal(placesNamed('Garage').length, 1, 'an untouched place is still there');

/* --- undo puts back exactly what moved --- */
B.apiUndo(moved.undo);
assert.equal(placesNamed('Shed').length, 1, 'undo restores the Stores row');
assert.equal(invIn('Shed'), 2, 'and the Inventory rows');
assert.equal(histIn('Shed'), 1, 'and the History rows');
assert.equal(invIn('Bottom shed') + histIn('Bottom shed'), 0, 'with nothing left under the new name');

/* --- a case-only rename is a real rename, not a no-op --- */
placeFixture();
B.apiEditStore({ from: 'Shed', to: 'SHED' });
assert.equal(store.Stores.filter((r) => r.Name === 'SHED').length, 1, 'case-only rename reaches Stores');
assert.equal(invIn('SHED'), 2, 'and the rows that referenced it');

/* --- a row typed into the sheet by hand, in the wrong case, still follows --- */
placeFixture();
store.Inventory[0].Store = 'shed';
B.apiEditStore({ from: 'Shed', to: 'Bottom shed' });
assert.equal(invIn('Bottom shed'), 2, 'a hand-typed "shed" is matched the same way the app matches it');

/* --- THE HARD ONE: undo must not capture rows that were never moved.
   An Inventory row can name a place that is not in the Stores tab at all —
   somebody typed it. If the rename target collides with that orphan, undoing
   must leave the orphan alone. This is CR-D5 in a different table. --- */
placeFixture();
store.Inventory.push({
  ID: 'ORPHAN1', Item: 'Rhubarb', Category: 'Fruit', Store: 'Bottom shed',
  'Weight (g)': 250, 'Date In': '2026-06-01', Note: '', Count: '', Unit: '', 'Month only': '',
});
const collide = B.apiEditStore({ from: 'Shed', to: 'Bottom shed' });
assert.equal(invIn('Bottom shed'), 3, 'the two moved bags now sit beside the orphan');
B.apiUndo(collide.undo);
assert.equal(invIn('Shed'), 2, 'undo returns the two that moved');
assert.equal(invIn('Bottom shed'), 1, 'and leaves the orphan where it was');
assert.equal(store.Inventory.filter((r) => r.ID === 'ORPHAN1')[0].Store, 'Bottom shed',
  'the orphan specifically is untouched');

/* --- renaming onto a place that already exists is refused, not merged.
   Merging two places means every bag in one is now physically somewhere else,
   which is a claim about the world the app cannot check. --- */
placeFixture();
assert.throws(
  () => B.apiEditStore({ from: 'Shed', to: 'Garage' }),
  /already a place called/i,
  'renaming onto an existing place is refused',
);
assert.equal(invIn('Shed'), 2, 'and nothing moved in the attempt');
assert.equal(placesNamed('Shed').length, 1, 'the place is still there');

/* --- recolouring: one cell, and nothing else --- */
placeFixture();
B.apiEditStore({ from: 'Shed', colour: '#00699B', where: 'Behind the greenhouse' });
const shed = placesNamed('Shed')[0];
assert.equal(shed.colour, '#00699B', 'the colour changes');
assert.equal(shed.where, 'Behind the greenhouse', 'and the description');
assert.equal(shed.name, 'Shed', 'while the name is left alone');
assert.equal(invIn('Shed'), 2, 'and no bag is touched by a recolour');

/* --- a colour reaches a CSS custom property, so it is validated here too --- */
placeFixture();
B.apiEditStore({ from: 'Shed', colour: 'red; } body { display:none' });
assert.match(placesNamed('Shed')[0].colour, /^#[0-9a-f]{3,8}$/i,
  'a colour that is not a hex code never reaches the sheet');

/* --- renaming a place with nothing in it still renames the place --- */
placeFixture();
B.apiEditStore({ from: 'Garage', to: 'Car port' });
assert.equal(placesNamed('Car port').length, 1, 'an empty place renames fine');

/* --- refusals --- */
placeFixture();
assert.throws(() => B.apiEditStore({ from: 'Shed', to: '   ' }), /needs a name/i,
  'a blank new name is refused');
assert.throws(() => B.apiEditStore({ from: 'Nowhere', to: 'Somewhere' }), /no place called/i,
  'renaming something that is not there says so');
assert.equal(invIn('Shed'), 2, 'no refusal moved anything');

/* --- renaming to itself is allowed and changes nothing --- */
placeFixture();
B.apiEditStore({ from: 'Shed', to: 'Shed' });
assert.equal(invIn('Shed'), 2, 'renaming to the same name is harmless');
assert.equal(placesNamed('Shed').length, 1, 'and does not duplicate the row');

seedStores = true;

console.log('All backend checks passed.');
