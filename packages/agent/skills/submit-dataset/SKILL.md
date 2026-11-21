---
name: submit-dataset
description: Checks a local dataset package with the archive's own rules, drafts fixes for what it finds, applies only the ones the person approves, and submits the package to their research-archive-in-a-box archive for review. Use when someone wants to check, fix, finish or submit a dataset package (a folder with datapackage.json), or asks about a submission's status or a curator's requested changes. Submitting needs an account in the contributor group.
---

# Submit a dataset

The checks are the same `cruise` rules the archive's ingest runs, so a package that passes
here passes there. You draft; the person decides. **Never write to the manifest without the
person's yes.** Before anything is sent to the archive, `submit` asks the person itself, in a
dialog. The tools come from the `cruise` MCP server; `diagnose` and `edit_manifest` work
offline.

## Steps

1. **Ask for the package folder and call `diagnose` on it.** Show the `verdict`, the score
   (`quality.score`, with `find`, `understand` and `trust`) and the findings grouped by
   question, errors first:
   - Structure (`structure.*`): the package's files, hashes and references. A
     `structure.checksums-hidden` finding means `checksums.sha256` lists a hidden file: any
     approved `edit_manifest` rewrites the file without it.
   - Can I find, cite and reuse it? (`package.*`)
   - Can I understand each column? (`field.*`)
   - Can I trust the values? (`values.*`)
2. **Draft a fix for each finding you can help with**: a missing title, description,
   keywords, license or rights status, temporal or spatial coverage, methods, contributors,
   an embargo date (`archive:embargoUntil`, a YYYY-MM-DD date the files are held back until
   while the page is public; only on the person's word), or a column's title, description or
   unit. Draft from what the folder holds: its `docs/`,
   its column names and values, its original files. Show each draft beside its finding.
   **Never invent a fact the folder doesn't support**: where it is silent (who made it, the
   license, the units, how values were measured), ask the person instead of guessing.
   Findings about the data itself (constant columns, out-of-range values, undocumented codes)
   aren't fixed by an edit: explain them and leave the decision to the person.
3. **Stop for the person's yes on each draft.** Apply only the approved ones with
   `edit_manifest`: each edit is `{"target", "value"}`, plus `"resource"` and `"column"` for
   a column. It rewrites `datapackage.json`, `README.md` and `checksums.sha256`, or writes
   nothing and names each failing edit; fix those with the person and try again. Then call
   `diagnose` again and show what changed.
4. **Repeat** until no errors are left or the person stops. Warnings may remain: list them
   and say they don't block publishing.
5. **Submit when the person asks.** Say what will happen and where: every file in
   `checksums.sha256` is uploaded and the package goes to review at the archive this window
   is on (`diagnose` answers it as `archive`; name it). Hidden files and folders
   (names starting with a dot, such as `.DS_Store` or `.git/`) are never part of a package:
   they are not listed, checked or uploaded. Call `sign_in` if needed (say first that it
   opens the browser), then `submit` with the folder. The plugin then shows the person a
   dialog with the archive, the number of files and their total size, and sends only if they
   accept it. Show the submission id, its status and the `archive` it went to. If it answers
   that the person didn't accept, nothing was sent: don't call it again unless they ask.
   `submit` refuses a package with an error finding; go back to step 2 if it does.
6. **Later, on request, call `submissions`** with the id to show its status. When it is
   `needs-changes`, show the curator's note (in its `decided` event) and the findings (in
   its `report`; if it answers a `report_error` instead, say the findings couldn't be read
   and why, and run `diagnose` on the folder to see them), go back to step 2, and call
   `submit` with the folder and `submission` set to the same id for its next round.
   When it is `failed`, show the `reason` of its `failed` event (an older event with no
   `reason`: say the archive couldn't finish publishing, and never show its `error`) and say: "This submission
   can't continue. Submit the package again to publish it: it keeps the same dataset id, and
   nothing you sent is lost from your copy." With their go, call `submit` with the folder and
   no `submission`, which starts a new submission of the same package.

## When a tool answers an error

Say what the tool said in plain words, keep working locally (`diagnose` and `edit_manifest`
need no network), and say what to run again:

- **No archive is set, or it is the wrong one**: ask for the archive's web address and call
  `connect`. It changes this window only; other open windows keep their archive.
- **The archive can't be reached**: the package stays as it is on disk; run `submit` again
  when the archive answers. Nothing is queued. A submit that failed part way leaves a draft
  in the archive that expires on its own; the next `submit` starts a fresh one.
- **Signed out or the sign-in expired**: sign-in lasts an hour and only while this session
  runs. Call `sign_in` again (with their go) and retry. A sign-in is for one archive; after
  `connect` to another, sign in again.
- **Not allowed**: pass on the archive's reason, which the error leads with. When it names
  the `contributor` group, the archive's admin can add it; when it says only the dataset's
  submitter or a curator may version it, the manifest's `id` belongs to someone else's
  published dataset: give the package its own `id`, or ask that dataset's submitter.
- **Conflict** (the archive's message): the submission isn't in a state that takes this step,
  such as one already in review. Call `submissions` to see where it stands.
- **Refused** (the archive's message): pass it on, and fix what it names with the person.
- **It needs an interactive session**: `submit` could not show its dialog, so nothing was
  sent. Say that submitting needs an interactive Claude Code session.
