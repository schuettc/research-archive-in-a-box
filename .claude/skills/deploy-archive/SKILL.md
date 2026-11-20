---
name: deploy-archive
description: For the person running a research archive from a fork of research-archive-in-a-box. Use to set up a deployment of the fork in their own AWS account (prerequisites, archive.yaml, connecting GitHub Actions to AWS, the first deploy, the first admin, the seed dataset and a smoke test), to update the fork from upstream and redeploy, or to tear a stage down.
---

# Deploy the archive

This skill sets up, updates and tears down a deployment of this fork. It is for the person who
runs the archive, not for researchers or curators.

Ground rules:

- **CI deploys archive stacks; you never do.** Never run `cdk deploy` on a `ResearchArchive-*`
  stack. You push to `main` and CI deploys each stage in `archive.yaml` order. The only stack you
  deploy from the laptop is `ResearchArchiveDeploy`, the GitHub-to-AWS connection.
- **✋ means stop.** At a ✋ step, say what will happen and what it costs or changes, then wait for
  the words the step names. Anything else is a no: answer questions, change nothing, and ask again.
- The recipes you call: `just stages`, `just invite-user`, `just set-roles`, `just set-embargo`,
  `just seed`, `just smoke`, `just reindex`, `just destroy`, `just check`. Run them from the
  repo's root. `just set-roles <stage> <email> <roles>` makes a person's roles exactly the
  comma-separated list given (`contributor`, `curator`, `admin`; `""` removes every role).
  `just set-embargo <stage> <dataset id> <YYYY-MM-DD>` moves a dataset's embargo to a date (today
  lifts it), as an admin. It and `just seed` open the archive's own sign-in page in a new browser
  tab: the admin signs in there and presses **Sign in the command line**. Say the tab is coming.

Choose the part the person asked for: **Setup**, **Update** or **Teardown**.

## Setup

### 1. Prerequisites

Check each, say what is missing and how to install it, and go no further until all are there:

- `uv --version` ([install](https://docs.astral.sh/uv/getting-started/installation/)),
  `node --version` is 24 or later, `just --version` ([install](https://just.systems/)).
- The AWS CLI is signed in: run `aws sts get-caller-identity`, show the account and the ARN, and
  ask: "Is this the AWS account the archive should live in?" A no means they sign in to the right
  one (`aws sso login --profile <name>` and `export AWS_PROFILE=<name>`, or `aws configure`).
  Note the region: `aws configure get region`.
- gh is signed in: `gh auth status`.
- The clone's `origin` is their own fork on GitHub: `git remote get-url origin` must not be
  `schuettc/research-archive-in-a-box`. Note `<owner>/<name>` from it.
- Actions is on for the fork: `gh api repos/<owner>/<name>/actions/permissions --jq .enabled` is
  `true`. If not, they turn it on under the fork's Settings → Actions.

Then run `uv sync --all-packages` and `npm ci`.

### 2. The config

Read the settings from the JSON Schema, never from memory, so a setting a later change adds
reaches you with no edit here: `packages/web/src/schema/archive-contract.schema.json`,
`$defs.ArchiveConfig` and the definitions it refers to (`Infrastructure`, `Stage`, `Modules`,
`ObjectLock`, `Vocabulary` and the rest). Each property's `description` and `default` are what you
tell the person.

1. Ask about the archive first: the publisher's name, the alert email (budget and failure alerts
   go there), the monthly budget in US dollars, the profiles, the licenses offered and the access
   levels offered. The access levels are `public` (anyone downloads the files), `limited` (any
   signed-in account downloads them), `restricted` (an admin approves each person's request) and
   `description-only` (the page and its description are published, with no files).
2. Then walk through every other setting, one at a time, with its default, and keep the default
   unless they want something else. The WAF is on unless they set `waf: false`: say it costs
   about $12 a month per stage, and that with `false` every caller of a stage shares one
   allowance of 50 requests a second. The other optional modules (such as object lock) are off
   unless they switch them on; say what each adds.
3. When you reach `brand`, say that every archive has a privacy page at `/privacy`, linked from
   the footer, which says what the archive keeps about the people who use it (request logs kept
   90 days, an account's email and name, a submitter's name, an access request's reason). The
   kit's default text fills in the brand's `name` and `contact`. Ask: "Should the privacy page
   say something of your own? The default is the kit's text." A yes writes it into
   `brand.privacy`, reading its `description` from `$defs.Brand`: plain text, paragraphs
   separated by blank lines.
4. After the other settings, ask: "Should the archive give each published version a DOI? It
   needs a DataCite repository account; the default is no." A no leaves the `doi` block out. A
   yes asks for the test repository id and its prefix, reading each field's `description` from
   `$defs.Doi`, and writes them in the archive-wide `doi` block with `test: true`. Never write
   `test: false` in the archive-wide block: every stage would then register live DOIs, and a
   live DOI from a test stage points at that stage for good, since it can never be deleted.
   Never ask for the password here: Setup's step 4 (DataCite password) stores it. Point them to `docs/dois.md` for getting
   an account.
5. Keep the one `prod` stage unless they ask for another, such as `dev` listed before `prod`. A
   stage in another AWS account gets its own `account` (and `region`).

   For each stage other than the one that holds the real archive, ask: "Should this stage keep
   its data when it is torn down? The default is yes." A no writes `keepData: false` on it,
   reading the field's `description` from `$defs.Stage`: the stage is then deleted whole when
   torn down, and it alone gets the local upload origin and the end-to-end sign-in client. Never
   write `keepData: false` on the stage that holds the real archive.

   With DOIs on, ask for each stage: "Should this stage register test DOIs or live ones? The
   default is test." A test stage needs nothing more. For a live stage (usually `prod` alone),
   ask for the live repository id and its prefix, and write the stage's own `doi` block, reading
   each field's `description` from `$defs.StageDoi`:

   ```yaml
   - name: prod
     doi:
       test: false
       repository: LIVE.IRC
       prefix: "10.12345"
   ```

6. Then, for each stage, ask: "Should this stage have its own domain? It needs a public Route 53
   hosted zone in the stage's account; the default is no." A no leaves the stage's `domain`
   block out. A yes asks for the name and the hosted zone's id, reading each field's
   `description` from `$defs.Domain`, and needs the stage's `region` (ask for it if the stage
   names none). When that region isn't us-east-1, step 3 bootstraps us-east-1 too. Point them to
   `docs/domain.md` for what it changes.

   Right after a yes, ask: "Should this stage's account emails (sign-up codes, invitations,
   password resets) come from no-reply@<name> through Amazon SES? The default is no, which keeps
   Cognito's own email, capped per day." Read `email`'s `description` from `$defs.Stage`. A no
   leaves `email` out. A yes writes `email: ses` on the stage, after checking the stage's region
   isn't one of the ten `docs/email.md` lists, where it isn't supported yet. Point them to
   `docs/email.md` for what it changes.

   Then, for each stage, ask: "Should anyone be able to create an account on this stage? The
   default is yes." Read `selfSignUp`'s `description` from `$defs.Stage`. A no writes
   `selfSignUp: false` on the stage; say that `limited` then means the people they invite. A yes
   leaves `selfSignUp` out; on a stage the public will reach, recommend `email: ses`, since
   Cognito's own email stops at about 50 a day and sign-up codes share it with invitations and
   password resets.

7. Write `archive.yaml` and validate it before going on:

   ```
   uv run python -c "from pathlib import Path; from archive_contract.config import load_config; print(load_config(Path('archive.yaml')))"
   ```

   On an error, fix it with them and validate again. `just stages` then prints the stages.

### 3. ✋ Connect GitHub to AWS

**What it does.** Deploys the `ResearchArchiveDeploy` stack into their AWS account: GitHub's OIDC
provider (unless the account already has one, which it then uses and leaves alone) and one IAM
deploy role. The role trusts only this fork's GitHub environments named for the stages
(`repo:<owner>/<name>:environment:<stage>`) and may only assume CDK's bootstrap roles. It also
bootstraps CDK in the account and region if that hasn't been done (a `CDKToolkit` stack with an
S3 bucket), and creates one GitHub environment per stage holding the role's ARN and the region,
which only `main` may deploy from.

**What it costs.** The provider and role cost nothing. The CDK bootstrap bucket bills for the
little it stores.

Before creating the role, say two things. Anyone who can push to `main`, or change the workflow
there, can run code with the deploy role, and that role can do anything in the AWS account: write
access to `main` is admin of the account. So recommend an AWS account that holds nothing but the
archive, and write access to `main` only for people they would give the account to.

**Wait for:** "connect it" (or a clear yes).

Then, for the account and region of the stages (run it once more against each other account a
stage names, signed in to that account):

1. If `aws cloudformation describe-stacks --stack-name CDKToolkit` fails, bootstrap:

   ```
   cd packages/infra && npx cdk bootstrap aws://<account>/<region>
   ```

   When a stage in this account has a `domain` and a region other than us-east-1, its certificate
   is made in us-east-1, so check and bootstrap there too:
   `aws cloudformation describe-stacks --region us-east-1 --stack-name CDKToolkit`, and if it
   fails, `cd packages/infra && npx cdk bootstrap aws://<account>/us-east-1`. Say this adds a
   second bootstrap stack (and its bucket) in us-east-1.

   When a stage in this account has `email: ses`, run
   `aws sesv2 get-account --region <region> --query ProductionAccessEnabled` for its region.
   When it is `false`, say that until AWS grants SES production access the archive can only email
   addresses verified in SES, so sign-up codes and invitations reach no one else. Offer either:
   - ✋ requesting production access, a request to AWS under their name and contact address
     (**wait for** a clear yes, with the contact address to give):
     `aws sesv2 put-account-details --region <region> --production-access-enabled --mail-type TRANSACTIONAL --website-url https://<name> --additional-contact-email-addresses <address> --contact-language EN`.
     AWS answers within 96 hours; or
   - verifying the first admin's address in SES for now:
     `aws sesv2 create-email-identity --region <region> --email-identity <address>`, then they
     click the link SES sends.

2. Check whether the account already has GitHub's OIDC provider (IAM allows only one, and
   another project's GitHub Actions deploys may have made it):

   ```
   aws iam get-open-id-connect-provider --open-id-connect-provider-arn arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com --query ClientIDList --output text
   ```

   - It answers `NoSuchEntity`: there is none. Deploy without the flag below.
   - It lists `sts.amazonaws.com`: use it. Add `-c githubOidcProvider=existing` to the deploy
     (and later to the teardown), and tell them the provider belongs to something else and
     stays.
   - It lists client ids without `sts.amazonaws.com`: stop. Say the existing provider doesn't
     accept STS, and that adding it to that provider is their call, since something else owns
     it.

3. Read the subject GitHub sends for this repo. New repos use immutable subjects, which carry
   the owner's and repo's numeric ids, and the role must trust exactly what GitHub sends:

   ```
   gh api repos/<owner>/<name>/actions/oidc/customization/sub
   ```

   - It has `sub_claim_prefix` (such as `repo:<owner>@<id>/<name>@<id>`): pass it as
     `-c githubSubPrefix=<that value>` to the deploy and later to the teardown.
   - It says `"use_default": true` with no `sub_claim_prefix`: pass nothing; the role trusts
     `repo:<owner>/<name>`.
   - It says `"use_default": false` (a custom subject template): stop. Say the repo uses a
     custom subject that the deploy role doesn't support yet.

4. Deploy the connection, with the flags steps 2 and 3 gave:

   ```
   cd packages/infra && npx cdk --app "npx tsx bin/deploy-access.ts" deploy -c githubRepo=<owner>/<name> -c githubSubPrefix=<prefix> --require-approval never
   ```

5. Read the role's ARN:

   ```
   aws cloudformation describe-stacks --stack-name ResearchArchiveDeploy --query "Stacks[0].Outputs[?OutputKey=='DeployRoleArn'].OutputValue" --output text
   ```

6. For each stage in that account, create its environment so that only `main` can deploy from
   it, then set its two variables (the stage's own `region`, or the profile's region when the
   stage names none). The branch rule matters: the role trusts any workflow run in the stage's
   environment, so without it a push to any branch whose workflow names `environment: prod`
   could assume the role and deploy.

   ```
   gh api -X PUT repos/<owner>/<name>/environments/<stage> --input - <<< '{"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}'
   gh api -X POST repos/<owner>/<name>/environments/<stage>/deployment-branch-policies -f name=main -f type=branch
   gh api -X POST repos/<owner>/<name>/environments/<stage>/variables -f name=AWS_DEPLOY_ROLE_ARN -f value=<role-arn>
   gh api -X POST repos/<owner>/<name>/environments/<stage>/variables -f name=AWS_REGION -f value=<region>
   ```

   A branch policy that already exists answers with an error; that is fine. A variable that
   already exists is changed with
   `gh api -X PATCH repos/<owner>/<name>/environments/<stage>/variables/<NAME> -f name=<NAME> -f value=<value>`.

Tell them that to require an approval before `prod` deploys, they add a required reviewer to the
`prod` environment in the fork's Settings → Environments; no code changes.

### 4. ✋ DataCite password

Only when `archive.yaml` has a `doi` block; otherwise go on to step 5.

**What it does.** The DataCite repository's password goes into SSM Parameter Store as a
SecureString at `/research-archive/<stage>/datacite-password`, in each stage's own account and
region. A stage on the test system stores the test repository's password; a live stage stores
the live repository's. Never in the chat, never in `archive.yaml` or the repo, never in Secrets Manager. The
archive's functions read it only when they call DataCite.

**What it costs.** A standard-tier SecureString under the AWS-managed `aws/ssm` key costs nothing
to store.

For each stage, the person runs this in their own terminal, signed in to the stage's account and
region, so the password never reaches this session (it reads the password without echoing it):

```
read -rs PW && aws ssm put-parameter --name /research-archive/<stage>/datacite-password --type SecureString --value "$PW" --overwrite; unset PW
```

**Wait for:** "stored". Then check it is there without reading its value:

```
aws ssm describe-parameters --parameter-filters Key=Name,Values=/research-archive/<stage>/datacite-password
```

It should list one parameter of type `SecureString`. If it lists none, they run the command again
in the right account and region.

### 5. ✋ Deploy

**What it does.** Commits `archive.yaml`, pushes to `main`, and CI deploys each stage in order
after the checks pass, then smoke-tests it.

With a stage that has a `domain`, also say: the deploy writes into the hosted zone the stage
names, and only adds records there (ACM's validation CNAME for the certificate, and an `A` and an
`AAAA` alias for the name); it never edits or deletes the zone's other records. It adds the stack
`ResearchArchive-<stage>-Certificate` in us-east-1.

With a stage that has `email: ses`, also say: the deploy writes three DKIM CNAMEs
(`<token>._domainkey.<name>`) into the same zone, waits for SES to verify the domain (minutes, up
to 55; after that it fails and rolls back), and then the stage's account emails come from
`no-reply@<name>`.

**What it costs.** Say what bills while the archive sits idle: storage in S3 and DynamoDB, the
CloudWatch alarms and dashboard, retained logs, and the WAF web ACL unless they set `waf: false`
(about $12 a month per stage). Say what bills per use: Lambda, API Gateway, CloudFront, DynamoDB
reads and writes, and Cognito past its free tier. Give no other dollar figure; none has been
measured. Point to the budget alarm: AWS
Budgets emails the alert email when the month passes `monthlyBudgetUsd`.

**Wait for:** "deploy it" (or a clear yes).

Then:

1. `git add archive.yaml && git commit -m "Configure the archive" && git push origin main`
2. Find the run: `gh run list --commit $(git rev-parse HEAD) --workflow CI --json databaseId --jq '.[0].databaseId'`
   (wait a few seconds and ask again if it isn't listed yet).
3. `gh run watch <run-id> --exit-status` until it ends. On a failure, show
   `gh run view <run-id> --log-failed` and stop.

A stage's job that says it has no `AWS_DEPLOY_ROLE_ARN` was skipped: step 3 missed it.

### 6. ✋ First admin

**What it does.** Creates the first account on the stage, in the `admin`, `curator` and
`contributor` groups (creating a submission needs contributor; deciding one needs curator).
Cognito emails a temporary password to the address.

**What it costs.** Nothing.

Before inviting, on a stage with sign-up on (`selfSignUp` left out or `true`), warn them:
**anyone can create an account** from the sign-in page's Create an account form, and the stage is
open to sign-up from the moment it deploys. On a stage with `selfSignUp: false` nobody can sign
themselves up: say that accounts come only from an invitation. A new account has no
role: it can read what any visitor reads, and sign in to download `limited` files and to ask for
`restricted` ones, but it can't submit, review or change settings until an admin gives it a role.
The first admin gives roles on the site under **Settings → People**, or from the terminal with
`just set-roles <stage> <email> <roles>`; `just set-roles <stage> <email> ""` takes every role
away.

Confirm the email address with them. **Wait for:** "invite <email>" (or a yes naming the address).

With `email: ses` and the account still in SES's sandbox (step 3), the invitation only arrives
if the address is verified in SES.

Then: `just invite-user <stage> <email> admin,curator,contributor`

### 7. ✋ Seed

**What it does.** Publishes the committed sample package (`examples/sample-package`, invented
stream temperature data under CC-BY-4.0, access `public`) through the archive's own submit and
publish path. It becomes **public data on their archive**. Before it submits, a browser tab
opens by itself on the archive's own sign-in page, because the seed submits and approves as the
admin and the terminal never sees their password: the admin signs in there, setting their own
password from the invite email, and presses **Sign in the command line**. Say the tab is coming
and why before running it; it waits five minutes for the sign-in.

**What it costs.** A few requests and a few kilobytes of storage. To take it down later, an
admin withdraws it from its page (**Withdraw…** in the curators' bar): its files stop being
served and it leaves search, and **Restore…** undoes it. Removing it for good is by hand, with
the deletion runbook in `docs/curating.md` (Deleting data for good).

**Wait for:** "seed it" (or a clear yes).

Then: `just seed <stage>`. It prints the dataset's URL when it is published, or the status and
its findings when it stops.

### 8. Smoke test

`just smoke <stage>`. Report each check's line: the site, health, search, the dataset page and a
download whose SHA-256 matches the manifest. Every check should say `ok` after the seed. With DOIs
on, check that the seeded dataset's page shows its DOI's address as its Identifier. If it doesn't,
the alerts email says why; once DataCite answers, `just reindex <stage> --dois` registers it. Then give
them the site's URL:
`aws cloudformation describe-stacks --stack-name ResearchArchive-<stage> --query "Stacks[0].Outputs[?OutputKey=='SiteDomain'].OutputValue" --output text`.
With a domain, that is the name: check that `curl -sSI https://<name>/` answers 200.

## Update

1. Add upstream if it is missing, and fetch it:

   ```
   git remote get-url upstream || git remote add upstream https://github.com/schuettc/research-archive-in-a-box.git
   git fetch upstream
   ```

2. Show what changed since the fork's last merge: `git log --oneline main..upstream/main`, and any
   change to the settings: `git diff main...upstream/main -- packages/web/src/schema/archive-contract.schema.json`.
3. Merge: `git merge upstream/main`. A conflict in `archive.yaml` keeps the fork's values. Show
   any other conflict to them; they decide how it resolves.
4. Walk through any setting the merge brought, as Setup's step 2 does, and validate
   `archive.yaml` again. A change to a stage's `domain` (adding, changing or removing it) follows
   `docs/domain.md`'s moving or removing section. A change to a stage's `email` follows
   `docs/email.md`.
5. `just check`. On a failure, stop and push nothing.
6. ✋ **Push.** What it does: pushes the merge to `main`, and CI deploys every stage in order.
   When a stage's `domain` changed, also say that stage's address changes, that the deploy only
   adds records to the named zone (or removes the two alias records it made), and that readers
   add their passkeys again after the move.
   **Wait for:** "push it" (or a clear yes). Then push and follow the run as Setup's step 5 does.
7. With DOIs on, a "DOI not registered" alert means a version was published without one: once
   DataCite answers, `just reindex <stage> --dois` registers every version still missing a DOI
   and re-sends every existing DOI's record.

## Teardown

1. Ask which stage. **They type the stage name** exactly; anything else stops here.
2. Say plainly what happens: the stage's stack is deleted. Read the stage's `keepData` from
   `archive.yaml`. A stage that keeps its data (the default) **keeps its buckets, tables, user pool
   and logs**: they still hold the data and still bill for storage, and deleting them is by hand. A
   stage with `keepData: false` deletes everything, data included. Submissions still waiting for
   review or for changes end, and their contributors would have to submit again on another stage.
   With a domain, the name's two alias records go with the stack and its certificate stack is
   deleted; no other record in the zone changes. With `email: ses`, the SES identity and its three
   DKIM records go with the stage's stack too.
3. ✋ **Wait for:** "destroy <stage>". Then: `just destroy <stage>`. It stops the stage's
   running ingest executions (they would block the delete), deletes the stack, deletes every
   log group under `/aws/lambda/ResearchArchive-<stage>-` (each function's own, which Lambda
   makes when it runs and the stack doesn't own, but not those of another stage whose name
   starts with this one's), and fails if the stack still exists. For a stage
   with a domain, it then deletes `ResearchArchive-<stage>-Certificate` in us-east-1 and prints
   the command that removes ACM's validation CNAME from the hosted zone; show it to them, since
   that record is theirs to delete.
4. ✋ Only when no stage is left in that account (every stage `archive.yaml` puts there is
   destroyed): offer removing the GitHub connection. What it does: deletes the
   `ResearchArchiveDeploy` stack (the deploy role, and the OIDC provider when this stack made
   it) and the GitHub environment of every stage in that account; CI can no longer deploy to
   this account. A provider that was already in the account stays. **Wait for:** "remove the
   connection". Then, naming every stage in that account, and adding the same
   `-c githubOidcProvider=existing` and `-c githubSubPrefix=<prefix>` setup used:

   ```
   cd packages/infra && npx cdk --app "npx tsx bin/deploy-access.ts" destroy -c githubRepo=<owner>/<name> --force
   for stage in <stage> <stage>; do gh api -X DELETE "repos/<owner>/<name>/environments/$stage"; done
   ```

   The CDK bootstrap stack stays; other CDK apps in the account may use it.
