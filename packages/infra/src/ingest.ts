import { ArnFormat, CfnOutput, Duration, RemovalPolicy, Size, Stack } from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as guardduty from "aws-cdk-lib/aws-guardduty";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import type * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";
import type { ResearchArchive } from "./research-archive";

export interface IngestProps {
  readonly archive: ResearchArchive;
  readonly stage: string;
  /** The archive's package-size limit, `submissions.maxPackageGiB`. */
  readonly maxPackageGiB: number;
}

/**
 * The room the ingest function's /tmp has beyond the package limit, in MiB. The contract's
 * DISK_MARGIN_MB repeated: the schema's maximum plus this is a Lambda's largest disk.
 */
export const DISK_MARGIN_MIB = 1024;

const GUARDDUTY_PLAN_SERVICE = "malware-protection-plan.guardduty.amazonaws.com";

function objects(bucket: s3.IBucket, ...prefixes: string[]): string[] {
  return prefixes.map((prefix) => bucket.arnForObjects(`${prefix}*`));
}

function allow(actions: string[], resources: string[], conditions?: Record<string, unknown>) {
  return new iam.PolicyStatement({ actions, resources, conditions });
}

/**
 * The ingest pipeline: the durable `IngestFunction` (one execution per submission, from submit
 * to its end), the `SubmissionsFunction` behind `/api/submissions`, `/api/people`,
 * `/api/curators` and `/api/checks`, the curators' topic, and
 * GuardDuty Malware Protection on the staging bucket's `incoming/` prefix.
 */
export class Ingest extends Construct {
  readonly alias: lambda.Alias;
  readonly curatorTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: IngestProps) {
    super(scope, id);
    const { archive } = props;
    const staging = archive.stagingBucket;
    const catalogTables = [archive.catalogTables.a, archive.catalogTables.b];

    // Each curator subscribes with a filter on `audience`: their user id, or "all".
    this.curatorTopic = new sns.Topic(this, "Curators", {
      displayName: "Research archive curators",
    });

    const catalogEnv = {
      ACTIVE_CATALOG_PARAMETER: archive.activeCatalogParameter.parameterName,
      CATALOG_TABLE_A: archive.catalogTables.a.tableName,
      CATALOG_TABLE_B: archive.catalogTables.b.tableName,
    };
    const recordEnv = {
      SUBMISSIONS_TABLE: archive.submissions.tableName,
      REVIEWS_TABLE: archive.reviews.tableName,
      SETTINGS_TABLE: archive.settings.tableName,
      STAGING_BUCKET: staging.bucketName,
    };

    // A fixed name: the submissions function names the ingest by string, not by reference. The
    // ingest's SITE_DOMAIN refers to the distribution, whose API origin refers to the stage that
    // deploys the submissions routes, so a reference back to the ingest would be a cycle.
    const functionName = `ResearchArchive-${props.stage}-Ingest`;
    const functionArn = Stack.of(this).formatArn({
      service: "lambda",
      resource: "function",
      resourceName: functionName,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });
    const aliasArn = `${functionArn}:live`;

    const fn = archive.pythonFunction("IngestFunction", {
      functionName,
      handler: "archive_backend.ingest.handler",
      timeout: Duration.minutes(15),
      memorySize: 2048,
      // The check step downloads the whole round to /tmp, and the zips step builds package.zip
      // there: the package limit plus a fixed margin.
      ephemeralStorageSize: Size.mebibytes(props.maxPackageGiB * 1024 + DISK_MARGIN_MIB),
      durableConfig: { executionTimeout: Duration.days(365), retentionPeriod: Duration.days(30) },
      environment: {
        ...recordEnv,
        ...catalogEnv,
        CURATOR_TOPIC_ARN: this.curatorTopic.topicArn,
        ALERT_TOPIC_ARN: archive.alertTopic.topicArn,
        ARCHIVE_CONFIG_PARAMETER: archive.archiveConfigParameter.parameterName,
        ARCHIVE_BUCKET: archive.archiveBucket.bucketName,
        DERIVED_BUCKET: archive.derivedBucket.bucketName,
        SITE_DOMAIN: archive.siteDomain,
      },
    });
    // A submission's durable execution runs on the version it started on, and may wait months
    // in review; a deploy that moves the alias keeps the old version rather than delete it.
    const version = fn.currentVersion;
    version.applyRemovalPolicy(RemovalPolicy.RETAIN);
    this.alias = new lambda.Alias(this, "Live", { aliasName: "live", version });

    // Scan reads the tags; check reads the round; hold copies it to held/; reports/ keeps the
    // diagnosis; reject, abandon, expire and publish empty held/.
    fn.addToRolePolicy(allow(["s3:GetObject"], objects(staging, "incoming/", "held/")));
    fn.addToRolePolicy(allow(["s3:GetObjectTagging"], objects(staging, "incoming/")));
    fn.addToRolePolicy(allow(["s3:PutObject"], objects(staging, "held/", "reports/")));
    // copy_object copies the source's scan tag, which needs PutObjectTagging on the copy.
    fn.addToRolePolicy(allow(["s3:PutObjectTagging"], objects(staging, "held/")));
    fn.addToRolePolicy(allow(["s3:DeleteObject"], objects(staging, "held/")));
    fn.addToRolePolicy(
      allow(["s3:ListBucket"], [staging.bucketArn], { StringLike: { "s3:prefix": "held/*" } }),
    );
    // Publish builds a version's zips under held/ before anything of it is in the archive
    // bucket; a zip too large for one PUT is written in parts, and aborted when that fails.
    fn.addToRolePolicy(allow(["s3:AbortMultipartUpload"], objects(staging, "held/")));
    // The copy step writes each file and zip to the version's public folder; later steps read
    // the manifest there for the catalog and the page.
    fn.addToRolePolicy(
      allow(
        ["s3:PutObject", "s3:GetObject"],
        objects(archive.archiveBucket, "open/", "restricted/"),
      ),
    );
    // A zip too large for one copy is copied in parts, and the DOI path rewrites one in parts
    // where it is; either is aborted when it fails.
    fn.addToRolePolicy(
      allow(["s3:AbortMultipartUpload"], objects(archive.archiveBucket, "open/", "restricted/")),
    );
    // The DOI path's zips step HEADs each zip to see whether it changed; without list rights S3
    // answers a missing key with 403 instead of 404. A failed publish lists what to remove.
    fn.addToRolePolicy(
      allow(["s3:ListBucket"], [archive.archiveBucket.bucketArn], {
        StringLike: { "s3:prefix": ["open/*", "restricted/*"] },
      }),
    );
    // A publish that fails before its version is live hides what it copied to the public folder,
    // and a later publish that takes over its claim does the same. The bucket is versioned, so the delete
    // adds a delete marker: no right to delete a version or to bypass Object Lock.
    fn.addToRolePolicy(
      allow(["s3:DeleteObject"], objects(archive.archiveBucket, "open/", "restricted/")),
    );
    fn.addToRolePolicy(allow(["s3:PutObject"], objects(archive.derivedBucket, "site/datasets/")));
    // Publish's catalog-file and sitemap steps rewrite the catalog file search reads and the
    // sitemap robots.txt names.
    fn.addToRolePolicy(
      allow(
        ["s3:PutObject"],
        [
          archive.derivedBucket.arnForObjects("site/catalog.json"),
          archive.derivedBucket.arnForObjects("site/sitemap.xml"),
        ],
      ),
    );
    archive.submissions.grant(fn, "dynamodb:GetItem", "dynamodb:UpdateItem");
    archive.reviews.grant(fn, "dynamodb:PutItem");
    archive.settings.grant(fn, "dynamodb:GetItem");
    // Publish claims its version with a conditional update of the dataset item, and its catalog
    // step moves currentVersion with a conditional put of it. A publish that fails deletes the
    // claim-only item of a first version, and the version's items, which it finds by a query.
    // The catalog-file step scans the active table for every row.
    for (const table of catalogTables) {
      table.grant(
        fn,
        "dynamodb:GetItem",
        "dynamodb:UpdateItem",
        "dynamodb:PutItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query",
        "dynamodb:BatchWriteItem",
        "dynamodb:Scan",
      );
    }
    archive.activeCatalogParameter.grantRead(fn);
    archive.archiveConfigParameter.grantRead(fn);
    archive.alertTopic.grantPublish(fn);
    this.curatorTopic.grantPublish(fn);
    archive.grantDoi(fn);
    // Publish embeds the dataset item before its put.
    if (archive.embeddings) {
      archive.grantEmbedding(fn);
    }

    const api = archive.pythonFunction("SubmissionsFunction", {
      handler: "archive_backend.submissions.handler",
      environment: {
        ...recordEnv,
        ...catalogEnv,
        INGEST_ALIAS_ARN: aliasArn,
        USER_POOL_ID: archive.userPool.userPoolId,
        USER_PROFILES_TABLE: archive.userProfiles.tableName,
        ARCHIVE_CONFIG_PARAMETER: archive.archiveConfigParameter.parameterName,
      },
    });
    // Presigned PUTs are signed with the function's own role, so it needs the PUT itself. A
    // curator's edit rewrites the held manifest and checksums and replaces the round's report.
    api.addToRolePolicy(
      allow(["s3:PutObject"], objects(staging, "incoming/", "held/", "reports/")),
    );
    // Submit HEADs each declared file in incoming/; read presigns the report; files presigns
    // the held package's files for a curator.
    api.addToRolePolicy(
      allow(["s3:GetObject"], objects(staging, "incoming/", "reports/", "held/")),
    );
    archive.submissions.grant(
      api,
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:Query",
    );
    archive.reviews.grant(api, "dynamodb:PutItem", "dynamodb:Query");
    archive.settings.grant(api, "dynamodb:GetItem", "dynamodb:PutItem");
    for (const table of catalogTables) {
      table.grant(api, "dynamodb:GetItem");
    }
    archive.activeCatalogParameter.grantRead(api);
    // /api/checks runs the archive's own profiles and required fields.
    archive.archiveConfigParameter.grantRead(api);
    api.addToRolePolicy(allow(["lambda:InvokeFunction"], [aliasArn]));
    // Lambda authorizes a callback against the ARN of the execution that opened it, which sits
    // under the function's qualified ARN.
    api.addToRolePolicy(
      allow(["lambda:SendDurableExecutionCallbackSuccess"], [`${functionArn}:*`]),
    );

    // /api/people turns ids into emails; /api/curators lists the curator group.
    // Each route reads the caller's disabled mark and their groups live, as the curation function does.
    archive.userProfiles.grant(api, "dynamodb:GetItem");
    api.addToRolePolicy(
      allow(
        [
          "cognito-idp:ListUsers",
          "cognito-idp:ListUsersInGroup",
          "cognito-idp:AdminListGroupsForUser",
        ],
        [archive.userPool.userPoolArn],
      ),
    );

    const integration = new apigateway.LambdaIntegration(api);
    const auth: apigateway.MethodOptions = {
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer: archive.authorizer,
    };
    const root = archive.api.root.getResource("api")!;
    root.addResource("people").addMethod("GET", integration, auth);
    root.addResource("curators").addMethod("GET", integration, auth);
    root.addResource("checks").addMethod("POST", integration, auth);
    const submissions = root.addResource("submissions");
    submissions.addMethod("POST", integration, auth);
    submissions.addMethod("GET", integration, auth);
    const policy = submissions.addResource("policy");
    policy.addMethod("GET", integration, auth);
    policy.addMethod("PUT", integration, auth);
    const one = submissions.addResource("{id}");
    one.addMethod("GET", integration, auth);
    one.addResource("files").addMethod("GET", integration, auth);
    for (const action of ["uploads", "submit", "decision", "edits"]) {
      one.addResource(action).addMethod("POST", integration, auth);
    }

    this.addMalwareProtection(staging);

    new CfnOutput(Stack.of(this), "IngestFunction", {
      key: "IngestFunction",
      value: this.alias.functionArn,
    });
    new CfnOutput(Stack.of(this), "CuratorTopic", {
      key: "CuratorTopic",
      value: this.curatorTopic.topicArn,
    });
  }

  /**
   * GuardDuty Malware Protection for S3 on `incoming/`, tagging each scanned object with
   * `GuardDutyMalwareScanStatus`. The role is AWS's documented template, with the object
   * actions narrowed to the scanned prefix. The bucket is SSE-S3, so no KMS statement.
   */
  private addMalwareProtection(staging: s3.IBucket): void {
    const stack = Stack.of(this);
    const managedRule = stack.formatArn({
      service: "events",
      resource: "rule",
      resourceName: "DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3*",
    });
    const role = new iam.Role(this, "MalwareProtectionRole", {
      assumedBy: new iam.ServicePrincipal(GUARDDUTY_PLAN_SERVICE),
      inlinePolicies: {
        MalwareProtection: new iam.PolicyDocument({
          statements: [
            allow(
              ["events:PutRule", "events:DeleteRule", "events:PutTargets", "events:RemoveTargets"],
              [managedRule],
              { StringLike: { "events:ManagedBy": GUARDDUTY_PLAN_SERVICE } },
            ),
            allow(["events:DescribeRule", "events:ListTargetsByRule"], [managedRule]),
            allow(
              [
                "s3:PutObjectTagging",
                "s3:GetObjectTagging",
                "s3:PutObjectVersionTagging",
                "s3:GetObjectVersionTagging",
              ],
              objects(staging, "incoming/"),
            ),
            allow(["s3:PutBucketNotification", "s3:GetBucketNotification"], [staging.bucketArn]),
            allow(
              ["s3:PutObject"],
              [staging.arnForObjects("malware-protection-resource-validation-object")],
            ),
            allow(["s3:ListBucket"], [staging.bucketArn]),
            allow(["s3:GetObject", "s3:GetObjectVersion"], objects(staging, "incoming/")),
          ],
        }),
      },
    });
    new guardduty.CfnMalwareProtectionPlan(this, "MalwareProtection", {
      role: role.roleArn,
      protectedResource: {
        s3Bucket: { bucketName: staging.bucketName, objectPrefixes: ["incoming/"] },
      },
      actions: { tagging: { status: "ENABLED" } },
    });
  }
}
