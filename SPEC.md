# Freezer Log — specification

What the app is, why it is shaped the way it is, and what it deliberately does
not do. For how to build, deploy or share it, see [README](README.md) and
[SHARING](SHARING.md).

---

## Purpose

Keep track of home-grown fruit and vegetables across several domestic freezers,
replacing a hand-kept spreadsheet. The primary user is not technically confident
and works standing at a freezer with a tablet.

It answers three questions and no others:

| | |
| --- | --- |
| **Put in** | Something has been picked and bagged. Record it. |
| **In the freezers** | What have I got, and what has been in there longest? |
| **Take out** | I am cooking. Remove what I have used. |

## Shape

```
Google Sheet          the database — four tabs, plain columns, hand-editable
   └─ Apps Script     bound to that sheet
        ├─ Code.gs    server logic; the only thing that touches the sheet
        └─ Index/Css/Js/Setup   the web app, served at a private URL
```

One spreadsheet, one deployment, one household. No shared backend, no accounts,
no server to keep running.

## Data model

A **bag** (one row of `Inventory`) is the unit of everything: one physical bag,
tub or box in one freezer, put in on one date. Quantities are never aggregated
in storage — six bags of raspberries are six rows — because bags are taken out
individually.

| Tab | Columns |
| --- | --- |
| `Inventory` | `ID`, `Item`, `Category`, `Freezer`, `Weight (g)`, `Date In`, `Note`, `Count`, `Unit` |
| `History` | the same, plus `Date Out` |
| `Items` | `Item`, `Category`, `Typical weight (g)`, `Typical count`, `Unit` |
| `Freezers` | `Name`, `Where`, `Colour` |

A bag needs **a weight, a count, or both**. Sweetcorn is better recorded as
*6 cobs* than as 900 g; raspberries are better as a weight.

Taking something out **moves** the row to `History` rather than deleting it, so
the record of what the garden produced accumulates on its own.

## Operations

`apiGetState`, `apiAdd`, `apiRemove`, `apiRemovePart`, `apiEditLot`,
`apiSplitLot`, `apiRenameItem`, `apiRenameCategory`, `apiUndo`.

Every mutating call returns an **undo token**, and every one of them is
reversible: adds delete, removals move back, edits restore prior values, splits
reassemble, renames rename back.

---

## Design constraints

These are the decisions that everything else follows from. Changing one of them
changes the app.

**1. The spreadsheet is the source of truth and must stay readable by a human.**
This was the founding requirement — she must be able to open, read and correct
the data as a spreadsheet. So: plain columns, no formulas in data tabs, no
encoded values, one row per real-world object. The app is a convenient face over
a file she owns, never a system that merely exports to one.

**2. The screen must always match the spreadsheet.** Writes are applied to the
interface only once the sheet has confirmed them. Nothing is optimistic. The
cost is that a dropped connection means the action does not happen — accepted,
because a tablet showing bags that the spreadsheet does not have is worse.

**3. Every action is undoable, and errors are written in English.** The user
cannot be expected to reason about state. No confirmation dialogs guarding
routine work; a 30-second undo instead, plus a session list of what was just
done. Backend errors read "Please choose which freezer it is in", never a code.

**4. Built for a tablet at a freezer.** Large type, minimum ~54 px touch targets,
bottom navigation, three tabs and no nesting. Every stepper button states its own
size (`−50`, `−10`) because an unlabelled `+` is a guess.

**5. Month and year are what matter; the day is a bonus.** Views lead with
"Jul 2025" and "1 year 1 mth ago". Exact dates are stored where known, for later
analysis, but never made to feel important.

**6. Weights are stored exactly as entered, in grams.** A 10 g grid was tried and
removed: once a keypad exists, rounding is the user's business, not the app's.
Ounces convert on entry and are not stored.

**7. Counts only combine when they count the same thing.** Six cobs plus four
heads is not ten of anything, so mixed sets show their weight, or each unit
listed separately.

**8. Freezers are defined only in the `Freezers` tab.** The app never invents
one. Colours are picked for the light theme and lightened automatically for
dark, so one value cannot be wrong on one of them.

**9. New columns are appended, never inserted.** A sheet already holding data
must keep every value under the right header when the layout is refreshed.

**10. No dependencies, no framework, no build step beyond concatenation.** Apps
Script has no module system, and this has to remain repairable by hand years
from now.

**11. Each deployment is independent.** One household's copy cannot affect
another's, and nobody's data passes through anyone else.

---

## Limitations

Known and accepted. Most follow directly from a constraint above.

**Offline: none at all.** With no connection the app will not even load — Apps
Script serves the page from Google, and its sandboxed iframe cannot register a
service worker, so an offline cache is not available on this architecture. If
the connection drops while the app is open, actions fail with a plain message
and nothing is queued or synced later. *A freezer beyond wi-fi range cannot be
used with this app.* Test the walk before relying on it.

**Latency.** Each action is a round trip to Google, typically one to two
seconds. Deliberately not hidden behind optimistic updates (constraint 2).

**One person at a time.** Writes are serialised with a script lock, so the sheet
cannot be corrupted, but there is no live refresh: two people using it at once
can act on a stale view. Fine for a household, wrong for a shop.

**The link is a key.** Deployed with *Anyone* access, whoever holds the URL can
read and change the log without signing in. That is what makes it painless on a
tablet. The alternative — *Anyone with a Google account* — costs one sign-in.

**Copies are frozen.** Updates do not propagate to spreadsheets already copied.
This is the price of independence (constraint 11) and is usually the right trade.

**Freezers cannot be renamed from the app.** Items and categories can. Renaming a
freezer means editing the `Freezers` tab *and* find-and-replacing the `Freezer`
column, or every existing bag is orphaned.

**Scale.** Designed for hundreds of bags. `History` grows for ever and is never
pruned. Reads fetch whole tabs; renames rewrite whole columns. At a few thousand
rows this will need revisiting, and Apps Script quotas are a ceiling nobody here
is near.

**Not included, on purpose.** Photos, barcodes, expiry alerts, notifications,
recipes, shopping lists, nutrition, multiple households, user accounts. Each
would earn its place only by making the three questions above harder to answer.

**Small things.** Backdating to a month sets the day to the 1st. Dark-theme
freezer colours need `color-mix`, and degrade to the stored colour without it.
`.freezer-bar` is unused CSS left from the removed by-freezer view.
