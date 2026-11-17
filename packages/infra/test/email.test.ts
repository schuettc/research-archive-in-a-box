import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Match } from "aws-cdk-lib/assertions";
import { expect, test } from "vitest";
import { IS_COMPLETE_SOURCE } from "../src/email";
import { domainArchive } from "./test-app";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

function idOf(resources: Record<string, Json>): string {
  const ids = Object.keys(resources);
  expect(ids).toHaveLength(1);
  return ids[0]!;
}

test("with email: ses the domain is an SES identity with Easy DKIM and no MAIL FROM", () => {
  const { template } = domainArchive("prod", { email: "ses" });

  const identities = template.findResources("AWS::SES::EmailIdentity");
  idOf(identities);
  // CDK's default is Easy DKIM with a 2048-bit key, which it writes as no attributes at all.
  expect(Object.values(identities)[0]?.Properties).toEqual({ EmailIdentity: "data.example.org" });
});

test("the identity's three DKIM CNAMEs go into the hosted zone beside the A and AAAA aliases", () => {
  const { template } = domainArchive("prod", { email: "ses" });
  const identity = idOf(template.findResources("AWS::SES::EmailIdentity"));

  const cnames = Object.values(
    template.findResources("AWS::Route53::RecordSet", { Properties: { Type: "CNAME" } }),
  );
  expect(cnames).toHaveLength(3);
  cnames.forEach((record, i) => {
    expect(record.Properties).toEqual({
      HostedZoneId: "Z0123456789ABCDEF",
      Type: "CNAME",
      TTL: "1800",
      Name: { "Fn::GetAtt": [identity, `DkimDNSTokenName${i + 1}`] },
      ResourceRecords: [{ "Fn::GetAtt": [identity, `DkimDNSTokenValue${i + 1}`] }],
    });
  });
  for (const type of ["A", "AAAA"]) {
    template.resourcePropertiesCountIs("AWS::Route53::RecordSet", { Type: type }, 1);
  }
});

test("a custom resource waits for the identity, after its records, for 55 minutes, inside CloudFormation's own hour", () => {
  const { template } = domainArchive("prod", { email: "ses" });
  const records = Object.keys(
    template.findResources("AWS::Route53::RecordSet", { Properties: { Type: "CNAME" } }),
  );

  const waiters = template.findResources("Custom::SesIdentityVerified");
  idOf(waiters);
  const waiter = Object.values(waiters)[0]!;
  expect(waiter.Properties.Identity).toBe("data.example.org");
  expect([...waiter.DependsOn].sort()).toEqual(expect.arrayContaining(records.sort()));

  // The provider polls isComplete every 30 seconds, 110 times: 55 minutes, so its own error
  // shows before CloudFormation's one-hour wait for a custom resource runs out.
  const machines = Object.values(template.findResources("AWS::StepFunctions::StateMachine"));
  expect(machines).toHaveLength(1);
  const definition = JSON.stringify(machines[0]?.Properties.DefinitionString);
  expect(definition).toContain('\\"IntervalSeconds\\":30,\\"MaxAttempts\\":110');
});

test("the isComplete function may only read the identity", () => {
  const { template } = domainArchive("prod", { email: "ses" });
  const identity = idOf(template.findResources("AWS::SES::EmailIdentity"));

  const functions = template.findResources("AWS::Lambda::Function", {
    Properties: { Handler: "index.is_complete", Runtime: "python3.13" },
  });
  const role = Object.values(functions)[0]?.Properties.Role["Fn::GetAtt"][0];
  const policies = Object.values(
    template.findResources("AWS::IAM::Policy", {
      Properties: { Roles: [{ Ref: role }] },
    }),
  );
  expect(policies).toHaveLength(1);
  const statements = policies[0]?.Properties.PolicyDocument.Statement as Json[];
  expect(statements).toHaveLength(1);
  expect(statements[0]?.Action).toBe("ses:GetEmailIdentity");
  expect(JSON.stringify(statements[0]?.Resource)).toContain(`identity/`);
  expect(JSON.stringify(statements[0]?.Resource)).toContain(identity);
  template.hasResourceProperties("AWS::Lambda::Function", {
    Handler: "index.on_event",
    Runtime: "python3.13",
    LoggingConfig: { LogGroup: Match.anyValue() },
  });
});

function isComplete(event: Json, verified: boolean): { result: Json; calls: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "is-complete-"));
  writeFileSync(join(dir, "index.py"), IS_COMPLETE_SOURCE);
  writeFileSync(
    join(dir, "boto3.py"),
    [
      "calls = []",
      "class _SesV2:",
      "    def get_email_identity(self, EmailIdentity):",
      "        calls.append(EmailIdentity)",
      `        return {"VerifiedForSendingStatus": ${verified ? "True" : "False"}}`,
      "def client(name):",
      "    assert name == 'sesv2', name",
      "    return _SesV2()",
    ].join("\n"),
  );
  const script =
    "import json, sys\n" +
    "sys.path.insert(0, sys.argv[1])\n" +
    "import boto3, index\n" +
    "result = index.is_complete(json.loads(sys.argv[2]), None)\n" +
    "print(json.dumps({'result': result, 'calls': boto3.calls}))\n";
  const run = spawnSync("python3", ["-I", "-c", script, dir, JSON.stringify(event)], {
    encoding: "utf-8",
  });
  expect(run.stderr).toBe("");
  return JSON.parse(run.stdout) as { result: Json; calls: string[] };
}

test("isComplete reports SES's verified status, and completes a delete without asking SES", () => {
  const event = { RequestType: "Create", ResourceProperties: { Identity: "data.example.org" } };

  expect(isComplete(event, false)).toEqual({
    result: { IsComplete: false },
    calls: ["data.example.org"],
  });
  expect(isComplete({ ...event, RequestType: "Update" }, true)).toEqual({
    result: { IsComplete: true },
    calls: ["data.example.org"],
  });
  expect(isComplete({ ...event, RequestType: "Delete" }, false)).toEqual({
    result: { IsComplete: true },
    calls: [],
  });
});
