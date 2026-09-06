/** Generates dev/seed.json — realistic-looking sample data for local testing. */
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const STORES = [
  { Name: 'Kitchen', Where: 'Fridge-store, top drawer', Colour: '#2f7fd0' },
  { Name: 'Garage', Where: 'Big chest store', Colour: '#2c8f68' },
  { Name: 'Utility', Where: 'Upright by the back door', Colour: '#c0632a' },
];

// [name, category, weight, stores, months, count, pieces, unit]
const CATALOGUE = [
  ['Raspberries', 'Fruit', 500, ['Garage', 'Kitchen'], ['2025-07', '2025-08', '2026-07'], 6],
  ['Blackcurrants', 'Fruit', 500, ['Garage'], ['2025-07', '2026-07'], 5],
  ['Redcurrants', 'Fruit', 400, ['Garage'], ['2025-07'], 2],
  ['Gooseberries', 'Fruit', 750, ['Garage'], ['2025-06', '2026-06'], 3],
  ['Blackberries', 'Fruit', 500, ['Utility'], ['2025-09'], 4],
  ['Rhubarb', 'Fruit', 1000, ['Garage', 'Utility'], ['2026-04', '2026-05'], 5],
  ['Plums', 'Fruit', 750, ['Utility'], ['2025-08'], 3],
  ['Stewed apple', 'Prepared', 500, ['Utility'], ['2025-10'], 4],
  ['Runner beans', 'Vegetables', 400, ['Garage'], ['2025-08', '2025-09'], 6],
  ['Broad beans', 'Vegetables', 500, ['Garage'], ['2026-06'], 4],
  ['Peas', 'Vegetables', 500, ['Kitchen', 'Garage'], ['2026-06', '2026-07'], 5],
  ['Sweetcorn', 'Vegetables', 900, ['Garage'], ['2025-09'], 3, 6, 'cobs'],
  ['Spinach', 'Vegetables', 250, ['Kitchen'], ['2026-05'], 3],
  ['Kale', 'Vegetables', 300, ['Utility'], ['2026-02'], 2],
  ['Courgette', 'Vegetables', 500, ['Utility'], ['2025-08'], 3],
  ['Leeks', 'Vegetables', 400, ['Garage'], ['2026-03'], 2],
  ['Tomato sauce', 'Prepared', 600, ['Kitchen', 'Utility'], ['2025-09', '2025-10'], 5],
  ['Leek and potato soup', 'Prepared', 700, ['Utility'], ['2026-03'], 3, 2, 'portions'],
  ['Basil pesto', 'Herbs', 150, ['Kitchen'], ['2025-08'], 4],
  ['Parsley', 'Herbs', 100, ['Kitchen'], ['2026-05'], 2],
  ['Globe artichokes', 'Vegetables', 0, ['Garage'], ['2026-07'], 2, 4, 'heads'],
];

let seq = 0;
function id() {
  seq += 1;
  return 'L' + (Date.now() - 900000 + seq * 1000).toString(36).toUpperCase();
}

const inventory = [];
const history = [];
const items = [];

CATALOGUE.forEach(([name, category, weight, stores, months, count, pieces, unit]) => {
  items.push({
    Item: name, Category: category, 'Typical weight (g)': weight || '',
    'Typical count': pieces || '', Unit: unit || '',
  });
  for (let i = 0; i < count; i++) {
    const month = months[i % months.length];
    const day = String(3 + ((i * 7) % 24)).padStart(2, '0');
    const store = stores[i % stores.length];
    inventory.push({
      ID: id(), Item: name, Category: category, Store: store,
      'Weight (g)': weight || '', 'Date In': `${month}-${day}`, Note: '',
      Count: pieces || '', Unit: unit || '',
    });
  }
  // A couple of things already used up, so History is not empty.
  if (count > 4) {
    history.push({
      ID: id(), Item: name, Category: category, Store: stores[0],
      'Weight (g)': weight || '', 'Date In': `${months[0]}-05`, 'Date Out': '2026-08-02', Note: '',
      Count: pieces || '', Unit: unit || '',
    });
  }
});

await writeFile(
  join(HERE, 'seed.json'),
  JSON.stringify({ Stores: STORES, Items: items, Inventory: inventory, History: history }, null, 2),
);

console.log(`seed.json: ${inventory.length} bags in stock, ${history.length} used up.`);
