# Email through SES

A stage with its own domain can send its account emails (sign-up codes, invitations and password
resets) through Amazon SES from `no-reply@<domain>`. It is **off by default**: a stage with no
`email` setting keeps Cognito's own email and deploys exactly as it does without this feature.

## Off by default

Add `email: ses` beside the stage's `domain` block in `archive.yaml` (the `deploy-archive` skill
asks about it and writes it):

```yaml
infrastructure:
  stages:
    - name: prod
      region: us-east-2
      domain:
        name: data.example.org
        hostedZoneId: Z0123456789ABCDEF
      email: ses
```

It needs:

- A `domain` (see [docs/domain.md](domain.md)): SES sends from the domain, and the deploy writes
  its records into the domain's hosted zone. The config refuses `email` without one.
- A region where Cognito can use SES in its own Region. These ten can't, and the config refuses
  `email: ses` there for now: Canada West (Calgary) `ca-west-1`, Mexico (Central)
  `mx-central-1`, Asia Pacific (Hong Kong) `ap-east-1`, (Malaysia) `ap-southeast-5`, (Thailand)
  `ap-southeast-7`, (Hyderabad) `ap-south-2`, (Melbourne) `ap-southeast-4`, Europe (Zurich)
  `eu-central-2`, (Spain) `eu-south-2`, and Middle East (UAE) `me-central-1`
  ([Cognito's email settings](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-email.html),
  "Amazon SES email configuration Regions").

## What it changes

Sign-up codes, invitations and password resets come from `<brand name> <no-reply@<domain>>`,
such as `Lake Archive <no-reply@data.example.org>`, through the account's own SES, instead of
from Cognito's `no-reply@verificationemail.com`. Cognito's daily cap on its own email no longer
applies; SES's sending limits do. The text of the emails doesn't change. Replies go nowhere:
nothing receives mail at `no-reply@<domain>`.

## The records it writes

The deploy makes the domain an SES identity with Easy DKIM and writes three
`<token>._domainkey.<domain>` CNAMEs into the hosted zone. It only adds those: it never edits or
deletes the zone's other records, and removing `email` deletes the three.

It writes no MAIL FROM records and no DMARC record. DMARC passes when either SPF or DKIM aligns
with the From domain, and with Easy DKIM the signature's domain is the From domain, so DKIM
aligns ([SES and DMARC](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dmarc.html)).
An archive whose parent domain publishes a strict DMARC policy (`p=reject` with `adkim=s`) is
still fine, since the signature's domain is exactly the From domain. One that also wants SPF to
align can add a custom MAIL FROM domain (an MX and an SPF TXT record on a subdomain) by hand.

## The first deploy waits

Cognito refuses an SES identity SES hasn't verified, and SES verifies the domain once it finds the
three records. So the deploy waits for that before it points the user pool at SES: usually a few
minutes, at most 55 minutes. After that it fails and rolls back, leaving the archive's email as
it was.

If it fails, check the records and SES's view of the identity, then deploy again:

```
dig +short CNAME <token>._domainkey.<domain>
aws sesv2 get-email-identity --email-identity <domain> --query "{verified:VerifiedForSendingStatus,dkim:DkimAttributes.Status}"
```

The three record names are in the stage's stack (its `AWS::Route53::RecordSet` resources) and in
`get-email-identity`'s `DkimAttributes.Tokens`. Each `dig` should print a value ending in
`dkim.amazonses.com`.

## SES's sandbox

SES puts every account in a sandbox, once per account and Region. In it, SES sends only to
addresses and domains verified in SES, at most 200 messages a day and one a second, so Cognito
can't email the archive's people. Check:

```
aws sesv2 get-account --region <region> --query ProductionAccessEnabled
```

When it says `false`, request production access once for the account and Region: in the SES
console, open the Account dashboard, choose **View Get set up page**, then **Request production
access**, with mail type **Transactional** and the site's URL; or:

```
aws sesv2 put-account-details --region <region> --production-access-enabled --mail-type TRANSACTIONAL --website-url https://<domain> --additional-contact-email-addresses <you> --contact-language EN
```

AWS answers within 96 hours
([Request production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)).
Until then, invite only addresses verified in SES: run
`aws sesv2 create-email-identity --region <region> --email-identity <address>`, then click the
link SES sends to that address.

## Checking the mail is signed

Open a received invitation's original (or raw headers) and look for:

- `dkim=pass header.d=<domain>` and `dmarc=pass` in `Authentication-Results`;
- `From: <brand name> <no-reply@<domain>>`.

## What it costs

SES charges per message sent ([SES pricing](https://aws.amazon.com/ses/pricing/)). The identity
and the three records cost nothing beyond the hosted zone you already pay for.

## Turning it off

Remove `email: ses` from the stage and deploy. The user pool goes back to Cognito's own email
first, then the identity and its three records are deleted.

To remove the stage's domain too, remove `email` in the same change or earlier: the config refuses
`email` without a domain. See [docs/domain.md](domain.md#removing-a-domain).

## What isn't covered yet

- Emails the archive would send itself: to a submitter on a review decision, and to a
  requester on an access decision. The archive doesn't send either yet, through SES or
  otherwise; the submitter and the requester see the decision on the site.
- Stages in the ten Regions without SES, which would need an identity in another Region.
