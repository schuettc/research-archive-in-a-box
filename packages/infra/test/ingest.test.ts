import { Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import type { CfnAlias } from "aws-cdk-lib/aws-lambda";
import type { CfnBucket } from "aws-cdk-lib/aws-s3";
import { beforeAll, expect, test } from "vitest";
import { ResearchArchive } from "../src/research-archive";
import { domainArchive, testApp } from "./test-app";

let archive: ResearchArchive;
let stack: Stack;
let template: Template;

type Statement = { Action: string | string[]; Resource: unknown; Condition?: unknown };

beforeAll(() => {
  stack = new Stack(testApp(), "S");
  archive = new ResearchArchive(stack, "Archive", {
    config: {
      publisher: "P",
      infrastructure: { alertEmail: "a@example.org", stages: [{ name: "prod" }] },
    },
    stage: "prod",
  });
  template = Template.fromStack(stack);
});

function fn(handler: string): { id: string; properties: Record<string, unknown> } {
  const fns = template.findResources("AWS::Lambda::Function", {
    Properties: { Handler: handler },
  });
  expect(Object.keys(fns)).toHaveLength(1);
  const [id, resource] = Object.entries(fns)[0] as [
    string,
    { Properties: Record<string, unknown> },
  ];
  return { id, properties: resource.Properties };
}

const INGEST = "archive_backend.ingest.handler";
const SUBMISSIONS = "archive_backend.submissions.handler";

function statementsOfRole(role: string): Statement[] {
  const policies = template.findResources("AWS::IAM::Policy", {
    Properties: { Roles: [{ Ref: role }] },
  });
  return Object.values(policies).flatMap(
    (p) =>
      (p as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties
        .PolicyDocument.Statement,
  );
}

function statements(handler: string): Statement[] {
  const { properties } = fn(handler);
  return statementsOfRole((properties.Role as { "Fn::GetAtt": string[] })["Fn::GetAtt"][0]!);
}

function actions(statement: { Action: string | string[] }): string[] {
  return Array.isArray(statement.Action) ? statement.Action : [statement.Action];
}

function logicalId(construct: { node: { defaultChild?: unknown } }): string {
  return stack.getLogicalId(construct.node.defaultChild as CfnBucket);
}

test("the ingest function is durable for a year, with 15 minutes, 2048 MB and 10 GiB of /tmp", () => {
  expect(fn(INGEST).properties).toMatchObject({
    Runtime: "python3.13",
    Architectures: ["arm64"],
    Timeout: 900,
    MemorySize: 2048,
    EphemeralStorage: { Size: 10240 },
    DurableConfig: { ExecutionTimeout: 365 * 24 * 3600, RetentionPeriodInDays: 30 },
  });
});

test("the ingest function's /tmp is the package limit plus 1 GiB", () => {
  const small = new Stack(testApp(), "Small");
  new ResearchArchive(small, "Archive", {
    config: {
      publisher: "P",
      submissions: { maxPackageGiB: 2 },
      infrastructure: { alertEmail: "a@example.org", stages: [{ name: "prod" }] },
    },
    stage: "prod",
  });

  Template.fromStack(small).hasResourceProperties("AWS::Lambda::Function", {
    Handler: INGEST,
    EphemeralStorage: { Size: 3072 },
  });
});

test("the ingest may abort a multipart upload under the archive's open/ and restricted/ alone", () => {
  const archiveId = logicalId(archive.archiveBucket);
  const aborts = statements(INGEST).filter(
    (s) =>
      actions(s).includes("s3:AbortMultipartUpload") &&
      JSON.stringify(s.Resource).includes(archiveId),
  );
  const resources = JSON.stringify(aborts.map((s) => s.Resource));

  // A zip too large for one copy arrives in parts, and the DOI path rewrites one in parts.
  expect(resources.match(/"\/[^"]*"/g)?.sort()).toEqual(['"/open/*"', '"/restricted/*"']);
});

test("the ingest's rights in the staging bucket are exactly these", () => {
  const stagingId = logicalId(archive.stagingBucket);
  const granted: Record<string, string[]> = {};
  for (const s of statements(INGEST)) {
    const resources = JSON.stringify(s.Resource);
    if (!resources.includes(stagingId)) continue;
    const prefixes = resources.match(/"\/[^"]*"/g)?.map((m) => m.slice(1, -1)) ?? ["(bucket)"];
    for (const action of actions(s)) {
      granted[action] = [...(granted[action] ?? []), ...prefixes].sort();
    }
  }

  // A publish builds its version's zips under held/ before anything is in the archive bucket:
  // a zip too large for one PUT is written there in parts, and aborted when that fails.
  expect(granted).toEqual({
    "s3:AbortMultipartUpload": ["/held/*"],
    "s3:DeleteObject": ["/held/*"],
    "s3:GetObject": ["/held/*", "/incoming/*"],
    "s3:GetObjectTagging": ["/held/*", "/incoming/*"],
    "s3:ListBucket": ["(bucket)"],
    "s3:PutObject": ["/held/*", "/reports/*"],
    "s3:PutObjectTagging": ["/held/*"],
  });
  const list = statements(INGEST).find(
    (s) => actions(s).includes("s3:ListBucket") && JSON.stringify(s.Resource).includes(stagingId),
  );
  expect(list?.Condition).toEqual({ StringLike: { "s3:prefix": "held/*" } });
});

test("no right of the ingest names a publishing/ folder", () => {
  const all = JSON.stringify(statements(INGEST));

  expect(all).not.toContain("publishing/");
});

test("it is invoked through a live alias, which the IngestFunction output names", () => {
  const aliasId = stack.getLogicalId(archive.ingestFunction.node.defaultChild as CfnAlias);

  template.hasResourceProperties("AWS::Lambda::Alias", {
    Name: "live",
    FunctionName: { Ref: fn(INGEST).id },
  });
  template.hasOutput("IngestFunction", { Value: { Ref: aliasId } });
});

// A durable execution waiting on review runs on the version it started on; a deploy that moved
// the alias must not delete it.
test("the ingest function's versions are kept when the alias moves", () => {
  const versions = template.findResources("AWS::Lambda::Version", {
    Properties: { FunctionName: { Ref: fn(INGEST).id } },
  });

  expect(Object.keys(versions)).toHaveLength(1);
  for (const version of Object.values(versions)) {
    expect(version.DeletionPolicy).toBe("Retain");
    expect(version.UpdateReplacePolicy).toBe("Retain");
  }
});

test("every environment variable either handler reads is set", () => {
  const ingest = fn(INGEST).properties.Environment as { Variables: Record<string, unknown> };
  const api = fn(SUBMISSIONS).properties.Environment as { Variables: Record<string, unknown> };

  expect(Object.keys(ingest.Variables).sort()).toEqual(
    [
      "SUBMISSIONS_TABLE",
      "REVIEWS_TABLE",
      "SETTINGS_TABLE",
      "STAGING_BUCKET",
      "CURATOR_TOPIC_ARN",
      "ALERT_TOPIC_ARN",
      "ARCHIVE_CONFIG_PARAMETER",
      "ARCHIVE_BUCKET",
      "DERIVED_BUCKET",
      "ACTIVE_CATALOG_PARAMETER",
      "CATALOG_TABLE_A",
      "CATALOG_TABLE_B",
      "SITE_DOMAIN",
    ].sort(),
  );
  expect(ingest.Variables.CURATOR_TOPIC_ARN).toEqual({ Ref: logicalId(archive.curatorTopic) });
  expect(ingest.Variables.SITE_DOMAIN).toEqual({
    "Fn::GetAtt": [logicalId(archive.distribution), "DomainName"],
  });
  expect(Object.keys(api.Variables).sort()).toEqual(
    [
      "SUBMISSIONS_TABLE",
      "REVIEWS_TABLE",
      "SETTINGS_TABLE",
      "STAGING_BUCKET",
      "INGEST_ALIAS_ARN",
      "ACTIVE_CATALOG_PARAMETER",
      "CATALOG_TABLE_A",
      "CATALOG_TABLE_B",
      "USER_POOL_ID",
      "ARCHIVE_CONFIG_PARAMETER",
      "USER_PROFILES_TABLE",
    ].sort(),
  );
  expect(api.Variables.USER_POOL_ID).toEqual({ Ref: logicalId(archive.userPool) });
  expect(JSON.stringify(api.Variables.INGEST_ALIAS_ARN)).toContain(
    ":function:ResearchArchive-prod-Ingest:live",
  );
});

test("each submissions route has its method behind the Cognito authorizer", () => {
  const [authorizer] = Object.keys(template.findResources("AWS::ApiGateway::Authorizer"));
  // Other plans hang their own {id} resources off /api, so each part is found under its parent.
  const resource = (pathPart: string, parent?: string): string => {
    const ids = Object.entries(
      template.findResources("AWS::ApiGateway::Resource", { Properties: { PathPart: pathPart } }),
    )
      .filter(
        ([, r]) =>
          parent === undefined ||
          JSON.stringify((r as { Properties: { ParentId: unknown } }).Properties.ParentId) ===
            JSON.stringify({ Ref: parent }),
      )
      .map(([id]) => id);
    expect(ids).toHaveLength(1);
    return ids[0]!;
  };
  const submissions = resource("submissions");
  const policy = resource("policy", submissions);
  const id = resource("{id}", submissions);
  const api = template.findResources("AWS::ApiGateway::Resource", {
    Properties: { PathPart: "api" },
  }) as object;
  const [apiId] = Object.keys(api);
  const routes: [string, string][] = [
    ["GET", resource("people", apiId)],
    ["GET", resource("curators", apiId)],
    ["POST", resource("checks", apiId)],
    ["POST", submissions],
    ["GET", submissions],
    ["GET", policy],
    ["PUT", policy],
    ["GET", id],
    ["GET", resource("files", id)],
    ["POST", resource("uploads", id)],
    ["POST", resource("submit", id)],
    ["POST", resource("decision", id)],
    ["POST", resource("edits", id)],
  ];

  for (const [method, resourceId] of routes) {
    template.hasResourceProperties("AWS::ApiGateway::Method", {
      HttpMethod: method,
      ResourceId: { Ref: resourceId },
      AuthorizationType: "COGNITO_USER_POOLS",
      AuthorizerId: { Ref: authorizer },
      Integration: {
        Uri: {
          "Fn::Join": ["", Match.arrayWith([{ "Fn::GetAtt": [fn(SUBMISSIONS).id, "Arn"] }])],
        },
      },
    });
  }
});

test("GuardDuty scans and tags the staging bucket's incoming/ prefix, with the documented role", () => {
  const staging = logicalId(archive.stagingBucket);
  const plans = template.findResources("AWS::GuardDuty::MalwareProtectionPlan");
  expect(Object.keys(plans)).toHaveLength(1);
  const plan = Object.values(plans)[0]!.Properties as {
    ProtectedResource: unknown;
    Actions: unknown;
    Role: { "Fn::GetAtt": [string, string] };
  };

  expect(plan.ProtectedResource).toEqual({
    S3Bucket: { BucketName: { Ref: staging }, ObjectPrefixes: ["incoming/"] },
  });
  expect(plan.Actions).toEqual({ Tagging: { Status: "ENABLED" } });
  const role = plan.Role["Fn::GetAtt"][0];
  expect(plan.Role["Fn::GetAtt"][1]).toBe("Arn");
  const roleProperties = template.toJSON().Resources[role].Properties as {
    AssumeRolePolicyDocument: { Statement: unknown[] };
    Policies: { PolicyDocument: { Statement: Statement[] } }[];
  };
  expect(roleProperties.AssumeRolePolicyDocument.Statement).toEqual([
    expect.objectContaining({
      Action: "sts:AssumeRole",
      Principal: { Service: "malware-protection-plan.guardduty.amazonaws.com" },
    }),
  ]);

  const all = roleProperties.Policies.flatMap((p) => p.PolicyDocument.Statement);
  const scan = all.find((s) => actions(s).includes("s3:GetObject"));
  expect(actions(scan!).sort()).toEqual(["s3:GetObject", "s3:GetObjectVersion"]);
  expect(JSON.stringify(scan!.Resource)).toContain("/incoming/*");
  const tag = all.find((s) => actions(s).includes("s3:PutObjectTagging"));
  expect(actions(tag!).sort()).toEqual([
    "s3:GetObjectTagging",
    "s3:GetObjectVersionTagging",
    "s3:PutObjectTagging",
    "s3:PutObjectVersionTagging",
  ]);
  expect(JSON.stringify(tag!.Resource)).toContain("/incoming/*");
  const validation = all.find((s) => actions(s).includes("s3:PutObject"));
  expect(JSON.stringify(validation!.Resource)).toContain(
    "/malware-protection-resource-validation-object",
  );
  const rule = all.find((s) => actions(s).includes("events:PutRule"));
  expect(rule!.Condition).toEqual({
    StringLike: { "events:ManagedBy": "malware-protection-plan.guardduty.amazonaws.com" },
  });
  expect(JSON.stringify(rule!.Resource)).toContain(
    ":rule/DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3*",
  );
});

test("there is a curators' topic, apart from the alert topic, and the ingest may publish to both", () => {
  const curators = logicalId(archive.curatorTopic);
  const alerts = logicalId(archive.alertTopic);
  expect(curators).not.toBe(alerts);
  template.hasResourceProperties("AWS::SNS::Topic", { DisplayName: "Research archive curators" });

  const publish = statements(INGEST).filter((s) => actions(s).includes("sns:Publish"));
  const topics = publish.map((s) => s.Resource);
  expect(topics).toContainEqual({ Ref: curators });
  expect(topics).toContainEqual({ Ref: alerts });
  expect(statements(SUBMISSIONS).some((s) => actions(s).includes("sns:Publish"))).toBe(false);
});

test("only the submissions function may send callbacks, scoped to the ingest function's executions", () => {
  // The ingest has a fixed name, so the submissions function names it without a reference.
  expect(fn(INGEST).properties.FunctionName).toBe("ResearchArchive-prod-Ingest");
  const callback = statements(SUBMISSIONS).filter((s) =>
    actions(s).includes("lambda:SendDurableExecutionCallbackSuccess"),
  );

  expect(callback).toHaveLength(1);
  expect(actions(callback[0]!)).toEqual(["lambda:SendDurableExecutionCallbackSuccess"]);
  expect(JSON.stringify(callback[0]!.Resource)).toMatch(
    /:function:ResearchArchive-prod-Ingest:\*"\]\]\}$/,
  );
  expect(
    statements(INGEST).some((s) =>
      actions(s).includes("lambda:SendDurableExecutionCallbackSuccess"),
    ),
  ).toBe(false);

  const invoke = statements(SUBMISSIONS).filter((s) =>
    actions(s).includes("lambda:InvokeFunction"),
  );
  expect(invoke).toHaveLength(1);
  expect(actions(invoke[0]!)).toEqual(["lambda:InvokeFunction"]);
  expect(JSON.stringify(invoke[0]!.Resource)).toMatch(
    /:function:ResearchArchive-prod-Ingest:live"\]\]\}$/,
  );
});

test("the ingest writes only the archive's open/ and restricted/ and the derived site's dataset pages, catalog file and sitemap", () => {
  const puts = statements(INGEST).filter((s) => actions(s).includes("s3:PutObject"));
  const resources = JSON.stringify(puts.map((s) => s.Resource));
  const archiveId = logicalId(archive.archiveBucket);
  const derivedId = logicalId(archive.derivedBucket);
  const stagingId = logicalId(archive.stagingBucket);

  for (const prefix of ["/open/*", "/restricted/*"]) expect(resources).toContain(prefix);
  expect(resources).toContain("/site/datasets/*");
  // Publish's catalog-file step rewrites the one file search reads, and nothing else under site/.
  expect(resources).toContain('"/site/catalog.json"');
  expect(resources.match(/\/site\/[^"]*/g)?.sort()).toEqual([
    "/site/catalog.json",
    "/site/datasets/*",
    "/site/sitemap.xml",
  ]);
  expect(resources).toContain("/held/*");
  expect(resources).toContain("/reports/*");
  for (const s of puts) {
    const r = JSON.stringify(s.Resource);
    if (r.includes(archiveId) || r.includes(derivedId) || r.includes(stagingId)) {
      expect(r).not.toMatch(/"\/\*"/);
    }
  }
});

test("the ingest may list the archive's open/ and restricted/, so a missing zip HEADs as 404, not 403", () => {
  const archiveId = logicalId(archive.archiveBucket);
  const lists = statements(INGEST).filter(
    (s) => actions(s).includes("s3:ListBucket") && JSON.stringify(s.Resource).includes(archiveId),
  );

  expect(lists).toHaveLength(1);
  expect(actions(lists[0]!)).toEqual(["s3:ListBucket"]);
  expect(JSON.stringify(lists[0]!.Resource)).not.toContain("/*");
  expect(lists[0]!.Condition).toEqual({
    StringLike: { "s3:prefix": ["open/*", "restricted/*"] },
  });
});

test("the submissions function may read incoming/, so submit can HEAD each declared file", () => {
  const reads = statements(SUBMISSIONS).filter((s) => actions(s).includes("s3:GetObject"));
  const resources = JSON.stringify(reads.map((s) => s.Resource));

  expect(resources).toContain("/incoming/*");
  expect(resources).toContain("/reports/*");
  expect(resources).not.toMatch(/"\/\*"/);
});

test("the submissions function reads held/ to sign links and to edit a held manifest", () => {
  const reads = statements(SUBMISSIONS).filter((s) => actions(s).includes("s3:GetObject"));
  expect(JSON.stringify(reads.map((s) => s.Resource))).toContain("/held/*");
});

test("the submissions function writes exactly incoming/, held/ and reports/, and deletes nothing", () => {
  const writes = statements(SUBMISSIONS).filter((s) =>
    actions(s).some((a) => a === "s3:PutObject" || a === "s3:DeleteObject"),
  );
  const stagingId = logicalId(archive.stagingBucket);
  const prefixes = writes.flatMap((s) => {
    expect(actions(s)).toEqual(["s3:PutObject"]);
    const resources = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
    return resources.map((r) => {
      const text = JSON.stringify(r);
      expect(text).toContain(stagingId);
      return /"(\/[a-z]+\/\*)"/.exec(text)?.[1];
    });
  });
  expect(prefixes.sort()).toEqual(["/held/*", "/incoming/*", "/reports/*"]);
});

test("the ingest may claim a version on either catalog table with a conditional update", () => {
  const updates = statements(INGEST).filter((s) => actions(s).includes("dynamodb:UpdateItem"));
  const resources = JSON.stringify(updates.map((s) => s.Resource));

  for (const table of [archive.catalogTables.a, archive.catalogTables.b]) {
    expect(resources).toContain(stack.getLogicalId(table.node.defaultChild as CfnBucket));
  }
});

test("the ingest may put and delete the dataset item it claims", () => {
  // The catalog step's conditional put moves currentVersion; a failed first version's claim is
  // deleted; a failed version's items are found by a query of its dataset.
  for (const action of ["dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Query"]) {
    const allowed = statements(INGEST).filter((s) => actions(s).includes(action));
    const resources = JSON.stringify(allowed.map((s) => s.Resource));

    for (const table of [archive.catalogTables.a, archive.catalogTables.b]) {
      expect(resources).toContain(stack.getLogicalId(table.node.defaultChild as CfnBucket));
    }
  }
});

test("the ingest may delete only under the archive's open/ and restricted/, and no object version", () => {
  const archiveId = logicalId(archive.archiveBucket);
  const all = statements(INGEST).filter((s) => JSON.stringify(s.Resource).includes(archiveId));
  const deletes = all.filter((s) => actions(s).includes("s3:DeleteObject"));

  expect(deletes).toHaveLength(1);
  const resources = JSON.stringify(deletes.map((s) => s.Resource));
  expect(resources.match(/"\/[^"]*"/g)?.sort()).toEqual(['"/open/*"', '"/restricted/*"']);
  // A delete adds a delete marker; the stored version and its Object Lock retention stay.
  const granted = all.flatMap(actions);
  expect(granted).not.toContain("s3:DeleteObjectVersion");
  expect(granted).not.toContain("s3:BypassGovernanceRetention");
  expect(granted.filter((a) => a.includes("*"))).toEqual([]);
});

test("the ingest may scan either catalog table, to rewrite the catalog file at publish", () => {
  const scans = statements(INGEST).filter((s) => actions(s).includes("dynamodb:Scan"));
  const resources = JSON.stringify(scans.map((s) => s.Resource));

  for (const table of [archive.catalogTables.a, archive.catalogTables.b]) {
    expect(resources).toContain(stack.getLogicalId(table.node.defaultChild as CfnBucket));
  }
});

test("the ingest may call Bedrock only with the embeddings module, to embed what it publishes", () => {
  const embedded = new Stack(testApp(), "E");
  new ResearchArchive(embedded, "Archive", {
    config: {
      publisher: "P",
      infrastructure: {
        alertEmail: "a@example.org",
        stages: [{ name: "prod" }],
        modules: { embeddings: {} },
      },
    },
    stage: "prod",
  });
  const withModule = Template.fromStack(embedded);
  const [ingest] = Object.values(
    withModule.findResources("AWS::Lambda::Function", { Properties: { Handler: INGEST } }),
  ) as { Properties: { Role: { "Fn::GetAtt": string[] } } }[];
  const granted = Object.values(
    withModule.findResources("AWS::IAM::Policy", {
      Properties: { Roles: [{ Ref: ingest!.Properties.Role["Fn::GetAtt"][0] }] },
    }),
  ).flatMap((p) =>
    (
      p as { Properties: { PolicyDocument: { Statement: Statement[] } } }
    ).Properties.PolicyDocument.Statement.flatMap(actions),
  );

  expect(granted).toContain("bedrock:InvokeModel");
  expect(statements(INGEST).flatMap(actions)).not.toContain("bedrock:InvokeModel");
});

test("the submissions function may list the pool's users, a group's members and a user's groups", () => {
  const onPool = statements(SUBMISSIONS)
    .flatMap(actions)
    .filter((action) => action.startsWith("cognito-idp:"));
  expect(onPool.sort()).toEqual([
    "cognito-idp:AdminListGroupsForUser",
    "cognito-idp:ListUsers",
    "cognito-idp:ListUsersInGroup",
  ]);
});

test("the submissions function may read a profile, and nothing else of UserProfiles", () => {
  const profiles = logicalId(archive.userProfiles);
  const onProfiles = statements(SUBMISSIONS)
    .filter((s) => JSON.stringify(s.Resource).includes(profiles))
    .flatMap(actions);
  expect(onProfiles).toEqual(["dynamodb:GetItem"]);
});

test("the submissions function may read the archive config, so a check runs the archive's rules", () => {
  const reads = statements(SUBMISSIONS).filter((s) => actions(s).includes("ssm:GetParameter"));
  const configId = stack.getLogicalId(
    archive.archiveConfigParameter.node.defaultChild as CfnBucket,
  );
  expect(JSON.stringify(reads.map((s) => s.Resource))).toContain(configId);
  const { properties } = fn(SUBMISSIONS);
  const variables = (properties.Environment as { Variables: Record<string, unknown> }).Variables;
  expect(variables.ARCHIVE_CONFIG_PARAMETER).toEqual({ Ref: configId });
});

const DOI_PARAMETER = "/research-archive/prod/datacite-password";

function doiTemplate(): Template {
  const doiStack = new Stack(testApp(), "Doi");
  new ResearchArchive(doiStack, "Archive", {
    config: {
      publisher: "P",
      infrastructure: { alertEmail: "a@example.org", stages: [{ name: "prod" }] },
      doi: { repository: "EXAMPLE.IRC", prefix: "10.5072", test: true },
    },
    stage: "prod",
  });
  return Template.fromStack(doiStack);
}

function grantsDoi(found: Template, handler: string): { variable: unknown; grant: boolean } {
  const [, resource] = Object.entries(
    found.findResources("AWS::Lambda::Function", { Properties: { Handler: handler } }),
  )[0] as [
    string,
    {
      Properties: {
        Role: { "Fn::GetAtt": string[] };
        Environment?: { Variables?: Record<string, unknown> };
      };
    },
  ];
  const role = resource.Properties.Role["Fn::GetAtt"][0];
  const policies = found.findResources("AWS::IAM::Policy", {
    Properties: { Roles: [{ Ref: role }] },
  });
  const all = Object.values(policies).flatMap(
    (p) =>
      (p as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties
        .PolicyDocument.Statement,
  );
  const grant = all.some(
    (s) =>
      actions(s).includes("ssm:GetParameter") &&
      JSON.stringify(s.Resource).includes(`parameter${DOI_PARAMETER}`),
  );
  return {
    variable: resource.Properties.Environment?.Variables?.DATACITE_PASSWORD_PARAMETER,
    grant,
  };
}

test("with no doi block the ingest function gets no DataCite password", () => {
  expect(grantsDoi(template, INGEST)).toEqual({ variable: undefined, grant: false });
  expect(JSON.stringify(template.toJSON())).not.toContain("datacite-password");
});

test("with a doi block the ingest function may read the DataCite password parameter", () => {
  expect(grantsDoi(doiTemplate(), INGEST)).toEqual({ variable: DOI_PARAMETER, grant: true });
});

test("with a domain, ingest is told the domain as the site's address", () => {
  const { template: t } = domainArchive();
  const [ingest] = Object.values(
    t.findResources("AWS::Lambda::Function", { Properties: { Handler: INGEST } }),
  );

  expect(ingest?.Properties.Environment.Variables.SITE_DOMAIN).toBe("data.example.org");
});
