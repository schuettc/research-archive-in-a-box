# @research-in-a-box/infra

The infrastructure package is the AWS CDK code that builds one archive in an AWS account. CDK turns TypeScript into a CloudFormation stack, the set of AWS resources AWS creates and deletes together. Each stage in `archive.yaml`, such as `prod`, becomes one stack named `ResearchArchive-<stage>`, built by the `ResearchArchive` construct: the storage buckets, the tables, the Lambda functions from `packages/backend`, the API, the sign-in user pool, and the CloudFront site that serves the web app from `packages/web`.

`bin/app.ts` is the app CI deploys, one stack per stage. `bin/deploy-access.ts` is the one stack a deployer runs from a laptop, `ResearchArchiveDeploy`, which lets the fork's GitHub Actions deploy to the account.

Who uses it: CI, on every push to `main`, and the `deploy-archive` skill, which deploys the access stack. Archive stacks are never deployed by hand.

Its one command runs its tests, which build the stacks from test configs and the committed `archive.yaml` and check them. It needs the web app built and the Lambda code installed first, as `just check-ts` does:

```
just lambda-assets && npm run build -w packages/web && npm test -w packages/infra
```
