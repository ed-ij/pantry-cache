/**
 * Local dev server.
 *
 * Runs the real src/backend.js against a JSON file instead of a Google Sheet,
 * so the whole app can be developed and tested without deploying. The API
 * surface is identical to the Apps Script one, so the client cannot tell the
 * difference.
 */

import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const DATA = join(ROOT, 'dev', 'data.json');
const SEED = join(ROOT, 'dev', 'seed.json');
const PORT = Number(process.env.PORT || 5178);

/* ------------------------------------------------------- load the backend */

let B = null; // filled in below; the adapter closes over it

const store = {};

function saveStore() {
  return writeFile(DATA, JSON.stringify(store, null, 2));
}

const DB = {
  ensure() {
    Object.keys(B.TABLES).forEach((name) => {
      if (!store[name]) store[name] = [];
    });
    if (!store.Freezers.filter((r) => String(r.Name || '').trim()).length) {
      DB.append('Freezers', B.SEED_FREEZERS);
    }
  },

  today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },

  sheetUrl() {
    return '';
  },

  getAll(name) {
    return (store[name] || []).map((r) => ({ ...r }));
  },

  append(name, objs) {
    store[name] = store[name] || [];
    objs.forEach((o) => {
      const row = {};
      B.TABLES[name].forEach((h) => { row[h] = o[h] === undefined ? '' : o[h]; });
      store[name].push(row);
    });
  },

  // The sheet adapter looks rows up by column A, so this one does too — which
  // for the Items tab means the item name rather than an ID.
  updateById(name, id, patch) {
    const key = B.TABLES[name][0];
    const row = (store[name] || []).find((r) => String(r[key]) === String(id));
    if (row) Object.assign(row, patch);
  },

  updateColumn(name, header, fn) {
    let changed = 0;
    for (const row of store[name] || []) {
      const next = fn(row[header]);
      if (next !== undefined && next !== row[header]) {
        row[header] = next;
        changed++;
      }
    }
    return changed;
  },

  deleteByIds(name, ids) {
    const key = B.TABLES[name][0];
    const wanted = new Set(ids.map(String));
    store[name] = (store[name] || []).filter((r) => !wanted.has(String(r[key])));
  },

  lock(fn) {
    return fn();
  },
};

function loadBackend() {
  const code = readFileSync(join(SRC, 'backend.js'), 'utf8');
  const factory = new Function('DB', `${code}
    return { TABLES, DATE_COLUMNS, SEED_FREEZERS, apiGetState, apiAdd, apiRemove, apiRemovePart, apiUndo,
             apiEditLot, apiSplitLot, apiRenameItem, apiRenameCategory };`);
  return factory(DB);
}

/* ------------------------------------------------------------------ serve */

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };

async function serveIndex(res) {
  let html = await readFile(join(SRC, 'index.html'), 'utf8');
  html = html
    .replace('<!--CSS-->', '<link rel="stylesheet" href="/styles.css">')
    .replace('<!--JS-->', '<script src="/app.js"></script>');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : null); } catch { resolve(null); }
    });
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/api/')) {
    const fn = url.pathname.slice(5);
    const arg = await readBody(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    try {
      if (typeof B[fn] !== 'function') throw new Error(`No such API: ${fn}`);
      const result = B[fn](arg);
      await saveStore();
      res.end(JSON.stringify({ result }));
    } catch (err) {
      console.error(`[api] ${fn}:`, err.message);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // The spreadsheet dialog, so its two states can be looked at without
  // deploying: /setup shows the instructions, /setup?url=... the finished link.
  if (url.pathname === '/setup') {
    const page = (await readFile(join(SRC, 'setup.html'), 'utf8'))
      .split('__APP_URL__').join(url.searchParams.get('url') || '');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(page);
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') return serveIndex(res);

  const name = url.pathname.replace(/^\//, '');
  if (['styles.css', 'app.js'].includes(name)) {
    const body = await readFile(join(SRC, name));
    res.writeHead(200, { 'Content-Type': MIME[name.slice(name.lastIndexOf('.'))] + '; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
    return;
  }

  res.writeHead(404).end('Not found');
});

/* ------------------------------------------------------------------ boot */

const seedPath = existsSync(DATA) ? DATA : SEED;
Object.assign(store, JSON.parse(readFileSync(seedPath, 'utf8')));
B = loadBackend();
DB.ensure();
await saveStore();

server.listen(PORT, () => {
  console.log(`Freezer Log dev server: http://localhost:${PORT}`);
  console.log(`Data file: ${DATA} (delete it to reset to dev/seed.json)`);
});
