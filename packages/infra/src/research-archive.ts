import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, Stack } from "aws-cdk-lib";
import type * as apigateway from "aws-cdk-lib/aws-apigateway";
import type * as acm from "aws-cdk-lib/aws-certificatemanager";
import type * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import type * as cognito from "aws-cdk-lib/aws-cognito";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as route53 from "aws-cdk-lib/aws-route53";
import type * as s3 from "aws-cdk-lib/aws-s3";
import type * as sns from "aws-cdk-lib/aws-sns";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { Access } from "./access";
import { Api } from "./api";
import { Auth } from "./auth";
import { Curation } from "./curation";
import { Email, REGIONS_WITHOUT_SES } from "./email";
import { loginBrand } from "./brand";
import { maxPackageGiB, stagesOf } from "./config";
import type { ArchiveConfig } from "./generated/archive-config";
import { Ingest } from "./ingest";
import { IntegrityCheck } from "./integrity";
import { Operations } from "./operations";
import { makePythonFunction, type PythonFunctionProps } from "./python-function";
import { ReadApi } from "./read-api";
import { Reindex } from "./reindex";
import { Storage } from "./storage";
import { Tables } from "./tables";
import { Web } from "./web";

// The standard tier's limit on a parameter's value.
const MAX_CONFIG_BYTES = 4096;

/** Where archive.yaml sits: the brand's file paths are relative to it unless told otherwise. */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The embeddings module's one model, as the contract's `Embeddings.model` allows. */
const EMBEDDING_MODEL = "amazon.titan-embed-text-v2:0";

export interface ResearchArchiveProps {
  readonly config: ArchiveConfig;
  readonly stage: string;
  /** The config file's folder, which the brand's logo and favicon paths are relative to. */
  readonly configDir?: string;
  /** The us-east-1 certificate for the stage's `domain`, from its certificate stack; only with one. */
  readonly certificate?: acm.ICertificate;
}

export class ResearchArchive extends Construct {
  /** The stage's keepData: its data outlives its stack, and it has no test conveniences. */
  readonly keepData: boolean;
  /** Whether `infrastructure.modules.embeddings` switches semantic search on. */
  readonly embeddings: boolean;
  readonly stagingBucket: s3.Bucket;
  readonly archiveBucket: s3.Bucket;
  readonly derivedBucket: s3.Bucket;
  readonly catalogTables: { readonly a: dynamodb.Table; readonly b: dynamodb.Table };
  readonly activeCatalogParameter: ssm.StringParameter;
  /** The validated config as JSON: the one way a Lambda reads the archive config. */
  readonly archiveConfigParameter: ssm.StringParameter;
  readonly submissions: dynamodb.Table;
  readonly reviews: dynamodb.Table;
  readonly settings: dynamodb.Table;
  readonly userProfiles: dynamodb.Table;
  readonly downloadCounts: dynamodb.Table;
  readonly accountEvents: dynamodb.Table;
  /** One item per person and restricted dataset: the request, its state and the decision. */
  readonly access: dynamodb.Table;
  /** The optional usage answers readers give before a download, one item per answer. */
  readonly usageResponses: dynamodb.Table;
  readonly alertTopic: sns.Topic;
  readonly userPool: cognito.UserPool;
  readonly userPoolClients: {
    readonly web: cognito.UserPoolClient;
  };
  readonly api: apigateway.RestApi;
  readonly authorizer: apigateway.CognitoUserPoolsAuthorizer;
  readonly distribution: cloudfront.Distribution;
  /**
   * The site's address, the one source of it: the stage's domain, or the distribution's own name
   * with none. Pages, citations, the sitemap, robots.txt, passkeys and download links use it.
   */
  readonly siteDomain: string;
  /** The reindex's `live` alias: durable functions are invoked only through a version or alias. */
  readonly reindexFunction: lambda.Alias;
  /** The ingest's `live` alias: one durable execution per submission, named by its id. */
  readonly ingestFunction: lambda.Alias;
  /** Curators subscribe by email, filtered on `audience` (their user id, or "all"). */
  readonly curatorTopic: sns.Topic;
  /** Each admin's email is subscribed when they're given the admin role. */
  readonly adminsTopic: sns.Topic;
  /**
   * The DOI module's DataCite repository password, an SSM SecureString the deploy skill has the
   * person store, at `/research-archive/<stage>/datacite-password`; undefined with no `doi` block.
   */
  readonly doiPasswordParameter?: string;
  /** The stage's own domain and its imported hosted zone, for records in it; undefined with none. */
  readonly domain?: { readonly name: string; readonly zone: route53.IHostedZone };
  /** The SES identity the account emails come from, with `email: ses`; undefined without. */
  readonly email?: Email;
  private readonly operations: Operations;

  constructor(scope: Construct, id: string, props: ResearchArchiveProps) {
    super(scope, id);
    const stage = stagesOf(props.config).find((s) => s.name === props.stage);
    if (!stage) {
      throw new Error(`stage "${props.stage}" is not in infrastructure.stages`);
    }
    if (stage.domain && !props.certificate) {
      throw new Error(
        `stage ${props.stage} has a domain (${stage.domain.name}), so it needs a certificate`,
      );
    }
    if (!stage.domain && props.certificate) {
      throw new Error(`a certificate was given, but stage ${props.stage} has no domain`);
    }
    if (stage.domain) {
      this.domain = {
        name: stage.domain.name,
        zone: route53.HostedZone.fromHostedZoneId(this, "Zone", stage.domain.hostedZoneId),
      };
    }
    // The contract's rules for email, repeated: the loader checks the schema only.
    if (stage.email === "ses" && !stage.domain) {
      throw new Error(
        `stage ${props.stage} sends email through SES from its domain, so it needs a domain`,
      );
    }
    if (stage.email === "ses" && stage.region && REGIONS_WITHOUT_SES.has(stage.region)) {
      throw new Error(
        `stage ${props.stage} is in ${stage.region}, where Cognito can't send through SES in its ` +
          "own Region; email: ses isn't supported there yet",
      );
    }
    // The contract's rule for a stage's doi, repeated for the same reason.
    if (stage.doi && !props.config.doi) {
      throw new Error(
        `stage ${props.stage} sets doi, so the archive needs a doi block with its ` +
          "repository and prefix",
      );
    }
    this.keepData = stage.keepData ?? true;
    if (props.config.doi) {
      this.doiPasswordParameter = `/research-archive/${props.stage}/datacite-password`;
    }
    const infrastructure = props.config.infrastructure;
    if (!infrastructure) {
      throw new Error("ResearchArchive needs config.infrastructure");
    }

    // The stage's own config: its doi settings, where it sets them, over the archive's, so the
    // functions that register DOIs use this stage's DataCite system and account.
    const stageConfig: ArchiveConfig =
      stage.doi && props.config.doi
        ? {
            ...props.config,
            doi: {
              ...props.config.doi,
              test: stage.doi.test,
              ...(stage.doi.repository && { repository: stage.doi.repository }),
              ...(stage.doi.prefix && { prefix: stage.doi.prefix }),
            },
          }
        : props.config;
    // The privacy text goes only into the web build, which reads it from archive.yaml; no function
    // reads it, so it stays out of the parameter and a long policy doesn't use up its 4 KB.
    const storedConfig: ArchiveConfig = stageConfig.brand
      ? { ...stageConfig, brand: { ...stageConfig.brand, privacy: undefined } }
      : stageConfig;
    const configJson = JSON.stringify(storedConfig);
    const configBytes = Buffer.byteLength(configJson, "utf-8");
    if (configBytes > MAX_CONFIG_BYTES) {
      throw new Error(
        `archive config is ${configBytes} bytes as JSON; the SSM parameter holds at most ${MAX_CONFIG_BYTES}`,
      );
    }
    this.archiveConfigParameter = new ssm.StringParameter(this, "ArchiveConfig", {
      parameterName: `/research-archive/${props.stage}/archive-config`,
      stringValue: configJson,
      tier: ssm.ParameterTier.STANDARD,
    });

    this.operations = new Operations(this, "Operations", {
      stage: props.stage,
      alertEmail: infrastructure.alertEmail,
      monthlyBudgetUsd: infrastructure.monthlyBudgetUsd ?? 50,
    });
    this.alertTopic = this.operations.alertTopic;

    const objectLock = infrastructure.modules?.objectLock ?? undefined;
    const storage = new Storage(this, "Storage", { keepData: this.keepData, objectLock });
    this.stagingBucket = storage.stagingBucket;
    this.archiveBucket = storage.archiveBucket;
    this.derivedBucket = storage.derivedBucket;

    this.embeddings = infrastructure.modules?.embeddings != null;
    const tables = new Tables(this, "Tables", {
      stage: props.stage,
      keepData: this.keepData,
      embeddings: this.embeddings,
    });
    this.catalogTables = tables.catalogTables;
    this.activeCatalogParameter = tables.activeCatalogParameter;
    this.submissions = tables.submissions;
    this.reviews = tables.reviews;
    this.settings = tables.settings;
    this.userProfiles = tables.userProfiles;
    this.downloadCounts = tables.downloadCounts;
    this.accountEvents = tables.accountEvents;
    this.access = tables.access;
    this.operations.addTables([
      this.catalogTables.a,
      this.catalogTables.b,
      this.submissions,
      this.reviews,
      this.settings,
      this.userProfiles,
      this.downloadCounts,
      this.accountEvents,
      this.access,
    ]);

    const brand = loginBrand(props.config, props.configDir ?? REPO_ROOT);
    if (stage.email === "ses" && this.domain) {
      this.email = new Email(this, "Email", { domain: this.domain, keepData: this.keepData });
    }
    const auth = new Auth(this, "Auth", {
      keepData: this.keepData,
      selfSignUp: stage.selfSignUp ?? true,
      brand,
      siteAddress: stage.domain?.name,
      ...(this.email && this.domain
        ? { email: { domain: this.domain.name, ready: this.email.verified } }
        : {}),
    });
    this.userPool = auth.userPool;

    const api = new Api(this, "Api", {
      userPool: this.userPool,
      waf: infrastructure.modules?.waf ?? true,
      requestsPerFiveMinutes: infrastructure.requestsPerAddressPerFiveMinutes ?? 2000,
      health: this.pythonFunction("HealthFunction", { handler: "archive_backend.health.handler" }),
      whoami: this.pythonFunction("WhoamiFunction", { handler: "archive_backend.whoami.handler" }),
    });
    this.api = api.restApi;
    this.operations.addApi(this.api);
    this.authorizer = api.authorizer;

    const web = new Web(this, "Web", {
      derivedBucket: this.derivedBucket,
      archiveBucket: this.archiveBucket,
      stagingBucket: this.stagingBucket,
      restApi: this.api,
      originKey: api.originKey,
      brandColor: brand.primaryColor,
      faviconExt: props.config.brand?.favicon
        ? extname(props.config.brand.favicon).toLowerCase()
        : undefined,
      domain:
        this.domain && props.certificate
          ? { ...this.domain, certificate: props.certificate }
          : undefined,
    });
    this.distribution = web.distribution;
    this.siteDomain = web.siteDomain;
    this.operations.addDistribution(this.distribution);
    // The web app PUTs uploads and reads reports from the staging bucket, on CloudFront's address
    // and on the domain; a local dev server too on a stage with keepData: false.
    storage.allowStagingOrigins([
      `https://${this.distribution.distributionDomainName}`,
      ...(this.domain ? [`https://${this.domain.name}`] : []),
      ...(this.keepData ? [] : ["http://localhost:5199"]),
    ]);
    // just smoke, just seed, CI's smoke step and just ingest-e2e read it on every stage.
    new CfnOutput(Stack.of(this), "SiteDomain", { key: "SiteDomain", value: this.siteDomain });
    if (this.domain) {
      // CloudFront's own address, which still answers: the domain docs and the walk use it.
      new CfnOutput(Stack.of(this), "DistributionDomain", {
        key: "DistributionDomain",
        value: this.distribution.distributionDomainName,
      });
    }
    this.userPoolClients = auth.addAppClients();
    auth.setRelyingParty(this.siteDomain);
    if (!this.keepData) {
      auth.addTestClient();
    }
    web.deploySite(
      {
        region: Stack.of(this).region,
        webClientId: this.userPoolClients.web.userPoolClientId,
        selfSignUp: stage.selfSignUp ?? true,
      },
      // The contract's defaults when the config names none, as ingest applies them.
      {
        profiles: props.config.profiles ?? ["core"],
        required: props.config.required ?? [],
        maxPackageGiB: maxPackageGiB(props.config),
      },
    );

    new IntegrityCheck(this, "IntegrityCheck", {
      archive: this,
      archiveBucket: this.archiveBucket,
      alertTopic: this.alertTopic,
    });

    this.usageResponses = new ReadApi(this, "ReadApi", {
      archive: this,
      stage: props.stage,
    }).usageResponses;
    this.operations.addTables([this.usageResponses]);
    if (this.embeddings) {
      this.operations.addSemanticFallback(props.stage);
    }

    new Curation(this, "Curation", { archive: this, stage: props.stage });

    this.reindexFunction = new Reindex(this, "Reindex", { archive: this }).alias;

    const ingest = new Ingest(this, "Ingest", {
      archive: this,
      stage: props.stage,
      maxPackageGiB: maxPackageGiB(props.config),
    });
    this.ingestFunction = ingest.alias;
    this.curatorTopic = ingest.curatorTopic;

    this.adminsTopic = new Access(this, "Access", { archive: this }).adminsTopic;
  }

  /** Let the function call Titan Text Embeddings v2, the embeddings module's model. */
  grantEmbedding(fn: lambda.Function): void {
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: [
          Stack.of(this).formatArn({
            service: "bedrock",
            account: "",
            resource: "foundation-model",
            resourceName: EMBEDDING_MODEL,
          }),
        ],
      }),
    );
  }

  /**
   * With the DOI module on, tell the function the DataCite password parameter's name and let it
   * read that one parameter; with it off, nothing. A SecureString under the AWS-managed aws/ssm
   * key needs no KMS grant.
   */
  grantDoi(fn: lambda.Function): void {
    if (!this.doiPasswordParameter) return;
    fn.addEnvironment("DATACITE_PASSWORD_PARAMETER", this.doiPasswordParameter);
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          Stack.of(this).formatArn({
            service: "ssm",
            resource: "parameter",
            resourceName: this.doiPasswordParameter.slice(1),
          }),
        ],
      }),
    );
  }

  /** A Python Lambda from archive-backend, built the way the archive's own are, with its alarm. */
  pythonFunction(id: string, props: PythonFunctionProps): lambda.Function {
    const fn = makePythonFunction(this, id, { ...props, keepData: this.keepData });
    this.operations.addFunction(fn);
    return fn;
  }
}
