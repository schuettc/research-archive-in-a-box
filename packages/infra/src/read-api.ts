import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as targets from "aws-cdk-lib/aws-scheduler-targets";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import type { ResearchArchive } from "./research-archive";
import { VECTOR_INDEX } from "./tables";

export interface ReadApiProps {
  readonly archive: ResearchArchive;
  readonly stage: string;
}

/**
 * The read API: one Lambda behind every search, dataset, version, project, download and usage
 * route under `/api`, the UsageResponses table it writes, and the daily rollup of CloudFront's
 * logs into DownloadCounts. Only the download and admin routes need a signed-in caller.
 */
export class ReadApi extends Construct {
  readonly usageResponses: dynamodb.Table;

  constructor(scope: Construct, id: string, props: ReadApiProps) {
    super(scope, id);
    const { archive } = props;

    this.usageResponses = new dynamodb.Table(this, "UsageResponses", {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      partitionKey: { name: "datasetId", type: dynamodb.AttributeType.STRING },
      // entry is written as `<YYYY-MM>#<uuid>`.
      sortKey: { name: "entry", type: dynamodb.AttributeType.STRING },
      ...(archive.keepData
        ? { removalPolicy: RemovalPolicy.RETAIN, deletionProtection: true }
        : { removalPolicy: RemovalPolicy.DESTROY }),
    });

    // The function reads the site's address (the distribution's name, or the stage's domain)
    // from a parameter named by a literal: with no domain, an environment variable holding it, or
    // a reference to the parameter, would make the distribution, the API stage that is its
    // origin, and this function depend on each other.
    const siteDomainName = `/research-archive/${props.stage}/site-domain`;
    new ssm.StringParameter(this, "SiteDomain", {
      parameterName: siteDomainName,
      stringValue: archive.siteDomain,
    });

    const fn = archive.pythonFunction("ApiFunction", {
      handler: "archive_backend.api.handler",
      environment: {
        ARCHIVE_BUCKET: archive.archiveBucket.bucketName,
        DERIVED_BUCKET: archive.derivedBucket.bucketName,
        CATALOG_TABLE_A: archive.catalogTables.a.tableName,
        CATALOG_TABLE_B: archive.catalogTables.b.tableName,
        ACTIVE_CATALOG_PARAMETER: archive.activeCatalogParameter.parameterName,
        DOWNLOAD_COUNTS_TABLE: archive.downloadCounts.tableName,
        USAGE_TABLE: this.usageResponses.tableName,
        USER_PROFILES_TABLE: archive.userProfiles.tableName,
        USER_POOL_ID: archive.userPool.userPoolId,
        ACCESS_TABLE: archive.access.tableName,
        SITE_DOMAIN_PARAMETER: siteDomainName,
        STAGE: props.stage,
        ARCHIVE_CONFIG_PARAMETER: archive.archiveConfigParameter.parameterName,
      },
    });
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          Stack.of(this).formatArn({
            service: "ssm",
            resource: "parameter",
            resourceName: siteDomainName.slice(1),
          }),
        ],
      }),
    );
    archive.catalogTables.a.grantReadData(fn);
    archive.catalogTables.b.grantReadData(fn);
    archive.activeCatalogParameter.grantRead(fn);
    archive.archiveConfigParameter.grantRead(fn);
    archive.derivedBucket.grantRead(fn, "site/catalog.json");
    archive.archiveBucket.grantRead(fn, "restricted/*");
    archive.archiveBucket.grantRead(fn, "projects/*");
    // Counting a signed link adds to the month; the dataset's total and the admin downloads
    // table read them.
    archive.downloadCounts.grant(fn, "dynamodb:UpdateItem", "dynamodb:Query", "dynamodb:Scan");
    // The download route reads a person's disabled mark and their approval for the dataset.
    archive.userProfiles.grant(fn, "dynamodb:GetItem");
    archive.access.grant(fn, "dynamodb:GetItem");
    // The admin downloads route reads the caller's groups live, as a token outlives a demotion.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cognito-idp:ListUsers", "cognito-idp:AdminListGroupsForUser"],
        resources: [archive.userPool.userPoolArn],
      }),
    );
    this.usageResponses.grantReadWriteData(fn);
    if (archive.embeddings) {
      archive.grantEmbedding(fn);
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["dynamodb:SearchVectors"],
          resources: [archive.catalogTables.a, archive.catalogTables.b].map(
            (table) => `${table.tableArn}/index/${VECTOR_INDEX}`,
          ),
        }),
      );
    }

    const integration = new apigateway.LambdaIntegration(fn);
    const open = { authorizationType: apigateway.AuthorizationType.NONE };
    const signedIn = {
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer: archive.authorizer,
    };
    const api = archive.api.root.getResource("api");
    if (!api) {
      throw new Error("ReadApi needs the /api resource");
    }
    api.addResource("search").addMethod("GET", integration, open);
    const dataset = api.addResource("datasets").addResource("{id}");
    dataset.addMethod("GET", integration, open);
    dataset.addResource("usage").addMethod("POST", integration, open);
    const versions = dataset.addResource("versions");
    versions.addMethod("GET", integration, open);
    const version = versions.addResource("{version}");
    version.addMethod("GET", integration, open);
    version.addResource("download").addMethod("GET", integration, signedIn);
    api.addResource("projects").addResource("{id}").addMethod("GET", integration, open);
    const admin = api.getResource("admin") ?? api.addResource("admin");
    admin.addResource("usage").addMethod("GET", integration, signedIn);
    admin.addResource("downloads").addMethod("GET", integration, signedIn);

    const rollup = archive.pythonFunction("DownloadRollupFunction", {
      handler: "archive_backend.downloads.handler",
      timeout: Duration.minutes(15),
      environment: {
        DERIVED_BUCKET: archive.derivedBucket.bucketName,
        DOWNLOAD_COUNTS_TABLE: archive.downloadCounts.tableName,
        SETTINGS_TABLE: archive.settings.tableName,
      },
    });
    archive.derivedBucket.grantRead(rollup, "logs/*");
    archive.downloadCounts.grant(rollup, "dynamodb:UpdateItem");
    archive.settings.grantReadWriteData(rollup);
    rollup.configureAsyncInvoke({ retryAttempts: 0 });

    new scheduler.Schedule(this, "Daily", {
      schedule: scheduler.ScheduleExpression.rate(Duration.days(1)),
      target: new targets.LambdaInvoke(rollup, { retryAttempts: 0 }),
    });
  }
}
