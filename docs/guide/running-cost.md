# Running cost

This page lists what an archive's stage bills for in your AWS account, and what stays near zero while no one uses it. It gives no dollar figure: none has been measured on a running archive yet, and AWS's prices differ by Region and change over time. To estimate one, put the services below into the [AWS Pricing Calculator](https://calculator.aws/) with your own expected use.

Two terms first. A **request** is one call a browser or program makes, such as loading a page or downloading a file; most of the services below bill per request. **Transfer** is the data sent out to readers, billed per gigabyte; downloading a 1 GB dataset ten times is 10 GB of transfer.

## What costs money

Each stage is its own stack, so each stage bills separately: a `dev` stage beside `prod` roughly doubles what sits idle.

### Per use

These grow with how much the archive is used, and are near zero when no one uses it:

- **Amazon CloudFront**, which serves the site, the dataset pages and the public files: per request and per gigabyte of transfer. Downloads of large datasets are usually the biggest item of a busy archive.
- **AWS Lambda**, which runs the API, the checks on each submission, publishing, the reindex and the scheduled jobs: per call and per second of running time. Checking a large submission runs longest.
- **Amazon API Gateway**, the API behind the web app: per request.
- **Amazon DynamoDB**, which holds the catalog, the submissions, the settings, the download counts and the access requests: billed on demand, per read and per write, with nothing reserved.
- **Amazon Cognito**, which holds the accounts: free up to its free tier of monthly active users, then per active user.
- **Amazon Bedrock**, only with the semantic search module (`infrastructure.modules.embeddings`): per call to the embedding model, once for each dataset published or reindexed, and once for each search that has search words.
- **Amazon SES**, only with `email: ses` on a stage: per email sent (sign-up codes, invitations, password resets).

### While idle

These bill whether or not anyone uses the archive:

- **Amazon S3 storage** for the published files and every earlier version of them (the archive bucket keeps versions), the uploads waiting in review, the generated dataset pages and download zips, and CloudFront's request logs, which are deleted after 90 days. With the object lock module on, locked versions can't be deleted early, so they bill until their lock ends.
- **DynamoDB storage**, and the continuous backups (point-in-time recovery) kept for the operational tables.
- **Amazon CloudWatch**: one alarm per function and on the API's server errors, the stage's dashboard, and the functions' logs, kept for a month.
- **AWS WAF**, only with the WAF module on: the web ACL and its rules bill monthly, plus a charge per request it inspects.
- **Amazon Route 53**, only with a domain: the hosted zone bills monthly, though the zone is yours and may hold more than the archive.
- **The scheduled jobs**: a daily count of downloads from the logs, a daily release of ended embargoes, and a weekly integrity check that reads the recorded checksum of every published file. They run whether or not anyone visits, and the weekly check's S3 requests grow with the number of files.
- **The CDK bootstrap stack**, made once per account and Region by the first deploy: a small S3 bucket of deploy assets.

The rest is free or close to it at an archive's scale: the SNS topics that send alerts, the Systems Manager parameters that hold the config and the DataCite password, the certificate for a domain, and the deploy role.

## Keeping an eye on it

`infrastructure.monthlyBudgetUsd` in `archive.yaml` sets an AWS budget, 50 US dollars unless you change it. AWS Budgets emails `infrastructure.alertEmail` when the month's actual spend passes 80% of it and again at 100%. It is a warning, not a limit: nothing is switched off when it is passed. The budget covers the whole AWS account, not just the archive, so an account that runs other things needs a higher figure.

AWS Cost Explorer, in the AWS console, breaks the bill down by service. Every resource of a stage is in the `ResearchArchive-<stage>` stack, so the services above are where to look.

## Lowering it

- Tear down a stage you aren't using with `just destroy <stage>` ([Deploying](deploying.md#tearing-down-a-stage)). A stage named `prod` keeps its buckets, tables and user pool, which go on billing for storage until you delete them by hand.
- Leave the optional modules off unless you need them: WAF bills monthly while it is on, and semantic search bills per search.
- Large files cost the most in transfer. A dataset whose files few people need can be `limited` or `restricted`, so only signed-in or approved readers download them.
