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
