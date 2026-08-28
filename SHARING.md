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
- **Their link is a key.** Deployed with *Anyone* access, whoever holds the URL
  can read and change their freezer list without signing in. That is what makes
  it painless on a tablet. If they would rather not, they can set *Who has
  access* to **Anyone with a Google account** and sign in on the device once.
- **Backups are theirs too.** Google keeps version history on the sheet
  (**File → Version history**), which covers most accidents. For a real backup,
  **File → Download → Microsoft Excel**.
- **It is given as-is.** You are not running a service. If their tablet breaks
  or they delete a tab, that is theirs to sort out — which is exactly why no
  copy can affect any other.

---

## Updates

Copies are frozen at the moment they were made. A fix you make later reaches
nobody automatically. This is the price of everyone owning their own thing, and
mostly it is the right trade: nothing you do can break someone else's freezer
list.

If you do want to push an update to someone who wants it:

1. `npm run build`
2. Send them `dist/Code.gs`, `dist/Index.html`, `dist/Css.html`, `dist/Js.html`
   and `dist/Setup.html`.
3. They paste each one over the matching file in **Extensions → Apps Script**,
   then **Deploy → Manage deployments → ✏️ → Version: New version**.

Their data is untouched by this — it lives in the spreadsheet tabs, not in the
code. Updating the template only affects people who copy it afterwards.
