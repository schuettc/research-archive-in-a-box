import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { expect, test } from "vitest";
import { ResearchArchive } from "../src/research-archive";
import { testApp } from "./test-app";

function build(name: string, keepData?: boolean): Template {
  const stack = new Stack(testApp(), "S");
  new ResearchArchive(stack, "Archive", {
    config: {
      publisher: "P",
      infrastructure: {
        alertEmail: "a@example.org",
        stages: [{ name, ...(keepData === undefined ? {} : { keepData }) }],
      },
    },
    stage: name,
  });
  return Template.fromStack(stack);
}

const KEPT_TYPES = [
  ["AWS::S3::Bucket", 3],
  ["AWS::DynamoDB::Table", 10],
  ["AWS::Cognito::UserPool", 1],
] as const;

/** The stage's buckets, tables, user pool and log groups, with how many log groups there are. */
function dataResources(template: Template) {
  const kept = KEPT_TYPES.flatMap(([type, count]) => {
    const found = Object.values(template.findResources(type));
    expect(found).toHaveLength(count);
    return found;
  });
  const logGroups = Object.values(template.findResources("AWS::Logs::LogGroup"));
  expect(logGroups.length).toBeGreaterThan(0);
  return [...kept, ...logGroups];
}

test.each([
  ["left out", undefined],
  ["true", true],
])("a stage keeps its data whatever its name, when keepData is %s", (_, keepData) => {
  const template = build("dev", keepData);

  for (const resource of dataResources(template)) {
    expect(resource.DeletionPolicy).toBe("Retain");
  }
  for (const table of Object.values(template.findResources("AWS::DynamoDB::Table"))) {
    expect(table.Properties.DeletionProtectionEnabled).toBe(true);
  }
  const [pool] = Object.values(template.findResources("AWS::Cognito::UserPool"));
  expect(pool?.Properties.DeletionProtection).toBe("ACTIVE");
  expect(template.findResources("Custom::S3AutoDeleteObjects")).toEqual({});
  template.resourceCountIs("AWS::Cognito::UserPoolClient", 1);
  const outputs = Object.keys(template.toJSON().Outputs);
  expect(outputs).not.toContain("E2eClientId");
  expect(outputs).not.toContain("UserPoolId");
  expect(JSON.stringify(template.toJSON())).not.toContain("localhost:5199");
});

test("a stage named prod with keepData: false is disposable and has the test conveniences", () => {
  const template = build("prod", false);

  for (const resource of dataResources(template)) {
    expect(resource.DeletionPolicy).toBe("Delete");
  }
  for (const table of Object.values(template.findResources("AWS::DynamoDB::Table"))) {
    expect(table.Properties.DeletionProtectionEnabled).not.toBe(true);
  }
  const [pool] = Object.values(template.findResources("AWS::Cognito::UserPool"));
  expect(pool?.Properties.DeletionProtection).not.toBe("ACTIVE");
  expect(Object.keys(template.findResources("Custom::S3AutoDeleteObjects"))).toHaveLength(3);
  template.resourceCountIs("AWS::Cognito::UserPoolClient", 2);
  const outputs = Object.keys(template.toJSON().Outputs);
  expect(outputs).toContain("E2eClientId");
  expect(outputs).toContain("UserPoolId");
  expect(JSON.stringify(template.toJSON())).toContain("http://localhost:5199");
});
