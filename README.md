# Freezer Log

A large-type, tablet-first web app for keeping track of what is in the freezers,
backed by a Google Sheet so the data can always be opened, read and corrected as
a spreadsheet.

What it is for, why it is built this way and what it deliberately does not do
are in [SPEC.md](SPEC.md). Three things it does:

| Tab | What it is for |
| --- | --- |
| **Put in** | Pick an item from a grid grouped by category, or type a new name. Set a weight and/or a count of pieces, say how many bags, choose a freezer, confirm. Dated today by default, easy to backdate. |
| **In the freezers** | **By item** (grouped under Fruit / Vegetables / Herbs / …) or **By age** (oldest first, grouped by month), filtered by freezer and searchable. The freezer chips carry their own totals, so the filter row doubles as the overview. |
| **Take out** | Oldest-first list you can filter by freezer or search. One tap to take a bag out, with an Undo. |

Tapping any bag also offers **Change this bag…**, which can put right its
freezer, date, weight, count or note, or split it into several bags. Items and
categories can be renamed from the **In the freezers** tab. Every one of those
is undoable.

---

## How it is put together

There is no server to run and nothing to install on anyone's machine.

```
Google Sheet  ──  the database. Four tabs, plain columns, editable by hand.
     │
     └─ Apps Script (bound to the sheet)
            ├─ Code.gs     server logic, reads and writes the sheet
            └─ Index/Css/Js  the web app, served at a private URL
```

Because the script is *bound* to the sheet, deploying it gives you a URL that
works from any device, with no sign-in and nothing to keep switched on at home.

---

## One-time setup

### 1. Build the files

```bash
npm run build
```

That writes `dist/` with the five files Apps Script wants.

### 2. Create the spreadsheet

Go to [sheets.new](https://sheets.new), name it something like **Freezer Log**.

### 3. Add the script

In the sheet: **Extensions → Apps Script**. Then, in the script editor:

- Rename the project to `Freezer Log`.
- Replace the contents of `Code.gs` with `dist/Code.gs`.
- **+ → HTML** three times, creating files named exactly `Index`, `Css` and `Js`
  (Apps Script adds the `.html` itself). Paste in `dist/Index.html`,
  `dist/Css.html` and `dist/Js.html` respectively — replace everything that is
  already in each file.
- **+ → HTML** once more, named `Setup`, and paste in `dist/Setup.html`. This is
  the dialog the spreadsheet menu shows.
- **⚙ Project Settings → Show "appsscript.json"**, then paste in
  `dist/appsscript.json`.
- Save.

> Prefer one command? Install [clasp](https://github.com/google/clasp), run
> `clasp login`, then `clasp clone <scriptId>` into `dist/` and `clasp push`.
> The five built files are already in the layout clasp expects.

### 4. Set up the tabs

Back in the spreadsheet, reload the page. A **Freezer Log** menu appears next to
Help. Choose **Freezer Log → Open the app / get my link**, which creates the tabs
and then walks through deploying. Approve the permissions
prompt (it is your own script, so Google shows the "unverified app" warning —
**Advanced → Go to Freezer Log (unsafe)**).

You now have four tabs: `Inventory`, `History`, `Items`, `Freezers`.

### 5. List the real freezers

On the **Freezers** tab, replace the two example rows with the actual freezers:

| Name | Where | Colour |
| --- | --- | --- |
| Kitchen | Fridge-freezer indoors | `#2f7fd0` |
| Garage | Big chest freezer | `#2c8f68` |
| Utility | Upright by the back door | `#c0632a` |

`Colour` is optional — leave it blank and one is chosen automatically. This is
the only place freezers are defined; the app never invents one.

Pick the colour for the **light** theme only. On the dark theme the app lightens
it automatically, so one value works in both and it cannot end up invisible on
one of them. (On a browser too old for `color-mix`, the stored colour is used
as-is on both — still legible, just not tuned.)

### 6. Deploy

Script editor → **Deploy → New deployment → Web app**:

- **Execute as:** Me
- **Who has access:** Anyone

Copy the web app URL. That is the app.

> **Worth a moment's thought:** "Anyone" means anyone holding that URL can open
> and change the log, with no sign-in — which is exactly what makes it painless
> on a tablet. The URL is long and unguessable and the contents are frozen
> raspberries, so this is a reasonable trade. If you would rather lock it down,
> set **Who has access** to *Anyone with a Google account*; your mum then has to
> be signed into Google on the tablet, once.

After changing any code you must **Deploy → Manage deployments → ✏️ → Version:
New version** for the change to reach the live URL.

Do that **signed in as the account that owns the script**. That keeps the URL
unchanged and keeps the app running on the owner's authorisation against their
own spreadsheet. Deploying from a different account produces a different URL and
runs as that account instead, which then depends on it keeping access to the
sheet.

> **If the link fails for you but the deployment looks right**, open it in a
> private window first. Apps Script routes `/exec` through an `authuser` index,
> and if your browser is signed into a different Google account from the one
> that owns the script, it fails with "Sorry, unable to open the file at this
> time" — an account problem wearing the costume of a broken deployment.
> Working in a private window proves anonymous access is fine. Add `?authuser=0`
> (or `1`, `2`) to the URL, or use a browser profile signed into the owning
> account.

### 7. Put it on the tablet

Open the URL in the tablet's browser and use **Add to Home screen**. It then
opens like an app, full screen, no address bar.

---

## The spreadsheet

Open it any time from the app itself (bottom of the **In the freezers** tab) or
from Google Drive. **File → Download → Microsoft Excel (.xlsx)** gives a real
Excel file whenever one is wanted.

### `Inventory` — what is in the freezers right now

| Column | Notes |
| --- | --- |
| `ID` | Generated. Leave it alone; it is how Undo finds a row again. |
| `Item` | e.g. `Raspberries` |
| `Category` | e.g. `Fruit` |
| `Freezer` | Must match a name on the `Freezers` tab |
| `Weight (g)` | **Grams**, as a plain number. 1.5 kg is `1500`. Blank if it was never weighed. |
| `Date In` | A real date. Only the month and year matter for the views. |
| `Note` | Free text, optional |
| `Count` | How many pieces are in the bag — 6 cobs, 4 portions. Blank if it is only weighed. |
| `Unit` | What those pieces are called. Goes with `Count`. |

### `History` — what has been used up

Same columns plus `Date Out`. Rows move here when something is taken out, and
move back if you undo. Nothing is ever deleted, so this builds into a record of
what the garden produced and how long it lasted.

### `Items` — the list the type-ahead suggests from

`Item`, `Category`, `Typical weight (g)`, `Typical count`, `Unit`. Rows are added
automatically the first time something new goes in, and the typical values are
what the Put in form pre-fills next time. Tidy up duplicates here (`Rasberries`
vs `Raspberries`) and the suggestions improve.

### `Freezers`

`Name`, `Where`, `Colour`. Add a row to add a freezer; the app picks it up on
the next reload.

### Editing by hand

Safe to do at any time. A few rules:

- **Don't rename or reorder the columns**, and don't insert new ones — the app
  reads them by position.
- Renaming a freezer on the `Freezers` tab does *not* rename it in `Inventory`;
  use Find & Replace on that column too.
- If a tab gets deleted or mangled, **Freezer Log → Set up / repair sheets**
  puts the headers back.
- The app reads the sheet when it loads. After editing by hand, tap the ↻ button
  in the app's top right.

---

## Weights and counts

A bag needs **a weight, a count of pieces, or both** — whichever actually tells
you something. Sweetcorn is better recorded as *6 cobs* than as 900 g, because
the number of cobs is what tells you how many people it feeds; raspberries are
better as a weight. Once an item has been counted, the app remembers the word
("cobs") and offers it again next time.

Weights are stored exactly as entered, in grams. Three ways to set one, because
different bags want different things:

- **Preset chips** (100 g, 250 g, 500 g, 1 kg, 2 kg) cover most bags in one tap.
- **Labelled steppers** — a fine pair (±10 g) inside and a coarse pair (±50 g)
  outside. Each button states its own size, so nothing is a guess.
- **Tap the number** for a full calculator keypad, which is the quickest way to
  a specific figure off a set of scales. It has a **Grams / Ounces** switch:
  type 6.5 in ounces and it converts to 184 g, which the steppers can then round
  off. (In ounces the last key becomes a decimal point rather than "00".)

The same control is used for counts, stepping by 1 and 5 instead of 10 g and
50 g, and for taking part of a bag out — where it also knows the bag's size and
will not let you take more than is in it.

Taking some of a counted bag splits its weight in the same proportion: two cobs
out of a 6-cob, 900 g bag leaves 4 cobs and 600 g.

Totals only add up counts that are counting the same thing. A single item or a
category of cobs shows "36 cobs · 5.4 kg"; a mixed shelf of cobs, portions and
heads shows its weight alone, rather than inventing a total of ten of nothing.

---

## Putting mistakes right

Nothing has to be deleted and re-entered. Tap a bag anywhere it appears and
choose **Change this bag…**:

- **Freezer, date, weight, count, unit, note** — all editable, with the same
  controls used when the bag went in.
- **Split this into several bags** — a tub recorded as "8 blocks" becomes eight
  bags of one block. Weight and count are shared out as evenly as they divide,
  with any remainder going to the first bags. Useful once something is being
  used a portion at a time rather than all at once.

**Renaming** is on the **In the freezers** tab, under **By item**:

- The pencil beside a category heading renames the category.
- Expanding an item shows **Rename "…"** beneath its bags.

A rename reaches every bag in the freezers *and* every row in `History`, so past
records stay consistent with the new name. Renaming onto a name that already
exists merges them rather than leaving two catalogue entries.

All of these can be undone from the toast, same as everything else.

---

## Keeping an existing copy up to date

A copy that already has **Freezer Log → Check for updates** in its menu uses it.
A copy made before that existed needs one manual pass first —
[UPGRADING.md](UPGRADING.md).

## Giving it to someone else

Each person gets their own copy, in their own Google account, with their own web
app and their own data — see [SHARING.md](SHARING.md). The short version is that
replacing `/edit` with `/copy` in the template's URL gives a link that hands
people their own copy, and the **Freezer Log** menu in that copy walks them
through publishing it.

---

## Importing the old spreadsheet

The hand-kept "Veg in freezers" workbook can be converted with:

```bash
node tools/import-sheet.mjs "~/Documents/Veg in freezers JUlY 2026.xlsx"
```

It reads the original (never writes to it) and produces `dev/data.json` so the
result can be checked locally, plus `dev/import/{Freezers,Items,Inventory}.csv`
to paste into the Google Sheet tabs.

The script prints a reconciliation against the SUM formulas already in the
original, which is the quickest way to confirm nothing was lost or double
counted. The mapping of columns to freezers, the item categories and the
spelling corrections are all constants at the top of the file — adjust them
there and re-run.

It refuses to overwrite an existing `dev/data.json`, since that would discard
anything added in the app since the last import; pass `--force` if that is
genuinely what you want.

### Keeping the CSVs up to date

Anything added or taken out in the local app is written straight to
`dev/data.json`. To refresh the CSVs from it:

```bash
npm run export
```

That rewrites all four tabs — `Freezers`, `Items`, `Inventory` and `History` —
so what you paste into the Google Sheet matches what you last saw on screen.

---

## Working on the code

```bash
npm run dev     # http://localhost:5178, backed by dev/data.json
npm run build   # regenerate dist/ for Apps Script
```

The dev server runs the *real* `src/backend.js` against a JSON file instead of a
sheet, so behaviour matches the deployed app. `dev/data.json` starts as a copy of
`dev/seed.json` (74 sample bags); delete it to reset, or run
`node dev/make-seed.mjs` to regenerate the sample data.

| File | Role |
| --- | --- |
| `src/backend.js` | All data logic. Runs in both hosts; talks only to a `DB` adapter. |
| `apps-script/host.js` | The `DB` adapter for Google Sheets, plus `doGet` and the sheet menu. |
| `dev/server.mjs` | The `DB` adapter for local JSON, plus a static file server. |
| `src/index.html`, `src/styles.css`, `src/app.js` | The app itself. No dependencies, no build step beyond concatenation. |
| `build.mjs` | Wraps the above into the file layout Apps Script requires. |

Edit the sources, never `dist/` — it is regenerated from scratch on every build.
