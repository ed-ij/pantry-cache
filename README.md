# Pantry Cache

A large-type, tablet-first web app for keeping track of what is in store,
backed by a Google Sheet so the data can always be opened, read and corrected as
a spreadsheet.

What it is for, why it is built this way and what it deliberately does not do
are in [SPEC.md](SPEC.md). Three things it does:

| Tab | What it is for |
| --- | --- |
| **Put in** | Pick an item from a grid grouped by category, or type a new name. Set a weight and/or a count of pieces, say how many bags, choose a store, confirm. Dated today by default, easy to backdate. |
| **In store** | Everything grouped under Fruit / Vegetables / Herbs / …, filtered by store and searchable. Totals across the top, and the store chips carry their own, so the filter row doubles as the overview. Tap an item to see its individual bags. |
| **Take out** | Oldest first, grouped by month, filtered and searched the same way. Tick everything you are cooking with and take the lot out in one go, with an Undo. |

Tapping a bag on **In store** also offers **Change this bag**, which can put
right its store, date, weight, count or note, or split it into several.

Behind the **&#9881;** in the top right is a settings screen — see
[Settings](#settings). Everything either tab can do is undoable.

---

## How it is put together

There is no server to run and nothing to install on anyone's machine.

```
Google Sheet ── the database. Four tabs, plain columns, editable by hand.
     │
     └─ Apps Script, bound to the sheet
            ├─ Code.gs           the logic; reads and writes the sheet
            ├─ Index, Css, Js    the app, served at its own private URL
            ├─ Setup, Update     the two dialogs in the Pantry Cache menu
            └─ appsscript.json   permissions, and who may open the app
```

Because the script is *bound* to the sheet, deploying it gives you a URL that
works from any device, with no sign-in and nothing to keep switched on at home.

Each copy holds its own code, pasted in once, so nothing changes under anybody's
feet. **Check for updates** reads this repository over the web and offers to
paste the newer files in; until somebody chooses to, a copy carries on exactly
as it is.

---

## The spreadsheet

Open it any time from the app itself (**&#9881; → Where all this is kept**) or
from Google Drive. **File → Download → Microsoft Excel (.xlsx)** gives a real
Excel file whenever one is wanted.

### `Inventory` — what is in store right now

| Column | Notes |
| --- | --- |
| `ID` | Generated. Leave it alone; it is how Undo finds a row again. |
| `Item` | e.g. `Raspberries` |
| `Category` | e.g. `Fruit` |
| `Store` | Must match a name on the `Stores` tab |
| `Weight (g)` | **Grams**, as a plain number. 1.5 kg is `1500`. Blank if it was never weighed. |
| `Date In` | A real date. The lists show its month; the exact day is on the bag itself, behind the **›**. |
| `Note` | Free text, optional |
| `Count` | How many pieces are in the bag — 6 cobs, 4 portions. Blank if it is only weighed. |
| `Unit` | What those pieces are called. Goes with `Count`. |
| `Month only` | `yes` when only the month was known going in. The day in `Date In` is then a placeholder and is never shown anywhere. Blank otherwise. |

### `History` — what has been used up

Same columns plus `Date Out`. Rows move here when something is taken out, and
move back if you undo. Nothing is ever deleted, so this builds into a record of
what the garden produced and how long it lasted.

### `Items` — the list the type-ahead suggests from

`Item`, `Category`, `Typical weight (g)`, `Typical count`, `Unit`. Rows are added
automatically the first time something new goes in, and the typical values are
what the Put in form pre-fills next time. Tidy up duplicates here (`Rasberries`
vs `Raspberries`) and the suggestions improve.

### `Stores`

`Name`, `Where`, `Colour`. Add a row to add a store; the app picks it up on
the next reload. Easier from the app: **&#9881; → Places → Add a place**, which
picks the colour for you.

### Editing by hand

Safe to do at any time. A few rules:

- **Don't rename or reorder the columns**, and don't insert new ones — the app
  reads them by position.
- Renaming a store on the `Stores` tab does *not* rename it in `Inventory` or
  `History`. Use **&#9881; → Places → Edit** instead: it renames every row on
  both tabs in one go, and can be undone. By hand it is a Find & Replace on each.
- If a tab gets deleted or mangled, **Pantry Cache → Set up / repair sheets**
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

Nothing has to be deleted and re-entered. Tap a bag on **In store** and choose
**Change this bag**:

- **Store, date, weight, count, unit, note** — all editable, with the same
  controls used when the bag went in.
- **Split this into several bags** — a tub recorded as "8 blocks" becomes eight
  bags of one block. Weight and count are shared out as evenly as they divide,
  with any remainder going to the first bags. Useful once something is being
  used a portion at a time rather than all at once.

**Renaming** needs **Editing** switched on under the cog. On **In store** then:

- The pencil beside a category heading renames the category.
- Expanding an item shows **Rename "…"** beneath its bags.

A rename reaches every bag in store *and* every row in `History`, so past
records stay consistent with the new name. Renaming onto a name that already
exists merges them rather than leaving two catalogue entries.

All of these can be undone from the toast, same as everything else.

Several bags at once — everything that came out of one drawer, say — is
**Editing → tick them on In store → Move**, described below.

---

## Settings

The **&#9881;** in the top right, beside the running total.

**How it looks.** Light, dark, or match the tablet. Separately, whether the
lists date a bag (*October 2025*) or age it (*11 months ago*). **Take out**
keeps its month headings whichever you pick, and the exact day is always on the
bag itself, behind the **›** — where it is shown both ways at once.

**Editing.** Off by default, because the pencils and tick boxes are noise when
you are only looking something up. On, it adds three things:

- the rename pencils on **In store**, beside categories and under items;
- a tick box on every bag, and a bar along the bottom to **Move** the ones you
  tick to another place — all-or-nothing, and undoable as one action;
- a list of items in the catalogue with nothing stored under them, to rename or
  remove. Anything that has been stored before is marked **kept** and cannot be
  removed: the type-ahead reads `History` as well as `Items`, so deleting the
  catalogue row would not stop it being suggested, and `History` is the record.

**Places.** Add one, or edit a name, its *where*, and its colour. Renaming here
reaches `Inventory` and `History` both — the thing a Find & Replace on the
`Stores` tab does not do.

**This copy.** Its build date and commit, and whether a newer version has been
published. That is the version to quote in a bug report.

**Where all this is kept.** The link to the spreadsheet behind it all.

---

## Building one from scratch

Only needed to make the first copy, or a template. Everybody else copies that —
see below.

### 1. Build the files

```bash
npm run build
```

That writes `dist/`: `Code.gs`, `appsscript.json`, and five HTML files.

### 2. Create the spreadsheet

Go to [sheets.new](https://sheets.new), name it something like **Pantry Cache**.

### 3. Add the script

In the sheet: **Extensions → Apps Script**. Then, in the script editor:

- Rename the project to `Pantry Cache`.
- Replace the contents of `Code.gs` with `dist/Code.gs`.
- **+ → HTML** five times, creating files named exactly `Index`, `Css`, `Js`,
  `Setup` and `Update` — Apps Script adds the `.html` itself. Paste the matching
  file from `dist/` into each, replacing everything already there.
- **⚙ Project Settings → Show "appsscript.json"**, then paste in
  `dist/appsscript.json`.
- Save.

Five files, and a name typed wrong breaks one of them silently — `Update` is the
easiest to miss, and without it *Check for updates* opens onto nothing.

> Prefer one command? Install [clasp](https://github.com/google/clasp), run
> `clasp login`, then `clasp clone <scriptId>` into `dist/` and `clasp push`.
> The built files are already in the layout clasp expects.

### 4. Set up the tabs

Back in the spreadsheet, reload the page. A **Pantry Cache** menu appears next to
Help. Choose **Pantry Cache → Open the app / get my link**, which creates the
tabs and then walks through deploying. Approve the permissions prompt — it is
your own script, so Google shows the "unverified app" warning
(**Advanced → Go to Pantry Cache (unsafe)**).

You now have four tabs: `Inventory`, `History`, `Items` and `Stores`, all empty.
Leave them that way. The app asks where things are kept the first time it opens,
so stores typed in here only become rows somebody has to delete.

---

> ### Making a template? Stop here.
>
> A template is a copy with the code in and no data. Do **not** deploy it —
> each person deploys their own. Skip to [Giving it to someone
> else](#giving-it-to-someone-else).

---

### 5. Deploy

Script editor → **Deploy → New deployment → Web app**:

- **Execute as:** Me
- **Who has access:** Anyone

Copy the web app URL. That is the app.

> **Worth a moment's thought:** "Anyone" means anyone holding that URL can open
> and change the log, with no sign-in — which is exactly what makes it painless
> on a tablet. The URL is long and unguessable and the contents are frozen
> raspberries, so this is a reasonable trade. If you would rather lock it down,
> set **Who has access** to *Anyone with a Google account*; whoever uses the
> tablet then has to be signed into Google on it, once.

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

### 6. Put it on the tablet

Open the URL in the tablet's browser and use **Add to Home screen**. It then
opens like an app, full screen, no address bar. It will ask where you keep
things; answer it, and start putting things in.

---

## Giving it to someone else

Each person gets their own copy, in their own Google account, with their own web
app and their own data. Send them [INSTALL.md](INSTALL.md) and a copy link;
between the two, they need nothing from you.

### The template

A template is what stopping at the marker above leaves you with: the code in,
the tabs empty, not deployed. Keep it on whichever account should own the
master, and never put real data in it — whatever is in there is what everybody
starts with.

When a release goes out, update the template the same way anybody else does —
**Pantry Cache → Check for updates** — or new copies start life behind.

### The link

Take the template's URL and replace `/edit` with `/copy`:

```
https://docs.google.com/spreadsheets/d/FILE_ID/copy
```

Set the file's sharing to **Anyone with the link — Viewer**, so the link works
for people you have not individually invited. Opening it offers them
**Make a copy**; the copy lands in their Drive with the script attached and
running as them. They cannot edit your template, and you cannot see their copy.

---

## Publishing an update

```bash
npm run build
npm run release -- "What changed, in one sentence."
git add -A && git commit -m "…" && git push
```

Pushing *is* publishing: the in-sheet dialog reads `latest.json` and `dist/`
straight from the repository, on the branch the copy was built from. Build on
`main`, or copies will be told to follow unreleased work.

Nothing is pulled until someone opens that menu and chooses to, so a bad release
cannot reach anyone's list on its own. Each copy shows its build date at the
bottom of **Open the app / get my link**, so a bug report can name a version.

---

## Working on the code

```bash
npm run dev     # http://localhost:5178, backed by dev/data.json
npm test        # backend, the sheet adapter, and a contrast check
npm run build   # regenerate dist/ for Apps Script
```

The dev server runs the *real* `src/backend.js` against a JSON file instead of a
sheet, so behaviour matches the deployed app. `dev/data.json` starts as a copy of
`dev/seed.json` (76 sample bags); delete it to reset, or run
`node dev/make-seed.mjs` to regenerate the sample data.

| File | Role |
| --- | --- |
| `src/backend.js` | All data logic. Runs in both hosts; talks only to a `DB` adapter. |
| `apps-script/host.js` | The `DB` adapter for Google Sheets, plus `doGet` and the sheet menu. |
| `dev/server.mjs` | The `DB` adapter for local JSON, plus a static file server. |
| `src/index.html`, `src/styles.css`, `src/app.js` | The app itself. No dependencies, no build step beyond concatenation. |
| `src/setup.html`, `src/update.html` | The two menu dialogs. Plain pages, run inside the spreadsheet rather than the app. |
| `build.mjs` | Wraps the above into the file layout Apps Script requires. |

Edit the sources, never `dist/` — it is regenerated from scratch on every build.

### Checks at commit time

`tools/setup-mac.sh` points git at the hooks in the repository:

```bash
git config core.hooksPath tools/hooks
```

They are tracked rather than per-machine, so a new laptop gets them with the
clone. Each one asks about something that has actually gone wrong here — real
rows in a commit, a `dist/` left behind `src/`, a build stamped with the wrong
branch, a release `latest.json` never names — and `npm test` besides, which is
a fifth of a second. There is no formatting or lint check: a hook that cries
wolf gets `--no-verify`, and takes the useful checks with it.

The last two questions are asked again in `pre-push`, because a release here is
a fast-forward of `main` and a fast-forward creates no commit for `pre-commit`
to run on. `--no-verify` skips either, for when you mean it.
