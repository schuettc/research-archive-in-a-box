---
name: find-data
description: Finds datasets in the person's research-archive-in-a-box archive, shows one with its columns, license and citation, and downloads the files they name. Use when someone asks what data the archive holds, looks for data on a topic, place or period, wants to cite a dataset, or asks to download its files. Public data needs no sign-in.
---

# Find data

Anyone can search the archive and fetch public data without signing in. Limited and restricted
files need `sign_in` first. The tools come from the `cruise` MCP server.

## Before you start

This window works with one archive: the one it started with, or the one last given to
`connect` in this window. `search` answers it as `archive`; say which archive the results come
from. If a tool answers that no archive is set, or the person wants a different archive, ask
for its web address (such as `https://d111111abcdef8.cloudfront.net`) and call `connect` with
it. `connect` changes the archive for this window only, signs this window out of the one it
was on, and makes the address the default for new windows; other open windows stay where
they are.

## Steps

1. **Ask what they are looking for.** Then call `search` with their words as `q` and any
   filters they give: `access` (public, limited, restricted, description-only), `license`, `format`,
   `project`, `from_date` and `to_date` (YYYY-MM-DD), and `bbox` as
   `[west, south, east, north]`. Use the answer's facet counts to suggest a narrower filter
   when there are many matches, and `page` for more.
2. **Show the matches as a short list**: title, years (`start` to `end`, or ongoing),
   license and access. Say how many matched in all.
3. **For the one they pick, call `get_dataset`** with its id. Show its description, its
   columns (from each resource's `schema.fields`) with their descriptions and units, its
   license or rights status, and the `citation` the tool answers. Don't make up what a
   column means: if it has no description, say so.
4. **Download only on request.** Ask which files (by the paths in the dataset's `files`) and
   into which local folder, then call `download` with the id, version, paths and folder.
   - A `description-only` dataset publishes its page and description with no files: say
     there are no files to download; its description and citation are still theirs to use.
   - If the dataset's access is `limited` or `restricted`, say before calling
     `sign_in` that it will open the browser to sign in, and wait for their go.
   - Report what was written and where. A file under `failed` didn't match its recorded
     hash and was not kept: say so and offer to try again.

## When a tool answers an error

Tell the person in plain words what the tool said, and what to do next:

- **The archive can't be reached**: check the address and the connection, then run the same
  step again. Nothing is queued.
- **Signed out or the sign-in expired**: say that sign-in lasts an hour and only while this
  session runs, then call `sign_in` again (with their go) and retry the step. A sign-in is
  for one archive; after `connect` to another, sign in again.
- **Not allowed** (it names the group needed, and the archive's reason in brackets): their
  account lacks that group; the archive's admin can add it. A restricted dataset needs an
  admin's approval: if the reason is `ask for access`, tell them to request it on the
  dataset's page in the archive, and pass on any other reason (waiting, declined, ended,
  disabled) as it is.
- **Refused** (the archive's message): pass the message on; usually a wrong id, version or
  path. Check them with `get_dataset`.
