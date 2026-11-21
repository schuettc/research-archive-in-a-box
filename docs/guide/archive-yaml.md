# The archive.yaml reference

`archive.yaml`, at the root of your fork, is the one file that makes the archive yours: its name, the rules its packages must meet, how it looks, and where it is deployed. This page lists every field it can hold.

The fields come from the archive contract's JSON Schema, [`packages/web/src/schema/archive-contract.schema.json`](../../packages/web/src/schema/archive-contract.schema.json), under `$defs.ArchiveConfig` and the definitions it refers to. The schema is generated from the contract's Python models in [`packages/contract/src/archive_contract/config.py`](../../packages/contract/src/archive_contract/config.py), and a test in `scripts/tests/` fails when the schema has a field this page doesn't list, so the two can't drift apart.

## How to read this page

YAML nests one block inside another by indenting it. Each entry below names a field by its **path**: the names of the blocks it sits in, joined by dots. `brand.privacy` is the `privacy` field inside the `brand` block:

```yaml
brand:
  privacy: We keep your email address to sign you in.
```

`[]` in a path means the block is a list, and the field belongs to each item of it. `infrastructure.stages[].region` is the `region` of each stage in the `stages` list:

```yaml
infrastructure:
  stages:
    - name: dev
      keepData: false
      region: eu-west-1
    - name: prod
      region: eu-west-1
```

Each entry gives the field's **type** (text, a number, true or false, a list or a block), its **default** (what applies when you leave it out) and an example.

A **stage** is one deployment of the archive, such as `dev` or `prod`: its own AWS stack, site, accounts and data. One `archive.yaml` can describe several stages, and CI deploys them in the order they are listed.

## A complete example

```yaml
publisher: Invented Research Cooperative
profiles: [core, ecology]
brand:
  intro: >-
    The Invented Research Cooperative shares the data behind its field studies.
  contact: archive-admin@example.org
  logo: examples/brand/logo.svg
  favicon: examples/brand/favicon.svg
  primaryColor: "#24395f"
doi:
  repository: EXAMPLE.IRC
  prefix: "10.5072"
submissions:
  maxPackageGiB: 9
infrastructure:
  alertEmail: archive-admin@example.org
  monthlyBudgetUsd: 50
  stages:
    - name: dev
      keepData: false
      region: eu-west-1
    - name: prod
      region: eu-west-1
      domain:
        name: data.example.org
        hostedZoneId: Z0123456789ABCDEFGHIJ
      email: ses
      doi:
        test: false
        repository: EXAMPLE.LIVE
        prefix: "10.12345"
```

## Checking your file

The deploy refuses a file that breaks the schema, naming each problem. To check it before you push, run this from the repository's root:

```
uv run python -c "from pathlib import Path; from archive_contract.config import load_config; print(load_config(Path('archive.yaml')))"
```

It prints the config when it is valid, and an error naming the field when it isn't. It also checks that the `brand.logo` and `brand.favicon` files exist and are allowed. `just stages` then prints the stages it found.

The blocks inside the top level refuse a field they don't know, so a misspelled `infrastructure.alertEmial` is an error rather than a setting silently ignored. The top level itself accepts and ignores a field it doesn't know.

The whole config, as JSON, has to fit in 4 KB, the size of the AWS Systems Manager parameter each stage stores it in; the deploy says so when it doesn't. `brand.privacy` doesn't count towards the 4 KB: the parameter leaves it out, since only the web app shows it and the web build reads it from `archive.yaml`.

## The archive

### `publisher`

The organisation that publishes the archive's datasets. It is filled in as every published dataset's publisher, appears in citations and DOI records, and is the archive's name wherever `brand.name` is not set.

- **Type:** text. Required.
- **Default:** none; the file is invalid without it.

```yaml
publisher: Invented Research Cooperative
```

### `profiles`

The profiles every submission is checked against. A **profile** is a named set of extra required fields, shipped with the kit: `core` (a title, a description, a creator, rights and at least one described resource) and `ecology` (also when, where and how the data was collected: `archive:temporalCoverage`, `archive:spatialCoverage` and `archive:methods`). [Packages and cruise](packages.md#profiles-and-the-archives-own-rules) shows what each adds to a package's check.

- **Type:** a list of profile names.
- **Default:** `[core]`.

```yaml
profiles: [core, ecology]
```

### `required`

Fields every submission must have, beyond those its profiles require. Each must be a field the manifest knows: `title`, `description`, `creator`, `rights`, `resources`, `keywords`, `contributors`, `archive:temporalCoverage`, `archive:spatialCoverage`, `archive:relatedIdentifiers`, `archive:funding` or `archive:methods`.

- **Type:** a list of field names.
- **Default:** an empty list: the profiles alone decide.

```yaml
required: [keywords, archive:funding]
```

## Reserved, not enforced yet

The four settings in this section, `vocabularies`, `themes`, `licenses` and `access`, are reserved for later use. The contract validates them, so a mistake in one is still an error, but no part of the kit reads them: setting one changes nothing about what the archive accepts, shows or offers.

### `vocabularies`

Controlled vocabularies for manifest fields: a **vocabulary** is an agreed list of terms for a field, such as the keywords a community uses. Each item names one. Submissions are not checked against it.

- **Type:** a list of blocks, each with the four fields below.
- **Default:** an empty list.

```yaml
vocabularies:
  - field: keywords
    name: LTER Controlled Vocabulary
    url: https://vocab.lternet.edu/
```

### `vocabularies[].field`

The manifest field the vocabulary is for.

- **Type:** text. Required in each item.
- **Default:** none.

```yaml
vocabularies:
  - field: keywords
    name: Station keywords
```

### `vocabularies[].name`

The vocabulary's name.

- **Type:** text. Required in each item.
- **Default:** none.

```yaml
vocabularies:
  - field: keywords
    name: LTER Controlled Vocabulary
```

### `vocabularies[].url`

Where the vocabulary is published, when it is published elsewhere.

- **Type:** text (an address).
- **Default:** none.

```yaml
vocabularies:
  - field: keywords
    name: LTER Controlled Vocabulary
    url: https://vocab.lternet.edu/
```

### `vocabularies[].terms`

The vocabulary's terms, when you list them here instead of pointing at a published one.

- **Type:** a list of text.
- **Default:** an empty list.

```yaml
vocabularies:
  - field: keywords
    name: Station keywords
    terms: [canopy, stems, soil moisture]
```

### `themes`

The archive's themes, such as `hydrology` or `forest`. A package's own themes, in its manifest's `archive:themes`, are what the review policy's rules and named reviewers match (see [Using the archive](using-the-archive.md#admin)).

- **Type:** a list of text.
- **Default:** an empty list.

```yaml
themes: [hydrology, forest, snow]
```

### `licenses`

The licences the archive offers its contributors. A package may carry any licence, whatever this list says.

- **Type:** a list of text (licence ids, such as `CC-BY-4.0`).
- **Default:** an empty list.

```yaml
licenses: [CC-BY-4.0, CC0-1.0]
```

### `access`

The access levels the archive offers, from `public`, `limited`, `restricted` and `description-only` ([Packages and cruise](packages.md#access-levels) says what each means). A package may use any of the four, whatever this list says.

- **Type:** a list of access levels.
- **Default:** all four.

```yaml
access: [public, limited]
```

## How the archive looks: brand

### `brand`

How the archive presents itself on its site, on the sign-in page and in the invitation email. Leave it out and the archive uses the publisher's name, the kit's colours and fonts, no logo and the kit's default privacy page.

- **Type:** a block of the fields below.
- **Default:** none.

```yaml
brand:
  contact: archive-admin@example.org
  primaryColor: "#2f5d3a"
```

### `brand.name`

The archive's name, as the site's title, in its header and on the sign-in page, when it differs from the publisher's.

- **Type:** text, 1 to 120 characters.
- **Default:** `publisher`.

```yaml
brand:
  name: Cooperative Data Archive
```

### `brand.intro`

A short paragraph under the heading of the Browse page, saying what the archive holds.

- **Type:** text, 1 to 600 characters.
- **Default:** none: the Browse page has no intro.

```yaml
brand:
  intro: >-
    The Invented Research Cooperative shares the data behind its field studies: streams, lakes,
    snow and the land around them.
```

### `brand.contact`

An email address readers can write to. It appears in the footer, on the privacy page, on a dataset's page, and on the page that tells a signed-in person they lack the role a page needs.

- **Type:** text, an email address.
- **Default:** none: those places say to ask the archive's admins.

```yaml
brand:
  contact: archive-admin@example.org
```

### `brand.logo`

The archive's logo, as a path relative to `archive.yaml`. It appears in the site's header, on the sign-in page and on each dataset's static page.

- **Type:** text, a path to a `.svg` or `.png` file of at most 200 KB. An SVG may not contain `<script>` or `<foreignObject>`, event-handler attributes, `role` or `aria-*` attributes, since the sign-in page refuses them.
- **Default:** none: the header shows the name alone.

```yaml
brand:
  logo: examples/brand/logo.svg
```

### `brand.favicon`

The small icon a browser shows in its tab, as a path relative to `archive.yaml`. The sign-in page uses it too.

- **Type:** text, a path to a `.svg` or `.ico` file of at most 200 KB, with the same SVG limits as the logo.
- **Default:** none: the browser's own.

```yaml
brand:
  favicon: examples/brand/favicon.svg
```

### `brand.primaryColor`

The colour of buttons, links and the focus ring, on the site and the sign-in page. The kit works out the darker and lighter shades it needs from this one colour.

- **Type:** text, a colour as `#` and six hexadecimal digits. Quote it, since YAML reads `#` as the start of a comment.
- **Default:** `"#24395f"`, a dark blue.

```yaml
brand:
  primaryColor: "#2f5d3a"
```

### `brand.font`

The font of the site's headings, as a CSS font-family list: font names separated by commas, the first one available being used.

- **Type:** text, 1 to 300 characters of letters, digits, spaces, commas, quotes and hyphens.
- **Default:** a serif list starting with Iowan Old Style, ending with `Georgia, serif`.

```yaml
brand:
  font: "Source Serif 4, Georgia, serif"
```

### `brand.privacy`

The text of the archive's privacy page at `/privacy`, in place of the kit's default. The default says what the kit itself keeps: request logs with IP addresses for 90 days to count downloads, an account's email address and name, a submission's contributor, and the reason given with an access request. Write your own when your archive keeps more, or answers to rules the default doesn't mention.

- **Type:** text, 1 to 2,500 characters. Plain text only: no HTML or Markdown is read. A blank line starts a new paragraph.
- **Default:** none: the kit's default page, filled in with `brand.name` and `brand.contact`.

```yaml
brand:
  privacy: |
    The Invented Research Cooperative keeps your email address so you can sign in.

    Write to archive-admin@example.org to see or delete what we hold about you.
```

## Submissions: submissions

### `submissions`

What the archive takes as a submission. Leave it out and the archive takes the largest package it can.

- **Type:** a block of the field below.
- **Default:** a block with the default below.

```yaml
submissions:
  maxPackageGiB: 9
```

### `submissions.maxPackageGiB`

The largest package the archive takes, as the total size of its files in GiB. A larger package is refused before anything is uploaded. The function that checks a package has its disk sized from this number at deploy, so a change takes effect at the next deploy. Whatever the number, each file may be at most 5 GiB and a package may hold at most 1,000 files.

- **Type:** a whole number from 1 to 9.
- **Default:** `9`, the most a package can be.

```yaml
submissions:
  maxPackageGiB: 4
```

## DOIs: doi

A **DOI** (Digital Object Identifier) is a permanent address for a dataset, such as `https://doi.org/10.5072/example`, that keeps working if the archive moves. The archive can register one for each published version through [DataCite](https://datacite.org/), which needs a DataCite repository account. [DOIs](../dois.md) explains getting an account, the test and live systems, and what happens at each publish, correction and withdrawal. The repository's password never goes in this file: the deploy skill stores it in AWS Systems Manager for each stage.

### `doi`

Turns DOIs on for every stage. Leave it out and no stage calls DataCite.

- **Type:** a block of the fields below.
- **Default:** none: DOIs are off.

```yaml
doi:
  repository: EXAMPLE.IRC
  prefix: "10.5072"
```

### `doi.repository`

The DataCite repository id, the Account ID DataCite gives with the account.

- **Type:** text, two parts joined by a dot, such as `EXAMPLE.IRC`. Required in the block.
- **Default:** none.

```yaml
doi:
  repository: EXAMPLE.IRC
  prefix: "10.5072"
```

### `doi.prefix`

The repository's DOI prefix, shown in DataCite Fabrica. Every DOI the archive registers starts with it.

- **Type:** text, `10.` and four to nine digits. Quote it, so YAML keeps it as text rather than a number. Required in the block.
- **Default:** none.

```yaml
doi:
  repository: EXAMPLE.IRC
  prefix: "10.5072"
```

### `doi.test`

Whether every stage uses DataCite's test system rather than the live one. Keep it `true` here: a stage that should register live DOIs, such as `prod`, says so in its own [`infrastructure.stages[].doi`](#infrastructurestagesdoi) block, so no other stage can register a live DOI, which can never be deleted.

- **Type:** true or false.
- **Default:** `true`.

```yaml
doi:
  repository: EXAMPLE.IRC
  prefix: "10.5072"
  test: true
```

## Where it is deployed: infrastructure

### `infrastructure`

Where and how the archive is deployed. `cruise --config` reads a file without it, but the deploy refuses one: every deployed archive needs at least `alertEmail`.

- **Type:** a block of the fields below.
- **Default:** none.

```yaml
infrastructure:
  alertEmail: archive-admin@example.org
```

### `infrastructure.alertEmail`

The address that hears when something needs attention: a function's errors, the API's server errors, semantic search failing, and the monthly budget. The alarms reach it through an Amazon SNS topic, which sends a confirmation email after the first deploy: no alarm arrives until the link in it is clicked. The budget's emails come from AWS Budgets and need no confirmation.

- **Type:** text, an email address. Required in the block.
- **Default:** none.

```yaml
infrastructure:
  alertEmail: archive-admin@example.org
```

### `infrastructure.monthlyBudgetUsd`

A monthly AWS budget in US dollars. AWS Budgets emails `alertEmail` when the month's actual spend passes 80% and again at 100% of it. It is a warning, not a limit: nothing stops when it is passed. It covers the whole AWS account, not just this archive. [Running cost](running-cost.md) says what costs money.

- **Type:** a whole number above 0.
- **Default:** `50`.

```yaml
infrastructure:
  alertEmail: archive-admin@example.org
  monthlyBudgetUsd: 100
```

### `infrastructure.requestsPerAddressPerFiveMinutes`

With the WAF on, how many API requests one address may make in five minutes. Past it, that address is refused until its count falls again; other addresses are not affected. A campus or an office can share one address, so keep it well above one person's use. It is unused with [`modules.waf: false`](#infrastructuremoduleswaf).

- **Type:** a whole number, 10 or more.
- **Default:** `2000`.

```yaml
infrastructure:
  alertEmail: archive-admin@example.org
  requestsPerAddressPerFiveMinutes: 1000
```

### `infrastructure.stages`

The stages to deploy, in order: CI deploys the first, then the next only if the first succeeded. Each stage becomes a CloudFormation stack named `ResearchArchive-<name>`.

- **Type:** a list of at least one stage block. Stage names must be unique.
- **Default:** one stage named `prod`.

```yaml
infrastructure:
  alertEmail: archive-admin@example.org
  stages:
    - name: dev
      keepData: false
    - name: prod
```

### `infrastructure.stages[].name`

The stage's name, which names its stack (`ResearchArchive-<name>`), its GitHub environment and its parameters. The name decides nothing else: whether a stage's data is kept is [`keepData`](#infrastructurestageskeepdata).

- **Type:** text: a lowercase letter, then up to 19 lowercase letters, digits or hyphens. Required in each stage.
- **Default:** none.

```yaml
infrastructure:
  alertEmail: archive-admin@example.org
  stages:
    - name: walk-test
```

### `infrastructure.stages[].keepData`

Whether the stage's data outlives its stack. A stage that keeps its data has its buckets, tables, user pool and logs left in place when its stack is deleted, with the tables and user pool protected from deletion; they go on billing for storage until you delete them by hand. A stage with `keepData: false` is disposable: tearing it down deletes everything, data included. It also has two test conveniences a kept stage never has: uploads from a local web app at `http://localhost:5199`, and a sign-in client for the end-to-end test (`just ingest-e2e`).

To delete a kept stage whole, set `keepData: false`, let CI deploy it, then tear it down.

- **Type:** `true` or `false`.
- **Default:** `true`.

```yaml
infrastructure:
  alertEmail: archive-admin@example.org
  stages:
    - name: dev
      keepData: false
    - name: prod
```

### `infrastructure.stages[].selfSignUp`

Whether anyone can create an account on the stage. With `true`, the sign-in page offers **Create an account**, and a new account has no role. With `false`, accounts come only from an invitation (`just invite-user`, or **Settings › People**), and the sign-in page says accounts are by invitation.

With `false`, `limited` means the people you invited: a limited dataset's files can be downloaded only by accounts your team made.

On a public stage with sign-up on, set [`email: ses`](#infrastructurestagesemail): Cognito's own email stops at about 50 a day, and sign-up codes, invitations and password resets share it. The WAF limits how fast one address can ask for emails.

- **Type:** `true` or `false`.
- **Default:** `true`.

```yaml
infrastructure:
  alertEmail: archive-admin@example.org
  stages:
    - name: prod
      selfSignUp: false
```

### `infrastructure.stages[].account`

The 12-digit id of the AWS account the stage deploys into. A stage in another account needs its own deploy access, set up while signed in to that account (see [Deploying](deploying.md#3--connect-github-to-aws)), and `just destroy` refuses to run while you are signed in to a different account.

- **Type:** text, 12 digits. Quote it.
- **Default:** none: the account CI's deploy role is in.

```yaml
infrastructure:
  alertEmail: archive-admin@example.org
  stages:
    - name: prod
      account: "111122223333"
      region: eu-west-1
```

### `infrastructure.stages[].region`

The AWS Region the stage deploys into, such as `eu-west-1`. The `just` recipes that work on a stage use it too.

- **Type:** text, a Region code.
- **Default:** none: the Region the stage's GitHub environment names (its `AWS_REGION` variable), and on your laptop your AWS profile's Region.

```yaml
infrastructure:
  alertEmail: archive-admin@example.org
  stages:
    - name: prod
      region: eu-west-1
```

### `infrastructure.stages[].domain`

The stage's own address, such as `data.example.org`, in place of the CloudFront address it gets otherwise (`d1234abcd.cloudfront.net`). It needs a Route 53 public hosted zone for the name in the stage's account, and a `region` on the stage. The deploy adds a certificate in us-east-1 (in its own stack, `ResearchArchive-<name>-Certificate`) and alias records for the name; it changes no other record in the zone. [A custom domain](../domain.md) explains moving and removing one.

- **Type:** a block of the two fields below.
- **Default:** none: the stage answers on its CloudFront address.

```yaml
infrastructure:
  alertEmail: archive-admin@example.org
  stages:
    - name: prod
      region: eu-west-1
      domain:
        name: data.example.org
        hostedZoneId: Z0123456789ABCDEFGHIJ
```

### `infrastructure.stages[].domain.name`

The site's address, inside the hosted zone below.

- **Type:** text, a lowercase domain name of at most 253 characters. Required in the block.
- **Default:** none.

```yaml
      domain:
        name: data.example.org
        hostedZoneId: Z0123456789ABCDEFGHIJ
```

### `infrastructure.stages[].domain.hostedZoneId`

The id of the Route 53 public hosted zone that holds the name, in the stage's account: the bare `Z...` id, not `/hostedzone/Z...`.

- **Type:** text, `Z` and up to 31 uppercase letters or digits. Required in the block.
- **Default:** none.

```yaml
      domain:
        name: data.example.org
        hostedZoneId: Z0123456789ABCDEFGHIJ
```

### `infrastructure.stages[].email`

`ses` sends the stage's account emails (sign-up codes, invitations and password resets) through Amazon SES from `no-reply@<domain>`, with DKIM records added to the domain's hosted zone. It needs a `domain`, and isn't supported in the ten Regions where Cognito can't send through SES in its own Region. Without it, Cognito sends them itself, with a low daily cap of about 50, so set it on a public stage with sign-up on ([`selfSignUp`](#infrastructurestagesselfsignup)). [Email through SES](../email.md) explains SES's sandbox and production access.

- **Type:** the text `ses`.
- **Default:** none: Cognito's own email.

```yaml
    - name: prod
      region: eu-west-1
      domain:
        name: data.example.org
        hostedZoneId: Z0123456789ABCDEFGHIJ
      email: ses
```

### `infrastructure.stages[].doi`

This stage's own DOI settings, over the archive-wide [`doi`](#doi) block, which must be there too. Its use is going live on one stage: DataCite's test and live systems are separate accounts, so the production stage names its live repository and prefix with `test: false`, while every other stage keeps the test system. Its password is its own already, at `/research-archive/<stage>/datacite-password` in the stage's account.

- **Type:** a block of the three fields below.
- **Default:** none: the stage uses the archive-wide `doi` block as it is.

```yaml
    - name: prod
      doi:
        test: false
        repository: EXAMPLE.LIVE
        prefix: "10.12345"
```

### `infrastructure.stages[].doi.test`

This stage's `doi.test`. `false` registers live DOIs from this stage only.

- **Type:** true or false. Required in the block.
- **Default:** none.

```yaml
      doi:
        test: false
        repository: EXAMPLE.LIVE
        prefix: "10.12345"
```

### `infrastructure.stages[].doi.repository`

This stage's DataCite repository id: the live account's, on a stage with `test: false`.

- **Type:** text, as [`doi.repository`](#doirepository).
- **Default:** none: the archive-wide `doi.repository`.

```yaml
      doi:
        test: false
        repository: EXAMPLE.LIVE
        prefix: "10.12345"
```

### `infrastructure.stages[].doi.prefix`

This stage's DOI prefix: the live repository's, on a stage with `test: false`.

- **Type:** text, as [`doi.prefix`](#doiprefix). Quote it.
- **Default:** none: the archive-wide `doi.prefix`.

```yaml
      doi:
        test: false
        repository: EXAMPLE.LIVE
        prefix: "10.12345"
```

### `infrastructure.modules`

The optional parts of every stage: the WAF is built unless it is switched off here, the others only when they are switched on.

- **Type:** a block of the fields below.
- **Default:** the WAF on, the others off.

```yaml
infrastructure:
  alertEmail: archive-admin@example.org
  modules:
    waf: false
```

### `infrastructure.modules.waf`

On unless it is `false`. It puts one AWS WAF web ACL in front of the stage's API and its sign-in: AWS's managed rule groups for common attacks, known bad inputs and addresses with a poor reputation, rate limits on sign-up, sign-in and the calls that send email, and a limit on the API requests one address may make ([`requestsPerAddressPerFiveMinutes`](#infrastructurerequestsperaddressperfiveminutes)). With it on, the API answers only requests that come through the site's address. A web ACL bills monthly whether or not it is used ([Running cost](running-cost.md)).

`false` turns it off for every stage in the file: a stage without it shares one allowance of 50 requests a second among all its callers.

- **Type:** true or false.
- **Default:** `true`.

```yaml
  modules:
    waf: false
```

### `infrastructure.modules.objectLock`

Write-once locking of the archive bucket, which holds every published file. With it on, each file version is locked in S3's governance mode for the number of days given: it can't be overwritten or deleted in that time except by someone with the `s3:BypassGovernanceRetention` permission, as [deleting data for good](../curating.md#deleting-data-for-good) describes.

- **Type:** a block with the one field below.
- **Default:** none: no locking.

```yaml
  modules:
    objectLock:
      retentionDays: 3650
```

### `infrastructure.modules.objectLock.retentionDays`

How many days each file version stays locked after it is written.

- **Type:** a whole number above 0. Required in the block.
- **Default:** none.

```yaml
    objectLock:
      retentionDays: 3650
```

### `infrastructure.modules.embeddings`

Semantic search: search by meaning as well as by words, so a search for "stream warming" can find a dataset described as "river temperature". With it on, each published dataset gets an **embedding** (a list of numbers that stands for what its description means), made by an Amazon Bedrock model, stored in a vector index on the catalog tables, and every search combines its word matches with the nearest datasets by meaning. When semantic search fails, search falls back to words alone and an alarm tells `alertEmail` once it keeps happening. Each embedding is a Bedrock call ([Running cost](running-cost.md)).

- **Type:** a block with the one field below. An empty block (`embeddings: {}`) switches it on.
- **Default:** none: search by words alone.

```yaml
  modules:
    embeddings: {}
```

### `infrastructure.modules.embeddings.model`

The Bedrock model that makes the embeddings. There is one choice today.

- **Type:** the text `amazon.titan-embed-text-v2:0`.
- **Default:** `amazon.titan-embed-text-v2:0`.

```yaml
  modules:
    embeddings:
      model: amazon.titan-embed-text-v2:0
```
