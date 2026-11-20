# For your archive's users

This page is for the person who runs an archive. It says which page of this guide to send to each kind of person who uses your archive, and gives a welcome text for contributors that you can paste into an email. The people who use your archive never see this repository unless you point them at it, so the links below are full addresses that work from anywhere.

## What to send each person

What a person needs depends on their role: a **reader** finds and downloads data, a **contributor** submits it, and a **curator** reviews submissions. [Using the archive](using-the-archive.md) has one section for each.

| Who | Send them | What it covers |
| --- | --- | --- |
| A reader | [Using the archive: Reader](https://github.com/schuettc/research-archive-in-a-box/blob/main/docs/guide/using-the-archive.md#reader) | Searching, a dataset's page, citing, and what happens when the files aren't public |
| A contributor | [Packages and cruise](https://github.com/schuettc/research-archive-in-a-box/blob/main/docs/guide/packages.md), then [Using the archive: Contributor](https://github.com/schuettc/research-archive-in-a-box/blob/main/docs/guide/using-the-archive.md#contributor) | Making a package and checking it with `cruise`, then submitting it and following it through review |
| A curator | [Using the archive: Curator](https://github.com/schuettc/research-archive-in-a-box/blob/main/docs/guide/using-the-archive.md#curator), then [Curating published datasets](https://github.com/schuettc/research-archive-in-a-box/blob/main/docs/curating.md) | The review queue and deciding a submission, then corrections to published datasets |

A reader needs nothing from you to browse and to download public files. A contributor or a curator needs an account with that role first: you give roles under **Settings › People**, as [People](using-the-archive.md#people) describes. A curator is emailed about waiting submissions only after you subscribe their address, as [The first admin](deploying.md#6--the-first-admin) explains.

A contributor should check a package with your archive's own rules before uploading it, and for that they need your `archive.yaml`. It holds no password or key, so you can send them the file, or tell them the profiles it names. [Profiles and the archive's own rules](packages.md#profiles-and-the-archives-own-rules) shows both ways.

## A welcome text for contributors

The archive's own invitation email holds only the sign-in details: the address, a temporary password and where to sign in. Send this text yourself, in an email of your own, when you invite a contributor. Replace each part in angle brackets first.

```
Welcome to <the archive's name>, at <the archive's address>.

You have a contributor account, so you can submit datasets for review. A dataset is submitted as a package: a folder with your data files and a manifest, datapackage.json, that describes them. This guide shows how to make one from a CSV file:
https://github.com/schuettc/research-archive-in-a-box/blob/main/docs/guide/packages.md

cruise is the tool that checks a package on your own computer before you upload anything. It needs uv (https://docs.astral.sh/uv/). Install cruise with:

uv tool install "git+https://github.com/schuettc/research-archive-in-a-box@v0.1.1#subdirectory=packages/tool"

Then check your package's folder with:

cruise diagnose <folder>

When it says the package is publishable, sign in at <the archive's address>, open Submissions, press Submit a package and choose the folder. This page walks through submitting and what each status means:
https://github.com/schuettc/research-archive-in-a-box/blob/main/docs/guide/using-the-archive.md#contributor

Questions go to <your contact address>.
```

If your archive's `archive.yaml` names a profile other than `core`, or required fields of its own, add a line telling contributors to check with those rules, such as `cruise diagnose --profile ecology <folder>`.

## Pointing at the guide from the archive itself

The archive's **About the archive** page shows your introduction, [`brand.intro`](archive-yaml.md#brandintro) in `archive.yaml`, and the same text appears above the datasets on Browse. To point contributors at the guide from there, end the introduction with a sentence of this kind:

```yaml
brand:
  intro: >-
    The Invented Research Cooperative shares the data behind its field studies. To submit a
    dataset, start with the guide at
    https://github.com/schuettc/research-archive-in-a-box/blob/main/docs/guide/packages.md
```

The introduction is plain text of at most 600 characters, so the address is shown as text to copy, not as a link, and the whole welcome text above doesn't fit there.
