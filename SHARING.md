# Giving Freezer Log to someone else

Each person gets their **own copy** of the spreadsheet, in their **own Google
account**, with their **own web app**. Nothing is shared between them, nothing
routes through you, and nobody's freezer list depends on anybody else's.

That independence is the whole point, and it has a cost worth being honest
about: there is no central version. If you improve the app, existing copies do
not change. See **Updates** at the end.

---

## Set up the template, once

Do this on the account that should own the master copy — plausibly your own,
kept separate from your mum's working one.

1. Make a spreadsheet with the code in it, following **One-time setup** in the
   [README](README.md), steps 1–4. Stop before deploying.
2. Leave the `Freezers` tab with example rows and the `Inventory`, `History` and
   `Items` tabs **empty**. Whatever is in the template is what everyone starts
   with.
3. Do **not** deploy the template. Each person deploys their own copy.

That spreadsheet is now the template. Never put real data in it.

---

## The link you send people

Take the normal spreadsheet URL:

```
https://docs.google.com/spreadsheets/d/FILE_ID/edit
```

and replace `/edit` with `/copy`:

```
https://docs.google.com/spreadsheets/d/FILE_ID/copy
```

Set the file's sharing to **Anyone with the link — Viewer** so the copy link
works for people you have not individually invited.

Opening that link offers them **Make a copy**. The copy lands in their own
Drive, with the script attached and running under their account. They cannot
edit your template, and you cannot see their copy.

---

## What they do

Send them this. It is the whole job.

> 1. Open the link and click **Make a copy**.
> 2. In the new spreadsheet, wait for the **Freezer Log** menu to appear next to
>    Help, then choose **Freezer Log → Open the app / get my link**.
> 3. Follow the five steps it shows you. It is mostly clicking **Deploy**.
> 4. Open the same menu again — it now shows your web address. Email it to
>    yourself, open it on your tablet, and use **Add to Home screen**.
> 5. List your freezers on the **Freezers** tab of the spreadsheet. That is the
>    only place they are defined.

The dialog does the explaining, including the "unverified app" warning that
looks alarming and is not — it is their own script asking to use their own
spreadsheet.

---

## Being clear about who owns what

Worth saying out loud when you send it, because people assume otherwise:

- **Their data is theirs.** It lives in their Google account, in a spreadsheet
  they own. You have no access to it and cannot recover it for them.
- **Their link is a key, and it cannot be taken back.** Deployed with *Anyone*
  access, whoever holds the URL can read and change their freezer list without
  signing in. That is what makes it painless on a tablet, and it is the right
  trade for frozen raspberries — but say the second half too, because it is the
  part people want to know on the day they wish they had not forwarded the
  email: **revoking access means creating a new deployment, which changes the
  URL**, so the link has to be re-added to the tablet's home screen. The
  realistic exposure is not a decision anyone makes deliberately — it is a URL
  sitting in an email, in browser history, or in a screenshot. If that ever
  stops feeling comfortable, *Who has access* → **Anyone with a Google account**
  costs exactly one sign-in on the device.
- **Backups are theirs too.** Google keeps version history on the sheet
  (**File → Version history**), which covers most accidents. For a real backup,
  **File → Download → Microsoft Excel**.
- **It is given as-is.** You are not running a service. If their tablet breaks
  or they delete a tab, that is theirs to sort out — which is exactly why no
  copy can affect any other.

---

## Updates

Copies do not update themselves — that is what keeps them independent, and it
means a bad release cannot reach anyone's freezer list. Instead, each copy can
ask whether there is a newer one:

**Freezer Log → Check for updates** reads a small file from the project's
repository, compares it against the build stamped into that copy, and if there
is something newer, shows what changed and hands over each file to paste, in
order. The spreadsheet itself is never touched.

To publish an update:

```bash
npm run build
npm run release -- "What changed, in one sentence."
git add -A && git commit -m "…" && git push
```

Pushing *is* publishing: the dialog reads `latest.json` and `dist/` straight
from the repository. Nothing is pulled until someone opens that menu and
chooses to.

Each copy shows its build date at the bottom of **Open the app / get my link**,
so a bug report can name a version.

A copy made before this mechanism existed has no **Check for updates** item to
choose. Bringing one up to date is a one-time manual pass, written out in
[UPGRADING.md](UPGRADING.md).

