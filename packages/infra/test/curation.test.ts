import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, expect, test } from "vitest";
import { ResearchArchive } from "../src/research-archive";
import { domainArchive, testApp } from "./test-app";

let stack: Stack;
let template: Template;

beforeAll(() => {
  stack = new Stack(testApp(), "S");
  new ResearchArchive(stack, "Archive", {
    config: {
      publisher: "P",
      infrastructure: { alertEmail: "a@example.org", stages: [{ name: "prod" }] },
    },
    stage: "prod",
  });
  template = Template.fromStack(stack);
});

type Resource = { Type: string; Properties: Record<string, unknown> };

function fn(handler: string): { id: string; properties: Record<string, unknown> } {
  const fns = template.findResources("AWS::Lambda::Function", {
    Properties: { Handler: handler },
  });
  expect(Object.keys(fns)).toHaveLength(1);
  const [id, resource] = Object.entries(fns)[0] as [string, Resource];
  return { id, properties: resource.Properties };
}

function statements(handler: string): { Action: string | string[]; Resource: unknown }[] {
  const { id } = fn(handler);
  const resources = template.toJSON().Resources;
  const role = (resources[id].Properties.Role as { "Fn::GetAtt": string[] })["Fn::GetAtt"][0];
  const policies = template.findResources("AWS::IAM::Policy", {
    Properties: { Roles: [{ Ref: role }] },
  });
  return Object.values(policies).flatMap(
    (p) =>
      (p as { Properties: { PolicyDocument: { Statement: never[] } } }).Properties.PolicyDocument
        .Statement,
  );
}

function grants(handler: string, action: string): string[] {
  return statements(handler)
    .filter((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]).includes(action))
    .map((s) => JSON.stringify(s.Resource));
}

/** Every method on the REST API, as `<METHOD> <path>` mapped to its authorization type. */
function methods(): Record<string, string> {
  const resources = template.toJSON().Resources as Record<string, Resource>;
  const pathOf = (id: string | undefined): string => {
    if (!id || resources[id]?.Type !== "AWS::ApiGateway::Resource") return "";
    const props = resources[id].Properties;
    return `${pathOf((props.ParentId as { Ref?: string }).Ref)}/${props.PathPart as string}`;
  };
  const found: Record<string, string> = {};
  for (const resource of Object.values(resources)) {
    if (resource.Type !== "AWS::ApiGateway::Method") continue;
    const props = resource.Properties;
    found[`${props.HttpMethod as string} ${pathOf((props.ResourceId as { Ref?: string }).Ref)}`] =
      props.AuthorizationType as string;
  }
  return found;
}

const CURATION = "archive_backend.curation.handler";
const LIFECYCLE = "archive_backend.lifecycle.handler";

test("the curation routes are signed in, beside the read routes", () => {
  expect(methods()).toMatchObject({
    "POST /api/admin/datasets/{id}/withdraw": "COGNITO_USER_POOLS",
    "POST /api/admin/datasets/{id}/restore": "COGNITO_USER_POOLS",
    "PUT /api/admin/datasets/{id}/embargo": "COGNITO_USER_POOLS",
    "PUT /api/datasets/{id}/versions/{version}/metadata": "COGNITO_USER_POOLS",
    "GET /api/datasets/{id}/versions/{version}": "NONE",
    "GET /api/admin/usage": "COGNITO_USER_POOLS",
  });
});

test("the curation function names the lifecycle by its fixed name and may invoke only it", () => {
  const { properties } = fn(CURATION);
  expect(properties).toMatchObject({
    Environment: { Variables: { LIFECYCLE_FUNCTION: "ResearchArchive-prod-Lifecycle" } },
  });
  expect(fn(LIFECYCLE).properties.FunctionName).toBe("ResearchArchive-prod-Lifecycle");
  const invokes = grants(CURATION, "lambda:InvokeFunction");
  expect(invokes).toHaveLength(1);
  expect(invokes[0]).toContain("function:ResearchArchive-prod-Lifecycle");
});

test("the curation function records its changes in AccountEvents", () => {
  expect(fn(CURATION).properties).toMatchObject({
    Environment: { Variables: { ACCOUNT_EVENTS_TABLE: expect.anything() } },
  });
  const puts = grants(CURATION, "dynamodb:PutItem");
  expect(puts).toHaveLength(1);
  expect(puts[0]).toContain("AccountEvents");
});

test("the curation function writes state/ and the versions it corrects, nothing else", () => {
  const puts = grants(CURATION, "s3:PutObject").join(" ");
  expect(puts).toContain("/state/*");
  for (const prefix of ["open", "restricted"]) {
    for (const name of ["datapackage.json", "README.md", "checksums.sha256"]) {
      expect(puts).toContain(`/${prefix}/*/${name}`);
    }
    // A correction writes only those three names, never a data file.
    expect(puts).not.toContain(`/${prefix}/*"`);
  }
  expect(puts).not.toContain("/site/");
  expect(grants(CURATION, "s3:DeleteObject").join(" ")).not.toContain("/open/*");
  const reads = grants(CURATION, "s3:GetObject").join(" ");
  expect(reads).toContain("/open/*");
  expect(reads).toContain("/restricted/*");
});

test("the curation function reads the caller's disabled mark and live groups, and nothing more", () => {
  expect(fn(CURATION).properties).toMatchObject({
    Environment: {
      Variables: { USER_POOL_ID: expect.anything(), USER_PROFILES_TABLE: expect.anything() },
    },
  });
  const profiles = statements(CURATION).filter((s) =>
    JSON.stringify(s.Resource).includes("UserProfiles"),
  );
  expect(profiles.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]))).toEqual([
    "dynamodb:GetItem",
  ]);
  const cognito = statements(CURATION)
    .flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]))
    .filter((a) => a.startsWith("cognito-idp:"));
  expect(cognito.sort()).toEqual(["cognito-idp:AdminListGroupsForUser", "cognito-idp:ListUsers"]);
  expect(grants(CURATION, "cognito-idp:ListUsers").join(" ")).toContain("UserPool");
});

test("the lifecycle moves data files, rewrites pages and the catalog, and invalidates", () => {
  const { properties } = fn(LIFECYCLE);
  expect(properties).toMatchObject({
    Timeout: 900,
    Environment: {
      Variables: { DISTRIBUTION_ID: expect.anything(), SITE_DOMAIN: expect.anything() },
    },
  });
  for (const action of ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]) {
    const found = grants(LIFECYCLE, action).join(" ");
    expect(found).toContain("/open/*");
    expect(found).toContain("/restricted/*");
  }
  const puts = grants(LIFECYCLE, "s3:PutObject").join(" ");
  expect(puts).toContain("/site/datasets/*");
  expect(puts).toContain("/site/catalog.json");
  expect(puts).toContain("/site/sitemap.xml");
  expect(grants(LIFECYCLE, "cloudfront:CreateInvalidation")).toHaveLength(1);
  template.hasResourceProperties("AWS::Lambda::EventInvokeConfig", {
    FunctionName: { Ref: fn(LIFECYCLE).id },
    MaximumRetryAttempts: 2,
  });
});

test("the lifecycle may abort a multipart copy in the archive's open/ and restricted/", () => {
  const found = grants(LIFECYCLE, "s3:AbortMultipartUpload").join(" ");

  expect(found).toContain("/open/*");
  expect(found).toContain("/restricted/*");
  expect(grants(CURATION, "s3:AbortMultipartUpload")).toEqual([]);
});

test("a lifecycle run whose retries all fail is sent to the alerts topic", () => {
  const topics = Object.keys(template.findResources("AWS::SNS::Topic")).filter((id) =>
    id.includes("AlertTopic"),
  );
  expect(topics).toHaveLength(1);
  template.hasResourceProperties("AWS::Lambda::EventInvokeConfig", {
    FunctionName: { Ref: fn(LIFECYCLE).id },
    DestinationConfig: { OnFailure: { Destination: { Ref: topics[0] } } },
  });
  expect(grants(LIFECYCLE, "sns:Publish")).toEqual([JSON.stringify({ Ref: topics[0] })]);
});

test("the lifecycle runs daily at 00:15 UTC with no retries", () => {
  const schedules = Object.values(template.findResources("AWS::Scheduler::Schedule")).filter((s) =>
    JSON.stringify(s).includes(fn(LIFECYCLE).id),
  ) as Resource[];
  expect(schedules).toHaveLength(1);
  expect(schedules[0]!.Properties).toMatchObject({
    ScheduleExpression: "cron(15 0 * * ? *)",
    Target: { RetryPolicy: { MaximumRetryAttempts: 0 }, Input: "{}" },
  });
});

const DOI_PARAMETER = "/research-archive/prod/datacite-password";

/** The function's DataCite password variable and whether it may read that parameter. */
function doiAccess(found: Template, handler: string): { variable: unknown; grant: boolean } {
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
  const policies = found.findResources("AWS::IAM::Policy", {
    Properties: { Roles: [{ Ref: resource.Properties.Role["Fn::GetAtt"][0] }] },
  });
  const grant = Object.values(policies)
    .flatMap(
      (p) =>
        (
          p as {
            Properties: {
              PolicyDocument: { Statement: { Action: string | string[]; Resource: unknown }[] };
            };
          }
        ).Properties.PolicyDocument.Statement,
    )
    .some(
      (s) =>
        (Array.isArray(s.Action) ? s.Action : [s.Action]).includes("ssm:GetParameter") &&
        JSON.stringify(s.Resource).includes(`parameter${DOI_PARAMETER}`),
    );
  return {
    variable: resource.Properties.Environment?.Variables?.DATACITE_PASSWORD_PARAMETER,
    grant,
  };
}

test("only with a doi block may the lifecycle read the DataCite password, and never the curation function", () => {
  const doiStack = new Stack(testApp(), "Doi");
  new ResearchArchive(doiStack, "Archive", {
    config: {
      publisher: "P",
      infrastructure: { alertEmail: "a@example.org", stages: [{ name: "prod" }] },
      doi: { repository: "EXAMPLE.IRC", prefix: "10.5072", test: true },
    },
    stage: "prod",
  });
  const withDois = Template.fromStack(doiStack);

  expect(doiAccess(template, LIFECYCLE)).toEqual({ variable: undefined, grant: false });
  expect(doiAccess(withDois, LIFECYCLE)).toEqual({ variable: DOI_PARAMETER, grant: true });
  expect(doiAccess(withDois, CURATION)).toEqual({ variable: undefined, grant: false });
});

test("with a domain, the lifecycle is told the domain as the site's address", () => {
  const { template: t } = domainArchive();
  const [lifecycle] = Object.values(
    t.findResources("AWS::Lambda::Function", { Properties: { Handler: LIFECYCLE } }),
  );

  expect(lifecycle?.Properties.Environment.Variables.SITE_DOMAIN).toBe("data.example.org");
});
