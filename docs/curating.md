# Curating published datasets

How curators and admins look after a dataset once it is published: correcting its details,
withdrawing and restoring it, holding its files back until a date, and seeing how often it is
downloaded. Everything here happens on the archive's own site, signed in, except moving an
embargo's date, which is a `just` recipe.

Who can do what:

| | Curator | Admin |
| --- | --- | --- |
| Correct details | yes | yes |
| Withdraw and restore | | yes |
| Move an embargo's date | | yes |
| The Downloads tab | | yes |

## Correcting details

A curator or admin sees a bar under the dataset page's meta line: "You can correct this dataset's
details." **Correct details** opens a form for the version shown on the page.

- **What can change:** the description, keywords, creators (names, ORCID iDs and affiliations),
  related publications and data, funding and methods. An ORCID iD is checked as you type; an
  affiliation is a name or a ROR address, such as `https://ror.org/03yrm5c26`.
- **What needs a new version:** the files, the version number, the licence and the access level.
  Submit a new version for those.
- **The note:** "What did you correct?" is required. It becomes the line under **Corrections** on
  the dataset page, with the date and the fields that changed.
- **Nothing is lost:** the earlier `datapackage.json` is kept as an S3 version, and a correction
  can itself be corrected. The version's README and `checksums.sha256` are rewritten with it; the
  data files are untouched.
- **One version at a time:** correcting an older version changes only that version. Open the
  version from the page's Versions list first.
- **A withdrawn dataset** can't be corrected: an admin restores it first.

With DOIs on, a correction also updates the DOI's record ([docs/dois.md](dois.md#what-happens-when)).

## Withdrawing and restoring

An admin withdraws a dataset from its page: **Withdraw…** in the curators' bar asks for a reason,
which is shown on the page. A withdrawal covers every version.

- **The page stays.** Each version's address (and its DOI, when it has one) answers with the
  withdrawn page: the title, the citation, the reason and the date, and a note that the files are
  no longer available. Citations of it still lead somewhere.
- **The files stop being served, but are kept.** They are moved out of the public folder, not
  deleted, and the weekly integrity check still covers them. The download route refuses every
  file of a withdrawn dataset, admins included.
- **A link handed out just before the withdrawal works for up to 5 minutes**, the life of a
  signed download link. Withdraw first, then tell anyone who needs to know.
- **It leaves search, the catalog and the sitemap** within a few minutes.
- **Restore… undoes it all.** On the withdrawn page an admin restores it: the files are served
  again within a few minutes, and the dataset returns to search, the catalog and the sitemap.

Each withdrawal and restore is recorded in the account events, with who did it, when and the
reason. With DOIs on, the DOI stays and its record says the dataset was withdrawn and why
([docs/dois.md](dois.md#what-happens-when)).

## Deleting data for good

Withdrawing keeps every file. When that isn't enough (a file holds personal data, or a rights
holder asks for their work to be removed), an admin with AWS access to the stage removes the
dataset by hand: every version of every file, its records and its pages. There is no button or
recipe for it, on purpose, and it can't be undone. The archive bucket is versioned, so deleting
a file only hides it behind a delete marker; each object version has to go by its version id.

1. **Withdraw it first**, from its page. The files stop being served at once, it leaves search,
   and with DOIs on the DOI's record says it was withdrawn. Write a reason that doesn't repeat
   what is being removed: the reason is kept as the record of the withdrawal. Decline any
   submission for the dataset still waiting in review, so nothing publishes it again. Wait until
   the page shows it withdrawn: its files are then under `restricted/<id>/`; a run that failed
   partway can leave some under `open/<id>/`. Publishing also kept each version's files under
   `publishing/<id>/` until the version went live, and the copies deleted from there are still
   stored as object versions. All three are cleared below.

2. **Find the stage's resources.** In a shell signed in to the stage's account, with the stage's
   region (the one `archive.yaml` names, or your default):

   ```bash
   stage=prod; id=<dataset id>; export AWS_REGION=<the stage's region>
   resource() { aws cloudformation list-stack-resources --stack-name "ResearchArchive-$stage" \
       --query "StackResourceSummaries[?ResourceType=='$1' && contains(LogicalResourceId, '$2')].PhysicalResourceId" \
       --output text; }
   archive="$(resource AWS::S3::Bucket StorageArchive)"
   derived="$(resource AWS::S3::Bucket StorageDerived)"
   staging="$(resource AWS::S3::Bucket StorageStaging)"
   distribution="$(resource AWS::CloudFront::Distribution WebDistribution)"
   echo "$archive $derived $staging $distribution"
   ```

3. **List every object version and delete marker** under the three prefixes, and read the list
   before deleting anything:

   ```bash
   for prefix in "open/$id/" "restricted/$id/" "publishing/$id/"; do
       aws s3api list-object-versions --bucket "$archive" --prefix "$prefix" \
           --query "[Versions, DeleteMarkers][].[Key, VersionId]" --output text
   done | grep -v '^None$' > versions.txt
   cat versions.txt
   ```

   Use the trailing slash: `open/$id` without it would also match a dataset whose id starts
   with this one's.

4. **Delete each version.** With write-once locking on (`objectLock` in `archive.yaml`), the
   versions are locked in governance mode, and deleting one needs `--bypass-governance-retention`
   and the `s3:BypassGovernanceRetention` permission. Without locking, set `bypass=` instead.

   ```bash
   bypass=--bypass-governance-retention
   while IFS=$'\t' read -r key version; do
       aws s3api delete-object --bucket "$archive" --key "$key" --version-id "$version" $bypass
       echo "deleted $key $version"
   done < versions.txt
   ```

   Run step 3's listing again: it should print nothing.

5. **Delete its records.** The catalog has two tables, A and B, and holds the dataset under
   `PK = DATASET#<id>` in each; the download counts, access requests and usage answers are keyed
   by the dataset id; its submissions name it in `datasetId`, and each submission's review
   events are keyed by the submission id.

   ```bash
   for table in CatalogA CatalogB; do
       name="$(resource AWS::DynamoDB::Table "Tables$table")"
       aws dynamodb query --table-name "$name" --key-condition-expression "PK = :pk" \
           --expression-attribute-values "{\":pk\": {\"S\": \"DATASET#$id\"}}" \
           --query "Items[].[PK.S, SK.S]" --output text |
       while IFS=$'\t' read -r pk sk; do
           aws dynamodb delete-item --table-name "$name" \
               --key "{\"PK\": {\"S\": \"$pk\"}, \"SK\": {\"S\": \"$sk\"}}"
       done
   done
   for pair in TablesDownloadCounts:month TablesAccess:userId ReadApiUsageResponses:entry; do
       table="${pair%%:*}" sort="${pair##*:}"
       name="$(resource AWS::DynamoDB::Table "$table")"
       aws dynamodb query --table-name "$name" --key-condition-expression "datasetId = :id" \
           --expression-attribute-values "{\":id\": {\"S\": \"$id\"}}" \
           --query "Items[].$sort.S" --output text | tr '\t' '\n' | grep -v '^None$' |
       while read -r value; do
           aws dynamodb delete-item --table-name "$name" \
               --key "{\"datasetId\": {\"S\": \"$id\"}, \"$sort\": {\"S\": \"$value\"}}"
       done
   done
   submissions="$(resource AWS::DynamoDB::Table TablesSubmissions)"
   reviews="$(resource AWS::DynamoDB::Table TablesReviews)"
   for sid in $(aws dynamodb scan --table-name "$submissions" --filter-expression "datasetId = :id" \
       --expression-attribute-values "{\":id\": {\"S\": \"$id\"}}" \
       --query "Items[].submissionId.S" --output text); do
       for key in $(aws dynamodb query --table-name "$reviews" \
           --key-condition-expression "submissionId = :sid" \
           --expression-attribute-values "{\":sid\": {\"S\": \"$sid\"}}" \
           --query "Items[].eventKey.S" --output text); do
           aws dynamodb delete-item --table-name "$reviews" \
               --key "{\"submissionId\": {\"S\": \"$sid\"}, \"eventKey\": {\"S\": \"$key\"}}"
       done
       aws dynamodb delete-item --table-name "$submissions" \
           --key "{\"submissionId\": {\"S\": \"$sid\"}}"
       aws s3 rm --recursive "s3://$staging/reports/$sid/"
       aws s3 rm --recursive "s3://$staging/held/$sid/"
       echo "deleted submission $sid"
   done
   ```

   The account events (who withdrew it, when and why) stay, as the record that it was removed.

6. **Delete its pages** from the derived bucket, then clear CloudFront's copies of the files and
   the pages. The `/data/*` files are cached under `/<id>/...`.

   ```bash
   aws s3 rm --recursive "s3://$derived/site/datasets/$id/"
   aws cloudfront create-invalidation --distribution-id "$distribution" \
       --paths "/$id/*" "/datasets/$id" "/datasets/$id/*"
   ```

   To keep a page that says the dataset was removed (for a DOI, or citations of it), skip the
   `aws s3 rm` and leave the withdrawn page, provided its title, citation and reason hold none of
   what is being removed.

7. **Reindex**, so the catalog file, the search index and the sitemap are rebuilt without it:
   `just reindex <stage>`, then `just reindex-status <stage>` until it has finished and its result shows the
   load `COMPLETED`.

What this leaves: the withdrawal record under `state/<id>/` in the archive bucket, with the
reason, who withdrew it and when; the operational tables keep point-in-time recovery for 35 days, so a restore
within that window would bring the deleted items back; the site's logs under the derived bucket's
`logs/` keep the file paths that were requested. With DOIs on, a findable DOI can't be deleted:
it stays registered, and resolves to the withdrawn page if you kept it, or to a 404 if not.

## Embargoes

An embargo keeps a dataset's files back until a date while the rest of it is public at once.

- **Setting one:** before submitting, set the date in the package with
  `cruise set <folder> archive:embargoUntil YYYY-MM-DD`, or ask the Claude Code plugin to set it
  (its `edit_manifest` tool). The curator sees the date in review.
- **While it holds:** the page, description, columns and citation (and the DOI, when there is one)
  are public. The page says "Files available from <date>", and each file shows the date instead of
  a Download button. The download route refuses the files whatever the access level.
- **When it ends:** the files are released from the date, in UTC. A daily run at 00:15 UTC moves
  the files of every embargo that has ended and rewrites their pages. After that the dataset's
  access level applies as usual.
- **Moving the date:** an admin runs `just set-embargo <stage> <id> <YYYY-MM-DD>`, which signs in
  in the browser and calls the admin route. A later date holds the files again; giving today's date
  lifts the embargo. Each move is recorded in the account events and listed under **Corrections**
  as "Embargo moved to <date>".

## Downloads

Each dataset's page shows its total downloads in the meta line, for every reader. It is left out
while the dataset is embargoed or withdrawn, and until its first download.

Admins see the counts per dataset per month in **Settings › Downloads**:

- **What is counted:** public files from the site's logs, once a day, so a download shows the next
  day; limited and restricted files when a download link is given out.
- **Months:** the last 3 months, the last 12 months or all time. On a phone each dataset is a card.
- **Download as CSV:** one row per dataset, `id,title,access`, then a column per month oldest
  first, then the total, for reports.
