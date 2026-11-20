import { Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { expect, test } from "vitest";
import { ResearchArchive } from "../src/research-archive";
import { testApp } from "./test-app";

function archive(waf?: boolean, requestsPerAddressPerFiveMinutes?: number): { template: Template } {
  const stack = new Stack(testApp(), "S");
  new ResearchArchive(stack, "Archive", {
    config: {
      publisher: "P",
      infrastructure: {
        alertEmail: "a@example.org",
        stages: [{ name: "prod" }],
        ...(waf === undefined ? {} : { modules: { waf } }),
        ...(requestsPerAddressPerFiveMinutes === undefined
          ? {}
          : { requestsPerAddressPerFiveMinutes }),
      },
    },
    stage: "prod",
  });
  return { template: Template.fromStack(stack) };
}

function resourceId(template: Template, type: string, pathPart: string): string {
  const [id] = Object.entries(
    template.findResources(type, { Properties: { PathPart: pathPart } }),
  ).map(([key]) => key);
  if (!id) throw new Error(`no ${type} ${pathPart}`);
  return id;
}

test("health is public and whoami uses the Cognito authorizer", () => {
  const { template } = archive();
  const health = resourceId(template, "AWS::ApiGateway::Resource", "health");
  const whoami = resourceId(template, "AWS::ApiGateway::Resource", "whoami");
  const [authorizer] = Object.keys(template.findResources("AWS::ApiGateway::Authorizer"));

  template.hasResourceProperties("AWS::ApiGateway::Authorizer", { Type: "COGNITO_USER_POOLS" });
  template.hasResourceProperties("AWS::ApiGateway::Method", {
    HttpMethod: "GET",
    ResourceId: { Ref: health },
    AuthorizationType: "NONE",
  });
  template.hasResourceProperties("AWS::ApiGateway::Method", {
    HttpMethod: "GET",
    ResourceId: { Ref: whoami },
    AuthorizationType: "COGNITO_USER_POOLS",
    AuthorizerId: { Ref: authorizer },
  });
  template.hasResourceProperties("AWS::ApiGateway::RestApi", {
    EndpointConfiguration: { Types: ["REGIONAL"] },
  });
});

test("the stage throttles at 50 per second with a burst of 100", () => {
  archive().template.hasResourceProperties("AWS::ApiGateway::Stage", {
    MethodSettings: Match.arrayWith([
      Match.objectLike({
        HttpMethod: "*",
        ResourcePath: "/*",
        ThrottlingRateLimit: 50,
        ThrottlingBurstLimit: 100,
        MetricsEnabled: true,
      }),
    ]),
  });
});

test("a config with no modules block has the web ACL with the per-address rule; waf: false has none", () => {
  const left = archive().template;
  left.resourceCountIs("AWS::WAFv2::WebACL", 1);
  left.resourceCountIs("AWS::WAFv2::WebACLAssociation", 2);
  const [acl] = Object.values(left.findResources("AWS::WAFv2::WebACL"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const limit = acl?.Properties.Rules.find((rule: any) => rule.Name === "ApiRateLimit");
  expect(limit.Statement.RateBasedStatement.Limit).toBe(2000);

  const off = archive(false).template;
  off.resourceCountIs("AWS::WAFv2::WebACL", 0);
  off.resourceCountIs("AWS::WAFv2::WebACLAssociation", 0);
  off.resourceCountIs("AWS::ApiGateway::ApiKey", 0);
});

test("requestsPerAddressPerFiveMinutes sets the per-address rule's limit", () => {
  const [acl] = Object.values(archive(undefined, 500).template.findResources("AWS::WAFv2::WebACL"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const limit = acl?.Properties.Rules.find((rule: any) => rule.Name === "ApiRateLimit");
  expect(limit.Statement.RateBasedStatement.Limit).toBe(500);
});

test.each([undefined, false])(
  "the usage route has its own throttle of 5 a second (modules.waf: %s)",
  (waf) => {
    archive(waf).template.hasResourceProperties("AWS::ApiGateway::Stage", {
      MethodSettings: Match.arrayWith([
        Match.objectLike({
          HttpMethod: "POST",
          ResourcePath: "/~1api~1datasets~1{id}~1usage",
          ThrottlingRateLimit: 5,
          ThrottlingBurstLimit: 5,
        }),
      ]),
    });
  },
);

test("WAF appears unless modules.waf is false, associated with the API stage", () => {
  const off = archive(false).template;
  off.resourceCountIs("AWS::WAFv2::WebACL", 0);
  off.resourceCountIs("AWS::WAFv2::WebACLAssociation", 0);

  const { template } = archive(true);
  const [stage] = Object.keys(template.findResources("AWS::ApiGateway::Stage"));
  const [acl] = Object.keys(template.findResources("AWS::WAFv2::WebACL"));
  const rules = template
    .toJSON()
    .Resources[acl!].Properties.Rules.map(
      (rule: { Statement: { ManagedRuleGroupStatement?: { Name: string } } }) =>
        rule.Statement.ManagedRuleGroupStatement?.Name,
    );
  template.hasResourceProperties("AWS::WAFv2::WebACL", {
    Scope: "REGIONAL",
    DefaultAction: { Allow: {} },
  });
  expect(rules.filter(Boolean)).toEqual([
    "AWSManagedRulesCommonRuleSet",
    "AWSManagedRulesKnownBadInputsRuleSet",
    "AWSManagedRulesAmazonIpReputationList",
  ]);
  template.hasResourceProperties("AWS::WAFv2::WebACLAssociation", {
    WebACLArn: { "Fn::GetAtt": [acl, "Arn"] },
  });
  const associations = Object.values(template.findResources("AWS::WAFv2::WebACLAssociation"));
  expect(associations.some((a) => JSON.stringify(a.Properties.ResourceArn).includes(stage!))).toBe(
    true,
  );
});

test("with WAF on, the same web ACL guards the user pool and rate-limits its sign-up and sign-in calls per address", () => {
  archive(false).template.resourceCountIs("AWS::WAFv2::WebACLAssociation", 0);

  const { template } = archive(true);
  const [pool] = Object.keys(template.findResources("AWS::Cognito::UserPool"));
  const [acl] = Object.keys(template.findResources("AWS::WAFv2::WebACL"));
  template.resourceCountIs("AWS::WAFv2::WebACL", 1);
  template.hasResourceProperties("AWS::WAFv2::WebACLAssociation", {
    WebACLArn: { "Fn::GetAtt": [acl, "Arn"] },
    ResourceArn: { "Fn::GetAtt": [pool, "Arn"] },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rules: any[] = template.toJSON().Resources[acl!].Properties.Rules;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const targets = (rule: any): string[] =>
    rule.Statement.RateBasedStatement.ScopeDownStatement.OrStatement.Statements.map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (s: any) => {
        // WAF reads SingleHeader as raw JSON, so its key must be Name, as CloudFormation expects.
        expect(s.ByteMatchStatement.FieldToMatch).toEqual({
          SingleHeader: { Name: "x-amz-target" },
        });
        return String(s.ByteMatchStatement.SearchString).replace(
          "AWSCognitoIdentityProviderService.",
          "",
        );
      },
    );

  const signIn = rules.find((rule) => rule.Name === "SignInRateLimit");
  expect(signIn).toMatchObject({
    Action: { Block: {} },
    Statement: { RateBasedStatement: { AggregateKeyType: "IP", Limit: 100 } },
  });
  expect(targets(signIn).sort()).toEqual(
    ["ConfirmForgotPassword", "ConfirmSignUp", "InitiateAuth", "RespondToAuthChallenge"].sort(),
  );

  // The calls that send an email get WAF's lowest limit over a minute, so one address can't
  // spend the account's 50 Cognito emails a day.
  const email = rules.find((rule) => rule.Name === "EmailRateLimit");
  expect(email).toMatchObject({
    Action: { Block: {} },
    Statement: {
      RateBasedStatement: { AggregateKeyType: "IP", Limit: 10, EvaluationWindowSec: 60 },
    },
  });
  expect(targets(email).sort()).toEqual(["ForgotPassword", "ResendConfirmationCode", "SignUp"]);
  expect(new Set(rules.map((rule) => rule.Priority)).size).toBe(rules.length);
});

test("with WAF on, every method needs the key CloudFront sends, from one usage plan on the stage", () => {
  const { template } = archive(true);
  const methods = Object.values(template.findResources("AWS::ApiGateway::Method"));
  expect(methods.length).toBeGreaterThan(10);
  for (const method of methods) expect(method.Properties.ApiKeyRequired).toBe(true);
  template.resourceCountIs("AWS::ApiGateway::ApiKey", 1);
  template.resourceCountIs("AWS::ApiGateway::UsagePlan", 1);
  template.resourceCountIs("AWS::ApiGateway::UsagePlanKey", 1);
  // API Gateway makes the value: the template names none.
  const [key] = Object.values(template.findResources("AWS::ApiGateway::ApiKey"));
  expect(key?.Properties.Value).toBeUndefined();

  const off = archive(false).template;
  off.resourceCountIs("AWS::ApiGateway::ApiKey", 0);
  for (const method of Object.values(off.findResources("AWS::ApiGateway::Method"))) {
    expect(method.Properties.ApiKeyRequired ?? false).toBe(false);
  }
});

test("with WAF on, one rule limits each visitor address to 2,000 API requests in five minutes", () => {
  const { template } = archive(true);
  const [acl] = Object.keys(template.findResources("AWS::WAFv2::WebACL"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rules: any[] = template.toJSON().Resources[acl!].Properties.Rules;
  expect(rules).toHaveLength(7);
  expect(new Set(rules.map((rule) => rule.Priority)).size).toBe(7);
  const limit = rules.find((rule) => rule.Name === "ApiRateLimit");
  expect(limit).toMatchObject({
    Action: { Block: {} },
    Statement: {
      RateBasedStatement: {
        AggregateKeyType: "CUSTOM_KEYS",
        Limit: 2000,
        EvaluationWindowSec: 300,
        CustomKeys: [
          {
            Header: {
              Name: "x-viewer-address",
              TextTransformations: [{ Priority: 0, Type: "NONE" }],
            },
          },
        ],
        ScopeDownStatement: {
          ByteMatchStatement: {
            FieldToMatch: { SingleHeader: { Name: "x-api-key" } },
            PositionalConstraint: "EXACTLY",
            TextTransformations: [{ Priority: 0, Type: "NONE" }],
          },
        },
      },
    },
  });
  // The value compared is the key's own, read at deploy: a reference, never text in the template.
  const search =
    limit.Statement.RateBasedStatement.ScopeDownStatement.ByteMatchStatement.SearchString;
  expect(search).toHaveProperty("Fn::GetAtt");
});

test("with WAF on, the web ACL takes API requests only with the key CloudFront sends", () => {
  const { template } = archive(true);
  const [acl] = Object.keys(template.findResources("AWS::WAFv2::WebACL"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rules: any[] = template.toJSON().Resources[acl!].Properties.Rules;
  expect(rules).toHaveLength(7);
  const through = rules.find((rule) => rule.Name === "ApiThroughSite");
  expect(through).toMatchObject({
    Action: { Block: {} },
    Statement: {
      AndStatement: {
        Statements: [
          {
            ByteMatchStatement: {
              FieldToMatch: { SingleHeader: { Name: "host" } },
              PositionalConstraint: "ENDS_WITH",
              TextTransformations: [{ Priority: 0, Type: "LOWERCASE" }],
            },
          },
          {
            NotStatement: {
              Statement: {
                ByteMatchStatement: {
                  FieldToMatch: { SingleHeader: { Name: "x-api-key" } },
                  PositionalConstraint: "EXACTLY",
                  TextTransformations: [{ Priority: 0, Type: "NONE" }],
                },
              },
            },
          },
        ],
      },
    },
  });
  // Only the API's own address ends this way; the user pool's requests carry another host.
  const [host, notKey] = through.Statement.AndStatement.Statements;
  expect(JSON.stringify(host.ByteMatchStatement.SearchString)).toMatch(
    /^\{"Fn::Join":\["",\["\.execute-api\.",\{"Ref":"AWS::Region"\},"\.",\{"Ref":"AWS::URLSuffix"\}\]\]\}$/,
  );
  // The key compared is the one the per-address limit counts by.
  const limit = rules.find((rule) => rule.Name === "ApiRateLimit");
  expect(notKey.NotStatement.Statement.ByteMatchStatement.SearchString).toEqual(
    limit.Statement.RateBasedStatement.ScopeDownStatement.ByteMatchStatement.SearchString,
  );
  // It is evaluated before every rate rule.
  for (const rule of rules.filter((r) => r.Statement.RateBasedStatement)) {
    expect(through.Priority).toBeLessThan(rule.Priority);
  }

  archive(false).template.resourceCountIs("AWS::WAFv2::WebACL", 0);
});

test("the integrity check runs weekly with no retries", () => {
  const { template } = archive();
  const fns = template.findResources("AWS::Lambda::Function", {
    Properties: { Handler: "archive_backend.integrity.handler" },
  });
  const [fnId] = Object.keys(fns);

  expect(Object.values(fns)[0]?.Properties).toMatchObject({
    Timeout: 900,
    Environment: {
      Variables: { ARCHIVE_BUCKET: expect.anything(), ALERT_TOPIC_ARN: expect.anything() },
    },
  });
  template.hasResourceProperties("AWS::Scheduler::Schedule", {
    ScheduleExpression: "rate(7 days)",
    Target: {
      Arn: { "Fn::GetAtt": [fnId, "Arn"] },
      RetryPolicy: { MaximumRetryAttempts: 0 },
    },
  });
  template.hasResourceProperties("AWS::Lambda::EventInvokeConfig", {
    FunctionName: { Ref: fnId },
    MaximumRetryAttempts: 0,
  });
});

test("API 5xx alarms on the alert topic, and the dashboard graphs 4xx and 5xx", () => {
  const { template } = archive();
  const [restApi] = Object.keys(template.findResources("AWS::ApiGateway::RestApi"));
  const [topic] = Object.keys(template.findResources("AWS::SNS::Topic"));
  const apiName = template.toJSON().Resources[restApi!].Properties.Name;

  template.hasResourceProperties("AWS::CloudWatch::Alarm", {
    Namespace: "AWS/ApiGateway",
    MetricName: "5XXError",
    Dimensions: [{ Name: "ApiName", Value: apiName }],
    Statistic: "Sum",
    Period: 300,
    Threshold: 1,
    ComparisonOperator: "GreaterThanOrEqualToThreshold",
    TreatMissingData: "notBreaching",
    AlarmActions: [{ Ref: topic }],
  });
  template.resourcePropertiesCountIs(
    "AWS::CloudWatch::Alarm",
    { Namespace: "AWS/ApiGateway", MetricName: "4XXError" },
    0,
  );
  const body = JSON.stringify(
    Object.values(template.findResources("AWS::CloudWatch::Dashboard"))[0]?.Properties
      .DashboardBody,
  );
  expect(body).toContain("4XXError");
  expect(body).toContain("5XXError");
});
