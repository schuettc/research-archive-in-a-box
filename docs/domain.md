# A custom domain

A stage can answer on its own name, such as `data.example.org`, instead of CloudFront's
`d1234abcd.cloudfront.net`. It is **off by default**: a stage with no `domain` block deploys
exactly as it does without this feature. The name's DNS must be in a Route 53 public hosted zone;
a domain whose DNS is elsewhere isn't supported yet.

## What it does

Give a stage a `domain` block in `archive.yaml` (the `deploy-archive` skill asks about it and
writes it):

```yaml
infrastructure:
  stages:
    - name: prod
      region: us-east-2
      domain:
        name: data.example.org
        hostedZoneId: Z0123456789ABCDEF
```

- `name`: the site's address, in lower case, with no trailing dot and no wildcard.
- `hostedZoneId`: the Route 53 public hosted zone that holds the name, in the stage's account.
  Use the bare `Z…` id, not `/hostedzone/Z…`.

With it, the deploy:

- Makes a certificate for the name in a stack of its own, `ResearchArchive-<stage>-Certificate`,
  always in us-east-1. CloudFront only takes certificates from ACM in us-east-1, whatever region
  the rest of the stage is in
  ([CloudFront's requirements](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cnames-and-https-requirements.html)).
  ACM validates it by DNS, writing one `_….<name>` CNAME into the hosted zone.
- Puts the name and the certificate on the stage's CloudFront distribution, and adds two alias
  records for the name in the zone: `A` for IPv4 and `AAAA` for IPv6. It only adds records: it
  never edits or deletes the zone's other records, and if the name already has an `A` or `AAAA`
  record the deploy fails and rolls back without changing anything.
- Uses the name everywhere the archive writes its own address: the dataset pages, citations and
  versioned identifiers, `sitemap.xml` and `robots.txt`, the passkey relying party, the links the
  API gives for public downloads, and the invitation email, which now says where to sign in.
- Keeps CloudFront's own address answering. On it, the site's pages answer with a permanent
  redirect (301) to the same path and query on the name, so old links land on the right page;
  `/api/*` and `/data/*` keep answering on both addresses.

The stack's `SiteDomain` output becomes the name, and a `DistributionDomain` output gives
CloudFront's own address.

## What's needed first

- A public hosted zone in Route 53, in the stage's AWS account, that holds the name.
- The stage's `region` in `archive.yaml`: the certificate is made in us-east-1 and read from the
  stage's region, so the config refuses a `domain` without one.
- CDK bootstrapped in us-east-1 too, when the stage is in another region:

  ```
  cd packages/infra && npx cdk bootstrap aws://<account>/us-east-1
  ```

  CI's deploy role may already use CDK's roles in any region; it needs them to exist there.

## What it costs

ACM charges nothing for a public certificate, and Route 53 charges nothing for alias queries to
CloudFront. The hosted zone's own monthly charge is already yours.

## Moving an archive that already has readers

Every address the archive writes changes, so plan the move:

1. With DOIs on, first add the name to the DataCite repository's **Domains** setting (see
   [docs/dois.md](dois.md)); DataCite refuses a DOI whose URL the repository's domains don't
   allow.
2. Add the `domain` block and deploy (push to `main`; CI deploys). For the few minutes the deploy takes to put the name on the distribution, page requests on CloudFront's address are already sent to the name, which doesn't answer yet; `/api` and `/data` keep working. Deploy at a quiet time.
3. Run `just reindex <stage>`. It rewrites every dataset page, `catalog.json` and the sitemap on
   the name. With DOIs on, run `just reindex <stage> --dois` instead: it does the same and
   re-sends every DOI's record with its URL on the name.
4. Tell readers. Old links keep working: CloudFront's address still answers and sends the site's
   pages to the name. Published versions keep the address they were published with inside their
   archived `datapackage.json` (it is checksummed and isn't rewritten), but their pages, the
   catalog, the sitemap and DOI records all move to the name.
5. Passkeys belong to the address they were made on, so after the move a reader's passkey no
   longer works. Each reader signs in with their password once on the name and adds a passkey
   again.

## Changing the name

A new name needs a new certificate, and CloudFormation won't change a certificate another stack is using in one deploy. Remove the domain (below), deploy, then add the new one and deploy again.

## Removing a domain

A stage with `email: ses` must drop it in the same change or earlier, since SES sends from the domain; see
[docs/email.md](email.md).

1. Take the `domain` block out of the stage in `archive.yaml` (keep its `region`) and deploy. That
   takes the name off the distribution and removes the two alias records; the site is back on
   CloudFront's address.
2. Delete the certificate stack, which the deploy no longer manages. Read its validation record's
   name first, since that record stays in the zone after the certificate goes (ACM writes it,
   and CloudFormation doesn't delete it):

   ```
   arn="$(aws cloudformation list-stack-resources --region us-east-1 --stack-name ResearchArchive-<stage>-Certificate --query "StackResourceSummaries[?ResourceType=='AWS::CertificateManager::Certificate'].PhysicalResourceId" --output text)"
   aws acm describe-certificate --region us-east-1 --certificate-arn "$arn" --query "Certificate.DomainValidationOptions[0].ResourceRecord.Name" --output text
   aws cloudformation delete-stack --region us-east-1 --stack-name ResearchArchive-<stage>-Certificate
   aws cloudformation wait stack-delete-complete --region us-east-1 --stack-name ResearchArchive-<stage>-Certificate
   ```

   ACM can take a while to notice that CloudFront no longer uses the certificate. Until it does, the delete waits, and the stack's events say the certificate "is in use". It finishes on its own; if the stack ends in `DELETE_FAILED`, run the `delete-stack` again.

3. Delete that `_….<name>` CNAME from the zone, with the name from step 2:

   ```
   aws route53 change-resource-record-sets --hosted-zone-id <zone-id> --change-batch "$(aws route53 list-resource-record-sets --hosted-zone-id <zone-id> --query "ResourceRecordSets[?Name=='<cname>' && Type=='CNAME'] | [0]" --output json | jq '{Changes: [{Action: "DELETE", ResourceRecordSet: .}]}')"
   ```

4. Run `just reindex <stage>` (with DOIs on, `just reindex <stage> --dois`) to move the pages,
   the sitemap and DOI records back to CloudFront's address.
5. As with a move, readers sign in with their password once and add a passkey again.

`just destroy <stage>` deletes the certificate stack too, after the stage's stack, and prints the
command that removes the validation record.
