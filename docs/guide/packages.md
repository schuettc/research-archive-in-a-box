# Packages and cruise

This page explains what a package is, how to make one from a CSV file, and how to check and fix it with `cruise`, the kit's command-line tool. Everything here runs on your own computer; nothing is sent anywhere until you submit the package to an archive.

## What a package is

A **package** is a folder that holds a dataset's files together with a description of them. For example, a field station that surveys four forest plots each June would make one package for that survey: a folder with the survey's CSV file and a description of what each column means, who collected it and under what licence.

Every package has three things at its top:

- **`datapackage.json`**, the **manifest**: a JSON file that describes the dataset (its title, description, creators, licence) and each of its files, down to every column's name, type, description and unit. It follows the [Frictionless Data Package](https://datapackage.org/) standard, with a few added fields whose names start with `archive:`, such as `archive:unit` for a column's unit or `archive:embargoUntil` for a date before which the files stay private.
- **The data files**, usually in a `data/` folder.
- **`checksums.sha256`**: one line per file, each with the file's SHA-256 hash, so anyone can check that no file changed after the package was made. `cruise` writes this file; you never edit it by hand.

`cruise` also writes a **`README.md`** from the manifest, so the package explains itself to someone who opens the folder without any tool.

The repository's [`examples/sample-package`](../../examples/sample-package) is a complete package: invented stream temperature readings from three sites, with a logger table, a code list, site locations as a shapefile, a depth grid and a methods document. Its top looks like this:

```
sample-package/
  datapackage.json
  checksums.sha256
  README.md
  changes.jsonl
  data/logger.csv
  data/logger.xlsx
  data/codes/condition-codes.csv
  data/sites/sites.shp (with .dbf, .prj and .shx)
  data/depth.asc
  data/depth.prj
  docs/methods.md
  docs/site-photo.png
  original/logger-raw.csv
```

Its `_build/` folder holds the script that generated it. `cruise` leaves the top-level `_build` folder, and every hidden file and folder (one whose name starts with a dot, such as `.DS_Store` or `.git/`), out of the package's checks and its `checksums.sha256`. The web app and the plugin upload only the files `checksums.sha256` lists, and the archive refuses a hidden path from any client, so `_build/` and hidden files stay on your computer. If a `checksums.sha256` written by an older `cruise` lists a hidden file, `cruise diagnose` reports `structure.checksums-hidden`; run any `cruise set` and the line is gone.

## Installing cruise

`cruise` is a Python program. Install it with [uv](https://docs.astral.sh/uv/), at a release tag:

```
uv tool install "git+https://github.com/schuettc/research-archive-in-a-box@v0.1.1#subdirectory=packages/tool"
```

`cruise --version` then prints `cruise 0.1.0`. Inside a clone of this repository, `uv run cruise` runs it without installing anything.

`cruise` has three commands:

- `cruise diagnose <folder>` checks one package and says what would stop it being published.
- `cruise audit <folder> [<folder> ...]` finds every package under some folders and ranks them by what needs fixing.
- `cruise set <folder> <field> <value>` changes a field in the manifest and rewrites `README.md` and `checksums.sha256` to match.

## Findings: errors, warnings and notes

A **finding** is one thing `cruise diagnose` noticed about a package, such as "Column battery_v has no description." Each finding has a **severity**:

- an **error** blocks publishing: the archive refuses the package until it is fixed;
- a **warning** is worth fixing, but the package can be published with it;
- a **note** is for information only.

Each finding also names the **rule** that raised it, such as `field.description-missing`, and the part of the package it is about, such as `logger.battery_v` (the `battery_v` column of the `logger` file). The findings are grouped under four questions a reader would ask: the package's structure, whether they can find, cite and reuse it, whether they can understand each column, and whether they can trust the values.

The **score** at the end counts how many of the checks under three of those questions passed, and the **verdict** says whether the package can be published.

A CSV table that can't be parsed is an error, `values.malformed`, and blocks publishing: a file that is not UTF-8, a row with more or fewer cells than the schema has fields, or a quote that is never closed. Nothing else can check such a table, so fix the file first. A table `cruise` leaves unread on purpose, such as one in a format other than CSV, gets the note `values.unreadable` and does not block.

A finding under the heading "Checks that could not run (a fault in cruise, not in your package)" means `cruise` itself failed on that one check, so what the check looks at was not checked. It is an error and blocks publishing, and its rule ends in `.check-failed`, such as `values.check-failed`. Nothing in your data caused it: send the message to the archive's maintainers. Every other check's result still stands.

## Checking the sample package

Copy the sample package somewhere first, so the edits below don't change the repository:

```
mkdir -p /tmp/guide
cp -R examples/sample-package /tmp/guide/sample-package
cd /tmp/guide
cruise diagnose sample-package
```

The output, in full:

```
sample-package

Can I understand each column?
  warning  field.description-missing  logger.battery_v
    Column battery_v has no description.
    fix: Describe what battery_v holds and how it was measured.
  warning  field.description-repeats-name  logger.depth_cm
    Column depth_cm's description only repeats its name.
    evidence: values "depth_cm"
    fix: Say what depth_cm holds, not just its name.
  warning  field.codes-undocumented  logger.qc_flag
    Column qc_flag holds codes with no code list.
    evidence: values "A", "B"
    fix: Add a code list for qc_flag and link it with a foreign key.

Can I trust the values?
  warning  values.constant  logger.logger_model
    Column logger_model holds the same value in every row.
    evidence: rows 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20; values "TL-100"; 60 rows in all
    fix: Move logger_model into the description, or drop it.

Score: 95% (find 5 of 5, understand 42 of 45, trust 32 of 33)
Verdict: publishable, with 4 warnings
```

The sample has four warnings on purpose, so there is something to fix. `cruise diagnose` exits with 0 when the package can be published and 1 when an error blocks it, so a script can use it as a check. `--json` prints the same findings as JSON.

## Fixing a finding with cruise set

`cruise set` changes one field and rewrites the files that depend on the manifest. To describe the `battery_v` column of the `logger` file:

```
cruise set sample-package description "Logger battery voltage at each reading, in volts." --resource logger --column battery_v
```

```
Set logger.battery_v.description.
Wrote datapackage.json, README.md, checksums.sha256 in sample-package.
```

`--resource` names the file (by its `name` in the manifest) and `--column` the column. Diagnosing again shows one warning fewer:

```
Score: 96% (find 5 of 5, understand 44 of 46, trust 32 of 33)
Verdict: publishable, with 3 warnings
```

What `cruise set` can change:

- for the package: `title`, `description`, `keywords`, `licenses`, `contributors`, `archive:rightsStatus`, `archive:temporalCoverage`, `archive:spatialCoverage`, `archive:methods` and `archive:embargoUntil`;
- for a column, with `--resource` and `--column`: its `title`, `description` and `archive:unit`.

The value of a text field (`title`, `description`, `archive:methods`, `archive:embargoUntil`, and a column's `title`, `description` and `archive:unit`) is taken as plain text. Any other value is read as JSON when it parses, so a list or an object is written as JSON, and as plain text otherwise. The value `null` removes the field.

To make many changes at once, write them to a JSON file as a list of edits, each with a `target` and a `value`, plus `resource` and `column` for a column, and pass it with `--file`:

```
cruise set sample-package --file edits.json
```

The edits apply **all or nothing**: each one is checked against the manifest's rules, and if any fails, nothing is written, each failing edit is named, and `cruise` exits with 1. For example, a date that doesn't exist:

```
cruise set sample-package archive:embargoUntil 2025-13-01
```

```
cruise: Nothing was written. edit 1: archive:embargoUntil: Input should be a valid date or datetime, month value is outside expected range of 1-12
```

Some fields have no `cruise set` target, among them the package's `id` (see [Write a first manifest](#1-write-a-first-manifest)), a file's own `title` and `description`, a table's `missingValues` (see [Comment lines and placeholders](#comment-lines-and-placeholders)) and the dataset's **access level** (`archive:access`, described under [Access levels](#access-levels)). Change those in `datapackage.json` with a text editor, then run any `cruise set` so that `checksums.sha256` matches the edited manifest again.

### Rights, dates and places

Three of the package fields take a JSON object, not a line of text. Each is checked when it is set, so a value in the wrong shape is refused and nothing is written.

**`archive:rightsStatus`** states the rights of a package that has no licence, for example data a government agency puts in the public domain. It is an object with a `status` and, for some statuses, a `statement`:

| `status` | Means | `statement` |
| --- | --- | --- |
| `public-domain` | No one holds rights in the data. | optional |
| `third-party` | Someone else sets the terms, such as the agency that first published it. | required: where the terms are set |
| `all-rights-reserved` | The rights holder keeps every right. | required: the rights statement itself |
| `undetermined` | No one knows yet. | optional |

`undetermined` doesn't count as stated rights, so a package with only that status still has the error "The package has no rights". A package with a licence needs no rights status. For example, for data whose terms are set elsewhere, `cruise set <folder> archive:rightsStatus` with this value:

```json
{ "status": "third-party", "statement": "Terms set by the agency that first published the data: https://example.org/terms" }
```

A plain word is refused, because the field needs an object:

```
cruise set sample-package archive:rightsStatus public-domain
```

```
cruise: Nothing was written. edit 1: archive:rightsStatus: Input should be a valid dictionary or instance of RightsStatus
```

And `third-party` with no statement, `'{"status": "third-party"}'`:

```
cruise: Nothing was written. edit 1: archive:rightsStatus: Value error, rights status 'third-party' needs a statement
```

**`archive:temporalCoverage`** is when the data covers: a `start` date, then exactly one of an `end` date, `"end": "unknown"` for data that stopped at a date nobody recorded, or `"ongoing": true` for data still being collected. For example `{"start": "2024-06-03", "end": "2024-06-04"}`, or `{"start": "2024-06-01", "ongoing": true}` as in the sample package. The end can't come before the start.

**`archive:spatialCoverage`** is where the data covers, as a **bounding box**: the smallest rectangle of longitude and latitude (WGS 84, the system GPS uses) that holds every place in the data. It is an object with `bbox`, four numbers in the order west, south, east, north, and an optional `description` in words. For example the sample package's `{"bbox": [-72.74, 44.23, -72.66, 44.32], "description": "Three invented sites along two streams."}`. Longitudes run from -180 to 180 and latitudes from -90 to 90; west may be greater than east for a box that crosses the 180th meridian.

## Making a package from a CSV

This example makes a package for a forest plot survey. Start with a folder and the CSV file in it:

```
mkdir -p plot-survey/data
```

`plot-survey/data/plots.csv`:

```
plot,date,canopy_cover,stems
P01,2024-06-03,72,41
P02,2024-06-03,65,38
P03,2024-06-04,80,52
P04,2024-06-04,58,29
```

### 1. Write a first manifest

`cruise` doesn't write a manifest from nothing, so write a short `plot-survey/datapackage.json` by hand. It gives the package an id and a name, lists the file with a title, says the file is a CSV table, and gives each column a name and a type (`string`, `integer`, `number`, `date`, `datetime`, `boolean` and the other [Frictionless field types](https://datapackage.org/standard/table-schema/#field-types)):

```json
{
  "id": "plot-survey",
  "name": "plot-survey",
  "resources": [
    {
      "name": "plots",
      "path": "data/plots.csv",
      "title": "Plot survey",
      "archive:kind": "table",
      "format": "csv",
      "schema": {
        "fields": [
          { "name": "plot", "type": "string" },
          { "name": "date", "type": "date" },
          { "name": "canopy_cover", "type": "integer" },
          { "name": "stems", "type": "integer" }
        ]
      }
    }
  ]
}
```

In Frictionless, each file is a **resource**: `name` is how the manifest and `cruise set --resource` refer to it, and `path` is where it is in the folder.

`id` is the dataset's address on the archive: this package, submitted through the web app, is published at `/datasets/plot-survey`, and a later package with the same `id` is submitted as its next version. It may hold letters, digits, `-` and `_`, up to 200 characters, and the web app refuses a package without one (the Claude Code plugin instead lets the archive make one from the title, plus six random letters). `cruise diagnose` doesn't check it and `cruise set` can't change it, so write it here by hand.

`"archive:kind": "table"` says the file is a table of rows and columns. A resource with no `archive:kind` counts as a plain file, which `cruise` never opens, so none of its values would be checked: an `abc` in the `stems` column would pass.

`"format": "csv"` says how the table is written. `cruise` reads only CSV tables: a table whose `format` is `csv`, or one with no `format` whose `path` ends in `.csv`. A table with any other `format` isn't read, so its values aren't checked.

### 2. Diagnose it

```
cruise diagnose plot-survey
```

```
plot-survey

Structure
  error  structure.size-hash-missing  plots
    data/plots.csv has no recorded size and hash
  error  structure.checksums-missing  checksums.sha256
    checksums.sha256 is absent

Can I find, cite and reuse it?
  error  package.core-missing  package
    The package has no title, which every published package needs.
    evidence: values "title"
    fix: Give the package a title.
  error  package.core-missing  package
    The package has no description, which every published package needs.
    evidence: values "description"
    fix: Describe the package in at least 50 characters: what, where, when and why.
  error  package.core-missing  package
    The package has no creator, which every published package needs.
    evidence: values "creator"
    fix: Name at least one contributor with the creator role.
  error  package.core-missing  package
    The package has no rights, which every published package needs.
    evidence: values "rights"
    fix: Add a license, or state the rights status if no license can be given.

Can I understand each column?
  warning  field.description-missing  plots.plot
    Column plot has no description.
    fix: Describe what plot holds and how it was measured.
  warning  field.description-missing  plots.date
    Column date has no description.
    fix: Describe what date holds and how it was measured.
  warning  field.description-missing  plots.canopy_cover
    Column canopy_cover has no description.
    fix: Describe what canopy_cover holds and how it was measured.
  warning  field.description-missing  plots.stems
    Column stems has no description.
    fix: Describe what stems holds and how it was measured.
  warning  field.unit-missing  plots.canopy_cover
    Column canopy_cover is a measurement with no unit.
    fix: Set archive:unit on canopy_cover, or mark it nominal or ordinal.
  warning  field.unit-missing  plots.stems
    Column stems is a measurement with no unit.
    fix: Set archive:unit on stems, or mark it nominal or ordinal.

Score: 33% (find 1 of 5, understand 4 of 10, trust 0 of 0)
Verdict: blocks publishing (6)
```

The six errors are the list of work: record the file's size and hash, write the checksums, and give the package a title, a description, a creator and its rights.

### 3. Record the file's size and hash

Each resource records its file's size in bytes and its hash, so the archive can tell if a file changed on the way. You record them by hand here because `cruise set` doesn't: it writes `checksums.sha256`, but a resource's `bytes` and `hash` are not among the manifest fields it can change. Read both:

```
wc -c < plot-survey/data/plots.csv
shasum -a 256 plot-survey/data/plots.csv
```

```
     113
d685a2dcdf5e2a5371f8cd9179bcc2d1f76ed52d4760180095f659ecbb19549a  plot-survey/data/plots.csv
```

On Linux, `sha256sum` gives the same hash. Add both to the resource in `datapackage.json`, with `sha256:` before the hash:

```json
      "bytes": 113,
      "hash": "sha256:d685a2dcdf5e2a5371f8cd9179bcc2d1f76ed52d4760180095f659ecbb19549a"
```

### 4. Fill in the rest with cruise set

The title, as one edit:

```
cruise set plot-survey title "Canopy cover and stem counts on four forest plots"
```

```
Set title.
Wrote datapackage.json, README.md, checksums.sha256 in plot-survey.
```

That run also wrote `checksums.sha256` for the first time. The rest goes in one file, `edits.json`:

```json
[
  { "target": "description", "value": "Canopy cover and the number of tree stems on four permanent forest plots at an invented field station, surveyed in June 2024." },
  { "target": "contributors", "value": [{ "title": "Field Station Survey Team", "roles": ["creator"] }] },
  { "target": "licenses", "value": [{ "name": "CC-BY-4.0", "path": "https://creativecommons.org/licenses/by/4.0/" }] },
  { "target": "description", "resource": "plots", "column": "plot", "value": "The plot's code, P01 to P04." },
  { "target": "description", "resource": "plots", "column": "date", "value": "The day the plot was surveyed." },
  { "target": "description", "resource": "plots", "column": "canopy_cover", "value": "Share of the sky hidden by the canopy, read at the plot centre." },
  { "target": "archive:unit", "resource": "plots", "column": "canopy_cover", "value": "percent" },
  { "target": "description", "resource": "plots", "column": "stems", "value": "Live tree stems wider than 10 cm at breast height inside the plot." },
  { "target": "archive:unit", "resource": "plots", "column": "stems", "value": "dimensionless" }
]
```

A **contributor** is a person or group named in the package; the one with the role `creator` is cited as its author. A person can also carry an `orcid`, their [ORCID iD](https://orcid.org/), and an `organization`. A **licence** says what others may do with the data: here [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/), use with credit.

```
cruise set plot-survey --file edits.json
```

```
Set description, contributors, licenses, plots.plot.description, plots.date.description, plots.canopy_cover.description, plots.canopy_cover.archive:unit, plots.stems.description, plots.stems.archive:unit.
Wrote datapackage.json, README.md, checksums.sha256 in plot-survey.
```

### 5. Diagnose again

```
cruise diagnose plot-survey
```

```
plot-survey

Can I trust the values?
  warning  package.creator-orcid-missing  package
    Field Station Survey Team has no ORCID iD, so their work can't be linked to them for certain.
    evidence: values "Field Station Survey Team"
    fix: Add Field Station Survey Team's ORCID iD (orcid) to their contributor entry.

Score: 96% (find 5 of 5, understand 14 of 14, trust 10 of 11)
Verdict: publishable, with 1 warning
```

The package can be published. The one warning stays because a team has no ORCID iD; naming a person with one as the creator would clear it.

The folder now holds everything the archive needs:

```
plot-survey/
  datapackage.json
  checksums.sha256
  README.md
  data/plots.csv
```

### What the manifest declares is checked

`cruise diagnose` holds each CSV table to what its manifest says about it. Every finding below is an error, so it blocks publishing.

The table's **header row** must hold the schema's field names, spelled exactly (capital letters and spaces count) and in the same order. If it doesn't, the finding is `structure.header-mismatch`, which names the column, what the file calls it and what the manifest calls it, and none of the table's values are checked until it is fixed. A table with no header row says so in its dialect, `"dialect": { "header": false }`, and is then not compared.

A table's `primaryKey` must name fields of that table; one that doesn't is `structure.primary-key`.

A table's foreign keys, and the [constraints](https://datapackage.org/standard/table-schema/#field-constraints) on its columns, are checked against the values in the file. Each finding lists the rows and the values:

| Rule | What it catches |
| --- | --- |
| `values.foreign-key-missing` | Rows whose foreign-key value is not in the column the key points at. |
| `values.required-missing` | Empty cells in a column whose constraints say `required`. |
| `values.not-unique` | Rows that repeat a value in a column whose constraints say `unique`. |
| `values.not-in-enum` | Values that are not in the column's `enum`. |
| `values.below-minimum` | Values below the column's `minimum`. |
| `values.above-maximum` | Values above the column's `maximum`. |
| `values.too-short` | Text values with fewer characters than the column's `minLength`. |
| `values.too-long` | Text values with more characters than the column's `maxLength`. |
| `values.pattern-mismatch` | Text values that don't match the column's `pattern`. |

An empty cell (or one of the table's `missingValues`) breaks only `required`; no other rule reports it. `minimum`, `maximum` and `enum` compare by the column's type, so on a `date` column `2020-06-01` is after `2019-12-31`, and on a `number` column `1e3` equals `1000`. `minimum` and `maximum` are checked on `number`, `integer`, `date`, `datetime`, `time` and `year` columns, and `minLength`, `maxLength` and `pattern` on `string` columns. Foreign keys and `unique` compare the text as written, so `1` and `1.0` are different values.

A `pattern` is read as a DuckDB (RE2) regular expression and must match the whole value: `S[0-9]` matches `S1` but not `S12`. RE2 refuses some escapes that XML Schema patterns allow, such as `\i`. A constraint `cruise` can't apply, such as that pattern or a `minimum` of `0.5` on an `integer` column, is itself reported under the same rule, as "Column a's minimum constraint (0.5) does not read as integer, so it can't be checked."

### Comment lines and placeholders

Many published CSV files start with lines of notes before the header row, each beginning with `#`, such as `# Monthly means from the station's weather mast`. `cruise` refuses a table like that: it reads the first line as the header, so it reports the error `structure.header-mismatch`, "data/plots.csv: column 1 is named "# Monthly means from the station's weather mast" in the file's header row, but the manifest names it 'plot'", and checks none of the table's values. Before you make the package, move those lines out of the CSV file: put what they say in the package's `description` or `archive:methods`, or in a document in the package, and keep the original file in a folder such as `original/`, as the sample package does.

Older data often writes a number such as `-9999` or `-99.99` where a value is missing; that number is a **placeholder**. `cruise diagnose` warns about one with `values.placeholder`, "Column canopy_cover has 1 value that looks like a placeholder for no value." If the number really means "no value", declare it in the table's schema in `datapackage.json` with `missingValues`, next to `fields`: `"missingValues": ["", "-9999"]`. Each entry is the text exactly as it appears in the file. The list replaces the default, which is `[""]` (an empty cell), so keep `""` in it. `cruise set` has no target for `missingValues`, so edit it by hand, then run any `cruise set` so the checksums match again.

### A column that describes another

A column whose values qualify another column's, such as each temperature's uncertainty, says so with `archive:ancillaryOf`, naming the other column and a role: `"archive:ancillaryOf": { "field": "water_temp_c", "role": "uncertainty" }`. The roles are `uncertainty`, `detection-limit` and `quality-flag`; [Terms](../terms.md) explains each and how the archive's EML export records it.

## Profiles and the archive's own rules

A **profile** is a named set of extra required fields. The kit ships two: `core`, which every package meets (a title, a description, a creator, rights and at least one described resource), and `ecology`, which also requires when and where the data was collected and how (`archive:temporalCoverage`, `archive:spatialCoverage` and `archive:methods`). An archive picks its profiles in `archive.yaml` (see [the archive.yaml reference](archive-yaml.md#profiles)), and its submissions are checked against them.

To check a package the way a particular archive will, apply its profiles with `--profile`, or point `cruise` at the archive's config with `--config archive.yaml`:

```
cruise diagnose --profile ecology plot-survey
```

```
plot-survey

Can I find, cite and reuse it?
  error  package.profile-field-missing  package
    The package has no archive:temporalCoverage, which the selected profiles or archive config require.
    evidence: values "archive:temporalCoverage"
    fix: Add archive:temporalCoverage to the manifest.
  error  package.profile-field-missing  package
    The package has no archive:spatialCoverage, which the selected profiles or archive config require.
    evidence: values "archive:spatialCoverage"
    fix: Add archive:spatialCoverage to the manifest.
  error  package.profile-field-missing  package
    The package has no archive:methods, which the selected profiles or archive config require.
    evidence: values "archive:methods"
    fix: Add archive:methods to the manifest.

Can I trust the values?
  warning  package.creator-orcid-missing  package
    Field Station Survey Team has no ORCID iD, so their work can't be linked to them for certain.
    evidence: values "Field Station Survey Team"
    fix: Add Field Station Survey Team's ORCID iD (orcid) to their contributor entry.

Score: 87% (find 5 of 8, understand 14 of 14, trust 10 of 11)
Verdict: blocks publishing (3)
```

[Rights, dates and places](#rights-dates-and-places) gives the shape of each. For the plot survey:

```
cruise set plot-survey archive:temporalCoverage '{"start": "2024-06-03", "end": "2024-06-04"}'
cruise set plot-survey archive:spatialCoverage '{"bbox": [-72.75, 44.25, -72.70, 44.30], "description": "Four permanent plots at an invented field station."}'
cruise set plot-survey archive:methods "Canopy cover read with a spherical densiometer at each plot centre; stems counted inside a 20 m by 20 m square."
cruise diagnose --profile ecology plot-survey
```

```
plot-survey

Can I trust the values?
  warning  package.creator-orcid-missing  package
    Field Station Survey Team has no ORCID iD, so their work can't be linked to them for certain.
    evidence: values "Field Station Survey Team"
    fix: Add Field Station Survey Team's ORCID iD (orcid) to their contributor entry.

Score: 97% (find 8 of 8, understand 14 of 14, trust 12 of 13)
Verdict: publishable, with 1 warning
```

The archive runs the same rules on every submission, from the same code, so a package that `cruise` passes with the archive's profiles passes the archive's checks too.

## Auditing many packages

`cruise audit` finds every folder with a `datapackage.json` under the folders it is given and prints one line per package, those with the most errors and the lowest score first. It does not look inside `_build`, `node_modules` or hidden folders.

```
cruise audit .
```

```
path            errors  warnings  notes  score                                                   most fired
plot-survey     0       1         0      96% (find 5 of 5, understand 14 of 14, trust 12 of 13)  package.creator-orcid-missing
sample-package  0       3         0      96% (find 5 of 5, understand 44 of 46, trust 32 of 33)  field.description-repeats-name
```

"Most fired" is the rule that raised the most findings in that package, which is usually the first thing to fix. `--profile`, `--config` and `--json` work as they do for `diagnose`.

## Access levels

A package's **access level**, `archive:access` in its manifest, says who may download its files once it is published. The description and the columns are public at every level.

| Level | Who can download the files |
| --- | --- |
| `public` | Anyone, with no account. A manifest that names no level is public. |
| `limited` | Anyone signed in to the archive: anyone who makes an account or, on an archive by invitation, the people its team invited. |
| `restricted` | People an admin approves, after they ask for access with a reason. |
| `description-only` | No one: the archive holds the description, not the files. |

An **embargo** holds the files back until a date at any level: `cruise set plot-survey archive:embargoUntil 2026-06-01`. [Curating published datasets](../curating.md#embargoes) explains what readers see while it holds.

## Next

A package that passes is ready to submit: through the archive's web app (see [Using the archive](using-the-archive.md#contributor)) or the Claude Code plugin, which checks and submits from your computer.
