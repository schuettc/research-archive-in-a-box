# Troubleshooting

This page covers what most often goes wrong while setting up an archive, during its first deploy, and with its first submissions. Each entry says what you see, why it happens and what to do. The setup steps it refers to are those of [Deploying](deploying.md).

## Pushing to main starts no CI run

**What you see:** you push to `main`, and the command that finds the run keeps printing nothing:

```
gh run list --commit $(git rev-parse HEAD) --workflow CI --json databaseId --jq '.[0].databaseId'
```

**Why:** GitHub Actions is off for the fork, so GitHub runs no workflow for the push. This prints `false` when it is off:

```
gh api repos/<owner>/<name>/actions/permissions --jq .enabled
```

**What to do:** turn Actions on under the fork's Settings › Actions, then push a new commit to `main`.

## CI can't assume the deploy role

**What you see:** the checks pass, and a stage's deploy job fails at the step that loads the deploy role (`aws-actions/configure-aws-credentials`), before `cdk deploy` starts.

**Why:** the deploy role trusts a run only when the **subject** in GitHub's token (the statement of which repository and environment the run belongs to) is exactly one the role lists. The role lists one subject for each stage that `archive.yaml` held when the `ResearchArchiveDeploy` stack was deployed, each made of the repository's subject prefix and `:environment:<stage>`. The subject GitHub sends differs from all of them when:

- the fork uses immutable subjects, which carry numeric ids, and the stack was deployed without `-c githubSubPrefix=<prefix>`, or with another repository's prefix;
- the repository was deleted and made again, or renamed, which gives it another subject;
- the stage was added to `archive.yaml` after the stack was deployed, so the role doesn't list it.

**What to do:** read the subject GitHub sends for the fork, as [The repository's subject](deploying.md#the-repositorys-subject-and-a-recreated-repository) shows, then deploy the `ResearchArchiveDeploy` stack again with the current `archive.yaml` and that prefix ([Connect GitHub to AWS](deploying.md#connect-github-to-aws) has the command). A new stage also needs its GitHub environment and the two variables in it.

A stage whose job ends with the notice `<stage> has no AWS_DEPLOY_ROLE_ARN in its environment; skipped` is a different case: the job did not fail, and the stage was not deployed, because its GitHub environment lacks the role's ARN. Create the environment and its variables as the same section shows, then run the run again with `gh run rerun <run-id>`.

## The deploy of a stage with a domain fails in us-east-1

**What you see:** a stage that has a `domain`, in a Region other than us-east-1, fails to deploy at its certificate stack, `ResearchArchive-<stage>-Certificate`.

**Why:** the certificate for a domain is made in us-east-1 whatever the stage's Region, in a stack of its own. CDK deploys a stack through roles that its bootstrap creates in each Region, and bootstrapping the stage's Region doesn't create them in us-east-1.

**What to do:** check whether us-east-1 is bootstrapped, and bootstrap it if this fails:

```
aws cloudformation describe-stacks --region us-east-1 --stack-name CDKToolkit
cd packages/infra && npx cdk bootstrap aws://<account>/us-east-1
```

Then run the failed run again with `gh run rerun <run-id>`. [A custom domain](../domain.md) lists what else a domain needs first.

## An email from the archive never arrives

Three kinds of email go through Amazon SNS, the AWS service that sends a message to every address subscribed to a topic: the alerts to `infrastructure.alertEmail`, the admins' notices of new access requests, and the curators' review messages. Account emails (invitations, sign-up codes, password resets) go another way, covered in the next entry.

**What you see:** an alert, an access request notice or a review message reaches nobody, though the address is right.

**Why:** SNS sends nothing to an address until its owner confirms the subscription. AWS emails a confirmation link when the address is subscribed: the alert email after the first deploy, an admin when they are given the admin role, and a curator when you run `just add-curator`. Until the link is clicked, no message reaches that address.

**What to do:** find the confirmation email from AWS and click its link. A curator who was never subscribed gets no review messages at all: giving the curator role doesn't subscribe anyone, so run `just add-curator <stage> <email> <userId>` for them, as [The first admin](deploying.md#6--the-first-admin) explains.

## Invitations and sign-up codes reach no one

**What you see:** on a stage with `email: ses`, an invited person gets no temporary password, or a new account gets no sign-up code, while an address you verified in SES does get them.

**Why:** Amazon SES, the AWS service that sends the stage's account emails, puts every AWS account in a **sandbox**, once per account and Region. In the sandbox it sends only to addresses and domains verified in SES. This prints `false` while the account is in it:

```
aws sesv2 get-account --region <region> --query ProductionAccessEnabled
```

**What to do:** request production access for the account and Region, which AWS answers within 96 hours, and until then invite only addresses verified in SES. [SES's sandbox](../email.md#sess-sandbox) has both commands.

## A submission stays "Being checked"

**What you see:** a submission's status stays **Being checked** long after its upload finished.

**Why:** the archive checks nothing until the malware scan, GuardDuty Malware Protection for S3, has marked every uploaded file with its result. It looks for the results again and again, waiting longer each time, up to an hour between looks, so a large upload can sit in **Being checked** for a while after its scan ends. If a file still has no result after a day, the archive ends the submission as **failed** and sends an alert to the alert email, saying how many files were never scanned and naming up to ten of them.

**What to do:** within the first day, wait. After a **failed** submission, the contributor submits the package again. If scans keep failing to arrive, look at the stage's malware protection plan (the `AWS::GuardDuty::MalwareProtectionPlan` resource in the `ResearchArchive-<stage>` stack) in the GuardDuty console of the stage's account, since the archive only sees that no result came.

## A submission comes straight back as "Changes requested"

**What you see:** a submission goes from **Being checked** to **Changes requested** with no curator involved.

**Why:** the archive's own checks found an error, and an error sends the submission back before any curator sees it. The submission's page lists the findings. It is one of these:

- A check of the package failed under the archive's rules. The archive checks with its own `archive.yaml`, so its profiles and required fields apply: an archive that uses the `ecology` profile sends back a package with no `archive:temporalCoverage`, even when plain `cruise diagnose` on a laptop called the package publishable.
- A file as stored differs from what the submission declared: another size, another SHA-256 hash, or a total larger than the archive takes.
- The malware scan of a file ended with a result other than clean. The finding names the file and the scan's result.

**What to do:** read the findings on the submission's page, fix the package, and press **Resubmit** to send the fixed folder as the next round. To see the same findings before uploading, run `cruise diagnose --config archive.yaml <folder>` with the archive's `archive.yaml`, as [Profiles and the archive's own rules](packages.md#profiles-and-the-archives-own-rules) describes. A submission with no resubmission within 30 days is abandoned.
