# DOIs

The archive can give each published version a DOI from [DataCite](https://datacite.org/). The
module is **off by default**: with no `doi` block in `archive.yaml`, publishing, corrections,
withdrawals, restores and the reindex never call DataCite, and the stack deploys exactly as it
does without it.

With it on, publishing a version registers a findable DOI for it, the dataset page and the
citation show the DOI's address, and the DOI's record follows the version's corrections,
withdrawal and restore.

## Not yet tried against DataCite

The module is tested against a stand-in for DataCite's REST API. Its records (a new version, a
correction that removes the funding, and a withdrawal) are checked against DataCite's
[Metadata Schema 4.5](https://datacite-metadata-schema.readthedocs.io/en/4.5/) in
[Invenio's JSON Schema](https://github.com/inveniosoftware/datacite) for it (DataCite publishes
only an XML Schema, and points to Invenio's for JSON), and by tests of the schema's mandatory
properties. No DataCite account was available to try it for real. So an archive turning it on should start
with `test: true` on DataCite's test system, publish one dataset, check that its DOI resolves to
the dataset's page, and only then go live. Registering sends `PUT /dois/{id}`, which DataCite's
[update docs](https://support.datacite.org/docs/updating-metadata-with-the-rest-api) say creates
the DOI when the name is free, rather than `POST /dois`; so the first thing to check on the test
system is that one publish registers its DOI. Please report problems in the repo's
[issues](https://github.com/schuettc/research-in-a-box/issues).

## Turning it on

Add a `doi` block to `archive.yaml` (the `deploy-archive` skill asks about it and writes it):

```yaml
doi:
  repository: EXAMPLE.IRC # the DataCite repository id
  prefix: "10.5072"
  test: true # DataCite's test system; false for live DOIs
```

- `repository`: the DataCite repository id, the Account ID DataCite sends with the account.
- `prefix`: the repository's DOI prefix, shown in DataCite Fabrica. Quote it, so YAML keeps it as
  text.
- `test`: `true` (the default) uses DataCite's test system; `false` registers live DOIs.

The repository's password never goes in `archive.yaml`: see [The password](#the-password).

The `doi` block is archive-wide: every stage registers DOIs with it unless the stage sets its
own. Keep `test: true` and the test account in the archive-wide block, and give only the
production stage a `doi` of its own with `test: false` and the live account:

```yaml
infrastructure:
  stages:
    - name: dev # registers test DOIs with the archive-wide block
    - name: prod
      doi:
        test: false # live DOIs from this stage only
        repository: LIVE.IRC # the live repository id
        prefix: "10.12345" # the live repository's prefix
```

A stage's `doi` takes `test` and, optionally, `repository` and `prefix`; each it sets replaces
the archive-wide value for that stage alone, and it needs the archive-wide `doi` block. A live
findable DOI registered from a test stage would point at the test site for good, since it can
never be deleted.

## Getting a DataCite account

Start on DataCite's test system. Test and live are separate systems with separate accounts,
passwords and prefixes, at `https://api.test.datacite.org` and `https://api.datacite.org`
([Create DOIs with the REST API](https://support.datacite.org/docs/api-create-dois)).

1. Ask for a test Repository account: a DataCite Direct Member or Consortium Lead creates one in
   Fabrica Test (`https://doi.test.datacite.org`), or DataCite support (support@datacite.org)
   creates one for a potential member
   ([Getting a test account](https://support.datacite.org/docs/getting-a-test-account)).
2. The account arrives as an email with a Generate password link. Set the password. The Account
   ID in the same email is the `repository` above.
3. Sign in to Fabrica Test and copy the repository's prefix: the `prefix` above.
4. In the repository's settings, check that **Domains** allows the archive's site domain (or
   `*`). DataCite refuses a DOI whose URL the repository's domains don't allow
   ([Update settings in Fabrica](https://support.datacite.org/docs/fabrica-settings),
   [Why is my URL not allowed?](https://support.datacite.org/docs/repository-domain-filter)).

## The password

The password is an SSM Parameter Store SecureString at
`/research-archive/<stage>/datacite-password`, in each stage's own account and region. It is
never in `archive.yaml`, the repo, Secrets Manager, a log or a chat. Only the functions that call
DataCite may read it, and only when the module is on.

Store it from your own terminal, signed in to the stage's account and region; the password is
read without being echoed:

```
read -rs PW && aws ssm put-parameter --name /research-archive/<stage>/datacite-password --type SecureString --value "$PW" --overwrite; unset PW
```

Check it is there without reading it:

```
aws ssm describe-parameters --parameter-filters Key=Name,Values=/research-archive/<stage>/datacite-password
```

To rotate it, set a new password in Fabrica and run the same `put-parameter --overwrite`. The
next call to DataCite uses it; nothing needs redeploying.

## The DOI and where it shows

A version's DOI is `<prefix>/<repository id, lower-cased>.<dataset id>.v<version>`; for
`EXAMPLE.IRC`, version 1 of `stream-temperature` is `10.5072/example.irc.stream-temperature.v1`.
It resolves to the version's own page, `https://<site>/datasets/<id>/v<version>`.

The version's `archive:identifier` holds the DOI's address: `https://doi.org/<doi>`, or with
`test: true` `https://handle.test.datacite.org/<doi>`. Test DOIs resolve only through DataCite's
test handle server, never through `https://doi.org`
([Testing guide](https://support.datacite.org/docs/testing-guide)). The address shows as the
Identifier on the dataset page, in its schema.org metadata and in the citation.

The DOI's record is the archive's DataCite export of the version's manifest: creators with their
ORCID iDs and ROR affiliations, title, publisher (the archive's `publisher`), year, descriptions,
keywords, dates, places, rights, related identifiers, funding and formats.

## What happens when

- **Publish.** After the version's files and page are written, the publish registers its DOI in
  the findable state, writes the address into the version's `datapackage.json` (and its line in
  `checksums.sha256`; the data files and README are untouched), and rewrites the catalog and the
  pages to show it. Before registering, it reads the DOI: one that already points to another
  address (another stage on the same repository) is never overwritten.
- **Correction.** After the correction is written, the DOI's record is re-sent with the corrected
  details. Every list is sent whole, so a removed field (funding, say) is removed on DataCite too
  ([Updating metadata with the REST API](https://support.datacite.org/docs/updating-metadata-with-the-rest-api)).
- **Withdrawal.** The DOI stays findable and still resolves to the version's page, which now
  answers withdrawn. Its record gains a description, "Withdrawn on <date>: <reason>".
- **Restore.** The record is re-sent without that description.

A DataCite failure never blocks or undoes a publish, a correction, a withdrawal or a restore.

## When DataCite fails

A publish retries the DataCite call with backoff, then emails the alerts address ("DOI not
registered: <id> v<n>") and finishes: the version is published without a DOI. A correction,
withdrawal or restore retries twice and then emails the alerts address, leaving DataCite's record
behind the archive.

Both are mended by one command, once DataCite answers:

```
just reindex <stage> --dois
```

It registers a DOI for every version still missing one (except versions of a withdrawn dataset),
re-sends the record of every version that has one, and rebuilds the catalog and pages. Versions
DataCite still refuses are named in one alert; follow the run with `just reindex-status <stage>`.

## A findable DOI is for good

A findable DOI can never be deleted or returned to a draft
([DOI states](https://support.datacite.org/docs/doi-states)). That is why the archive is built
and tried on DataCite's test system, and why a withdrawal keeps the DOI and answers with the
withdrawn page.

## Going live

1. Get a DataCite membership (directly or through a consortium) and a live Repository account
   with its own prefix and password.
2. Give the production stage its own `doi` with `test: false` and the live `repository` and
   `prefix`, as above, and leave the archive-wide `doi` block on the test system, so the other
   stages keep registering test DOIs.
3. Store the live password at `/research-archive/<stage>/datacite-password` as above.
4. Deploy, then run `just reindex <stage> --dois`. Versions holding test DOIs count as missing a
   DOI under the live settings, so they get live ones; the test DOIs stay on the test system.
