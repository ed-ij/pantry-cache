# Upgrading a copy made before "Check for updates" existed

Copies created from the original instructions have no way to ask whether there
is a newer version — the update mechanism is itself part of the update. So the
first upgrade is done by hand, once. Afterwards it is
**Pantry Cache → Check for updates**, and this document stops applying.

About ten minutes, and the spreadsheet is never at risk.

---

## What is actually changing

**The script, not the data.** Every step below happens in the script editor or
the Apps Script deployment. No row is read, written or moved by any of it.

**One column is appended.** `Inventory` and `History` gain a `Month only`
column at the far right. It is left blank on every row that already exists,
and blank means *the day is known* — which is true of every bag recorded so
far, because until now there was no way to record anything else. Nothing needs
backfilling.

> The old code overwrote row 1 whenever it did not match what it expected,
> which silently made an inserted column permanent. The new code appends what
> is missing and refuses out loud if anything else is wrong. That is the
> change that makes this step safe.

**The app is renamed, and so are one tab and one column.** Nothing about this
app was ever specific to freezing — it is equally a pantry, a cellar or a spare
fridge — so *Freezer Log* is now **Pantry Cache**, the `Freezers` tab is
`Stores`, and the `Freezer` column in `Inventory` and `History` is `Store`.

The renaming is done for you, in place, the first time the new code touches the
sheet. Your rows are not rewritten: the tab keeps its contents and the column
keeps its values, only the names on them change.

> This is why it is done *for* you rather than left as an instruction. The
> header check appends whatever is missing, so a sheet left to itself would
> gain an empty `Store` column beside the full `Freezer` one and quietly orphan
> every value in it. Renaming in place keeps the data attached to its column.
>
> If you would rather see it happen before anything else does, the migration is
> idempotent — running **Set up / repair sheets** twice changes nothing the
> second time.

**The permissions get narrower, and gain one.** The script previously asked for
access to every spreadsheet you own; it now asks only for the one it is bound
to (`spreadsheets.currentonly`). It also asks for `script.external_request`,
which is what lets *Check for updates* fetch the version file. Expect to
approve the app again — see [step 4](#4-authorise-the-new-permissions).

---

## Before you start

**Know which Google account owns the script**, and do all of this signed into
it. Deploying from a different account produces a *different URL* and runs as
that account, which then depends on it keeping access to the sheet. The tablet
is bookmarked to the current URL, so this matters more than anything else here.

Open the sheet, then **Extensions → Apps Script**, and keep both tabs open.

---

## 1. Get the files

If you have the repository:

```bash
git checkout main && npm run build
```

That writes `dist/`. Otherwise open the repository on GitHub, switch to the
`main` branch, and take the files from `dist/` there — they are committed, and
they are exactly what a household receives.

> Take them from `main`, not `dev`. A build stamps the branch it was cut from
> and points its own update checks at that branch, so a `dev` build would tell
> this copy to follow unreleased work.

## 2. Paste them in

In the script editor. Five files are replacements — open each, select all,
paste over it:

| Script editor file | From |
| --- | --- |
| `Code.gs` | `dist/Code.gs` |
| `Index` | `dist/Index.html` |
| `Css` | `dist/Css.html` |
| `Js` | `dist/Js.html` |
| `Setup` | `dist/Setup.html` |

Then one file that does not exist yet:

- **+ → HTML**, named exactly `Update` (Apps Script adds the `.html` itself),
  and paste in `dist/Update.html`.

**This is the step people miss.** Everything else is a replacement, so it is
easy to work down the list and never notice that one of them is a creation.
`Update` is the dialog that does the checking — without it the new menu item
opens onto nothing.

Finally the manifest, which is hidden by default:

- **⚙ Project Settings → Show "appsscript.json" manifest file in editor**
- Back in the editor, open `appsscript.json` and paste in
  `dist/appsscript.json`.

Save.

> The manifest carries the permission changes. Paste it *before* deploying, or
> the new version goes out asking for the old permissions and the update check
> fails at the point it tries to fetch anything.

## 3. Reload the spreadsheet

Not the script editor — the spreadsheet tab. The **Pantry Cache** menu is built
when the sheet opens, so the new **Check for updates** item only appears after
a reload.

## 4. Authorise the new permissions

Run **Pantry Cache → Set up / repair sheets**.

Google will ask you to approve the script again, because the permissions
changed in step 2. It shows the "Google hasn't verified this app" warning:
**Advanced → Go to Pantry Cache (unsafe)**. This is your own script in your own
account, and the warning is what Google shows for any script it has not put
through review.

That same menu item does two useful things once it is allowed to run: it
appends the `Month only` column described above, and it reports any bag that
ended up recorded in both `Inventory` and `History` — the visible residue of a
write that was interrupted half way, which nothing used to notice.

> The column would also be appended by itself the first time the new code
> writes to the sheet. Doing it deliberately means you watch it succeed rather
> than assuming it did.

## 5. Deploy the new version

**Deploy → Manage deployments → ✏️ (edit) → Version: New version → Deploy.**

Edit the deployment that is already there. Do **not** use *New deployment* —
that mints a second web app with a different URL, leaves the old one serving
the old code, and the tablet carries on talking to the old one.

---

## Checking it worked

**Pantry Cache → Open the app / get my link** shows a build stamp at the bottom.
It should match the `build` field in `latest.json` on `main`. If it still shows
the old date, the deployment did not take — go back to step 5.

Then, on the tablet, open the app as normal. The URL has not changed, so the
home-screen icon still works. Take one bag out and put it back with **Undo**,
which exercises a read, a write and the new undo path in one gesture.

---

## If something looks wrong

**The URL changed.** You used *New deployment* instead of editing the existing
one, or you were signed into the wrong account. Delete the new deployment, and
redo step 5 as the owning account.

**The menu has no "Check for updates".** The spreadsheet has not been reloaded
since the paste — step 3.

**"Check for updates" opens an empty dialog.** The `Update` file was not
created, or was named something other than `Update` — step 2.

**The app opens but cannot read anything.** The permissions were not
re-approved. Run **Set up / repair sheets** from the menu and complete the
authorisation.

**The link fails for you but the deployment looks right.** Open it in a private
window. Apps Script routes `/exec` through an `authuser` index, so a browser
signed into a different Google account fails with "Sorry, unable to open the
file at this time" — an account problem wearing the costume of a broken
deployment.

---

## After this

Never again. **Pantry Cache → Check for updates** compares the copy's build
stamp against `latest.json` in the repository, shows what changed, and hands
over each file to paste in order. The only manual step left is
**Deploy → Manage deployments → ✏️ → New version**, which Apps Script does not
allow a script to do for itself.

Nothing is ever pulled automatically, so a bad release cannot reach anyone's
store list on its own. See [SHARING.md](SHARING.md) for publishing one.
