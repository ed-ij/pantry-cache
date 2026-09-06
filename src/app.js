/* ==========================================================================
   Pantry Cache — client.

   Talks to Apps Script via google.script.run when deployed, and to the local
   dev server over fetch when running `npm run dev`. Everything renders from a
   single `S` state object.

   Writes are applied to that state only once the sheet has confirmed them, so
   what is on screen is always what is in the spreadsheet. The cost is that a
   dropped connection means the action simply does not happen — nothing is
   queued and nothing syncs later — so it has to say so plainly.
   ========================================================================== */

/* ------------------------------------------------------------ transport */

/**
 * Every sentence the backend throws is written for a person — "Please choose
 * which store it is going in". Anything else that reaches this point is not:
 * Google's own lock timeout ("Could not obtain lock after 20000ms"), a stack
 * trace from an unexpected exception, a transport failure with no message at
 * all. Constraint 3 exists to keep those off the screen, and they were the one
 * class it did not cover.
 *
 * So a failure is either one of ours, which passes through, or it is not, and
 * becomes one plain sentence. The original goes to the console either way, so
 * Stackdriver still has it.
 */
function translateError(raw) {
  var msg = String((raw && raw.message) || raw || '');
  if (window.console && console.error) console.error('[pantry-cache]', raw);

  // Our own messages all end in a full stop and read as English. Google's do
  // not, and neither do transport failures — but rather than trying to
  // recognise every way that can look, anything unrecognised is treated as
  // "not saved", which is both truer and safer than guessing.
  if (/^[A-Z][^]*[.?]$/.test(msg) && !/\b(error|exception|null|undefined|0x|at .+:\d+)\b/i.test(msg)) {
    return { message: msg, ours: true };
  }
  if (/lock/i.test(msg)) {
    return { message: 'Someone else is using the app just now. Please try again in a moment.', ours: false };
  }
  return {
    message: 'That was not saved. Check the connection and try again.',
    ours: false,
    likelyOffline: true,
  };
}

function api(fn, arg) {
  return new Promise(function (resolve, reject) {
    if (window.google && window.google.script && window.google.script.run) {
      window.google.script.run
        .withSuccessHandler(resolve)
        .withFailureHandler(function (err) { reject(new Error(err && err.message ? err.message : String(err))); })
        [fn](arg);
      return;
    }
    fetch('/api/' + fn, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(arg === undefined ? null : arg),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) { return d.error ? reject(new Error(d.error)) : resolve(d.result); })
      .catch(reject);
  });
}

/* -------------------------------------------------------------- helpers */

var $ = function (sel) { return document.querySelector(sel); };

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * One bag's weight, to the gram. Constraint 6 stores what was entered and this
 * has to show it: at two decimals a bag weighed at 12345 g read "12.35 kg", and
 * splitting it four ways gave four bags reading 3.09 kg — 12.36 kg between them,
 * against the 12.35 kg that had just been on screen. The grams were right the
 * whole time; the display was the only thing losing them.
 *
 * Trailing zeros are dropped, so the precision only appears when it is real:
 * 2 kg stays "2 kg", 2.5 stays "2.5 kg", and 12345 says so.
 */
function fmtW(g) {
  g = Math.round(Number(g) || 0);
  if (g < 1000) return g + ' g';
  return (g / 1000).toFixed(3).replace(/\.?0+$/, '') + ' kg';
}

/**
 * A total across many bags, where the gram is noise rather than a fact somebody
 * entered — nobody weighed the freezer, and "38.954 kg" in the header reads as
 * false precision about a number that changes with every bag.
 */
function fmtWTotal(g) {
  g = Math.round(Number(g) || 0);
  if (g < 1000) return g + ' g';
  return (g / 1000).toFixed(2).replace(/\.?0+$/, '') + ' kg';
}

function parseISO(iso) {
  var p = String(iso || '').split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}

function todayISO() {
  var d = new Date();
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
}

/**
 * The day this tab last saw, by the browser's clock. `S.today` itself comes
 * from the spreadsheet — its timezone is what decides the date — so this is
 * only used to notice that midnight has passed.
 *
 * It has to be noticed, because this app is meant to sit on a tablet left
 * switched on beside a store. Without it, `S.today` is whatever it was when
 * the page loaded: the morning's produce is stamped yesterday, the take-out
 * dates in History are wrong, and every "1 year 1 mth ago" is measured from a
 * stale point.
 */
var seenDay = todayISO();

function dayRolled() {
  var now = todayISO();
  if (now === seenDay) return false;
  seenDay = now;
  return true;
}

/**
 * Brings `S.today` forward without waiting for a round trip, for the moment
 * just before a write. A date the user chose deliberately is left alone; only
 * one that was simply the default follows the clock.
 */
function advanceToday() {
  var now = todayISO();
  if (now === S.today) return;
  var wasDefault = S.draft.dateIn === S.today;
  S.today = now;
  if (wasDefault) S.draft.dateIn = now;
}

function fmtDate(iso) {
  if (!iso) return '—';
  return parseISO(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Constraint 5: the month is what matters, the day is a bonus. Where the day
 * was never known — backdating to "Jul 2025" stores the 1st, because a date
 * cell has to hold something — say the month and stop, rather than showing an
 * invented day in the same typeface as a real one.
 */
function fmtWhen(lot) {
  if (!lot || !lot.dateIn) return 'date not recorded';
  return lot.monthOnly ? fmtMonth(lot.dateIn) : fmtDate(lot.dateIn);
}

function fmtMonth(iso) {
  if (!iso) return '—';
  return parseISO(iso).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}

function ageText(iso) {
  if (!iso) return '';
  var days = Math.round((parseISO(S.today) - parseISO(iso)) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 31) return days + ' days ago';
  var a = parseISO(iso), b = parseISO(S.today);
  var m = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  if (b.getDate() < a.getDate()) m -= 1;
  if (m < 12) return m + ' month' + (m === 1 ? '' : 's') + ' ago';
  var y = Math.floor(m / 12), r = m % 12;
  return y + ' year' + (y === 1 ? '' : 's') +
    (r ? ' ' + r + ' month' + (r === 1 ? '' : 's') : '') + ' ago';
}

function norm(s) { return String(s || '').trim().toLowerCase(); }

/**
 * Oldest first, with undated bags last rather than first.
 *
 * An empty date sorts before every real one, so a cleared or unreadable date
 * cell used to pin its bag to the top of every oldest-first list and take the
 * "use first" badge with it. Constraint 1 makes the sheet hand-editable on
 * purpose, so that is a state the design invited.
 */
function byAge(a, b) {
  if (!a.dateIn !== !b.dateIn) return a.dateIn ? -1 : 1;
  return (a.dateIn || '').localeCompare(b.dateIn || '') || a.item.localeCompare(b.item);
}

/** A bag with no readable date cannot be the one to use first. */
function datedFirst(lots) {
  return lots.filter(function (l) { return l.dateIn; });
}

var GRAMS_PER_OZ = 28.349523125;

/** The two step sizes offered either side of a readout. */
var WEIGHT_STEPS = [50, 10];
var COUNT_STEPS = [5, 1];

/** "6 cobs", dropped back to the singular for one: one box, not one boxe. */
function fmtCount(n, unit) {
  n = Math.round(Number(n) || 0);
  var word = String(unit || 'pieces').trim() || 'pieces';
  if (n === 1) {
    if (/(x|s|ch|sh)es$/i.test(word)) word = word.slice(0, -2);
    else if (/ies$/i.test(word)) word = word.slice(0, -3) + 'y';
    else if (/s$/i.test(word) && !/ss$/i.test(word)) word = word.slice(0, -1);
  }
  return n + ' ' + word;
}

/** How big one bag is, in whichever measures were recorded for it. */
function lotSize(lot) {
  var parts = [];
  if (lot.count > 0) parts.push(fmtCount(lot.count, lot.unit));
  if (lot.weightG > 0) parts.push(fmtW(lot.weightG));
  return parts.join(' \u00b7 ') || '—';
}

/** The same, totalled over a set of bags. */
/**
 * Totals a set of bags, as an array of measures. Counts only add up when they
 * are counting the same thing — six cobs plus four heads is not ten of anything
 * — so mixed units are listed side by side rather than merged or dropped.
 * The first entry is the headline; callers show as much of the rest as fits.
 */
function lotsSize(lots, weightFirst) {
  var byUnit = {};
  lots.forEach(function (l) {
    if (!(l.count > 0)) return;
    var key = norm(l.unit) || 'pieces';
    if (!byUnit[key]) byUnit[key] = { unit: l.unit || 'pieces', total: 0 };
    byUnit[key].total += l.count;
  });

  var counts = Object.keys(byUnit)
    .map(function (k) { return byUnit[k]; })
    .sort(function (a, b) { return b.total - a.total; })
    .map(function (u) { return fmtCount(u.total, u.unit); });

  var w = sum(lots, function (l) { return l.weightG; });
  var weight = w > 0 ? [fmtWTotal(w)] : [];

  var parts = weightFirst ? weight.concat(counts) : counts.concat(weight);
  return parts.length ? parts : ['—'];
}

/** Mirrors the backend's cleanName so the screen shows exactly what gets saved. */
function tidyName(s) {
  var v = String(s || '').trim().replace(/\s+/g, ' ');
  return v ? v.charAt(0).toUpperCase() + v.slice(1) : '';
}

function sum(list, pick) {
  return list.reduce(function (t, x) { return t + (pick ? pick(x) : x); }, 0);
}

function groupBy(list, key) {
  var out = {};
  list.forEach(function (x) {
    var k = key(x);
    (out[k] = out[k] || []).push(x);
  });
  return out;
}

/* ---------------------------------------------------------------- state */

var BLANK_DRAFT = {
  item: '', category: '', weightG: 500, count: 0, unit: '', qty: 1,
  store: '', dateIn: '', monthOnly: false, note: '', showNote: false, showCount: false,
  // Constraint 6 says weights are stored exactly as entered. 500 g was entered
  // by nobody — it is a starting position, and until she touches the control it
  // is drawn as a suggestion and refuses to save.
  weightConfirmed: false,
};

/** Words that come up often enough to be worth one tap. */
var UNIT_SUGGESTIONS = ['cobs', 'portions', 'pieces', 'heads', 'bunches', 'sticks'];

/**
 * The suggestions, with whatever word is already in use added at the front if
 * it is not among them — otherwise a bag of "blocks" shows no chip selected
 * and every chip looks like a change.
 */
/**
 * Stores the plural, because fmtCount only ever singularises. Type "cob" and
 * every screen read "6 cob" for ever, with no way to fix it but editing each
 * bag.
 */
function pluralUnit(word) {
  var w = String(word || '').trim();
  if (!w || /s$/i.test(w)) return w;
  if (/(x|ch|sh)$/i.test(w)) return w + 'es';
  if (/[^aeiou]y$/i.test(w)) return w.slice(0, -1) + 'ies';
  return w + 's';
}

function unitChoices(current) {
  var c = norm(current);
  if (c && UNIT_SUGGESTIONS.indexOf(c) < 0) return [current].concat(UNIT_SUGGESTIONS);
  return UNIT_SUGGESTIONS;
}

var S = {
  ready: false,
  tab: 'add',
  today: todayISO(),
  stores: [],
  items: [],
  categories: [],
  inventory: [],
  problems: [],
  sheetUrl: '',

  query: '',
  draft: Object.assign({}, BLANK_DRAFT),
  recentAdds: [],
  recentTakes: [],

  openCats: {},

  // One filter and one search across both tabs. They used to be four separate
  // pieces of state, so filtering to the Shed in "In store" and then
  // tapping "Take out" silently put you back to all stores.
  store: 'all',
  search: '',
  viewLimit: 60,
  open: {},

  takeLimit: 40,
  // Taking several bags out for one meal is the third question the spec asks,
  // and the backend has always accepted a list.
  selected: {},

  // The first-run screen's draft. Null until that screen is first rendered, so
  // a copy that already has stores never carries a form it will not show.
  newStores: null,
  suggestedStores: [],
  storeColours: [],

  // 'auto' follows the tablet. The other two override it, which is why the
  // stylesheet carries each dark rule twice.
  theme: 'auto',
  // Off by default: browsing is the common case and rename pencils beside every
  // heading are noise for it. On, the editing affordances appear and catalogue
  // entries with nothing under them become visible so they can be tidied up.
  editing: false,
  // Bags ticked for moving on In store. Separate from S.selected, which
  // belongs to Take out and survives a tab change.
  moving: {},
  version: null,

  modal: null,
  toast: null,
  busy: false,
  loadFailed: false,
  slowLoad: false,
  offline: navigator.onLine === false,
};

var toastTimer = null;
var lastToastHtml = '';

/**
 * Browser storage is per-artifact and can throw outright — a private window, or
 * a browser set to block site data — so every read and write is guarded and the
 * app renders correctly having found nothing.
 */
function readPref(key, fallback) {
  try {
    var v = window.localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch (e) { return fallback; }
}

function writePref(key, value) {
  try { window.localStorage.setItem(key, value); } catch (e) { /* nothing to do */ }
}

/** Stamps the choice on <html>, where the stylesheet's [data-theme] rules see it. */
function applyTheme() {
  var el = document.documentElement;
  if (S.theme === 'auto') el.removeAttribute('data-theme');
  else el.setAttribute('data-theme', S.theme);
}

function setState(patch) {
  Object.assign(S, patch);
  render();
}

/** Ends a write: clears the flag, notes that the connection is alive. */
function done() {
  S.busy = false;
  succeeded();
}

/**
 * The sheet holds one colour per store. Rather than asking for a second one
 * that works on a dark background, the stored value is handed to CSS as a
 * custom property and the dark theme lightens it there — so whatever colour
 * gets typed into the spreadsheet stays legible either way.
 */
function dot(colour) {
  return '<span class="dot" style="--fz:' + esc(colour) + '"></span>';
}

/** The store's name, tinted with its own colour rather than a neutral pill. */
function storeBadge(name) {
  return '<span class="badge badge-store" style="--fz:' + esc(storeColour(name)) + '">' +
    dot(storeColour(name)) + esc(name) + '</span>';
}

function storeColour(name) {
  var f = S.stores.filter(function (x) { return x.name === name; })[0];
  return f ? f.colour : 'var(--ink-3)';
}

/* ---------------------------------------------------------------- toast */

function toast(msg, undoToken, kind) {
  clearTimeout(toastTimer);
  S.toast = { msg: msg, undo: undoToken || null, kind: kind || '' };
  render();
  toastTimer = setTimeout(function () {
    S.toast = null;
    render();
  }, undoToken ? 30000 : (kind === 'bad' ? 9000 : 4500));
}

/**
 * The spec names the scenario precisely: a store beyond wi-fi range. That
 * tablet is still associated with the access point, so navigator.onLine reports
 * true and never fires. The old test also matched the fetch API's vocabulary —
 * "failed to fetch", "load failed" — which is the dev server's transport, not
 * google.script.run's.
 *
 * So a failed request is the authoritative signal: the badge latches on when
 * one looks like a transport failure, and clears when anything succeeds.
 * navigator.onLine stays as a fast path, not as the source of truth.
 */
function fail(err) {
  var t = translateError(err);
  if (t.likelyOffline) S.offline = true;
  toast(t.likelyOffline
    ? 'No connection, so that was not saved. Try again once the wi-fi is back.'
    : t.message, null, 'bad');
}

/** Anything reaching the sheet proves the connection, whatever onLine claims. */
function succeeded() {
  if (S.offline) S.offline = false;
}

/* --------------------------------------------------------------- render */

/** Whether the previous paint had a dialog over the app; see render(). */
var lastRenderHadModal = false;

function render() {
  document.body.classList.toggle('is-busy', !!S.busy);
  var active = document.activeElement;
  var focusId = active && active.id ? active.id : null;
  var selStart = focusId && 'selectionStart' in active ? active.selectionStart : null;

  // showModal() makes everything behind the dialog inert, so while one is open
  // the tab bar and the panel cannot be seen past it or reached. Rebuilding
  // them on every tap inside the modal — every colour cell, every keystroke in
  // a rename — threw away and recreated up to 13 KB of In store that nobody
  // could look at. They are redrawn when the modal opens or closes instead,
  // which is the only time the difference can be seen.
  var modalOpen = !!S.modal;
  if (!modalOpen || !lastRenderHadModal) {
    $('#topbar-right').innerHTML = renderTopRight();
    $('#tabbar').innerHTML = (isFirstRun() || S.tab === 'settings-place') ? '' : renderTabs();
    $('#panel').innerHTML = S.ready ? renderPanel() : renderLoading();
  }
  lastRenderHadModal = modalOpen;

  // aria-live: rewriting this on every render — which means every keystroke in
  // a search box and every chip tap — made a screen reader re-read the toast
  // each time. Only touch it when what it says has actually changed.
  var toastHtml = renderToast();
  if (toastHtml !== lastToastHtml) {
    $('#toast-host').innerHTML = toastHtml;
    lastToastHtml = toastHtml;
  }

  syncModal();

  if (focusId) {
    var again = document.getElementById(focusId);
    if (again) {
      again.focus();
      if (selStart !== null && 'setSelectionRange' in again) {
        try { again.setSelectionRange(selStart, selStart); } catch (e) { /* not a text input */ }
      }
    }
  }
}

/**
 * A <dialog> supplies the role, the accessible name, the focus trap, the inert
 * background, Escape handling and the top layer — all of which were missing,
 * and none of which needs a library. Before this, opening a modal left
 * document.activeElement on <body>, so Tab started from the top of the page
 * behind the scrim, and the page scrolled underneath.
 */
var modalKey = null;
var focusBeforeModal = null;

var lastModalHtml = '';

function syncModal() {
  var host = $('#modal-host');

  // The keypad is the one dialog that is typed into rather than tapped once, so
  // it is worth updating rather than rebuilding.
  if (S.modal && S.modal.kind === 'keypad' && host.open &&
      modalKey === 'keypad:' + (S.modal.id || '') && patchKeypad(S.modal)) {
    return;
  }

  var want = S.modal ? renderModal() : '';

  if (!want) {
    if (host.open) host.close();
    host.innerHTML = '';
    lastModalHtml = '';
    modalKey = null;
    if (focusBeforeModal && document.contains(focusBeforeModal)) focusBeforeModal.focus();
    focusBeforeModal = null;
    return;
  }

  var opening = !host.open;
  if (opening) focusBeforeModal = document.activeElement;
  // Identical markup still destroys and recreates every node in it, losing any
  // press or focus that was live at the time.
  if (want !== lastModalHtml) {
    host.innerHTML = want;
    lastModalHtml = want;
  }
  if (opening) host.showModal();

  // Only move focus when a different dialog appears, not on every keystroke
  // inside the one already open.
  var key = S.modal.kind + ':' + (S.modal.id || '');
  if (key !== modalKey) {
    modalKey = key;
    var first = host.querySelector('input, .btn-hero, .btn-primary, .btn-warm, button');
    if (first) first.focus();
  }
}

/** Is there unsaved work in the open dialog that a stray tap would discard? */
function modalIsDirty() {
  var m = S.modal;
  if (!m) return false;
  if (m.kind === 'edit') {
    var l = lotById(m.id);
    if (!l) return false;
    return m.store !== l.store || m.dateIn !== l.dateIn || m.weightG !== l.weightG ||
      m.count !== l.count || norm(m.unit) !== norm(l.unit || 'pieces') || m.note !== l.note;
  }
  if (m.kind === 'rename') return norm(tidyName(m.value)) !== norm(m.from);
  return false;
}

/**
 * Constraint 3 asks for English rather than codes; the loading state deserves
 * the same. An Apps Script cold start regularly runs past the "one to two
 * seconds" the spec quotes, and three shimmering grey rectangles with no words
 * read as broken.
 */
function renderLoading() {
  return '<div class="stack">' +
    '<div class="muted" style="text-align:center;padding:8px 0 4px">' +
      esc(S.slowLoad ? 'Still reading the spreadsheet\u2026 this is taking longer than usual.' : 'Reading the spreadsheet\u2026') +
    '</div>' +
    '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>' +
    '</div>';
}

function settingsButton() {
  var on = S.tab === 'settings';
  return '<button class="icon-btn' + (on ? ' is-on' : '') + '" data-act="' +
    (on ? 'settings-close' : 'settings-open') + '" ' +
    'aria-label="' + (on ? 'Close settings' : 'Settings') + '" ' +
    'title="' + (on ? 'Close settings' : 'Settings') + '">&#9881;</button>';
}

function renderTopRight() {
  // lotsSize, not a bare weight sum: 42 cobs of sweetcorn with no weight were
  // reported as 0, while the stores view — using the same data — said "42
  // cobs". The number that is always on screen was the wrong one.
  var totals = lotsSize(S.inventory, true);
  var total = totals[0] === '\u2014' ? '0 g' : totals[0];
  var extra = totals.length > 1;
  if (!S.ready) return '';
  // "0 g stored" beside a banner saying nothing could be read is exactly the
  // confident-and-wrong number the banner exists to avoid.
  if (S.loadFailed) {
    return settingsButton() +
      '<span class="badge badge-warm">Not loaded</span>' +
      '<button class="btn btn-ghost btn-compact" data-act="refresh" title="Try again">&#8635;</button>';
  }
  if (S.offline) {
    return settingsButton() +
      '<span class="badge badge-warm">Offline &mdash; cannot save</span>' +
      '<button class="btn btn-ghost btn-compact" data-act="refresh" title="Try again">&#8635;</button>';
  }
  return settingsButton() +
    '<span class="badge" title="' + esc(totals.join(' \u00b7 ')) + '">' +
    esc(extra ? total + ' +' + (totals.length - 1) + ' more' : total + ' stored') + '</span>' +
    '<button class="btn btn-ghost btn-compact" data-act="refresh" title="Reload from the spreadsheet">&#8635;</button>';
}

var TABS = [
  { id: 'add', icon: '&#43;', label: 'Put in' },
  { id: 'view', icon: '&#9776;', label: 'In store' },
  { id: 'take', icon: '&#8722;', label: 'Take out' },
];

function renderTabs() {
  return TABS.map(function (t) {
    var on = S.tab === t.id;
    return '<button class="tab' + (on ? ' is-active' : '') + (on && t.id === 'take' ? ' is-warm' : '') + '" ' +
      'data-act="tab" data-tab="' + t.id + '" aria-label="' + t.label + '" aria-current="' + (on ? 'page' : 'false') + '">' +
      '<span class="tab-icon" aria-hidden="true">' + t.icon + '</span>' +
      '<span class="tab-label">' + t.label + '</span></button>';
  }).join('');
}

/**
 * An empty store list used to be a dead end: the Put in tab said "No stores
 * listed yet — add them on the Stores tab of the spreadsheet", which asks
 * somebody who has just opened an app to go and edit a spreadsheet before it
 * will do anything. It is only reachable when the load *succeeded* and returned
 * nothing, so it can be trusted as an empty sheet rather than a failed fetch.
 */
function isFirstRun() {
  return S.ready && !S.loadFailed && !S.stores.length;
}

/** A row's colour, falling back to the palette position so it is never unset. */
/**
 * The six presets, plus whatever colour this place actually has if it is not
 * one of them — a colour typed into the spreadsheet, or picked here before —
 * so the current choice is always visible rather than silently unrepresented.
 * "Other" is a native colour input, which is the one control on this screen
 * that is better borrowed than built.
 */
/**
 * Kept to a mid band of lightness on purpose. The colour is painted as a dot and
 * mixed into a badge behind text, so a near-white or near-black choice reads as
 * broken rather than as a preference — and the person choosing has no way to
 * know that in advance. Twenty-four evenly spread hues is more than enough to
 * tell six or seven places apart.
 */
function hslHex(h, s, l) {
  var a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  var f = function (n) {
    var k = (n + h / 30) % 12;
    var v = l / 100 - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    return ('0' + Math.round(255 * v).toString(16)).slice(-2);
  };
  return '#' + f(0) + f(8) + f(4);
}

function paletteColours() {
  var hues = [6, 28, 44, 64, 96, 148, 172, 194, 212, 244, 280, 320];
  var out = [];
  [44, 32].forEach(function (l) {
    hues.forEach(function (h) { out.push(hslHex(h, 62, l)); });
  });
  return out;
}

/**
 * Hue, and the two axes of the grid. Nothing outside these ranges is offered:
 * saturation never falls low enough to reach grey, and lightness never climbs
 * to white or drops to black. The colour is painted as a dot and mixed into a
 * badge behind text, so those are not choices, they are ways to look broken.
 *
 * The bounds were found by looking rather than reasoned, and they widened once
 * the dark theme stopped mixing store colours with white: chroma survives now,
 * so a low-saturation choice stays a colour there instead of going grey.
 */
/**
 * The hues the slider can stop on. A step in HSL is not a step the eye takes
 * evenly — 90 to 150 is four greens that look like two, while the same span in
 * the blues is clearly four colours — so an even step wastes choices in one
 * place and starves another. These are spaced by eye instead, and the slider
 * indexes them rather than sweeping 360 degrees.
 *
 * Twenty is enough to tell a household's places apart several times over, and
 * few enough that no two are a near-miss for each other. Note how few sit
 * between 88 and 165: that whole span reads as two or three greens however
 * finely it is cut, so the choices are spent on the blues instead.
 */
var HUES = [4, 20, 36, 50, 64, 88, 112, 140, 165, 182,
            196, 208, 222, 238, 254, 272, 290, 308, 326, 344];

/** The offered hue closest to one already stored. */
function nearestHueIndex(h) {
  var best = 0;
  for (var i = 1; i < HUES.length; i++) {
    var d = Math.min(Math.abs(HUES[i] - h), 360 - Math.abs(HUES[i] - h));
    var b = Math.min(Math.abs(HUES[best] - h), 360 - Math.abs(HUES[best] - h));
    if (d < b) best = i;
  }
  return best;
}
var SATS = [35, 65, 95];
var LUMS = [58, 43, 28];

function hexToHsl(hex) {
  var m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  if (!m) return null;
  var r = parseInt(m[1], 16) / 255, g = parseInt(m[2], 16) / 255, b = parseInt(m[3], 16) / 255;
  var max = Math.max(r, g, b), min = Math.min(r, g, b);
  var l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };
  var d = max - min;
  var s = d / (1 - Math.abs(2 * l - 1));
  var h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = Math.round(h * 60);
  return { h: (h + 360) % 360, s: s * 100, l: l * 100 };
}

/** The nearest offered saturation and lightness, so an existing colour lands
 *  on a real cell rather than showing nothing selected. */
/**
 * Hard-edged bands, one per offered hue, so the slider shows its own steps.
 *
 * Each band is centred on where the thumb actually comes to rest, which is not
 * where an even division of the track would put it: the thumb does not overhang
 * the ends, so its centre travels between one radius in and one radius short,
 * not from 0% to 100%. Twenty equal slices drifted against that by half a band
 * at each end, and the marker sat off its own colour.
 */
function hueStops() {
  var n = HUES.length;
  var r = '1.1rem';                        // half the thumb, from .hue's CSS
  var at = function (x) {
    return 'calc(' + r + ' + (100% - 2 * ' + r + ') * ' + (x / (n - 1)).toFixed(5) + ')';
  };
  return HUES.map(function (h, i) {
    var c = 'hsl(' + h + ' 70% 45%)';
    var from = i === 0 ? '0%' : at(i - 0.5);
    var to = i === n - 1 ? '100%' : at(i + 0.5);
    return c + ' ' + from + ', ' + c + ' ' + to;
  }).join(', ');
}

function nearestStep(list, v) {
  return list.reduce(function (best, x) {
    return Math.abs(x - v) < Math.abs(best - v) ? x : best;
  }, list[0]);
}

function colourState(value) {
  var hsl = hexToHsl(value) || { h: 200, s: 64, l: 45 };
  return { hue: Math.round(hsl.h), sat: nearestStep(SATS, hsl.s), lum: nearestStep(LUMS, hsl.l) };
}

/**
 * A hue slider and a grid of what that hue can be, which is the shape of the
 * control people already know. The native input was the wrong one for a tablet:
 * small targets, and a tap outside its popover commits whatever is under it and
 * closes, so a slip could not be told from a choice.
 */
function modalColour(m) {
  var cells = LUMS.map(function (l) {
    return SATS.map(function (s) {
      var on = m.sat === s && m.lum === l;
      return '<button class="cell' + (on ? ' is-on' : '') + '" ' +
        'style="--s:' + s + ';--l:' + l + '" data-act="pick-cell" data-s="' + s + '" data-l="' + l + '" ' +
        'aria-label="' + s + '% intensity, ' + l + '% brightness" ' +
        'aria-pressed="' + (on ? 'true' : 'false') + '"></button>';
    }).join('');
  }).join('');

  return wrap(
    '<h2 class="modal-title">Choose a colour</h2>' +
    '<div class="picker" style="--hue:' + m.hue + '">' +
      '<input class="hue" type="range" min="0" max="' + (HUES.length - 1) + '" step="1" ' +
        'value="' + nearestHueIndex(m.hue) + '" data-act="pick-hue" aria-label="Hue" ' +
        'style="--stops:' + hueStops() + '">' +
      '<div class="cells" style="--cols:' + SATS.length + '">' + cells + '</div>' +
    '</div>' +
    // No spacer between them: it is a third flex child with a gap either side,
    // which was enough to wrap the pair onto two lines on a phone.
    '<div class="row" style="margin-top:20px;align-items:center;' +
      'justify-content:space-between;flex-wrap:nowrap">' +
      '<button class="btn btn-ghost" data-act="cancel-colour">Cancel</button>' +
      '<button class="btn btn-primary" data-act="use-colour">Use this colour</button>' +
    '</div>'
  );
}

function colourSwatches(current, act, extra) {
  var palette = S.storeColours.length ? S.storeColours : ['#5F8A20'];
  var cur = (current || '').toLowerCase();
  var list = palette.slice();
  if (cur && palette.every(function (c) { return c.toLowerCase() !== cur; })) list.push(current);

  var swatches = list.map(function (c) {
    var on = cur === c.toLowerCase();
    return '<button class="swatch' + (on ? ' is-on' : '') + '" style="--fz:' + esc(c) + '" ' +
      'data-act="' + act + '" data-colour="' + esc(c) + '" ' + extra + ' ' +
      'aria-label="Colour ' + esc(c) + '" aria-pressed="' + (on ? 'true' : 'false') + '"></button>';
  }).join('');

  return '<div class="swatches">' + swatches +
    '<button class="swatch swatch-other" data-act="open-colour" ' + extra + ' ' +
      'data-current="' + esc(current || '') + '" ' +
      'aria-label="Choose another colour">+</button>' +
  '</div>';
}

function storeDraftColour(row, i) {
  return row.colour || S.storeColours[i % (S.storeColours.length || 1)] || '#5F8A20';
}

function firstRunDraft() {
  if (!S.newStores) S.newStores = [{ name: '', where: '', colour: '' }];
  return S.newStores;
}

function renderFirstRun() {
  var rows = firstRunDraft();
  var palette = S.storeColours.length ? S.storeColours : ['#5F8A20'];

  // Both what is already saved and what is in the form: offering "Kitchen" to
  // somebody who already has a Kitchen only leads to a duplicate-name refusal.
  var used = {};
  S.stores.forEach(function (f) { used[f.name.trim().toLowerCase()] = true; });
  rows.forEach(function (r) { if (r.name) used[r.name.trim().toLowerCase()] = true; });

  var suggestions = S.suggestedStores
    .filter(function (n) { return !used[n.toLowerCase()]; })
    .map(function (n) {
      return '<button class="chip" data-act="store-suggest" data-name="' + esc(n) + '">' + esc(n) + '</button>';
    }).join('');

  var cards = rows.map(function (row, i) {
    var swatches = colourSwatches(storeDraftColour(row, i), 'store-colour', 'data-row="' + i + '"');

    return '<div class="card stack">' +
      '<div class="row">' +
        '<div class="spacer">' +
          '<label class="label" for="store-name-' + i + '">What is it called?</label>' +
          '<input class="input input-hero" id="store-name-' + i + '" type="text" ' +
            'placeholder="Garage" value="' + esc(row.name) + '" ' +
            'data-act="store-name" data-row="' + i + '">' +
        '</div>' +
        (rows.length > 1
          ? '<button class="btn btn-ghost btn-compact" data-act="store-row-del" data-row="' + i + '" ' +
            'aria-label="Remove this one">Remove</button>'
          : '') +
      '</div>' +

      '<div>' +
        '<label class="label" for="store-where-' + i + '">Where is it? <span class="muted small">optional</span></label>' +
        '<input class="input" id="store-where-' + i + '" type="text" ' +
          'placeholder="Chest freezer by the door" value="' + esc(row.where) + '" ' +
          'data-act="store-where" data-row="' + i + '">' +
      '</div>' +

      '<div>' +
        '<span class="label">Which colour marks it?</span>' +
        swatches +
      '</div>' +
    '</div>';
  }).join('');

  var named = rows.filter(function (r) { return r.name.trim(); }).length;

  var adding = S.tab === 'settings-place';

  return '<div class="stack">' +
    '<div class="card">' +
      '<div style="font-size:1.5rem;font-weight:800;letter-spacing:-.03em">' +
        (adding ? 'Add a place' : 'Where do you keep things?') + '</div>' +
      '<p class="muted" style="margin-top:8px">' +
        'A freezer, a fridge, the pantry, a shelf in the shed &mdash; anywhere you want to keep ' +
        'track of. You can add more later, and change any of this in the spreadsheet whenever ' +
        'you like.' +
      '</p>' +
      (suggestions
        ? '<div style="margin-top:12px"><span class="label">Common ones</span>' +
          '<div class="chips">' + suggestions + '</div></div>'
        : '') +
    '</div>' +

    cards +

    '<button class="btn btn-ghost" data-act="store-row-add">Add another place</button>' +

    '<button class="btn btn-warm btn-hero" data-act="save-stores"' +
      (named && !S.busy ? '' : ' disabled') + '>' +
      (S.busy ? 'Saving&hellip;' : named > 1 ? 'Save these ' + named + ' places' : 'Save this place') +
    '</button>' +

    (adding
      ? '<button class="btn btn-ghost" data-act="settings-open">Cancel</button>'
      : S.sheetUrl
        ? '<p class="muted small" style="text-align:center">or ' +
          '<a href="' + esc(S.sheetUrl) + '" target="_blank" rel="noopener">set them up in the spreadsheet</a></p>'
        : '') +
  '</div>';
}

/* ------------------------------------------------------------- settings */

function themeChoice(id, label) {
  var on = S.theme === id;
  return '<button class="chip' + (on ? ' is-on' : '') + '" data-act="set-theme" data-theme-id="' + id + '" ' +
    'aria-pressed="' + (on ? 'true' : 'false') + '">' + label + '</button>';
}

/** Catalogue entries with nothing under them — the things editing mode is for. */
function unstockedItems() {
  var held = {};
  S.inventory.forEach(function (l) { held[norm(l.item)] = 1; });
  return S.items.filter(function (i) { return !held[norm(i.name)]; });
}

function renderSettings() {
  var spare = unstockedItems();

  var spareRows = spare.length
    ? spare.map(function (i) {
        return '<div class="row row-line">' +
          '<div class="spacer">' + esc(i.name) +
            '<span class="muted small"> &middot; ' + esc(i.category) + '</span></div>' +
          '<button class="btn btn-ghost btn-compact" data-act="open-rename" data-scope="item" ' +
            'data-from="' + esc(i.name) + '">Rename</button>' +
          (i.everStored
            ? '<span class="muted small" title="It has been stored before, so the ' +
              'type-ahead will keep suggesting it whatever the item list says">kept</span>'
            : '<button class="btn btn-ghost btn-compact" data-act="delete-item" ' +
              'data-name="' + esc(i.name) + '">Remove</button>') +
          '</div>';
      }).join('')
    : '<p class="muted small">Nothing to tidy up &mdash; every item in the list has bags under it.</p>';

  var kept = spare.filter(function (i) { return i.everStored; }).length;

  var v = S.version;

  return '<div class="stack">' +

    '<div class="card stack">' +
      '<div class="card-title">How it looks</div>' +
      '<div class="chips">' +
        themeChoice('auto', 'Match the tablet') +
        themeChoice('light', 'Light') +
        themeChoice('dark', 'Dark') +
      '</div>' +
    '</div>' +

    '<div class="card stack">' +
      '<div class="row">' +
        '<div class="spacer">' +
          '<div class="card-title">Editing</div>' +
          '<p class="muted small" style="margin:6px 0 0">Shows the rename controls, and lists ' +
            'anything left in the item list with no bags under it.</p>' +
        '</div>' +
        '<button class="btn ' + (S.editing ? 'btn-warm' : 'btn-ghost') + ' btn-compact" ' +
          'data-act="toggle-editing" aria-pressed="' + (S.editing ? 'true' : 'false') + '">' +
          (S.editing ? 'On' : 'Off') + '</button>' +
      '</div>' +
      (S.editing
        ? '<div class="stack" style="margin-top:6px">' +
            '<div class="label">Items with nothing stored</div>' + spareRows +
            (kept
              ? '<p class="muted small" style="margin:0">Marked <b>kept</b> means it has been ' +
                'stored before. Those stay in the suggestions whatever the item list says, ' +
                'because that history is the record and is not this screen\'s to edit.</p>'
              : '') +
          '</div>'
        : '') +
    '</div>' +

    '<div class="card stack">' +
      '<div class="card-title">Places</div>' +
      S.stores.map(function (f) {
        return '<div class="row row-line">' + dot(f.colour) +
          '<div class="spacer">' + esc(f.name) +
            (f.where ? '<span class="muted small"> &middot; ' + esc(f.where) + '</span>' : '') +
          '</div>' +
          '<button class="btn btn-ghost btn-compact" data-act="open-store-edit" ' +
            'data-name="' + esc(f.name) + '">Edit</button>' +
          '</div>';
      }).join('') +
      '<button class="btn btn-ghost" data-act="settings-add-place">Add a place</button>' +
    '</div>' +

    '<div class="card stack">' +
      '<div class="card-title">This copy</div>' +
      (v
        ? '<div class="row row-line"><div class="spacer">Version</div>' +
            '<span class="muted small">' + esc(v.build ? fmtDate(String(v.build).slice(0, 10)) : '\u2014') +
            (v.commit ? ' &middot; ' + esc(v.commit) : '') + '</span></div>' +
          (v.branch && v.branch !== 'main'
            ? '<div class="muted small">Following <b>' + esc(v.branch) + '</b>, not a released build.</div>'
            : '') +
          (v.error
            ? '<div class="muted small">' + esc(v.error) + '</div>'
            : v.newer
              ? '<div class="banner" style="display:block">A newer version is available' +
                (v.notes ? ': ' + esc(v.notes) : '.') +
                '<div class="muted small" style="margin-top:6px">Open the spreadsheet and choose ' +
                '<b>Pantry Cache &rarr; Check for updates</b> to install it.</div></div>'
              : '<div class="muted small">This is the newest published version.</div>')
        : '<button class="btn btn-ghost" data-act="check-updates">' +
          (S.busy ? 'Checking&hellip;' : 'Check for updates') + '</button>') +
    '</div>' +

    renderProblems() +
    renderSheetLink() +
  '</div>';
}

function renderPanel() {
  if (S.loadFailed) return renderLoadFailed();
  if (isFirstRun()) return renderFirstRun();
  if (S.tab === 'settings') return renderSettings();
  if (S.tab === 'settings-place') return renderFirstRun();
  if (S.tab === 'add') return renderAdd();
  if (S.tab === 'view') return renderView();
  return renderTake();
}

/**
 * Shown instead of the tabs, not alongside them. A toast that disappears after
 * nine seconds leaves a plausible, false empty state behind for ever; this
 * stays until a reload works.
 */
function renderLoadFailed() {
  return '<div class="stack">' +
    '<div class="banner" style="display:block">' +
      '<div style="font-weight:700;font-size:1.05rem">The store list could not be fetched</div>' +
      '<div style="margin-top:6px;font-weight:500">' +
        'This is not the same as the stores being empty &mdash; nothing has been read, ' +
        'so nothing can be shown. Your spreadsheet is untouched.' +
      '</div>' +
    '</div>' +
    '<button class="btn btn-primary btn-hero btn-block" data-act="refresh">Try again</button>' +
    (S.sheetUrl
      ? '<a class="btn btn-block" href="' + esc(S.sheetUrl) + '" target="_blank" rel="noopener">Open the spreadsheet instead</a>'
      : '') +
    '</div>';
}

/* ------------------------------------------------------------------ ADD */

function matchItems(q) {
  var n = norm(q);
  if (!n) return S.items.slice(0, 10);
  var starts = [], contains = [];
  S.items.forEach(function (it) {
    var k = norm(it.name);
    if (k.indexOf(n) === 0) starts.push(it);
    else if (k.indexOf(n) > -1) contains.push(it);
  });
  return starts.concat(contains).slice(0, 20);
}

function renderAdd() {
  if (!S.draft.item) return renderAddPick();
  return renderAddDetails();
}

/** How many tiles fill two rows of the grid at tablet width. */
var TILES_PER_CATEGORY = 6;

function renderAddPick() {
  var q = S.query.trim();
  return '<div class="stack">' +
    '<div>' +
      '<label class="label" for="q-item">What are you putting in the store?</label>' +
      '<input class="input input-hero" id="q-item" type="text" autocomplete="off" ' +
        'placeholder="Type a name&hellip;" value="' + esc(S.query) + '" data-act="query">' +
    '</div>' +
    (q ? renderAddSearch(q) : renderAddBrowse()) +
    renderRecentAdds() +
    '</div>';
}

/** One item as a grid tile: the name, and what is already in store. */
function itemTile(it) {
  var inStock = S.inventory.filter(function (l) { return norm(l.item) === norm(it.name); });
  var meta = inStock.length
    ? lotsSize(inStock)[0] + ' &middot; ' + inStock.length + (inStock.length === 1 ? ' bag' : ' bags')
    : 'none in';
  return '<button class="tile' + (inStock.length ? '' : ' is-empty') + '" data-act="pick-item" ' +
    'data-name="' + esc(it.name) + '" data-category="' + esc(it.category) + '" data-typical="' + (it.typicalG || 0) + '" ' +
    'data-count="' + (it.typicalCount || 0) + '" data-unit="' + esc(it.unit || '') + '">' +
    '<div class="tile-name">' + esc(it.name) + '</span>' +
    '<div class="tile-meta">' + meta + '</span></button>';
}

/**
 * Browsing view: items grouped by category, both the categories and the items
 * inside them ordered by how often they are used, so the things she reaches for
 * most are the ones under her thumb. Each category shows two rows before
 * offering the rest, which keeps the whole catalogue to a screen or two.
 */
function renderAddBrowse() {
  if (!S.items.length) {
    return '<div class="empty"><span class="empty-mark">&#127811;</span>' +
      'Start typing what you have picked &mdash; raspberries, runner beans, rhubarb&hellip;</div>';
  }

  var byCat = {};
  // S.items arrives sorted by use, so each bucket keeps that order.
  S.items.forEach(function (it) {
    (byCat[it.category] = byCat[it.category] || []).push(it);
  });

  var cats = Object.keys(byCat).sort(function (a, b) {
    var ua = sum(byCat[a], function (it) { return it.uses; });
    var ub = sum(byCat[b], function (it) { return it.uses; });
    return ub - ua || byCat[b].length - byCat[a].length || a.localeCompare(b);
  });

  return cats.map(function (cat) {
    var all = byCat[cat];
    var expanded = !!S.openCats[cat];
    // When there is an overflow tile it has to live inside the two rows too,
    // so it takes the last slot rather than spilling onto a third row.
    var cap = all.length > TILES_PER_CATEGORY ? TILES_PER_CATEGORY - 1 : TILES_PER_CATEGORY;
    var shown = expanded ? all : all.slice(0, cap);
    var hidden = all.length - shown.length;

    var tiles = shown.map(itemTile).join('');
    if (hidden > 0) {
      tiles += '<button class="tile tile-more" data-act="more-cat" data-cat="' + esc(cat) + '">' +
        '&#43; ' + hidden + ' more</button>';
    } else if (expanded && all.length > TILES_PER_CATEGORY) {
      tiles += '<button class="tile tile-more" data-act="more-cat" data-cat="' + esc(cat) + '">Show fewer</button>';
    }

    return '<div class="cat-head"><span class="cat-name">' + esc(cat) + '</span>' +
      '<span class="cat-count">' + all.length + '</span></div>' +
      '<div class="tile-grid">' + tiles + '</div>';
  }).join('');
}

/** Searching flattens the categories — a match is a match, wherever it lives. */
function renderAddSearch(q) {
  var matches = matchItems(q);
  var exact = S.items.some(function (it) { return norm(it.name) === norm(q); });

  var newTile = !exact
    ? '<button class="tile tile-new" data-act="new-item" data-name="' + esc(q) + '">' +
      '<div class="tile-name">&#43; ' + esc(tidyName(q)) + '</span>' +
      '<div class="tile-meta">something new</span></button>'
    : '';

  if (!matches.length && !newTile) return '';
  return '<div class="tile-grid">' + newTile + matches.map(itemTile).join('') + '</div>';
}

function countStores(lots) {
  var names = {};
  lots.forEach(function (l) { names[l.store] = 1; });
  var list = Object.keys(names);
  return list.length === 1 ? list[0] : list.length + ' stores';
}

function renderAddDetails() {
  var d = S.draft;
  var sized = (d.weightG > 0 && d.weightConfirmed) || (d.showCount && d.count > 0);
  var canSave = d.item && d.store && sized && !S.busy;

  // An unconfirmed weight must not light its chip up: a selected "500 g"
  // beside a readout saying it is a guess says two opposite things at once.
  var weightChips = [100, 250, 500, 1000, 2000].map(function (g) {
    var on = d.weightG === g && d.weightConfirmed;
    return '<button class="chip' + (on ? ' is-on' : '') + '" data-act="set-weight" data-g="' + g + '">' + fmtW(g) + '</button>';
  }).join('');

  var storeBtns = S.stores.map(function (f) {
    return '<button class="chip' + (d.store === f.name ? ' is-on' : '') + '" data-act="set-store" data-name="' + esc(f.name) + '">' +
      dot(f.colour) + esc(f.name) + '</button>';
  }).join('');

  var backdated = !!d.dateIn && (d.dateIn !== S.today || d.monthOnly);
  var dateLabel = d.dateIn === S.today && !d.monthOnly
    ? 'Today &middot; ' + esc(fmtDate(d.dateIn))
    : esc(fmtWhen({ dateIn: d.dateIn, monthOnly: d.monthOnly }));

  return '<div class="stack">' +

    '<div class="card">' +
      '<div class="row">' +
        '<div class="spacer">' +
          '<div style="font-size:1.6rem;font-weight:800;letter-spacing:-.03em">' + esc(d.item) + '</div>' +
          '<div class="badge" style="margin-top:6px">' + esc(d.category) + '</div>' +
        '</div>' +
        '<button class="btn btn-ghost" data-act="clear-item">Change</button>' +
      '</div>' +
    '</div>' +

    '<div class="card stack">' +
      '<div><span class="label">How much in each bag or tub?</span>' +
        (d.weightG > 0
          ? stepControl(d.weightG, {
              steps: WEIGHT_STEPS, fmt: fmtW, noun: 'grams',
              bump: 'bump-weight', type: 'type-weight',
              hint: d.weightConfirmed ? '' : 'a guess — set it',
            })
          : '<div class="not-set">Not weighed <button class="btn btn-ghost" data-act="set-weight" data-g="500">Add a weight</button></div>') +
        '<div class="chips" style="margin-top:10px">' + weightChips + '</div>' +
        (d.weightG > 0 && d.showCount && d.count > 0
          ? '<button class="btn btn-ghost btn-compact" style="padding-left:0;margin-top:6px" ' +
            'data-act="set-weight" data-g="0">Don&rsquo;t weigh it &mdash; count only</button>'
          : '') +
      '</div>' +

      '<div>' + (d.showCount
        ? '<span class="label">How many pieces in each bag?</span>' +
          stepControl(d.count || 1, {
            steps: COUNT_STEPS, noun: 'pieces', bump: 'bump-count', type: 'type-count',
            fmt: function (n) { return fmtCount(n, d.unit); },
          }) +
          '<div class="chips" style="margin-top:10px">' +
            unitChoices(d.unit).map(function (u) {
              return '<button class="chip' + (norm(d.unit) === norm(u) ? ' is-on' : '') + '" data-act="set-unit" data-unit="' + esc(u) + '">' + esc(u) + '</button>';
            }).join('') +
          '</div>' +
          // A word to choose, a dialog to open and a field to delete were three
          // different kinds of thing wearing identical pills.
          '<div class="row" style="margin-top:6px;gap:4px">' +
            '<button class="btn btn-ghost btn-compact" style="padding-left:0" data-act="type-unit">' +
              'Another word&hellip;</button>' +
            '<button class="btn btn-ghost btn-compact" data-act="hide-count">' +
              'Don&rsquo;t count them</button>' +
          '</div>'
        : '<button class="btn btn-ghost" style="padding-left:0" data-act="show-count">' +
          '&#43; Count the pieces (cobs, portions&hellip;)</button>') +
      '</div>' +

      '<div><span class="label">How many of them?</span>' +
        '<div class="stepper">' +
          '<button class="stepper-btn" id="bump-qty-m1" data-act="bump-qty" data-by="-1"' + (d.qty <= 1 ? ' disabled' : '') + '>&minus;1</button>' +
          '<div class="stepper-value">' + d.qty + '<small>' + (d.qty === 1 ? 'bag / tub' : 'bags / tubs') + '</small></div>' +
          '<button class="stepper-btn" id="bump-qty-p1" data-act="bump-qty" data-by="1">&plus;1</button>' +
        '</div>' +
      '</div>' +
    '</div>' +

    '<div class="card">' +
      '<span class="label">Which store?</span>' +
      // No "none listed yet" fallback: an empty store list is caught by
      // renderFirstRun() before this screen is ever reached.
      '<div class="chips">' + storeBtns + '</div>' +
    '</div>' +

    '<div class="card' + (backdated ? ' is-flagged' : '') + '">' +
      '<span class="label">Date it went in</span>' +
      '<div class="row">' +
        '<div class="spacer" style="font-size:1.1rem;font-weight:700">' + dateLabel +
          (backdated ? ' <span class="badge badge-warm">not today</span>' : '') + '</div>' +
        '<button class="btn" data-act="open-date">Change date</button>' +
      '</div>' +
      // The date is kept between bags so a run of bagging-up stays quick, and
      // it is the one field that is occasionally wrong on purpose. Backdate one
      // bag and every bag after it was silently filed under that month, with
      // the only signal being that the word "Today" quietly disappeared.
      (backdated
        ? '<div class="muted small" style="margin-top:8px">' +
          'Kept from the last bag. <button class="btn btn-ghost btn-compact" style="padding-left:0" ' +
          'data-act="set-date" data-date="' + S.today + '">Use today instead</button></div>'
        : '') +
      (d.showNote
        ? '<div style="margin-top:14px"><span class="label">Note (optional)</span>' +
          '<input class="input" id="note-input" type="text" placeholder="e.g. from the top bed" value="' + esc(d.note) + '" data-act="note"></div>'
        : '<button class="btn btn-ghost" style="margin-top:8px;padding-left:0" data-act="show-note">&#43; Add a note</button>') +
    '</div>' +

    '<button class="btn btn-primary btn-hero btn-block" data-act="save-add"' + (canSave ? '' : ' disabled') +
      ' aria-label="Put ' + d.qty + ' of ' + esc(draftEach(d)) + ' ' + esc(d.item) + ' in the ' + esc(d.store) + ' store">' +
      (S.busy ? 'Saving&hellip;' :
        '<span>Put in the ' + esc(d.store || '&hellip;') + ' store' +
        '<span class="btn-sub">' + esc(draftSummary(d)) + '</span></span>') +
    '</button>' +

    renderRecentAdds() +
    '</div>';
}

/**
 * The stepper used for weights and for counts alike. Unlabelled +/- buttons
 * were the original complaint: you could not tell how far each press moved you.
 * So every button states its own size, there is a coarse pair outside and a
 * fine pair inside, and the number itself opens a keypad.
 */
function stepControl(value, opts) {
  var steps = opts.steps;
  var fmt = opts.fmt;
  var max = opts.max || 0;

  // render() restores focus by id, and only text inputs had one — so pressing
  // +50 destroyed the button and dropped focus to <body>. A stable id per
  // action and step is all the existing logic needs.
  function btn(by) {
    var over = max && by > 0 && value + by > max;
    var under = value + by < (opts.min === undefined ? 1 : opts.min);
    return '<button class="step-btn' + (Math.abs(by) === steps[1] ? ' step-fine' : ' step-coarse') + '" ' +
      'id="' + esc(opts.bump) + '-' + (by > 0 ? 'p' : 'm') + Math.abs(by) + '" ' +
      'data-act="' + opts.bump + '" data-by="' + by + '"' + (over || under ? ' disabled' : '') +
      ' aria-label="' + (by > 0 ? 'Add ' : 'Take off ') + Math.abs(by) + ' ' + esc(opts.noun) + '">' +
      (by > 0 ? '&plus;' : '&minus;') + Math.abs(by) + '</button>';
  }

  return '<div class="weigher' + (opts.hint ? ' is-unset' : '') + '">' +
    btn(-steps[0]) + btn(-steps[1]) +
    '<button class="weigher-value" id="' + esc(opts.type) + '" data-act="' + opts.type + '" aria-label="Type an exact ' + esc(opts.noun) + '">' +
      esc(fmt(value)) + '<small>' + esc(opts.hint || 'tap to type') + '</small></button>' +
    btn(steps[1]) + btn(steps[0]) +
    '</div>';
}

/** "6 cobs · 900 g" — one bag, in whichever measures are set. */
function draftEach(d) {
  return lotSize({ weightG: d.weightG, count: d.showCount ? d.count : 0, unit: d.unit });
}

/**
 * One bag reads as just its size; several read as the per-bag size and the
 * total. Both halves can contain a middle dot, so they are joined with a dash
 * rather than another dot.
 */
function draftSummary(d) {
  var each = draftEach(d);
  var dated = d.dateIn && d.dateIn !== S.today
    ? ' \u2014 dated ' + fmtWhen({ dateIn: d.dateIn, monthOnly: d.monthOnly })
    : '';
  if (d.qty === 1) return each + dated;
  var total = lotSize({
    weightG: d.weightG * d.qty,
    count: (d.showCount ? d.count : 0) * d.qty,
    unit: d.unit,
  });
  return d.qty + ' bags of ' + each + ' \u2014 ' + total + ' in total' + dated;
}

function renderRecentAdds() {
  if (!S.recentAdds.length) return '';
  var rows = S.recentAdds.map(function (r, i) {
    return '<div class="row-btn" style="cursor:default">' +
      '<div class="row-main"><div class="row-name">' + esc(r.label) + '</div>' +
      '<div class="row-meta">' + esc(r.sub) + '</div></div>' +
      '<button class="btn btn-ghost" data-act="undo-recent" data-kind="add" data-i="' + i + '">Undo</button></div>';
  }).join('');
  return '<div class="card card-flush">' +
    '<div class="card-head"><div class="card-title">Put in just now</div></div>' + rows + '</div>';
}

/* ----------------------------------------------------------------- VIEW */

function renderView() {
  var inv = filtered();
  var q = norm(S.search);

  var kinds = {};
  inv.forEach(function (l) { kinds[norm(l.item)] = 1; });

  var head = '<div class="stack">' +
    '<div class="summary">' +
      totalStat(inv) +
      stat(String(inv.length), inv.length === 1 ? 'Bag / tub' : 'Bags / tubs') +
      stat(String(Object.keys(kinds).length), 'Different things') +
    '</div>' +
    storeFilter('') +
    searchBox('Search the stores\u2026');

  var body = inv.length
    ? renderByItem(inv)
    : '<div class="empty"><span class="empty-mark">&#128230;</span>' +
      (q || S.store !== 'all'
        ? 'Nothing here matches.'
        : 'Nothing is stored yet. Add something on the <b>Put in</b> tab.') +
      '</div>';

  return head + body + renderRecentTakes() + '</div>' + renderMoveBar();
}

/** The store filter, shared by both tabs, with each chip carrying its total. */
function storeFilter(warm) {
  var on = warm ? ' is-on-warm' : ' is-on';
  var allTotal = sum(S.inventory, function (l) { return l.weightG; });
  return '<div class="chips">' +
    '<button class="chip' + (S.store === 'all' ? on : '') + '" data-act="set-store-filter" data-name="all">' +
      'All stores <span class="chip-num">' + esc(fmtWTotal(allTotal)) + '</span></button>' +
    S.stores.map(function (f) {
      var t = sum(S.inventory.filter(function (l) { return l.store === f.name; }), function (l) { return l.weightG; });
      return '<button class="chip' + (S.store === f.name ? on : '') + '" data-act="set-store-filter" data-name="' + esc(f.name) + '">' +
        dot(f.colour) + esc(f.name) +
        ' <span class="chip-num">' + esc(fmtWTotal(t)) + '</span></button>';
    }).join('') +
    '</div>';
}

function searchBox(placeholder) {
  return '<label class="sr-only" for="search">' + esc(placeholder) + '</label>' +
    '<input class="input" id="search" type="search" placeholder="' + esc(placeholder) + '" ' +
    'aria-label="' + esc(placeholder) + '" value="' + esc(S.search) + '" data-act="set-search">';
}

/** The inventory as both tabs see it: one store filter, one search. */
function filtered() {
  var inv = S.inventory;
  if (S.store !== 'all') inv = inv.filter(function (l) { return l.store === S.store; });
  var q = norm(S.search);
  if (q) {
    inv = inv.filter(function (l) {
      return norm(l.item).indexOf(q) > -1 || norm(l.category).indexOf(q) > -1;
    });
  }
  return inv;
}

/**
 * Cells the sheet could not be read from. The old parsers had no failure mode —
 * "1.5kg" in a column headed Weight (g) silently became 2 grams — so this is
 * the other half of that fix: say which row, say what was in it, and point at
 * the spreadsheet, which is where it gets corrected.
 */
function renderProblems() {
  if (!S.problems.length) return '';
  var lines = S.problems.slice(0, 6).map(function (p) {
    return '<li>' + esc(p.item || 'A bag') + ' &mdash; ' + esc(p.field) +
      ' reads &ldquo;' + esc(p.raw) + '&rdquo;</li>';
  }).join('');
  var more = S.problems.length > 6 ? '<li>&hellip;and ' + (S.problems.length - 6) + ' more</li>' : '';
  return '<div class="banner" style="display:block">' +
    '<div style="font-weight:700">' +
      (S.problems.length === 1
        ? 'One cell in the spreadsheet could not be read'
        : S.problems.length + ' cells in the spreadsheet could not be read') +
    '</div>' +
    '<ul style="margin:8px 0 0;padding-left:20px;font-weight:500">' + lines + more + '</ul>' +
    '<div class="small" style="margin-top:8px;font-weight:500">' +
      'Those are being counted as nothing. Open the spreadsheet below to put them right.</div>' +
    '</div>';
}

/**
 * The spreadsheet is the real database, so give it a visible door: this is how
 * you add a store, rename something, or fix a mistake the app cannot.
 */
/**
 * Only on In store, only while editing, and only once something is ticked —
 * so nothing about the ordinary browsing screen changes until it is asked for.
 */
function renderMoveBar() {
  if (!S.editing || S.tab !== 'view') return '';
  var picked = Object.keys(S.moving);
  var lots = picked.map(lotById).filter(Boolean);
  if (!lots.length) return '';

  var where = {};
  lots.forEach(function (l) { where[l.store] = 1; });
  var from = Object.keys(where);

  return '<div class="pickbar">' +
    '<div class="pickbar-inner">' +
      '<button class="btn btn-ghost btn-compact" data-act="clear-moves">Clear</button>' +
      '<div class="spacer">' +
        '<div style="font-weight:700">' + lots.length + (lots.length === 1 ? ' bag' : ' bags') + ' chosen</div>' +
        '<div class="small muted">' +
          (from.length === 1 ? 'in the ' + esc(from[0]) : 'across ' + from.length + ' places') +
        '</div>' +
      '</div>' +
      '<button class="btn btn-primary" data-act="open-move"' + (S.busy ? ' disabled' : '') + '>' +
        'Move&hellip;</button>' +
    '</div>' +
  '</div>';
}

function renderSheetLink() {
  return '<div class="card">' +
    '<div class="card-title">Where all this is kept</div>' +
    '<p class="muted small" style="margin:6px 0 14px">Everything lives in a Google Sheet you can open like a spreadsheet. ' +
    'That is where you add a new store, correct a date, or check back over past years.</p>' +
    (S.sheetUrl
      ? '<a class="btn btn-block" href="' + esc(S.sheetUrl) + '" target="_blank" rel="noopener">Open the spreadsheet</a>'
      : '<div class="muted small">(The link appears once the app is running from the spreadsheet.)</div>') +
    '</div>';
}

function stat(num, label, sub) {
  return '<div class="stat"><div class="stat-num">' + esc(num) + '</div>' +
    (sub ? '<div class="stat-sub">' + esc(sub) + '</div>' : '') +
    '<div class="stat-label">' + esc(label) + '</div></div>';
}

/**
 * Leads with weight where there is any, and with the count where there is not,
 * so a shelf of unweighed artichokes does not report itself as "0 g".
 */
function totalStat(lots) {
  var totals = lotsSize(lots, true);
  var weighed = lots.some(function (l) { return l.weightG > 0; });
  // Was: dropped to '' entirely at four or more measures, so with cobs,
  // litres, blocks and boxes in store the summary showed the weight and
  // silently omitted the rest. Constraint 7 says not to add them up; that is
  // not a licence to hide them.
  var rest = totals.slice(1);
  var sub = rest.length <= 2
    ? rest.join(' \u00b7 ')
    : rest.slice(0, 2).join(' \u00b7 ') + ' \u00b7 +' + (rest.length - 2) + ' more';
  return stat(totals[0], weighed ? 'Total weight' : 'Total', sub);
}

function renderByItem(inv) {
  var oneStore = S.store !== 'all';
  var byCat = groupBy(inv, function (l) { return l.category; });

  var sections = Object.keys(byCat).sort().map(function (cat) {
    var lots = byCat[cat];
    var byItem = groupBy(lots, function (l) { return l.item; });
    var rows = Object.keys(byItem).sort().map(function (item) {
      return itemRow(byItem[item], 'i:' + cat + ':' + item, oneStore ? S.store : null);
    }).join('');
    // One figure only. A section header listing every unit gets long, and
    // "1 bag" as a unit reads confusingly next to "24 bags" as the tally, so
    // the per-unit detail is left to the item rows underneath.
    var size = lotsSize(lots, true)[0];
    return '<div class="group-head">' + esc(cat) +
      ' <span class="group-meta">' + (size === '—' ? '' : esc(size) + ' &middot; ') +
      lots.length + (lots.length === 1 ? ' bag' : ' bags') + '</span>' +
      '<span class="spacer"></span>' +
      (S.editing
        ? '<button class="icon-btn" data-act="open-rename" data-scope="category" data-from="' + esc(cat) + '" ' +
          'aria-label="Rename ' + esc(cat) + '" title="Rename ' + esc(cat) + '">&#9998;</button>'
        : '') +
      '</div>' + rows;
  }).join('');

  return '<div class="card card-flush">' +
    '<div class="card-hint">tap to see each bag</div>' + sections + '</div>';
}

/** One expandable row: totals on top, individual bags underneath. */
function itemRow(lots, key, storeContext) {
  var open = !!S.open[key];
  var totals = lotsSize(lots);
  var sorted = lots.slice().sort(byAge);
  var oldest = datedFirst(sorted)[0];

  var meta = lots.length + (lots.length === 1 ? ' bag' : ' bags');
  if (!storeContext) {
    var places = {};
    lots.forEach(function (l) { places[l.store] = (places[l.store] || 0) + l.weightG; });
    meta += ' &middot; ' + Object.keys(places).map(function (p) {
      return storeBadge(p);
    }).join(' ');
  }

  var detail = open
    ? '<div class="lots">' + sorted.map(function (l, i) {
        return '<div class="lot' + (S.editing && S.moving[l.id] ? ' is-picked' : '') + '">' +
          (S.editing
            ? '<button class="tick' + (S.moving[l.id] ? ' is-on' : '') + '" data-act="toggle-move" ' +
              'data-id="' + esc(l.id) + '" role="checkbox" ' +
              'aria-checked="' + (S.moving[l.id] ? 'true' : 'false') + '" ' +
              'aria-label="Choose this bag to move">' +
              (S.moving[l.id] ? '&#10003;' : '') + '</button>'
            : '') +
          '<span class="lot-weight">' + esc(lotSize(l)) + '</span>' +
          '<span class="lot-date">' +
            (l.dateIn ? esc(fmtWhen(l)) + ' &middot; ' + esc(ageText(l.dateIn)) : 'date not recorded') +
          '</span>' +
          (storeContext ? '' : storeBadge(l.store)) +
          (l.dateIn && l === oldest && sorted.length > 1 ? '<span class="badge badge-warm">use first</span>' : '') +
          (l.note ? '<span class="lot-date">' + esc(l.note) + '</span>' : '') +
          '<span class="spacer"></span>' +
          '<button class="row-more" data-act="ask-take" data-id="' + esc(l.id) + '" ' +
            'aria-label="More about this bag">&rsaquo;</button>' +
          '</div>';
      }).join('') +
      (S.editing
        ? '<div class="lots-foot">' +
          '<button class="btn btn-ghost btn-compact" style="padding-left:0" ' +
          'data-act="open-rename" data-scope="item" data-from="' + esc(lots[0].item) + '">' +
          '&#9998; Rename &ldquo;' + esc(lots[0].item) + '&rdquo;</button>' +
        '</div>'
        : '') + '</div>'
    : '';

  return '<button class="row-btn" data-act="toggle-open" data-key="' + esc(key) + '">' +
    '<span class="row-main"><span class="row-name">' + esc(lots[0].item) + '</span>' +
    '<span class="row-meta">' + meta +
      (oldest ? ' &middot; oldest ' + esc(fmtMonth(oldest.dateIn)) : ' &middot; no dates recorded') + '</span></span>' +
    '<span class="row-right"><span class="row-strong">' + esc(totals[0]) + '</span>' +
    (totals.length > 1 ? '<span class="row-sub">' + esc(totals.slice(1).join(' \u00b7 ')) + '</span>' : '') + '</span>' +
    '<span class="row-chevron">' + (open ? '&#9662;' : '&rsaquo;') + '</span></button>' + detail;
}

/* ----------------------------------------------------------------- TAKE */

/**
 * Oldest first, grouped by month, with the bags you are taking selectable.
 *
 * This screen used to exist twice: "In store → By age" rendered nearly
 * the same list, sorted the same way, and opened the same removal dialog, with
 * different chrome and its own filter state. The month headings came from
 * there; the "use first" badges from here.
 *
 * And it took one bag at a time. apiRemove has always accepted a list, but the
 * interface only ever sent one — so a meal was four modals and four round
 * trips, each toast replacing the last one's undo. The spec's third question is
 * "I am cooking. Remove what I have used", which is a plural sentence.
 */
function renderTake() {
  var lots = filtered().slice().sort(byAge);
  var shown = lots.slice(0, S.takeLimit);
  var picked = Object.keys(S.selected);

  var oldestSeen = {};
  var lastMonth = null;
  var rows = shown.map(function (l) {
    var first = l.dateIn && !oldestSeen[norm(l.item)];
    if (l.dateIn) oldestSeen[norm(l.item)] = 1;

    var month = l.dateIn ? l.dateIn.slice(0, 7) : 'none';
    var headHtml = '';
    if (month !== lastMonth) {
      lastMonth = month;
      headHtml = '<div class="group-head">' +
        (l.dateIn
          ? esc(fmtMonth(l.dateIn)) + ' <span class="group-meta">' + esc(ageText(l.dateIn)) + '</span>'
          : 'No date recorded <span class="group-meta">fix these in the spreadsheet</span>') +
        '</div>';
    }

    var on = !!S.selected[l.id];
    return headHtml +
      '<div class="pick-row' + (on ? ' is-picked' : '') + '">' +
        '<button class="pick" data-act="toggle-pick" data-id="' + esc(l.id) + '" ' +
          'role="checkbox" aria-checked="' + on + '" ' +
          'aria-label="' + esc(l.item + ', ' + lotSize(l) + ', ' + l.store + ' store') + '">' +
          '<span class="pick-box" aria-hidden="true">' + (on ? '&#10003;' : '') + '</span>' +
          '<span class="row-main">' +
            '<span class="row-name">' + esc(l.item) +
              (first ? ' <span class="badge badge-warm">use first</span>' : '') + '</span>' +
            '<span class="row-meta">' + storeBadge(l.store) + ' ' +
            (l.dateIn ? 'put in ' + esc(fmtWhen(l)) + ' &middot; ' + esc(ageText(l.dateIn)) : 'date not recorded') +
            (l.note ? ' &middot; ' + esc(l.note) : '') + '</span>' +
          '</span>' +
          '<span class="row-right"><span class="row-strong">' + esc(lotSize(l)) + '</span></span>' +
        '</button>' +
        '<button class="row-more" data-act="ask-take" data-id="' + esc(l.id) + '" ' +
          'aria-label="More about this bag">&rsaquo;</button>' +
      '</div>';
  }).join('');

  var more = lots.length > shown.length
    ? '<button class="btn btn-block" data-act="take-more" style="margin-top:12px">Show more (' + (lots.length - shown.length) + ' left)</button>'
    : '';

  var body = shown.length
    ? '<div class="card card-flush">' +
      '<div class="card-head"><div class="card-title">Oldest first</div><div class="spacer"></div>' +
      '<div class="card-sub">tap what you are taking out</div></div>' + rows + '</div>' + more
    : '<div class="empty"><span class="empty-mark">&#128230;</span>' +
      (S.inventory.length ? 'Nothing here matches.' : 'Nothing is stored yet.') + '</div>';

  return '<div class="stack">' +
    storeFilter('warm') +
    searchBox('Search the stores\u2026') +
    body +
    renderRecentTakes() +
    '</div>' +
    renderPickBar(picked);
}

/** The running tally, and the one call that takes them all out together. */
function renderPickBar(picked) {
  if (!picked.length) return '';
  var lots = picked.map(lotById).filter(Boolean);
  if (!lots.length) return '';
  var totals = lotsSize(lots, true);
  return '<div class="pickbar">' +
    '<div class="pickbar-inner">' +
      '<button class="btn btn-ghost btn-compact" data-act="clear-picks">Clear</button>' +
      '<div class="spacer">' +
        '<div style="font-weight:700">' + lots.length + (lots.length === 1 ? ' bag' : ' bags') + ' chosen</div>' +
        '<div class="small muted">' + esc(totals.join(' \u00b7 ')) + '</div>' +
      '</div>' +
      '<button class="btn btn-warm" data-act="do-take-picked"' + (S.busy ? ' disabled' : '') + '>' +
        (S.busy ? 'Taking out&hellip;' : 'Take ' + (lots.length === 1 ? 'it' : 'them') + ' out') + '</button>' +
    '</div>' +
    '</div>';
}

function renderRecentTakes() {
  if (!S.recentTakes.length) return '';
  var rows = S.recentTakes.map(function (r, i) {
    return '<div class="row-btn" style="cursor:default">' +
      '<div class="row-main"><div class="row-name">' + esc(r.label) + '</div>' +
      '<div class="row-meta">' + esc(r.sub) + '</div></div>' +
      '<button class="btn btn-ghost" data-act="undo-recent" data-kind="take" data-i="' + i + '">Put back</button></div>';
  }).join('');
  return '<div class="card card-flush">' +
    '<div class="card-head"><div class="card-title">Taken out just now</div></div>' + rows + '</div>';
}

/* ---------------------------------------------------------------- TOAST */

function renderToast() {
  if (!S.toast) return '';
  return '<div class="toast' + (S.toast.kind === 'bad' ? ' toast-bad' : '') + '">' +
    '<span class="toast-msg">' + esc(S.toast.msg) + '</span>' +
    (S.toast.undo ? '<button class="toast-undo" data-act="undo-toast">Undo</button>' : '') +
    '<button class="toast-close" data-act="hide-toast" aria-label="Dismiss">&times;</button>' +
    '</div>';
}

/* --------------------------------------------------------------- MODALS */

function renderModal() {
  var m = S.modal;
  if (!m) return '';
  if (m.kind === 'category') return modalCategory(m);
  if (m.kind === 'keypad') return modalKeypad(m);
  if (m.kind === 'date') return modalDate(m);
  if (m.kind === 'take') return modalTake(m);
  if (m.kind === 'part') return modalPart(m);
  if (m.kind === 'unit') return modalUnit(m);
  if (m.kind === 'edit') return modalEdit(m);
  if (m.kind === 'split') return modalSplit(m);
  if (m.kind === 'colour') return modalColour(m);
  if (m.kind === 'move') return modalMove(m);
  if (m.kind === 'store') return modalStore(m);
  if (m.kind === 'rename') return modalRename(m);
  return '';
}

function wrap(inner) {
  var notice = S.modal && S.modal.notice
    ? '<div class="banner" style="margin-bottom:14px">' + esc(S.modal.notice) + '</div>'
    : '';
  return '<div class="modal-card">' + notice + inner + '</div>';
}

/** Never an empty modal host, which :empty hides and the user reads as a dead tap. */
function modalGone() {
  return wrap(
    '<h2 class="modal-title">That bag has gone</h2>' +
    '<p class="muted">It is no longer in the store &mdash; it may have been taken out ' +
    'on another device, or undone.</p>' +
    '<button class="btn btn-primary btn-block" style="margin-top:16px" data-act="refresh">Reload the list</button>'
  );
}

function modalCategory(m) {
  var chips = S.categories.map(function (c) {
    return '<button class="chip" data-act="choose-category" data-category="' + esc(c) + '">' + esc(c) + '</button>';
  }).join('');
  return wrap(
    '<h2 class="modal-title">' + esc(m.name) + '</h2>' +
    '<p class="muted" style="margin-top:0">What sort of thing is it?</p>' +
    '<div class="chips">' + chips + '</div>' +
    '<div style="margin-top:16px"><span class="label">Or type a new sort</span>' +
    '<input class="input" id="cat-input" type="text" placeholder="e.g. Jams" data-act="cat-input" value="' + esc(m.custom || '') + '"></div>' +
    '<div class="row" style="margin-top:16px">' +
      '<button class="btn btn-ghost" data-act="close-modal">Cancel</button><span class="spacer"></span>' +
      '<button class="btn btn-primary" data-act="choose-category" data-category="' + esc(m.custom || '') + '"' + (m.custom ? '' : ' disabled') + '>Use this</button>' +
    '</div>'
  );
}

/**
 * Calculator-style keypad — the pattern every till and kitchen-scale app uses,
 * because typing a number beats hunting for it with arrows. Shared by the
 * Put in form and the part-take-out dialog via `m.target`.
 */
/** Everything the keypad shows that depends on what has been typed. */
function keypadValues(m) {
  var isWeight = !m.unit || m.unit === 'g';
  var oz = isWeight && m.oz;

  var typed = m.digits === '' ? 0 : Number(m.digits) || 0;
  var raw = oz ? Math.round(typed * GRAMS_PER_OZ) : Math.round(typed);
  var capped = m.max && raw > m.max ? m.max : raw;

  var note = '';
  if (m.max && raw > m.max) {
    note = 'There is only ' + (isWeight ? fmtW(m.max) : fmtCount(m.max, m.unit)) + ' in the bag, so that is all it will take.';
  } else if (oz && typed) {
    note = typed + ' oz is ' + fmtW(capped) + ' — round it off afterwards if you like.';
  } else if (isWeight && capped >= 1000) {
    note = 'That is ' + (capped / 1000).toFixed(2).replace(/\.?0+$/, '') + ' kg.';
  }

  return { isWeight: isWeight, oz: oz, capped: capped, note: note };
}

/** The display, the note and the button label — the three things a keypress moves. */
function keypadFace(m) {
  var v = keypadValues(m);
  return {
    digits: m.digits === '' ? '<span class="muted">0</span>' : esc(m.digits),
    unit: esc(v.oz ? 'oz' : (m.unit || 'g')),
    note: esc(v.note),
    action: (m.target === 'part' ? 'Take ' : 'Use ') +
      esc(v.isWeight ? fmtW(v.capped) : fmtCount(v.capped, m.unit)),
    enabled: v.capped >= 1,
    oz: !!v.oz,
  };
}

/**
 * Writes only those three, leaving the keys in the DOM. Rewriting the whole
 * dialog per keystroke tore the buttons out from under the finger pressing
 * them: no pressed state, and a tap landing mid-rewrite hit a node that had
 * already gone. Returns false when the layout itself has to change — switching
 * grams to ounces swaps the last key — so the caller can fall back.
 */
function patchKeypad(m) {
  var host = $('#modal-host');
  var display = host.querySelector('.keypad-number');
  var apply = host.querySelector('[data-act="keypad-apply"]');
  if (!display || !apply) return false;

  var face = keypadFace(m);
  var lastKey = host.querySelector('.keypad .key:nth-last-child(2)');
  if (!lastKey || lastKey.textContent !== (face.oz ? '.' : '00')) return false;

  display.innerHTML = face.digits;
  host.querySelector('.keypad-unit').textContent = face.unit;
  host.querySelector('.keypad-note').textContent = face.note;
  apply.textContent = face.action;
  apply.disabled = !face.enabled;
  return true;
}

function modalKeypad(m) {
  var v = keypadValues(m);
  var isWeight = v.isWeight;
  var oz = v.oz;
  var capped = v.capped;
  var note = v.note;

  // The last key earns its place differently in each mode: "00" saves taps on
  // round gram weights, a decimal point is what half-ounces need.
  var keys = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '0', oz ? '.' : '00'];

  var units = isWeight
    ? '<div class="seg" style="margin-bottom:4px">' +
        '<button class="seg-btn' + (oz ? '' : ' is-on') + '" data-act="keypad-unit" data-oz="0">Grams</button>' +
        '<button class="seg-btn' + (oz ? ' is-on' : '') + '" data-act="keypad-unit" data-oz="1">Ounces</button>' +
      '</div>'
    : '';

  return wrap(
    '<h2 class="modal-title">' + esc(m.title || 'Type the weight') + '</h2>' +
    (m.sub ? '<p class="muted" style="margin:0 0 4px">' + esc(m.sub) + '</p>' : '') +
    units +
    '<div class="keypad-display">' +
      '<span class="keypad-number">' + (m.digits === '' ? '<span class="muted">0</span>' : esc(m.digits)) + '</span>' +
      '<span class="keypad-unit">' + esc(oz ? 'oz' : (m.unit || 'g')) + '</span>' +
    '</div>' +
    '<div class="keypad-note">' + esc(note) + '</div>' +
    '<div class="keypad">' +
      keys.map(function (k) {
        return '<button class="key" id="key-' + esc(k) + '" data-act="keypad-digit" data-k="' + k + '">' + k + '</button>';
      }).join('') +
      '<button class="key key-alt" data-act="keypad-back" aria-label="Delete last digit">&#9003;</button>' +
    '</div>' +
    '<div class="row" style="margin-top:16px">' +
      '<button class="btn btn-ghost" data-act="close-modal">Cancel</button>' +
      '<button class="btn btn-ghost" data-act="keypad-clear">Clear</button>' +
      '<span class="spacer"></span>' +
      '<button class="btn ' + (m.target === 'part' ? 'btn-warm' : 'btn-primary') + '" data-act="keypad-apply"' +
        (capped >= 1 ? '' : ' disabled') + '>' +
        (m.target === 'part' ? 'Take ' : 'Use ') +
        esc(isWeight ? fmtW(capped) : fmtCount(capped, m.unit)) + '</button>' +
    '</div>'
  );
}

function modalDate(m) {
  var months = [];
  var d = parseISO(S.today);
  // Eighteen, not eight: produce is annual, and someone cataloguing a store
  // that has been filling up for two years is the normal first use of this app.
  for (var i = 1; i <= 18; i++) {
    var x = new Date(d.getFullYear(), d.getMonth() - i, 1);
    var iso = x.getFullYear() + '-' + ('0' + (x.getMonth() + 1)).slice(-2) + '-01';
    months.push('<button class="chip' + (m.value === iso && m.monthOnly ? ' is-on' : '') + '" ' +
      'data-act="pick-date" data-date="' + iso + '" data-month-only="1">' +
      x.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }) + '</button>');
  }
  var yest = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1);
  var yestISO = yest.getFullYear() + '-' + ('0' + (yest.getMonth() + 1)).slice(-2) + '-' + ('0' + yest.getDate()).slice(-2);

  return wrap(
    '<h2 class="modal-title">When did it go in?</h2>' +
    '<p class="muted" style="margin-top:0">The month is what matters most &mdash; pick the exact day if you know it.</p>' +
    '<div class="chips">' +
      '<button class="chip' + (m.value === S.today && !m.monthOnly ? ' is-on' : '') +
        '" data-act="pick-date" data-date="' + S.today + '">Today</button>' +
      '<button class="chip' + (m.value === yestISO && !m.monthOnly ? ' is-on' : '') +
        '" data-act="pick-date" data-date="' + yestISO + '">Yesterday</button>' +
    '</div>' +
    '<div class="section-title" style="margin:18px 0 8px">Earlier months</div>' +
    '<div class="chips">' + months.join('') + '</div>' +
    '<div style="margin-top:18px"><span class="label">Or pick an exact date</span>' +
    '<input class="input" id="date-input" type="date" max="' + S.today + '" value="' + esc(m.value) + '" data-act="date-input"></div>' +
    '<div class="row" style="margin-top:20px">' +
      '<button class="btn btn-ghost" data-act="close-modal">Cancel</button><span class="spacer"></span>' +
      '<button class="btn btn-primary" data-act="set-date" data-date="' + esc(m.value) + '" ' +
        'data-month-only="' + (m.monthOnly ? '1' : '') + '">Use ' +
        esc(fmtWhen({ dateIn: m.value, monthOnly: m.monthOnly })) + '</button>' +
    '</div>'
  );
}

function lotById(id) {
  return S.inventory.filter(function (l) { return l.id === id; })[0];
}

/**
 * The bag, or a plain sentence and a reload.
 *
 * Half the handlers used to call lotById and read a property straight off it,
 * throwing a TypeError into a console nobody is looking at; the other half
 * guarded and returned '' from the modal, which :empty then hid. Both produced
 * the same thing on screen — you tap, and nothing happens — for a state the
 * spec explicitly says will occur, since two people can act on a stale view.
 */
function requireLot(id) {
  var lot = lotById(id);
  if (lot) return lot;
  setState({ modal: null });
  toast('That bag is no longer in the store. Reloading\u2026', null, 'bad');
  load(false);
  return null;
}

function modalTake(m) {
  var l = lotById(m.id);
  if (!l) return modalGone();
  // A count of 1 with a unit — "1 litre" of stock, "1 box" of faggots — used
  // to satisfy neither branch, so a whole class of Prepared food offered no
  // partial take-out at all. Those are exactly the things you take half of.
  var splittable = l.count > 1 || l.weightG > 100 || (l.count === 1 && !l.weightG);
  return wrap(
    '<h2 class="modal-title">' + esc(l.item) + '</h2>' +
    '<p class="muted" style="margin-top:0">' + esc(lotSize(l)) + ' in the ' + esc(l.store) + ' store' +
      (l.dateIn ? ' &middot; put in ' + esc(fmtWhen(l)) + ' (' + esc(ageText(l.dateIn)) + ')' : ' &middot; date not recorded') +
      (l.note ? ' &middot; ' + esc(l.note) : '') + '</p>' +
    // The same bag, asked about from two different questions. On Take out the
    // question is "how much of this is going", so removal leads and editing is
    // not offered at all. On In store it is "what have I got", so changing the
    // bag leads and only the whole-bag removal comes with it.
    //
    // Split appears in neither: the Change dialog already offers it, and a peer
    // that only duplicates what the button above it opens is clutter with a
    // second name.
    '<div class="stack" style="margin-top:18px">' +
      (S.tab === 'take'
        ? '<button class="btn btn-warm btn-hero btn-block" data-act="do-take" data-id="' + esc(l.id) + '">' +
            'Take all ' + esc(lotSize(l)) + ' out</button>' +
          (splittable
            ? '<button class="btn btn-block" data-act="open-part" data-id="' + esc(l.id) + '">' +
              (l.count > 1 ? 'Take only some of them' : 'Take only part of it') + '</button>'
            : '') +
          (l.count === 1 && !l.weightG
            ? '<div class="muted small" style="margin-top:-4px">Taking part of it needs a weight ' +
              '&mdash; add one under &ldquo;Change this bag&rdquo;, on the In store tab.</div>'
            : '')
        : '<button class="btn btn-block" data-act="open-edit" data-id="' + esc(l.id) + '">' +
            '&#9998; Change this bag</button>' +
          '<button class="btn btn-block" data-act="do-take" data-id="' + esc(l.id) + '">' +
            'Take all ' + esc(lotSize(l)) + ' out</button>') +
      '<button class="btn btn-ghost btn-block" data-act="close-modal">Cancel</button>' +
    '</div>'
  );
}

function modalPart(m) {
  var l = lotById(m.id);
  if (!l) return modalGone();
  var counted = l.count > 0;
  var max = counted ? l.count : l.weightG;
  var fmt = counted
    ? function (n) { return fmtCount(n, l.unit); }
    : fmtW;

  var presets = counted
    ? [1, 2, 4, 6].filter(function (n) { return n < l.count; })
    : [100, 250, 500, 1000].filter(function (g) { return g < l.weightG; });
  var chips = presets.map(function (n) {
    return '<button class="chip' + (m.value === n ? ' is-on-warm' : '') + '" ' +
      'data-act="' + (counted ? 'set-part-count' : 'set-part') + '" data-' + (counted ? 'n' : 'g') + '="' + n + '">' +
      esc(fmt(n)) + '</button>';
  }).join('');

  // Weight follows the same proportion as the count, so say what that means.
  var leftOver = counted && l.weightG
    ? fmtCount(l.count - m.value, l.unit) + ' (about ' + fmtW(Math.round(l.weightG * (l.count - m.value) / l.count)) + ')'
    : fmt(max - m.value);

  return wrap(
    '<h2 class="modal-title">' +
      (counted ? 'How many of the ' + esc(fmtCount(l.count, l.unit)) + '?' : 'How much of the ' + esc(fmtW(l.weightG)) + '?') +
    '</h2>' +
    '<p class="muted" style="margin-top:0">' + esc(l.item) + ' &middot; ' + esc(l.store) + ' store</p>' +
    (chips ? '<div class="chips" style="margin:14px 0">' + chips + '</div>' : '') +
    stepControl(m.value, {
      steps: counted ? COUNT_STEPS : WEIGHT_STEPS,
      fmt: fmt, max: max, noun: counted ? 'pieces' : 'grams',
      bump: 'bump-part', type: 'type-part',
    }) +
    '<p class="muted small" style="margin-top:12px">' + esc(leftOver) + ' would stay in the store.</p>' +
    '<div class="row" style="margin-top:18px">' +
      '<button class="btn btn-ghost" data-act="close-modal">Cancel</button><span class="spacer"></span>' +
      '<button class="btn btn-warm" data-act="do-part" data-id="' + esc(l.id) + '">Take ' + esc(fmt(m.value)) + ' out</button>' +
    '</div>'
  );
}

/**
 * Correcting one bag: everything that can be set on the way in can be put right
 * here, so a wrong date or store never means deleting and starting again.
 */
function modalEdit(m) {
  var l = lotById(m.id);
  if (!l) return modalGone();

  var stores = S.stores.map(function (f) {
    return '<button class="chip' + (m.store === f.name ? ' is-on' : '') + '" data-act="edit-store" data-name="' + esc(f.name) + '">' +
      dot(f.colour) + esc(f.name) + '</button>';
  }).join('');

  var units = unitChoices(m.unit).map(function (u) {
    return '<button class="chip' + (norm(m.unit) === norm(u) ? ' is-on' : '') + '" data-act="edit-unit" data-unit="' + esc(u) + '">' + esc(u) + '</button>';
  }).join('');

  return wrap(
    '<h2 class="modal-title">' + esc(l.item) + '</h2>' +
    '<p class="muted" style="margin-top:0">Put right anything that is wrong.</p>' +

    '<div class="stack" style="margin-top:16px">' +
      '<div><span class="label">Which store</span><div class="chips">' + stores + '</div></div>' +

      '<div><span class="label">Date it went in</span>' +
        '<div class="row">' +
          '<div class="spacer" style="font-size:1.05rem;font-weight:700">' +
            esc(fmtWhen({ dateIn: m.dateIn, monthOnly: m.monthOnly })) + '</div>' +
          '<button class="btn" data-act="open-date" data-target="edit">Change date</button>' +
        '</div>' +
      '</div>' +

      '<div><span class="label">Weight</span>' +
        (m.weightG > 0
          ? stepControl(m.weightG, { steps: WEIGHT_STEPS, fmt: fmtW, noun: 'grams', bump: 'edit-bump-weight', type: 'edit-type-weight', min: 0 })
          : '<div class="not-set">Not weighed <button class="btn btn-ghost" data-act="edit-set-weight" data-g="500">Add a weight</button></div>') +
        (m.weightG > 0 && m.count > 0
          ? '<button class="btn btn-ghost" style="padding-left:0" data-act="edit-set-weight" data-g="0">Remove the weight</button>'
          : '') +
      '</div>' +

      '<div>' + (m.count > 0
        ? '<span class="label">How many pieces</span>' +
          stepControl(m.count, {
            steps: COUNT_STEPS, noun: 'pieces', bump: 'edit-bump-count', type: 'edit-type-count',
            fmt: function (n) { return fmtCount(n, m.unit); },
          }) +
          '<div class="chips" style="margin-top:10px">' + units +
            (m.weightG > 0 ? '<button class="chip" data-act="edit-bump-count" data-by="-99999">Remove the count</button>' : '') +
          '</div>'
        : '<button class="btn btn-ghost" style="padding-left:0" data-act="edit-add-count">&#43; Count the pieces</button>') +
      '</div>' +

      '<div><span class="label">Note</span>' +
        '<input class="input" id="edit-note" type="text" placeholder="optional" value="' + esc(m.note) + '" data-act="edit-note"></div>' +

      '<button class="btn btn-block" data-act="open-split" data-id="' + esc(l.id) + '">' +
        'Split this into several bags&hellip;</button>' +
    '</div>' +

    '<div class="row" style="margin-top:20px">' +
      '<button class="btn btn-ghost" data-act="close-modal">Cancel</button><span class="spacer"></span>' +
      '<button class="btn btn-primary" data-act="save-edit">Save changes</button>' +
    '</div>'
  );
}

/** One bag into several — eight blocks becoming eight bags of one. */
function modalSplit(m) {
  var l = lotById(m.id);
  if (!l) return modalGone();
  var into = m.into;
  var each = {
    weightG: l.weightG ? Math.ceil(l.weightG / into) : 0,
    count: l.count ? Math.ceil(l.count / into) : 0,
    unit: l.unit,
  };
  var max = l.count > 0 ? l.count : Math.min(99, l.weightG);

  return wrap(
    '<h2 class="modal-title">Split the ' + esc(lotSize(l)) + '</h2>' +
    '<p class="muted" style="margin-top:0">' + esc(l.item) + ' &middot; ' + esc(l.store) + ' store</p>' +
    (l.count > 1
      ? '<div class="chips" style="margin:14px 0">' +
        '<button class="chip' + (into === l.count ? ' is-on' : '') + '" data-act="set-split" data-n="' + l.count + '">' +
        'One per bag (' + l.count + ')</button></div>'
      : '') +
    stepControl(into, {
      steps: [5, 1], min: 2, max: max, noun: 'bags', bump: 'bump-split', type: 'type-split',
      fmt: function (n) { return n + ' bags'; },
    }) +
    '<p class="muted small" style="margin-top:12px">Each bag would be about ' + esc(lotSize(each)) + '.</p>' +
    '<div class="row" style="margin-top:18px">' +
      '<button class="btn btn-ghost" data-act="' + (m.back ? 'back-modal' : 'close-modal') + '">' +
        (m.back ? 'Back' : 'Cancel') + '</button><span class="spacer"></span>' +
      '<button class="btn btn-primary" data-act="do-split" data-id="' + esc(l.id) + '">Split into ' + into + ' bags</button>' +
    '</div>'
  );
}

/** Renaming an item or a category, everywhere it appears. */
/**
 * Renaming onto a name that already exists merges the two, which is the right
 * behaviour and a surprising one to discover afterwards. So the copy changes as
 * soon as the typing collides with something.
 */
function renameCollision(m) {
  var to = norm(tidyName(m.value));
  if (!to || to === norm(m.from)) return null;
  if (m.scope === 'item') {
    var match = S.items.filter(function (it) { return norm(it.name) === to; })[0];
    if (!match) return null;
    var bags = S.inventory.filter(function (l) { return norm(l.item) === norm(m.from); }).length;
    return 'There is already an item called &ldquo;' + esc(match.name) + '&rdquo;. ' +
      (bags ? 'These ' + bags + (bags === 1 ? ' bag' : ' bags') + ' will join it.' : 'The two will be merged.');
  }
  var cat = S.categories.filter(function (c) { return norm(c) === to; })[0];
  return cat ? 'There is already a group called &ldquo;' + esc(cat) + '&rdquo;. The two will be merged.' : null;
}

function modalMove(m) {
  var lots = Object.keys(S.moving).map(lotById).filter(Boolean);
  var where = {};
  lots.forEach(function (l) { where[l.store] = 1; });

  var from = Object.keys(where);
  var only = from.length === 1 ? from[0] : null;

  var options = S.stores.map(function (f) {
    // Somewhere every chosen bag already is would be a move to nowhere.
    var pointless = !!only && norm(only) === norm(f.name);
    return '<button class="btn btn-block" data-act="do-move" data-name="' + esc(f.name) + '"' +
      (pointless || S.busy ? ' disabled' : '') + '>' +
      dot(f.colour) + ' ' + esc(f.name) +
      (pointless ? ' <span class="muted small">(already there)</span>' : '') + '</button>';
  }).join('');

  return wrap(
    '<h2 class="modal-title">Move ' + lots.length + (lots.length === 1 ? ' bag' : ' bags') + '</h2>' +
    '<p class="muted" style="margin-top:0">Where are they now? This only changes where they are ' +
      'kept &mdash; nothing is taken out, and it can be undone.</p>' +
    '<div class="stack" style="margin-top:16px">' + options + '</div>' +
    '<div class="row" style="margin-top:20px">' +
      '<button class="btn btn-ghost" data-act="close-modal">Cancel</button>' +
    '</div>'
  );
}

function modalStore(m) {
  var palette = S.storeColours.length ? S.storeColours : ['#5F8A20'];
  var taken = S.stores.some(function (f) {
    return norm(f.name) !== norm(m.from) && norm(f.name) === norm(tidyName(m.name));
  });

  var swatches = colourSwatches(m.colour, 'store-edit-colour', '');

  var bags = S.inventory.filter(function (l) { return norm(l.store) === norm(m.from); }).length;

  return wrap(
    '<h2 class="modal-title">' + esc(m.from) + '</h2>' +
    '<p class="muted" style="margin-top:0">' +
      (bags
        ? 'Renaming moves ' + bags + (bags === 1 ? ' bag' : ' bags') + ' with it, and everything ' +
          'taken out of here before now. It is one change, and it can be undone.'
        : 'Nothing is kept here at the moment.') +
    '</p>' +
    (taken
      ? '<div class="banner" style="display:block;margin-top:12px">There is already a place called ' +
        esc(tidyName(m.name)) + '. Two places cannot be merged by renaming one onto the other.</div>'
      : '') +

    '<div class="stack" style="margin-top:14px">' +
      '<div><label class="label" for="store-edit-name">What is it called?</label>' +
        '<input class="input input-hero" id="store-edit-name" type="text" ' +
          'value="' + esc(m.name) + '" data-act="store-edit-name"></div>' +
      '<div><label class="label" for="store-edit-where">Where is it? ' +
        '<span class="muted small">optional</span></label>' +
        '<input class="input" id="store-edit-where" type="text" placeholder="Chest freezer by the door" ' +
          'value="' + esc(m.where) + '" data-act="store-edit-where"></div>' +
      '<div><span class="label">Which colour marks it?</span>' + swatches + '</div>' +
    '</div>' +

    '<div class="row" style="margin-top:20px">' +
      '<button class="btn btn-ghost" data-act="close-modal">Cancel</button><span class="spacer"></span>' +
      '<button class="btn btn-primary" data-act="do-edit-store"' +
        (tidyName(m.name) && !taken && !S.busy ? '' : ' disabled') + '>' +
        (S.busy ? 'Saving&hellip;' : 'Save') + '</button>' +
    '</div>'
  );
}

function modalRename(m) {
  var isItem = m.scope === 'item';
  var collision = renameCollision(m);
  return wrap(
    '<h2 class="modal-title">Rename ' + (isItem ? 'this' : 'this group') + '</h2>' +
    '<p class="muted" style="margin-top:0">' +
      (isItem
        ? 'Every bag of &ldquo;' + esc(m.from) + '&rdquo; will take the new name, in store and in the record of what has been used.'
        : 'Everything filed under &ldquo;' + esc(m.from) + '&rdquo; will move to the new name.') +
    '</p>' +
    (collision ? '<div class="banner" style="margin-top:12px">' + collision + '</div>' : '') +
    '<input class="input input-hero" id="rename-input" type="text" style="margin-top:14px" ' +
      'value="' + esc(m.value) + '" data-act="rename-input">' +
    '<div class="row" style="margin-top:20px">' +
      '<button class="btn btn-ghost" data-act="close-modal">Cancel</button><span class="spacer"></span>' +
      '<button class="btn btn-primary" data-act="do-rename"' +
        (tidyName(m.value) && norm(tidyName(m.value)) !== norm(m.from) ? '' : ' disabled') + '>' +
        (collision ? 'Merge' : 'Rename') + '</button>' +
    '</div>'
  );
}

/** Free-text unit, for anything the suggestion chips do not cover. */
function modalUnit(m) {
  return wrap(
    '<h2 class="modal-title">What are the pieces called?</h2>' +
    '<p class="muted" style="margin-top:0">Whatever you would say out loud &mdash; cobs, tubs, slices.</p>' +
    '<input class="input input-hero" id="unit-input" type="text" style="margin-top:14px" ' +
      'placeholder="e.g. cobs" value="' + esc(m.value || '') + '" data-act="unit-input">' +
    '<div class="row" style="margin-top:20px">' +
      '<button class="btn btn-ghost" data-act="close-modal">Cancel</button><span class="spacer"></span>' +
      '<button class="btn btn-primary" data-act="apply-unit">Use this word</button>' +
    '</div>'
  );
}

/* -------------------------------------------------------------- actions */

var ACTIONS = {
  tab: function (d) {
    setState({ tab: d.tab, modal: null });
    // Otherwise a tap on "Put in" from halfway down 200 bags lands halfway
    // down the form, with "What are you putting in the store?" off screen.
    window.scrollTo(0, 0);
    // #panel has carried tabindex="-1" all along; nothing ever focused it, so
    // a screen reader was never told the view had changed.
    var panel = $('#panel');
    if (panel) panel.focus();
  },

  refresh: function () { setState({ modal: null }); load(true); },

  'close-modal': function () { setState({ modal: null }); },
  'back-modal': function () { setState({ modal: S.modal.back || null }); },

  'hide-toast': function () {
    clearTimeout(toastTimer);
    setState({ toast: null });
  },

  /* --- add: picking --- */
  'pick-item': function (d) {
    var unit = d.unit || '';
    setState({
      draft: Object.assign({}, S.draft, {
        item: d.name,
        category: d.category || 'Other',
        // Something that has only ever been counted starts unweighed, rather
        // than inviting a made-up 500 g.
        weightG: Number(d.typical) || (unit ? 0 : 500),
        count: Number(d.count) || 0,
        unit: unit,
        // Something counted last time is almost certainly counted this time.
        showCount: !!unit,
        dateIn: S.draft.dateIn || S.today,
        store: S.draft.store || (S.stores[0] ? S.stores[0].name : ''),
      }),
    });
  },

  'more-cat': function (d) {
    var open = Object.assign({}, S.openCats);
    if (open[d.cat]) delete open[d.cat]; else open[d.cat] = true;
    setState({ openCats: open });
  },

  'new-item': function (d) { setState({ modal: { kind: 'category', name: tidyName(d.name), custom: '' } }); },

  'cat-input': function (d, el) { S.modal.custom = el.value; render(); },

  'choose-category': function (d) {
    var name = S.modal.name;
    var cat = d.category || 'Other';
    setState({
      modal: null,
      draft: Object.assign({}, S.draft, {
        item: name,
        category: cat,
        weightG: 500,
        dateIn: S.draft.dateIn || S.today,
        store: S.draft.store || (S.stores[0] ? S.stores[0].name : ''),
      }),
    });
  },

  'clear-item': function () {
    setState({ draft: Object.assign({}, S.draft, { item: '', category: '' }), query: '' });
  },

  /* --- add: details --- */
  'bump-weight': function (d) {
    var next = Math.max(1, S.draft.weightG + Number(d.by));
    setState({ draft: Object.assign({}, S.draft, { weightG: next, weightConfirmed: true }) });
  },

  'set-weight': function (d) {
    setState({ draft: Object.assign({}, S.draft, {
      weightG: Number(d.g), weightConfirmed: Number(d.g) > 0,
    }) });
  },

  'set-part-count': function (d) {
    S.modal.value = Number(d.n);
    render();
  },

  'type-weight': function () {
    setState({ modal: { kind: 'keypad', target: 'draft', digits: '', title: 'How much in each bag?' } });
  },

  'type-part': function () {
    var l = requireLot(S.modal.id);
    if (!l) return;
    var counted = l.count > 0;
    setState({
      modal: {
        kind: 'keypad', target: 'part', id: S.modal.id, digits: '',
        max: counted ? l.count : l.weightG,
        unit: counted ? (l.unit || 'pieces') : 'g',
        title: counted ? 'How many to take out?' : 'How much to take out?',
        sub: l.item + ' — ' + lotSize(l) + ' in the bag',
      },
    });
  },

  'keypad-digit': function (d) {
    if (d.k === '.' && S.modal.digits.indexOf('.') > -1) return;
    var next = S.modal.digits + d.k;
    if (d.k !== '.') next = next.replace(/^0+(?=\d)/, '');
    if (next.length > 7) return;
    S.modal.digits = next;
    render();
  },

  'keypad-unit': function (d) {
    S.modal.oz = d.oz === '1';
    S.modal.digits = '';
    render();
  },

  'keypad-back': function () {
    S.modal.digits = S.modal.digits.slice(0, -1);
    render();
  },

  'keypad-clear': function () { S.modal.digits = ''; render(); },

  'keypad-apply': function () {
    var m = S.modal;
    var typed = Number(m.digits) || 0;
    var v = Math.round(m.oz ? typed * GRAMS_PER_OZ : typed);
    if (m.max && v > m.max) v = m.max;
    if (v < 1) return;
    if (m.target === 'part') setState({ modal: { kind: 'part', id: m.id, value: v } });
    else if (m.target === 'count') setState({ modal: null, draft: Object.assign({}, S.draft, { count: v }) });
    else if (m.target === 'edit-weight') setState({ modal: Object.assign({}, m.back, { weightG: v }) });
    else if (m.target === 'edit-count') setState({ modal: Object.assign({}, m.back, { count: v }) });
    else if (m.target === 'split') setState({ modal: Object.assign({}, m.back, { into: Math.max(2, v) }) });
    else setState({ modal: null, draft: Object.assign({}, S.draft, { weightG: v, weightConfirmed: true }) });
  },

  'bump-qty': function (d) {
    var next = Math.max(1, Math.min(99, S.draft.qty + Number(d.by)));
    setState({ draft: Object.assign({}, S.draft, { qty: next }) });
  },

  'set-store': function (d) {
    setState({ draft: Object.assign({}, S.draft, { store: d.name }) });
  },

  'open-date': function (d) {
    var target = d.target === 'edit' ? 'edit' : 'draft';
    var current = target === 'edit' ? S.modal.dateIn : (S.draft.dateIn || S.today);
    var monthOnly = target === 'edit' ? !!S.modal.monthOnly : !!S.draft.monthOnly;
    setState({
      modal: {
        kind: 'date', target: target, value: current, monthOnly: monthOnly,
        back: target === 'edit' ? S.modal : null,
      },
    });
  },
  'date-input': function (d, el) {
    setState({ modal: Object.assign({}, S.modal, { value: el.value, monthOnly: false }) });
  },
  // Chips select and stay open; the button at the bottom commits. Previously
  // the chips applied and closed while the native input needed the button, so
  // the button read as a confirmation for choices it had nothing to do with.
  'pick-date': function (d) {
    setState({
      modal: Object.assign({}, S.modal, { value: d.date, monthOnly: d.monthOnly === '1' }),
    });
  },

  'set-date': function (d) {
    if (!d.date) return;
    var monthOnly = d.monthOnly === '1';
    if (S.modal.target === 'edit') {
      setState({ modal: Object.assign({}, S.modal.back, { dateIn: d.date, monthOnly: monthOnly }) });
      return;
    }
    setState({ modal: null, draft: Object.assign({}, S.draft, { dateIn: d.date, monthOnly: monthOnly }) });
  },

  'show-count': function () {
    setState({ draft: Object.assign({}, S.draft, { showCount: true, count: S.draft.count || 6, unit: S.draft.unit || 'pieces' }) });
  },

  'hide-count': function () {
    // Taking the count away leaves the bag with no size at all unless a weight
    // was already given. It used to substitute 500 g here, silently, which is
    // the same invented number wearing a different hat: Save is simply
    // unavailable until she says how much.
    setState({ draft: Object.assign({}, S.draft, { showCount: false, count: 0, unit: '' }) });
  },

  'bump-count': function (d) {
    var next = Math.max(1, Math.min(999, (S.draft.count || 1) + Number(d.by)));
    setState({ draft: Object.assign({}, S.draft, { count: next }) });
  },

  'set-unit': function (d) {
    setState({ draft: Object.assign({}, S.draft, { unit: d.unit }) });
  },

  'type-unit': function () {
    setState({ modal: { kind: 'unit', value: S.draft.unit } });
  },

  'unit-input': function (d, el) { S.modal.value = el.value; },

  'apply-unit': function () {
    var u = pluralUnit(String(S.modal.value || '').trim());
    setState({ modal: null, draft: Object.assign({}, S.draft, { unit: u || 'pieces' }) });
  },

  'type-count': function () {
    setState({ modal: { kind: 'keypad', target: 'count', digits: '', unit: S.draft.unit || 'pieces', title: 'How many in each bag?' } });
  },

  'show-note': function () { setState({ draft: Object.assign({}, S.draft, { showNote: true }) }); },
  // The convention, now that there is one: an input whose value changes what
  // is drawn goes through debounced setState; an input that nothing else on
  // screen depends on writes straight to state and skips the render. The note
  // fields are the second kind.
  note: function (d, el) { S.draft.note = el.value; },
  query: debounced(function (v) { setState({ query: v }); }),

  'save-add': function () { doAdd(); },

  /* --- view --- */
  'set-store-filter': function (d) { setState({ store: d.name, viewLimit: 60, takeLimit: 40 }); },
  'set-search': debounced(function (v) { setState({ search: v, viewLimit: 60, takeLimit: 40 }); }),
  'view-more': function () { setState({ viewLimit: S.viewLimit + 60 }); },
  'toggle-open': function (d) {
    var open = Object.assign({}, S.open);
    if (open[d.key]) delete open[d.key]; else open[d.key] = true;
    setState({ open: open });
  },

  /* --- take --- */
  'take-more': function () { setState({ takeLimit: S.takeLimit + 40 }); },

  'toggle-pick': function (d) {
    var picked = Object.assign({}, S.selected);
    if (picked[d.id]) delete picked[d.id]; else picked[d.id] = true;
    setState({ selected: picked });
  },
  'clear-picks': function () { setState({ selected: {} }); },
  'do-take-picked': function () { doTake(Object.keys(S.selected)); },
  'ask-take': function (d) {
    if (!requireLot(d.id)) return;
    setState({ modal: { kind: 'take', id: d.id } });
  },
  'open-part': function (d) {
    var l = requireLot(d.id);
    if (!l) return;
    if (l.count === 1 && !l.weightG) return ACTIONS['open-edit'](d);
    var value = l.count > 0
      ? Math.max(1, Math.floor(l.count / 2))
      : Math.round(Math.min(250, Math.max(50, l.weightG / 2)));
    setState({ modal: { kind: 'part', id: d.id, value: value } });
  },
  'bump-part': function (d) {
    var l = requireLot(S.modal.id);
    if (!l) return;
    var max = l.count > 0 ? l.count : l.weightG;
    S.modal.value = Math.max(1, Math.min(max, S.modal.value + Number(d.by)));
    render();
  },
  'set-part': function (d) {
    S.modal.value = Number(d.g);
    render();
  },
  'do-take': function (d) { doTake([d.id]); },
  'do-part': function (d) { doPart(d.id, S.modal.value); },

  /* --- undo --- */
  /* --- correcting a bag --- */
  'open-edit': function (d) {
    var l = requireLot(d.id);
    if (!l) return;
    setState({
      modal: {
        kind: 'edit', id: l.id, store: l.store, dateIn: l.dateIn, monthOnly: !!l.monthOnly,
        weightG: l.weightG, count: l.count, unit: l.unit || 'pieces', note: l.note,
      },
    });
  },

  'edit-store': function (d) { S.modal.notice = null; S.modal.store = d.name; render(); },
  'edit-unit': function (d) { S.modal.notice = null; S.modal.unit = d.unit; render(); },
  'edit-note': function (d, el) { S.modal.note = el.value; },

  'edit-bump-weight': function (d) {
    S.modal.notice = null;
    S.modal.weightG = Math.max(0, S.modal.weightG + Number(d.by));
    render();
  },
  'edit-set-weight': function (d) { S.modal.weightG = Number(d.g); render(); },
  'edit-type-weight': function () {
    setState({ modal: { kind: 'keypad', target: 'edit-weight', digits: '', title: 'Weight of this bag', back: S.modal } });
  },

  'edit-add-count': function () { S.modal.count = 1; S.modal.unit = S.modal.unit || 'pieces'; render(); },
  'edit-bump-count': function (d) {
    S.modal.notice = null;
    var next = S.modal.count + Number(d.by);
    S.modal.count = next < 1 ? (S.modal.weightG > 0 ? 0 : 1) : Math.min(999, next);
    render();
  },
  'edit-type-count': function () {
    setState({
      modal: {
        kind: 'keypad', target: 'edit-count', digits: '', unit: S.modal.unit || 'pieces',
        title: 'How many pieces', back: S.modal,
      },
    });
  },

  'save-edit': function () { doEdit(); },

  /* --- splitting --- */
  'open-split': function (d) {
    var l = requireLot(d.id);
    if (!l) return;
    // Reachable from the take dialog as well as from Change, so remember only
    // an edit to come back to — returning to a take dialog would be a loop.
    var back = S.modal && S.modal.kind === 'edit' ? S.modal : null;
    setState({ modal: { kind: 'split', id: d.id, into: l.count > 1 ? l.count : 2, back: back } });
  },
  'bump-split': function (d) {
    var l = requireLot(S.modal.id);
    if (!l) return;
    var max = l.count > 0 ? l.count : Math.min(99, l.weightG);
    S.modal.into = Math.max(2, Math.min(max, S.modal.into + Number(d.by)));
    render();
  },
  'set-split': function (d) { S.modal.into = Number(d.n); render(); },
  'type-split': function () {
    var l = requireLot(S.modal.id);
    if (!l) return;
    setState({
      modal: {
        kind: 'keypad', target: 'split', digits: '', unit: 'bags',
        max: l.count > 0 ? l.count : Math.min(99, l.weightG),
        title: 'How many bags?', back: S.modal,
      },
    });
  },
  'do-split': function (d) { doSplit(d.id, S.modal.into); },

  /* --- renaming --- */
  'open-rename': function (d) {
    setState({ modal: { kind: 'rename', scope: d.scope, from: d.from, value: d.from } });
  },
  'settings-open': function () {
    // Remembered, so closing settings returns to the tab you were reading.
    settingsCameFrom = S.tab === 'settings' ? settingsCameFrom : S.tab;
    setState({ tab: 'settings', modal: null });
    window.scrollTo(0, 0);
  },
  'settings-close': function () {
    setState({ tab: settingsCameFrom || 'view', modal: null });
    window.scrollTo(0, 0);
  },
  'set-theme': function (d) {
    S.theme = d.themeId;
    writePref('theme', d.themeId);
    applyTheme();
    setState({});
  },
  'toggle-editing': function () {
    // Ticks are invisible with editing off, and acting on an invisible
    // selection later would be a surprise.
    setState({ editing: !S.editing, moving: {} });
  },
  'open-colour': function (d) {
    // The store dialog is itself a modal, so its half-finished edit is carried
    // through here and put back when this step closes, either way.
    var at = colourState(d.current);
    // Snapped on the way in, so the grid and the slider agree from the first
    // paint. Nothing is written unless the button at the bottom is pressed.
    at.hue = HUES[nearestHueIndex(at.hue)];
    setState({ modal: Object.assign({
      kind: 'colour',
      value: hslHex(at.hue, at.sat, at.lum),
      row: d.row === undefined ? null : Number(d.row),
      back: S.modal && S.modal.kind === 'store' ? S.modal : null,
    }, at) });
  },
  // Dragging a slider that re-rendered under the finger would drop the gesture
  // on the first move, so the hue is the one control here that updates the DOM
  // it owns instead. The grid takes its hue from a custom property for exactly
  // this reason: one assignment repaints all twenty cells.
  'pick-hue': function (d, el) {
    var m = S.modal;
    m.hue = HUES[Number(el.value)] === undefined ? m.hue : HUES[Number(el.value)];
    m.value = hslHex(m.hue, m.sat, m.lum);
    var box = document.querySelector('.picker');
    if (box) box.style.setProperty('--hue', m.hue);
    var prev = document.querySelector('.picker-preview');
    if (prev) prev.style.setProperty('--fz', m.value);
  },
  'pick-cell': function (d) {
    var m = S.modal;
    var sat = Number(d.s);
    var lum = Number(d.l);
    setState({ modal: Object.assign({}, m, {
      sat: sat, lum: lum, value: hslHex(m.hue, sat, lum),
    }) });
  },
  'cancel-colour': function () {
    setState({ modal: S.modal.back || null });
  },
  'use-colour': function () {
    var m = S.modal;
    if (m.back) {
      setState({ modal: Object.assign({}, m.back, { colour: m.value }) });
    } else {
      firstRunDraft()[m.row].colour = m.value;
      setState({ modal: null });
    }
  },

  'toggle-move': function (d) {
    var picked = Object.assign({}, S.moving);
    if (picked[d.id]) delete picked[d.id]; else picked[d.id] = true;
    setState({ moving: picked });
  },
  'clear-moves': function () { setState({ moving: {} }); },
  'open-move': function () { setState({ modal: { kind: 'move' } }); },
  'do-move': function (d) { doMove(d.name); },

  'open-store-edit': function (d) {
    var f = S.stores.filter(function (x) { return x.name === d.name; })[0];
    if (!f) return;
    setState({ modal: { kind: 'store', from: f.name, name: f.name, where: f.where, colour: f.colour } });
  },
  'store-edit-name': function (d, el) {
    setState({ modal: Object.assign({}, S.modal, { name: el.value }) });
  },
  'store-edit-where': function (d, el) {
    setState({ modal: Object.assign({}, S.modal, { where: el.value }) });
  },
  'store-edit-colour': function (d) {
    setState({ modal: Object.assign({}, S.modal, { colour: d.colour }) });
  },
  'do-edit-store': function () { doEditStore(); },

  'settings-add-place': function () {
    // The first-run screen is the add form; sending them to it with the tab
    // bar still available means it is a detour rather than a mode.
    S.newStores = [{ name: '', where: '', colour: '' }];
    setState({ tab: 'settings-place' });
    window.scrollTo(0, 0);
  },
  'check-updates': function () { doCheckUpdates(); },
  'delete-item': function (d) { doDeleteItem(d.name); },

  // Both re-render, because the Save button's enabled state is derived from
  // these values — skipping the render left it disabled however much you typed.
  // render() puts focus and the caret back by element id, which is why these
  // inputs carry stable ones.
  'store-name': function (d, el) {
    firstRunDraft()[Number(d.row)].name = el.value;
    setState({});
  },
  'store-where': function (d, el) {
    firstRunDraft()[Number(d.row)].where = el.value;
    setState({});
  },
  // Fires from a preset button (data-colour) and from the native picker
  // (its value), which is why the source is checked rather than assumed.
  'store-colour': function (d) {
    firstRunDraft()[Number(d.row)].colour = d.colour;
    setState({});
  },
  'store-suggest': function (d) {
    var rows = firstRunDraft();
    // Fill the first empty name rather than always appending, so tapping three
    // suggestions in a row does not leave a blank card between each.
    var at = -1;
    for (var i = 0; i < rows.length; i++) {
      if (!rows[i].name.trim()) { at = i; break; }
    }
    if (at < 0) { rows.push({ name: '', where: '', colour: '' }); at = rows.length - 1; }
    rows[at].name = d.name;
    setState({});
  },
  'store-row-add': function () {
    firstRunDraft().push({ name: '', where: '', colour: '' });
    setState({});
  },
  'store-row-del': function (d) {
    firstRunDraft().splice(Number(d.row), 1);
    setState({});
  },
  'save-stores': function () { doSaveStores(); },

  'rename-input': function (d, el) {
    setState({ modal: Object.assign({}, S.modal, { value: el.value, notice: null }) });
  },
  'do-rename': function () { doRename(); },

  'undo-toast': function () {
    var token = S.toast && S.toast.undo;
    if (token) doUndo(token);
  },
  'undo-recent': function (d) {
    var list = d.kind === 'add' ? S.recentAdds : S.recentTakes;
    var entry = list[Number(d.i)];
    if (entry) doUndo(entry.token);
  },
};

/* ---------------------------------------------------------- operations */

function doAdd() {
  advanceToday();
  var d = S.draft;
  var payload = {
    item: d.item, category: d.category, store: d.store,
    weightG: d.weightG, count: d.showCount ? d.count : 0, unit: d.unit,
    qty: d.qty, dateIn: d.dateIn || S.today, monthOnly: !!d.monthOnly, note: d.note,
  };
  var label = d.qty + ' × ' + draftEach(d) + ' ' + d.item;
  var sub = 'into the ' + d.store + ' store · ' + fmtDate(payload.dateIn);

  setState({ busy: true });
  api('apiAdd', payload).then(function (res) {
    S.inventory = S.inventory.concat(res.lots);
    if (!S.items.some(function (it) { return norm(it.name) === norm(d.item); })) {
      S.items.unshift({
        name: d.item, category: d.category, typicalG: d.weightG,
        typicalCount: payload.count, unit: payload.unit, uses: 1,
      });
    }
    if (S.categories.indexOf(d.category) < 0) S.categories.push(d.category);
    S.recentAdds.unshift({ label: label, sub: sub, token: res.undo });
    S.recentAdds = S.recentAdds.slice(0, 8);
    done();
    // Keep the store and date so a run of bagging-up stays quick.
    S.draft = Object.assign({}, BLANK_DRAFT, {
    store: d.store, dateIn: d.dateIn, monthOnly: d.monthOnly,
  });
    S.query = '';
    toast(label + ' put in the ' + d.store + ' store', res.undo);
  }).catch(function (e) {
    S.busy = false;
    fail(e);
  });
}

function doTake(ids) {
  advanceToday();
  var lots = ids.map(lotById).filter(Boolean);
  if (!lots.length) return;

  var names = {};
  lots.forEach(function (l) { names[l.item] = (names[l.item] || 0) + 1; });
  var kinds = Object.keys(names);
  var label = lots.length === 1
    ? lotSize(lots[0]) + ' ' + lots[0].item
    : kinds.slice(0, 3).map(function (n) { return names[n] > 1 ? names[n] + ' \u00d7 ' + n : n; }).join(', ') +
      (kinds.length > 3 ? ' and ' + (kinds.length - 3) + ' more' : '');

  var stores = {};
  lots.forEach(function (l) { stores[l.store] = 1; });
  var where = Object.keys(stores);
  var sub = 'out of the ' + (where.length === 1 ? where[0] + ' store' : where.length + ' stores') +
    ' \u00b7 ' + fmtDate(S.today);

  setState({ busy: true, modal: null });
  api('apiRemove', { ids: ids, dateOut: S.today }).then(function (res) {
    S.inventory = S.inventory.filter(function (l) { return ids.indexOf(l.id) < 0; });
    S.selected = {};
    S.recentTakes.unshift({ label: label, sub: sub, token: res.undo });
    S.recentTakes = S.recentTakes.slice(0, 8);
    done();
    toast(label + ' taken out', res.undo);
  }).catch(function (e) {
    S.busy = false;
    fail(e);
  });
}

function doPart(id, value) {
  advanceToday();
  var lot = lotById(id);
  if (!lot) return;
  var counted = lot.count > 0;
  if (value >= (counted ? lot.count : lot.weightG)) return doTake([id]);

  var payload = counted
    ? { id: id, count: value, dateOut: S.today }
    : { id: id, weightG: value, dateOut: S.today };
  var takenW = counted ? Math.round((lot.weightG * value) / lot.count) : value;
  var label = (counted ? fmtCount(value, lot.unit) : fmtW(value)) + ' ' + lot.item;

  setState({ busy: true, modal: null });
  api('apiRemovePart', payload).then(function (res) {
    lot.weightG -= takenW;
    if (counted) lot.count -= value;
    S.recentTakes.unshift({ label: label, sub: 'out of the ' + lot.store + ' store · ' + lotSize(lot) + ' left', token: res.undo });
    S.recentTakes = S.recentTakes.slice(0, 8);
    done();
    toast(label + ' taken out', res.undo);
  }).catch(function (e) {
    S.busy = false;
    fail(e);
  });
}

function doEdit() {
  var m = S.modal;
  var patch = {
    store: m.store, dateIn: m.dateIn, monthOnly: !!m.monthOnly, weightG: m.weightG,
    count: m.count, unit: m.count > 0 ? m.unit : '', note: m.note,
  };
  setState({ busy: true, modal: null });
  api('apiEditLot', { id: m.id, patch: patch }).then(function (res) {
    var i = S.inventory.findIndex(function (l) { return l.id === m.id; });
    if (i > -1) S.inventory[i] = res.lot;
    done();
    toast(res.lot.item + ' updated', res.undo);
  }).catch(function (e) {
    S.busy = false;
    fail(e);
  });
}

function doSplit(id, into) {
  var lot = lotById(id);
  if (!lot) return;
  setState({ busy: true, modal: null });
  api('apiSplitLot', { id: id, into: into }).then(function (res) {
    S.inventory = S.inventory.filter(function (l) { return l.id !== id; }).concat(res.lots);
    done();
    toast(lot.item + ' split into ' + into + ' bags', res.undo);
  }).catch(function (e) {
    S.busy = false;
    fail(e);
  });
}

/**
 * Reads the values off the inputs as well as the draft. They are kept in step
 * on every keystroke, but a value restored by the browser — autofill, or a
 * back-navigation — reaches the DOM without firing an input event.
 */
function doSaveStores() {
  var cameFromSettings = S.tab === 'settings-place';
  var rows = firstRunDraft().map(function (row, i) {
    var name = $('#store-name-' + i);
    var where = $('#store-where-' + i);
    return {
      name: name ? tidyName(name.value) : row.name,
      where: where ? tidyName(where.value) : row.where,
      colour: storeDraftColour(row, i),
    };
  }).filter(function (r) { return r.name; });

  if (!rows.length) return;

  setState({ busy: true });
  api('apiSaveStores', { stores: rows }).then(function () {
    done();
    S.newStores = null;
    return load(false).then(function () {
      // Landing on Put in is the point: they came here to record something, and
      // naming the places was the obstacle, not the errand.
      setState({ tab: cameFromSettings ? 'settings' : 'add' });
      toast(rows.length > 1 ? rows.length + ' places saved.' : rows[0].name + ' saved.');
    });
  }).catch(function (e) {
    S.busy = false;
    fail(e);
  });
}

function doCheckUpdates() {
  setState({ busy: true });
  api('apiUpdateStatus').then(function (v) {
    done();
    setState({ version: v });
  }).catch(function () {
    S.busy = false;
    // Not fail(): a version check that cannot run is worth saying plainly in
    // place, rather than as a red toast over whatever else is on screen.
    setState({ version: { error: 'Could not check just now. The spreadsheet menu can also tell you.' } });
  });
}

function doMove(to) {
  var ids = Object.keys(S.moving);
  if (!ids.length) return;

  setState({ busy: true, modal: null });
  api('apiMoveBags', { ids: ids, to: to }).then(function (res) {
    done();
    S.moving = {};
    return load(false).then(function () {
      toast(res.moved + (res.moved === 1 ? ' bag' : ' bags') + ' moved to the ' + res.to, res.undo);
    });
  }).catch(function (e) {
    S.busy = false;
    // The usual reason is a selection that has gone stale, and the backend
    // refuses the whole move in that case — so re-read rather than leaving
    // ticks beside bags that are no longer there.
    S.moving = {};
    load(false);
    fail(e);
  });
}

function doEditStore() {
  var m = S.modal;
  var to = tidyName(m.name);
  if (!to) return;

  setState({ busy: true, modal: null });
  api('apiEditStore', { from: m.from, to: to, where: tidyName(m.where), colour: m.colour })
    .then(function (res) {
      done();
      // A place name is on every bag, every filter chip and the header total,
      // so re-read rather than trying to patch each one.
      return load(false).then(function () {
        // The filter may have been pointing at the old name.
        if (norm(S.store) === norm(m.from)) S.store = res.name;
        toast(res.renamed
          ? 'Renamed to ' + res.name + ', and moved ' + res.renamed +
            (res.renamed === 1 ? ' row' : ' rows') + ' with it'
          : res.name + ' updated', res.undo);
      });
    }).catch(function (e) {
      S.busy = false;
      fail(e);
    });
}

function doDeleteItem(name) {
  setState({ busy: true });
  api('apiDeleteItem', { name: name }).then(function (res) {
    done();
    return load(false).then(function () {
      toast('Removed ' + res.removed + ' from the item list.', res.undo);
    });
  }).catch(function (e) {
    S.busy = false;
    fail(e);
  });
}

function doRename() {
  var m = S.modal;
  var to = tidyName(m.value);
  // The backend runs cleanName over both names, so "Raspberries" and
  // "raspberries" are the same rename to it. Comparing the raw strings here let
  // that through, and the app then reported a rename that had not happened.
  if (!to || norm(to) === norm(m.from)) return setState({ modal: null });

  var fn = m.scope === 'item' ? 'apiRenameItem' : 'apiRenameCategory';
  setState({ busy: true, modal: null });
  api(fn, { from: m.from, to: to }).then(function (res) {
    done();
    // A rename touches the catalogue and every view, so re-read rather than
    // trying to patch each one by hand.
    return load(false).then(function () {
      toast(res.merged ? 'Merged into ' + to : 'Renamed to ' + to, res.undo);
    });
  }).catch(function (e) {
    S.busy = false;
    fail(e);
  });
}

function doUndo(token) {
  setState({ busy: true, toast: null });
  api('apiUndo', token).then(function () {
    S.recentAdds = S.recentAdds.filter(function (r) { return r.token !== token; });
    S.recentTakes = S.recentTakes.filter(function (r) { return r.token !== token; });
    done();
    return load(false).then(function () { toast('Undone.'); });
  }).catch(function (e) {
    S.busy = false;
    fail(e);
  });
}

/* ------------------------------------------------------------ bootstrap */

var slowTimer = null;

function load(showToast) {
  clearTimeout(slowTimer);
  slowTimer = setTimeout(function () {
    if (!S.ready) setState({ slowLoad: true });
  }, 6000);

  return api('apiGetState').then(function (st) {
    clearTimeout(slowTimer);
    S.slowLoad = false;
    succeeded();
    S.loadFailed = false;
    S.stores = st.stores;
    S.suggestedStores = st.suggestedStores || [];
    S.storeColours = st.storeColours || [];
    S.items = st.items;
    S.categories = st.categories;
    S.inventory = st.inventory;
    S.problems = st.problems || [];
    S.sheetUrl = st.sheetUrl || '';
    S.today = st.today || todayISO();
    if (!S.draft.dateIn) S.draft.dateIn = S.today;
    if (!S.draft.store && S.stores[0]) S.draft.store = S.stores[0].name;
    S.ready = true;
    render();
    if (showToast) toast('Reloaded from the spreadsheet.');
  }).catch(function (e) {
    clearTimeout(slowTimer);
    S.slowLoad = false;
    // Not "ready with nothing in it" — that is indistinguishable from an empty
    // store, and the app then told the user to go and repair a spreadsheet
    // that was perfectly fine. An unknown state is never drawn as a known one.
    S.ready = true;
    S.loadFailed = true;
    render();
    fail(e);
  });
}

/**
 * Constraint 2 refuses to hide latency, which means a round trip is always
 * visible — one to two seconds in which the row you have just asked to remove
 * is still sitting there looking tappable. Tapping it again is the natural
 * response, and the second call then failed with "Those bags are no longer in
 * the store": a red error for an action that had in fact succeeded.
 *
 * S.busy was already set by all seven operations and read by exactly one
 * button. Refusing anything that writes, here, makes the protection deliberate
 * rather than a side effect of the modal closing.
 */
function writesToSheet(act) {
  return /^(do-|save-|undo-|delete-)/.test(act) || act === 'refresh';
}

/**
 * Everywhere else the app trades confirmation for undo. The Edit dialog is the
 * one place where a stray tap outside destroys work that was never committed,
 * so there is nothing to undo — and a mis-tap beside a bottom sheet, on a
 * tablet held at a store, is not a rare event.
 */
function tryCloseModal() {
  if (modalIsDirty()) {
    // Not a toast: showModal() puts the dialog in the top layer, so a toast
    // would sit behind its own backdrop. The message belongs beside the
    // controls it names anyway.
    setState({ modal: Object.assign({}, S.modal, { notice: 'Tap Cancel to discard those changes, or Save changes to keep them.' }) });
    return;
  }
  ACTIONS['close-modal']();
}

document.addEventListener('click', function (e) {
  if (e.target.id === 'modal-host') {
    // The picker is a step inside another dialog, so backing out of it means
    // going back one, not closing the lot.
    if (S.modal && S.modal.kind === 'colour') return ACTIONS['cancel-colour']();
    return tryCloseModal();
  }
  var el = e.target.closest('[data-act]');
  if (!el) return;
  var act = el.dataset.act;
  if (el.tagName === 'INPUT') return; // inputs act on `input`, not `click`
  if (S.busy && writesToSheet(act)) return;
  if (ACTIONS[act]) {
    e.preventDefault();
    ACTIONS[act](el.dataset, el, e);
  }
});

/**
 * The search boxes re-rendered up to 60 rows per character, and the pressure
 * that created showed as three different answers to the same question: two
 * inputs deliberately skipped render(), and a third reached into the DOM to
 * toggle a button by hand. Debouncing lets all of them go back through
 * setState, which is the only convention the app needs.
 */
var inputTimer = null;

function debounced(fn) {
  return function (d, el) {
    var value = el.value;
    clearTimeout(inputTimer);
    inputTimer = setTimeout(function () { fn(value); }, 120);
  };
}

document.addEventListener('input', function (e) {
  var el = e.target.closest('[data-act]');
  if (!el) return;
  var act = el.dataset.act;
  if (ACTIONS[act]) ACTIONS[act](el.dataset, el, e);
});

// <dialog> closes itself on Escape; intercept so the same guard applies and
// so S.modal stays in step with what is on screen.
document.addEventListener('cancel', function (e) {
  if (e.target.id !== 'modal-host') return;
  e.preventDefault();
  tryCloseModal();
});

window.addEventListener('offline', function () { setState({ offline: true }); });
window.addEventListener('online', function () {
  setState({ offline: false });
  load(false);
});

/**
 * The usual shape of a new day here is a tablet that was asleep: it wakes, the
 * page becomes visible, and nothing has been touched yet. Reloading at that
 * moment gets the sheet's own date back before the first tap.
 */
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible' && dayRolled()) load(false);
});

var settingsCameFrom = 'view';

// Before the first paint, so a chosen theme does not flash the other one.
S.theme = readPref('theme', 'auto');
if (S.theme !== 'light' && S.theme !== 'dark') S.theme = 'auto';
applyTheme();

render();
load(false);
