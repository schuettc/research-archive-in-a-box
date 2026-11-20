import { ArnFormat, Duration, Stack } from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as iam from "aws-cdk-lib/aws-iam";
import * as destinations from "aws-cdk-lib/aws-lambda-destinations";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as targets from "aws-cdk-lib/aws-scheduler-targets";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import type { ResearchArchive } from "./research-archive";

/** The lifecycle function's fixed name, for whatever names it by string. */
export function lifecycleFunctionName(stage: string): string {
  return `ResearchArchive-${stage}-Lifecycle`;
}

export interface CurationProps {
  readonly archive: ResearchArchive;
  readonly stage: string;
}

function allow(actions: string[], resources: string[], conditions?: Record<string, unknown>) {
  return new iam.PolicyStatement({ actions, resources, conditions });
}

/**
 * Curation: the `CurationFunction` behind withdraw and restore under `/api/admin/datasets/{id}`
 * and embargo, corrections at `/api/datasets/{id}/versions/{version}/metadata`, and the `LifecycleFunction` it invokes asynchronously to move a dataset's files, invalidate
 * its `/data/` paths in CloudFront and rewrite its pages and the catalog file.
 */
export class Curation extends Construct {
  readonly lifecycle: lambda.Function;
  readonly curation: lambda.Function;

  constructor(scope: Construct, id: string, props: CurationProps) {
    super(scope, id);
    const { archive } = props;
    const tables = [archive.catalogTables.a, archive.catalogTables.b];
    const archiveBucket = archive.archiveBucket;
    const data = ["open/", "restricted/"].map((prefix) =>
      archiveBucket.arnForObjects(`${prefix}*`),
    );

    // A fixed name: the curation function names the lifecycle by string, not by reference. The
    // lifecycle's SITE_DOMAIN and DISTRIBUTION_ID refer to the distribution, whose API origin
    // refers to the stage that deploys the curation routes, so a reference would be a cycle.
    const functionName = lifecycleFunctionName(props.stage);
    const functionArn = Stack.of(this).formatArn({
      service: "lambda",
      resource: "function",
      resourceName: functionName,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });

    this.lifecycle = archive.pythonFunction("LifecycleFunction", {
      functionName,
      handler: "archive_backend.lifecycle.handler",
      // A dataset holds up to 1000 files, each copied, checked and deleted.
      timeout: Duration.minutes(15),
      environment: {
        ARCHIVE_BUCKET: archiveBucket.bucketName,
        DERIVED_BUCKET: archive.derivedBucket.bucketName,
        CATALOG_TABLE_A: archive.catalogTables.a.tableName,
        CATALOG_TABLE_B: archive.catalogTables.b.tableName,
        ACTIVE_CATALOG_PARAMETER: archive.activeCatalogParameter.parameterName,
        ARCHIVE_CONFIG_PARAMETER: archive.archiveConfigParameter.parameterName,
        SITE_DOMAIN: archive.siteDomain,
        DISTRIBUTION_ID: archive.distribution.distributionId,
      },
    });
    // A failed move raises, and the async invoke's retries run the sync again. A run whose
    // retries all fail is sent to the alerts topic; the daily run syncs the dataset again.
    this.lifecycle.configureAsyncInvoke({
      retryAttempts: 2,
      onFailure: new destinations.SnsDestination(archive.alertTopic),
    });
    const lifecycle = this.lifecycle;
    lifecycle.addToRolePolicy(allow(["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], data));
    // A zip too large for one copy is moved in parts; a copy that fails is aborted.
    lifecycle.addToRolePolicy(allow(["s3:AbortMultipartUpload"], data));
    // HEAD of a missing key answers 403 instead of 404 without list rights.
    lifecycle.addToRolePolicy(
      allow(["s3:ListBucket"], [archiveBucket.bucketArn], {
        StringLike: { "s3:prefix": ["open/*", "restricted/*"] },
      }),
    );
    lifecycle.addToRolePolicy(
      allow(
        ["s3:PutObject"],
        [
          archive.derivedBucket.arnForObjects("site/datasets/*"),
          archive.derivedBucket.arnForObjects("site/catalog.json"),
          archive.derivedBucket.arnForObjects("site/sitemap.xml"),
        ],
      ),
    );
    for (const table of tables) {
      table.grant(lifecycle, "dynamodb:Query", "dynamodb:Scan", "dynamodb:UpdateItem");
    }
    archive.activeCatalogParameter.grantRead(lifecycle);
    archive.archiveConfigParameter.grantRead(lifecycle);
    archive.distribution.grantCreateInvalidation(lifecycle);
    // A withdrawal, a restore or a correction has it update the DOIs' DataCite records.
    archive.grantDoi(lifecycle);

    // Each day at 00:15 UTC, sync every dataset whose files are out of place: an embargo that
    // has ended, or a run that failed for good. A run is safe to repeat, and a failed one is
    // picked up by the next day's.
    new scheduler.Schedule(this, "DailyRelease", {
      schedule: scheduler.ScheduleExpression.cron({ minute: "15", hour: "0" }),
      target: new targets.LambdaInvoke(lifecycle, {
        retryAttempts: 0,
        input: scheduler.ScheduleTargetInput.fromObject({}),
      }),
    });

    this.curation = archive.pythonFunction("CurationFunction", {
      handler: "archive_backend.curation.handler",
      environment: {
        ARCHIVE_BUCKET: archiveBucket.bucketName,
        CATALOG_TABLE_A: archive.catalogTables.a.tableName,
        CATALOG_TABLE_B: archive.catalogTables.b.tableName,
        ACTIVE_CATALOG_PARAMETER: archive.activeCatalogParameter.parameterName,
        LIFECYCLE_FUNCTION: functionName,
        ACCOUNT_EVENTS_TABLE: archive.accountEvents.tableName,
        USER_POOL_ID: archive.userPool.userPoolId,
        USER_PROFILES_TABLE: archive.userProfiles.tableName,
      },
    });
    const curation = this.curation;
    curation.addToRolePolicy(
      allow(["s3:PutObject", "s3:DeleteObject"], [archiveBucket.arnForObjects("state/*")]),
    );
    // A correction reads the version where it is and rewrites only its manifest, README and
    // checksums, never a data file.
    curation.addToRolePolicy(allow(["s3:GetObject"], data));
    curation.addToRolePolicy(
      allow(
        ["s3:PutObject"],
        ["open/", "restricted/"].flatMap((prefix) =>
          ["datapackage.json", "README.md", "checksums.sha256"].map((name) =>
            archiveBucket.arnForObjects(`${prefix}*/${name}`),
          ),
        ),
      ),
    );
    for (const table of tables) {
      table.grant(curation, "dynamodb:GetItem", "dynamodb:UpdateItem");
    }
    archive.activeCatalogParameter.grantRead(curation);
    // A token outlives a disable or a demotion: each route reads the caller's disabled mark and
    // their groups live, as the access function does for its admins.
    archive.userProfiles.grant(curation, "dynamodb:GetItem");
    curation.addToRolePolicy(
      allow(
        ["cognito-idp:ListUsers", "cognito-idp:AdminListGroupsForUser"],
        [archive.userPool.userPoolArn],
      ),
    );
    // Every withdrawal, restore, correction and embargo move is an account event.
    archive.accountEvents.grant(curation, "dynamodb:PutItem");
    curation.addToRolePolicy(allow(["lambda:InvokeFunction"], [functionArn]));

    const integration = new apigateway.LambdaIntegration(curation);
    const signedIn: apigateway.MethodOptions = {
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer: archive.authorizer,
    };
    const api = archive.api.root.getResource("api");
    if (!api) {
      throw new Error("Curation needs the /api resource");
    }
    // The admin plan adds /api/admin too: whichever comes first makes it.
    const admin = api.getResource("admin") ?? api.addResource("admin");
    const dataset = admin.resourceForPath("datasets/{id}");
    dataset.addResource("withdraw").addMethod("POST", integration, signedIn);
    dataset.addResource("restore").addMethod("POST", integration, signedIn);
    dataset.addResource("embargo").addMethod("PUT", integration, signedIn);
    api
      .resourceForPath("datasets/{id}/versions/{version}")
      .addResource("metadata")
      .addMethod("PUT", integration, signedIn);
  }
}
