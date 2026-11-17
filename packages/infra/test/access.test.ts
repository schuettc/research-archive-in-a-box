import { Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import type { CfnTable } from "aws-cdk-lib/aws-dynamodb";
import { beforeAll, expect, test } from "vitest";
import { ResearchArchive } from "../src/research-archive";
import { testApp } from "./test-app";

let archive: ResearchArchive;
let stack: Stack;
let template: Template;

type Statement = { Action: string | string[]; Resource: unknown; Condition?: unknown };

const ACCESS = "archive_backend.access.handler";

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

function fn(): { id: string; properties: Record<string, unknown> } {
  const fns = template.findResources("AWS::Lambda::Function", {
    Properties: { Handler: ACCESS },
  });
  expect(Object.keys(fns)).toHaveLength(1);
  const [id, resource] = Object.entries(fns)[0] as [
    string,
    { Properties: Record<string, unknown> },
  ];
  return { id, properties: resource.Properties };
}

function statements(): Statement[] {
  const role = (fn().properties.Role as { "Fn::GetAtt": string[] })["Fn::GetAtt"][0]!;
  const policies = template.findResources("AWS::IAM::Policy", {
    Properties: { Roles: [{ Ref: role }] },
  });
  return Object.values(policies).flatMap(
    (p) =>
      (p as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties
        .PolicyDocument.Statement,
  );
}

function actions(statement: { Action: string | string[] }): string[] {
  return Array.isArray(statement.Action) ? statement.Action : [statement.Action];
}

function logicalId(construct: { node: { defaultChild?: unknown } }): string {
  return stack.getLogicalId(construct.node.defaultChild as CfnTable);
}

function service(prefix: string): Statement[] {
  return statements().filter((s) => actions(s).some((a) => a.startsWith(`${prefix}:`)));
}

test("the access function reads its pool, tables and topic from its environment", () => {
  const env = fn().properties.Environment as { Variables: Record<string, unknown> };

  expect(env.Variables).toEqual({
    USER_POOL_ID: { Ref: logicalId(archive.userPool) },
    USER_PROFILES_TABLE: { Ref: logicalId(archive.userProfiles) },
    ACCOUNT_EVENTS_TABLE: { Ref: logicalId(archive.accountEvents) },
    ADMINS_TOPIC_ARN: { Ref: logicalId(archive.adminsTopic) },
    ACCESS_TABLE: { Ref: logicalId(archive.access) },
    ACTIVE_CATALOG_PARAMETER: { Ref: logicalId(archive.activeCatalogParameter) },
    CATALOG_TABLE_A: { Ref: logicalId(archive.catalogTables.a) },
    CATALOG_TABLE_B: { Ref: logicalId(archive.catalogTables.b) },
  });
});

test("its role allows exactly the people routes' Cognito calls, on the pool", () => {
  expect(service("cognito-idp")).toEqual([
    expect.objectContaining({
      Action: [
        "cognito-idp:ListUsers",
        "cognito-idp:AdminListGroupsForUser",
        "cognito-idp:AdminCreateUser",
        "cognito-idp:AdminAddUserToGroup",
        "cognito-idp:AdminRemoveUserFromGroup",
        "cognito-idp:AdminDisableUser",
        "cognito-idp:AdminEnableUser",
        "cognito-idp:AdminUserGlobalSignOut",
      ],
      Resource: { "Fn::GetAtt": [logicalId(archive.userPool), "Arn"] },
    }),
  ]);
});

test("in DynamoDB it may read and mark profiles, add and read account events and access items, and read the catalog's dataset items", () => {
  const on = (construct: { node: { defaultChild?: unknown } }): string[] => {
    const id = logicalId(construct);
    const found = service("dynamodb").filter((s) => JSON.stringify(s.Resource).includes(`"${id}"`));
    expect(found).toHaveLength(1);
    return actions(found[0]!).sort();
  };

  expect(service("dynamodb")).toHaveLength(5);
  expect(on(archive.userProfiles)).toEqual(["dynamodb:GetItem", "dynamodb:UpdateItem"]);
  expect(on(archive.accountEvents)).toEqual(["dynamodb:PutItem", "dynamodb:Query"]);
  expect(on(archive.access)).toEqual(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Scan"]);
  expect(on(archive.catalogTables.a)).toEqual(["dynamodb:GetItem"]);
  expect(on(archive.catalogTables.b)).toEqual(["dynamodb:GetItem"]);
});

test("it may read the active-catalog parameter and no other", () => {
  const ssm = service("ssm");

  expect(ssm).toHaveLength(1);
  expect(actions(ssm[0]!)).toContain("ssm:GetParameter");
  expect(JSON.stringify(ssm[0]!.Resource)).toContain(logicalId(archive.activeCatalogParameter));
});

test("it may subscribe only emails to the Admins topic, list and end them, publish to it, and nothing else in SNS", () => {
  const topic = { Ref: logicalId(archive.adminsTopic) };
  const sns = service("sns");
  expect(sns).toEqual([
    expect.objectContaining({
      Action: "sns:Subscribe",
      Resource: topic,
      Condition: { StringEquals: { "sns:Protocol": "email" } },
    }),
    expect.objectContaining({
      Action: ["sns:ListSubscriptionsByTopic", "sns:Unsubscribe", "sns:Publish"],
      Resource: topic,
    }),
  ]);
  expect(sns[1]).not.toHaveProperty("Condition");
});

test("the Admins topic is the archive's own", () => {
  template.hasResourceProperties("AWS::SNS::Topic", {
    DisplayName: "Research archive admins",
  });
});

test("each people and access route has its method behind the Cognito authorizer", () => {
  const [authorizer] = Object.keys(template.findResources("AWS::ApiGateway::Authorizer"));
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
  const admin = resource("admin");
  const people = resource("people", admin);
  const sub = resource("{sub}", people);
  const routes: [string, string][] = [
    ["GET", people],
    ["POST", people],
    ["PUT", resource("roles", sub)],
    ["POST", resource("resend", sub)],
    ["POST", resource("disable", sub)],
    ["POST", resource("enable", sub)],
    ["GET", resource("account-events", admin)],
  ];
  const requests = resource("access-requests", admin);
  const asked = resource("{sub}", resource("{dataset}", requests));
  // /api/admin/datasets exists too (the curation routes), so name the parent.
  const dataset = resource("{id}", resource("datasets", resource("api")));
  routes.push(
    ["GET", resource("access", dataset)],
    ["POST", resource("access-requests", dataset)],
    ["GET", requests],
    ["POST", resource("decision", asked)],
    ["POST", resource("take-back", asked)],
  );

  for (const [method, resourceId] of routes) {
    template.hasResourceProperties("AWS::ApiGateway::Method", {
      HttpMethod: method,
      ResourceId: { Ref: resourceId },
      AuthorizationType: "COGNITO_USER_POOLS",
      AuthorizerId: { Ref: authorizer },
      Integration: {
        Uri: { "Fn::Join": ["", Match.arrayWith([{ "Fn::GetAtt": [fn().id, "Arn"] }])] },
      },
    });
  }
});
