/**
 * Pantry Cache — Google Apps Script host.
 *
 * Provides the `DB` adapter that src/backend.js expects, backed by the
 * spreadsheet this script is bound to, plus the web-app entry point.
 * Generated into Code.gs by build.mjs — edit the sources, not the build output.
 */

/** Bumped when the sheet layout changes, to force a one-off re-setup. */
const SETUP_VERSION = '3';

let SS_ = null;

/**
 * The script is bound to the spreadsheet, so the active one is always the right
 * one. There used to be an openById fallback for the unbound case, which the
 * architecture says never happens — and keeping it forced the inferred OAuth
 * scope up to "every spreadsheet you own". The manifest now asks for
 * spreadsheets.currentonly, under which openById would not work anyway.
 */
function spreadsheet_() {
  if (SS_) return SS_;
  SS_ = SpreadsheetApp.getActiveSpreadsheet();
  if (!SS_) throw new Error('This script is not attached to a spreadsheet.');
  return SS_;
}

/** Per-execution cache of sheet contents; cleared whenever we write. */
let CACHE_ = {};
let HEADERS_ = {};

/**
 * The app was called Freezer Log and its tab was `Freezers`; both were renamed
 * once it became clear nothing about it is specific to freezing. A sheet
 * written by the old code still says so.
 *
 * This has to run before the header check below. That check appends whatever is
 * missing, so left to itself it would add an empty `Store` column beside the
 * populated `Freezer` one and quietly orphan every value in it. Renaming in
 * place keeps the data attached to its column.
 *
 * Idempotent: a sheet already using the new names, or a fresh one with neither,
 * comes out unchanged.
 */
function migrateFreezersToStores_(ss) {
  const old = ss.getSheetByName('Freezers');
  if (old && !ss.getSheetByName('Stores')) old.setName('Stores');

  ['Inventory', 'History'].forEach(function (name) {
    const sh = ss.getSheetByName(name);
    if (!sh) return;
    const row = headerRow_(sh);
    const at = row.indexOf('Freezer');
    if (at < 0 || row.indexOf('Store') >= 0) return;
    sh.getRange(1, at + 1).setValue('Store');
  });

  HEADERS_ = {};
}

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

    migrateFreezersToStores_(ss);

    let created = false;

    names.forEach(function (name) {
      const headers = TABLES[name];
      let sh = ss.getSheetByName(name);
      if (!sh) {
        sh = ss.insertSheet(name);
        created = true;
      }
      // Row 1 is the contract between the sheet and this code. It used to be
      // overwritten whenever it did not match — which is the worst possible
      // response to an inserted column: the values stay shifted and the
      // evidence that anything is wrong is erased. Now missing headers are
      // appended (constraint 9), and anything else is refused out loud.
      const existing = headerRow_(sh);
      const missing = headers.filter(function (h) { return existing.indexOf(h) < 0; });
      if (!existing.length) {
        sh.getRange(1, 1, 1, headers.length).setValues([headers]);
        HEADERS_ = {};
      } else if (missing.length) {
        sh.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
        HEADERS_ = {};
      }
      const width = Math.max(headerRow_(sh).length, headers.length);
      sh.getRange(1, 1, 1, width).setFontWeight('bold').setBackground('#e8eef5');
      sh.setFrozenRows(1);

      const laidOut = headerRow_(sh);
      laidOut.forEach(function (h, i) {
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

    if (!DB.getAll('Stores').filter(function (r) { return txt(r.Name); }).length) {
      DB.append('Stores', SEED_STORES);
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
    // Read what row 1 actually says rather than assuming TABLES' order. Insert
    // a column and every read used to shift by one — notes became counts,
    // weights became dates — with nothing to notice it. Reordering and inserted
    // columns now cost nothing, which is what makes constraint 1 safe rather
    // than merely stated.
    const headers = headerRow_(sh);
    if (last < 2 || !headers.length) {
      CACHE_[name] = [];
      return CACHE_[name];
    }
    const values = sh.getRange(2, 1, last - 1, headers.length).getValues();
    const tz = spreadsheet_().getSpreadsheetTimeZone();
    CACHE_[name] = values
      .map(function (row) {
        const obj = {};
        headers.forEach(function (h, i) {
          if (!h) return;
          let v = row[i];
          if (v instanceof Date) v = Utilities.formatDate(v, tz, 'yyyy-MM-dd');
          obj[h] = v;
        });
        return obj;
      })
      .filter(function (obj) {
        // Skip rows the user has blanked out in the sheet.
        return headers.some(function (h) { return h && txt(obj[h]) !== ''; });
      });
    return CACHE_[name];
  },

  append: function (name, objs) {
    if (!objs || !objs.length) return;
    const sh = sheet_(name);
    const headers = headerRow_(sh);
    const rows = objs.map(function (o) {
      return headers.map(function (h) { return h in o ? toCell_(h, o[h]) : ''; });
    });
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
    CACHE_ = {};
    HEADERS_ = {};
  },

  updateById: function (name, id, patch) {
    const sh = sheet_(name);
    const headers = headerRow_(sh);
    const rowIndex = findRow_(sh, id);
    if (rowIndex < 0) return;
    Object.keys(patch).forEach(function (h) {
      const col = headers.indexOf(h);
      if (col < 0) return;
      sh.getRange(rowIndex, col + 1).setValue(toCell_(h, patch[h]));
    });
    CACHE_ = {};
    HEADERS_ = {};
  },

  /**
   * Rewrites one column in a single read-modify-write. A rename can touch
   * dozens of rows, and doing that a cell at a time is painfully slow against
   * a spreadsheet. `fn` returns the new value, or undefined to leave it alone.
   */
  updateColumn: function (name, header, fn) {
    const sh = sheet_(name);
    const col = headerRow_(sh).indexOf(header);
    const last = sh.getLastRow();
    if (col < 0 || last < 2) return 0;

    // Column A alongside, so `fn` can decide per row rather than only per
    // value — which is what lets an undo touch exactly the rows its own
    // rename touched, and no others.
    const keys = sh.getRange(2, 1, last - 1, 1).getValues();
    const range = sh.getRange(2, col + 1, last - 1, 1);
    const values = range.getValues();
    let changed = 0;
    for (let i = 0; i < values.length; i++) {
      const next = fn(values[i][0], txt(keys[i][0]));
      if (next !== undefined && next !== values[i][0]) {
        values[i][0] = next;
        changed++;
      }
    }
    if (changed) {
      range.setValues(values);
      CACHE_ = {};
      HEADERS_ = {};
    }
    return changed;
  },

  /**
   * Deletes contiguous runs rather than one row at a time. Taking forty bags
   * out was forty sequential calls into the Sheets API, after forty rows had
   * already been appended to History — and the rows being removed are usually
   * neighbours, so in practice this collapses a batch to a handful of calls.
   *
   * Still not atomic: Apps Script has no transactions, and a failure partway
   * leaves rows in both tabs. That is the safe direction (see removeWhole_),
   * and `Set up / repair sheets` reports the duplicates.
   */
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
    if (!targets.length) return;

    // Bottom-up so earlier row numbers stay valid, in runs so there are fewer
    // calls. targets is already ascending.
    let end = targets.length - 1;
    for (let i = targets.length - 1; i >= 0; i--) {
      const startsRun = i === 0 || targets[i - 1] !== targets[i] - 1;
      if (startsRun) {
        sh.deleteRows(targets[i], end - i + 1);
        end = i - 1;
      }
    }
    CACHE_ = {};
    HEADERS_ = {};
  },

  /**
   * Undo tokens live here rather than in the browser, so that a token cannot be
   * hand-written and handed back as authority to delete rows. CacheService is
   * the right fit: it expires on its own and needs no extra tab in the sheet.
   * Losing one to a cache eviction costs an undo, which the dialog already
   * explains in English.
   */
  tokens: {
    put: function (handle, value, ttlSeconds) {
      CacheService.getScriptCache().put('undo:' + handle, JSON.stringify(value), ttlSeconds);
    },
    take: function (handle) {
      if (!handle) return null;
      const cache = CacheService.getScriptCache();
      const key = 'undo:' + handle;
      const raw = cache.get(key);
      if (!raw) return null;
      cache.remove(key);
      try {
        return JSON.parse(raw);
      } catch (err) {
        return null;
      }
    },
  },

  lock: function (fn) {
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      return fn();
    } finally {
      CACHE_ = {};
      HEADERS_ = {};
      lock.releaseLock();
    }
  },
};

/**
 * Row 1, as it actually is. Cached per execution alongside the values, since
 * every read and write now consults it.
 */
function headerRow_(sh) {
  const name = sh.getName();
  if (HEADERS_[name]) return HEADERS_[name];
  if (sh.getLastRow() < 1 || sh.getLastColumn() < 1) return [];
  HEADERS_[name] = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
    .map(function (h) { return txt(h); });
  return HEADERS_[name];
}

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
    .setTitle('Pantry Cache')
    // Deployed with Anyone access, so the URL alone can write. Without this,
    // any page may frame the app, which is the whole of a clickjacking setup.
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.SAMEORIGIN)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/** Spreadsheet menu, so the sheet itself offers a way in. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Pantry Cache')
    .addItem('Open the app / get my link', 'showSetup')
    .addItem('Set up / repair sheets', 'setupSheets')
    .addItem('Check for updates', 'showUpdate')
    .addToUi();
}

function setupSheets() {
  DB.ensure(true);

  // A write interrupted between the two tables leaves a bag recorded twice.
  // Nothing used to notice, so the totals were quietly wrong from then on.
  const inInventory = {};
  DB.getAll('Inventory').forEach(function (r) { inInventory[txt(r.ID)] = txt(r.Item); });
  const both = DB.getAll('History')
    .filter(function (r) { return inInventory[txt(r.ID)]; })
    .map(function (r) { return txt(r.ID) + '  ' + txt(r.Item); });

  if (both.length) {
    SpreadsheetApp.getUi().alert(
      'Some bags are recorded twice',
      both.length + (both.length === 1 ? ' bag is' : ' bags are') +
      ' listed in both Inventory and History, which happens if a take-out was ' +
      'interrupted partway.\n\n' + both.slice(0, 20).join('\n') +
      (both.length > 20 ? '\n…and ' + (both.length - 20) + ' more' : '') +
      '\n\nDelete whichever row is wrong: the History row if the bag is still ' +
      'in the store, the Inventory row if it has been used.',
      SpreadsheetApp.getUi().ButtonSet.OK,
    );
  }

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
    .split('__APP_URL__').join(appUrl_())
    .split('__BUILD__').join(BUILD);

  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(560).setHeight(600),
    'Pantry Cache',
  );
}

/* ------------------------------------------------------------------ updates */

/**
 * Every household runs its own copy of this code, pasted in by hand. That is
 * what makes each one independent — constraint 11 — and it is also why a fix
 * used to reach people as five files in an email, with nothing recording who
 * was running what.
 *
 * So each copy pulls rather than being pushed to: it asks a small JSON file on
 * GitHub what the current build is, compares it against its own stamp, and if
 * there is something newer, shows the files to paste. Nothing updates itself.
 * A bad release still cannot reach anyone's store list without them choosing
 * to take it, so independence survives intact.
 */
const RELEASE_FILES = [
  { name: 'Code.gs', path: 'dist/Code.gs', where: 'the Code.gs file' },
  { name: 'Index.html', path: 'dist/Index.html', where: 'the Index file' },
  { name: 'Css.html', path: 'dist/Css.html', where: 'the Css file' },
  { name: 'Js.html', path: 'dist/Js.html', where: 'the Js file' },
  { name: 'Setup.html', path: 'dist/Setup.html', where: 'the Setup file' },
  { name: 'Update.html', path: 'dist/Update.html', where: 'the Update file' },
];

function fetchText_(path) {
  const res = UrlFetchApp.fetch(RELEASE_BASE + path, {
    muteHttpExceptions: true,
    followRedirects: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('Could not reach the update server. Please try again later.');
  }
  return res.getContentText();
}

/** Called by the dialog. Returns what this copy is running and what is current. */
function apiUpdateStatus() {
  const out = {
    build: BUILD, commit: BUILD_COMMIT, branch: BUILD_BRANCH,
    latest: '', notes: '', newer: false,
  };
  let manifest;
  try {
    manifest = JSON.parse(fetchText_('latest.json'));
  } catch (err) {
    out.error = 'Could not check for updates just now. Please try again later.';
    return out;
  }
  out.latest = String(manifest.build || '');
  out.notes = String(manifest.notes || '');
  // ISO timestamps, so a plain string comparison is the whole of the logic.
  out.newer = !!out.latest && out.latest > BUILD;
  out.files = RELEASE_FILES.map(function (f) { return { name: f.name, where: f.where }; });
  return out;
}

/** Called by the dialog, one file at a time, so nothing large is fetched unasked. */
function apiUpdateFile(name) {
  const file = RELEASE_FILES.filter(function (f) { return f.name === name; })[0];
  if (!file) throw new Error('No such file.');
  return fetchText_(file.path);
}

function showUpdate() {
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutputFromFile('Update').setWidth(620).setHeight(620),
    'Pantry Cache — updates',
  );
}
