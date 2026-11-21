import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import type { CfnDistribution } from "aws-cdk-lib/aws-cloudfront";
import type { CfnParameter } from "aws-cdk-lib/aws-ssm";
import { expect, test } from "vitest";
import { createApp, stackName } from "../bin/app";
import type { ArchiveConfig, Stage } from "../src/generated/archive-config";
import { loadArchiveConfig, stagesOf } from "../src/config";
import { ResearchArchive } from "../src/research-archive";
import { domainArchive, testApp } from "./test-app";

function configFile(yaml: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "archive-config-")), "archive.yaml");
  writeFileSync(path, yaml, "utf-8");
  return path;
}

const INFRASTRUCTURE = "infrastructure:\n  alertEmail: a@example.org\n";

// A fork edits archive.yaml (its stages, its brand), so tests of the committed file check it
// against what the file says, never against upstream's values.
const COMMITTED = fileURLToPath(new URL("../../../archive.yaml", import.meta.url));

test("the default app makes one stack per stage of the committed archive.yaml, with the Repo tag", () => {
  const stages = stagesOf(loadArchiveConfig(COMMITTED)).map((stage) => stage.name);
  const assembly = createApp().synth();

  expect(assembly.stacks.map((s) => s.stackName).sort()).toEqual(stages.map(stackName).sort());
  for (const stage of stages) {
    expect(assembly.getStackByName(stackName(stage)).tags).toEqual({
      Repo: "schuettc/research-archive-in-a-box",
    });
  }
});

test("a second stage makes a second stack", () => {
  const app = createApp(
    configFile(`publisher: P\n${INFRASTRUCTURE}  stages:\n    - name: prod\n    - name: dev\n`),
  );
  const assembly = app.synth();

  expect(assembly.stacks.map((s) => s.stackName).sort()).toEqual([
    "ResearchArchive-dev",
    "ResearchArchive-prod",
  ]);
  expect(assembly.getStackByName(stackName("dev")).tags).toEqual({
    Repo: "schuettc/research-archive-in-a-box",
  });
});

test("a stage with an account and region sets the stack's environment", () => {
  const app = createApp(
    configFile(
      `publisher: P\n${INFRASTRUCTURE}  stages:\n` +
        "    - name: prod\n      account: '123456789012'\n      region: us-east-2\n" +
        "    - name: dev\n",
    ),
  );

  const prod = app.node.findChild(stackName("prod")) as Stack;
  const dev = app.node.findChild(stackName("dev")) as Stack;
  expect(prod.account).toBe("123456789012");
  expect(prod.region).toBe("us-east-2");
  expect(Stack.of(dev).environment).toBe("aws://unknown-account/unknown-region");
});

test("ARCHIVE_CONFIG points the default app at another config file", () => {
  const path = configFile(`publisher: P\n${INFRASTRUCTURE}  stages:\n    - name: test\n`);
  const previous = process.env.ARCHIVE_CONFIG;
  process.env.ARCHIVE_CONFIG = path;
  try {
    const assembly = createApp().synth();

    expect(assembly.stacks.map((s) => s.stackName)).toEqual(["ResearchArchive-test"]);
  } finally {
    if (previous === undefined) {
      delete process.env.ARCHIVE_CONFIG;
    } else {
      process.env.ARCHIVE_CONFIG = previous;
    }
  }
});

test("a config with no infrastructure section is refused with a clear message", () => {
  expect(() => createApp(configFile("publisher: P\n"))).toThrow(
    "archive.yaml needs an infrastructure section",
  );
});

test("a typo in modules is refused", () => {
  expect(() =>
    createApp(configFile(`publisher: P\n${INFRASTRUCTURE}  modules:\n    wafs: true\n`)),
  ).toThrow(/wafs/);
});

test("ResearchArchive refuses a stage not in the config", () => {
  const config: ArchiveConfig = {
    publisher: "P",
    infrastructure: { alertEmail: "a@example.org", stages: [{ name: "prod" }] },
  };
  const stack = new Stack(new App(), "S");

  expect(() => new ResearchArchive(stack, "Archive", { config, stage: "dev" })).toThrow(
    'stage "dev" is not in infrastructure.stages',
  );
});

test("the construct writes the config as JSON to the stage's standard archive-config parameter", () => {
  const config: ArchiveConfig = {
    publisher: "P",
    profiles: ["core"],
    infrastructure: { alertEmail: "a@example.org", stages: [{ name: "prod" }, { name: "dev" }] },
  };
  const stack = new Stack(testApp(), "S");
  const archive = new ResearchArchive(stack, "Archive", { config, stage: "dev" });
  const id = stack.getLogicalId(archive.archiveConfigParameter.node.defaultChild as CfnParameter);

  expect(Template.fromStack(stack).toJSON().Resources[id].Properties).toEqual({
    Name: "/research-archive/dev/archive-config",
    Type: "String",
    Tier: "Standard",
    Value: JSON.stringify(config),
  });
});

function storedConfig(config: ArchiveConfig, stage: string): ArchiveConfig {
  const stack = new Stack(testApp(), "S");
  const archive = new ResearchArchive(stack, "Archive", { config, stage });
  const id = stack.getLogicalId(archive.archiveConfigParameter.node.defaultChild as CfnParameter);
  const value = Template.fromStack(stack).toJSON().Resources[id].Properties.Value as string;
  return JSON.parse(value) as ArchiveConfig;
}

test("a stage's doi overrides the archive's in that stage's config parameter only", () => {
  const config: ArchiveConfig = {
    publisher: "P",
    doi: { repository: "EXAMPLE.IRC", prefix: "10.5072", test: true },
    infrastructure: {
      alertEmail: "a@example.org",
      stages: [
        { name: "dev" },
        { name: "prod", doi: { test: false, repository: "LIVE.IRC", prefix: "10.12345" } },
        { name: "staging", doi: { test: false } },
      ],
    },
  };

  expect(storedConfig(config, "prod").doi).toEqual({
    repository: "LIVE.IRC",
    prefix: "10.12345",
    test: false,
  });
  expect(storedConfig(config, "staging").doi).toEqual({
    repository: "EXAMPLE.IRC",
    prefix: "10.5072",
    test: false,
  });
  expect(storedConfig(config, "dev").doi).toEqual(config.doi);
  expect(config.doi?.test).toBe(true);
});

test("a stage with no doi.test of its own keeps the archive's, which defaults to the test system", () => {
  const config: ArchiveConfig = {
    publisher: "P",
    doi: { repository: "EXAMPLE.IRC", prefix: "10.5072" },
    infrastructure: { alertEmail: "a@example.org", stages: [{ name: "prod" }] },
  };

  expect(storedConfig(config, "prod")).toEqual(config);
});

test("a stage doi without the archive's doi block is refused at synth", () => {
  const config: ArchiveConfig = {
    publisher: "P",
    infrastructure: {
      alertEmail: "a@example.org",
      stages: [{ name: "prod", doi: { test: false } }],
    },
  };
  const stack = new Stack(testApp(), "S");

  expect(() => new ResearchArchive(stack, "Archive", { config, stage: "prod" })).toThrow(
    "stage prod sets doi, so the archive needs a doi block with its repository and prefix",
  );
});

test("a config whose JSON is over 4096 bytes is refused at synth", () => {
  const config: ArchiveConfig = {
    publisher: "P".repeat(4096),
    infrastructure: { alertEmail: "a@example.org", stages: [{ name: "prod" }] },
  };
  const stack = new Stack(testApp(), "S");

  expect(() => new ResearchArchive(stack, "Archive", { config, stage: "prod" })).toThrow(
    /archive config is \d+ bytes as JSON; the SSM parameter holds at most 4096/,
  );
});

test("the privacy text is left out of the config parameter, so a long one still synthesises", () => {
  const config: ArchiveConfig = {
    publisher: "P",
    // The schema's longest privacy text, 2,500 characters, is 5,000 bytes of JSON in é alone.
    brand: { name: "Lake Archive", privacy: "é".repeat(2500) },
    infrastructure: { alertEmail: "a@example.org", stages: [{ name: "prod" }] },
  };

  const stored = storedConfig(config, "prod");

  expect(stored.brand).toEqual({ name: "Lake Archive" });
  expect(JSON.stringify(stored)).not.toContain("privacy");
  expect(config.brand?.privacy).toBeDefined();
});

const DOMAIN = "data.example.org";
const ZONE = "Z0123456789ABCDEF";

function domainStage(region: string): string {
  return (
    `publisher: P\n${INFRASTRUCTURE}  stages:\n    - name: prod\n      region: ${region}\n` +
    `      domain:\n        name: ${DOMAIN}\n        hostedZoneId: ${ZONE}\n`
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

function resourcesOf(template: Json, type: string): Json[] {
  return Object.values(template.Resources as Record<string, Json>).filter((r) => r.Type === type);
}

function domainAssembly(region: string): { cert: Json; stage: Json; stacks: string[] } {
  const assembly = createApp(configFile(domainStage(region))).synth();
  return {
    cert: assembly.getStackByName("ResearchArchive-prod-Certificate").template as Json,
    stage: assembly.getStackByName("ResearchArchive-prod").template as Json,
    stacks: assembly.stacks.map((s) => s.stackName).sort(),
  };
}

test("a stage with a domain gets a certificate stack in us-east-1 with a DNS-validated certificate", () => {
  const app = createApp(configFile(domainStage("eu-west-1")));
  const cert = app.node.findChild("ResearchArchive-prod-Certificate") as Stack;
  const { cert: template, stacks } = domainAssembly("eu-west-1");

  expect(stacks).toEqual(["ResearchArchive-prod", "ResearchArchive-prod-Certificate"]);
  expect(cert.region).toBe("us-east-1");
  const certificates = resourcesOf(template, "AWS::CertificateManager::Certificate");
  expect(certificates).toHaveLength(1);
  expect(certificates[0]?.Properties).toMatchObject({
    DomainName: DOMAIN,
    ValidationMethod: "DNS",
    DomainValidationOptions: [{ DomainName: DOMAIN, HostedZoneId: ZONE }],
  });
});

test("a stage in another region reads the certificate through CDK's cross-region reader", () => {
  const { stage } = domainAssembly("eu-west-1");

  expect(resourcesOf(stage, "Custom::CrossRegionExportReader")).toHaveLength(1);
  const config = resourcesOf(stage, "AWS::CloudFront::Distribution")[0]?.Properties
    .DistributionConfig as Json;
  expect(config.ViewerCertificate.AcmCertificateArn["Fn::GetAtt"][1]).toMatch(/^\/cdk\/exports\//);
});

test("a stage in us-east-1 reads the certificate through an ordinary export", () => {
  const { stage } = domainAssembly("us-east-1");

  expect(resourcesOf(stage, "Custom::CrossRegionExportReader")).toHaveLength(0);
  const config = resourcesOf(stage, "AWS::CloudFront::Distribution")[0]?.Properties
    .DistributionConfig as Json;
  expect(config.ViewerCertificate.AcmCertificateArn["Fn::ImportValue"]).toBeDefined();
});

test("with a domain the distribution answers on the name with the certificate, and A and AAAA aliases point at it", () => {
  const { stage } = domainAssembly("eu-west-1");
  const [distribution] = resourcesOf(stage, "AWS::CloudFront::Distribution");
  const distributionId = Object.entries(stage.Resources as Record<string, Json>).find(
    ([, r]) => r === distribution,
  )?.[0];
  const config = distribution?.Properties.DistributionConfig as Json;

  expect(config.Aliases).toEqual([DOMAIN]);
  expect(config.ViewerCertificate.SslSupportMethod).toBe("sni-only");
  const records = resourcesOf(stage, "AWS::Route53::RecordSet");
  expect(records.map((r) => r.Properties.Type).sort()).toEqual(["A", "AAAA"]);
  for (const record of records) {
    expect(record.Properties).toMatchObject({ Name: `${DOMAIN}.`, HostedZoneId: ZONE });
    expect(record.Properties.AliasTarget.DNSName).toEqual({
      "Fn::GetAtt": [distributionId, "DomainName"],
    });
    // CloudFrontTarget names CloudFront's zone through a mapping keyed by partition.
    const [map, partition, key] = record.Properties.AliasTarget.HostedZoneId["Fn::FindInMap"];
    expect(partition).toEqual({ Ref: "AWS::Partition" });
    expect(stage.Mappings[map]["aws"][key]).toBe("Z2FDTNDATAQYW2");
  }
});

test("a stage with no domain has one stack, no certificate, no record set and no aliases", () => {
  const assembly = createApp(
    configFile(
      `publisher: P\n${INFRASTRUCTURE}  stages:\n    - name: prod\n      region: us-east-1\n`,
    ),
  ).synth();
  const template = assembly.getStackByName("ResearchArchive-prod").template as Json;

  expect(assembly.stacks.map((s) => s.stackName)).toEqual(["ResearchArchive-prod"]);
  expect(resourcesOf(template, "AWS::CertificateManager::Certificate")).toHaveLength(0);
  expect(resourcesOf(template, "AWS::Route53::RecordSet")).toHaveLength(0);
  const config = resourcesOf(template, "AWS::CloudFront::Distribution")[0]?.Properties
    .DistributionConfig as Json;
  expect(config.Aliases).toBeUndefined();
});

test("a stage with a domain and no region is refused", () => {
  expect(() =>
    createApp(
      configFile(
        `publisher: P\n${INFRASTRUCTURE}  stages:\n    - name: prod\n` +
          `      domain:\n        name: ${DOMAIN}\n        hostedZoneId: ${ZONE}\n`,
      ),
    ),
  ).toThrow("stage prod has a domain, so it needs a region");
});

test("ResearchArchive refuses a domain without a certificate, and a certificate without a domain", () => {
  const stages = [
    { name: "prod", region: "us-east-1", domain: { name: DOMAIN, hostedZoneId: ZONE } },
  ];
  const config: ArchiveConfig = {
    publisher: "P",
    infrastructure: { alertEmail: "a@example.org", stages: [stages[0]!] },
  };
  expect(
    () => new ResearchArchive(new Stack(testApp(), "S"), "Archive", { config, stage: "prod" }),
  ).toThrow(/domain .* needs a certificate/);

  const plain: ArchiveConfig = {
    publisher: "P",
    infrastructure: { alertEmail: "a@example.org", stages: [{ name: "prod" }] },
  };
  const stack = new Stack(testApp(), "S");
  const certificate = acm.Certificate.fromCertificateArn(
    stack,
    "C",
    "arn:aws:acm:us-east-1:123456789012:certificate/x",
  );
  expect(
    () => new ResearchArchive(stack, "Archive", { config: plain, stage: "prod", certificate }),
  ).toThrow(/certificate .* no domain/);
});

test("with a domain, the staging bucket allows both the CloudFront origin and the name", () => {
  const { archive: a, stack, template } = domainArchive("dev", { keepData: false });
  const distribution = stack.getLogicalId(a.distribution.node.defaultChild as CfnDistribution);
  const cors = resourcesOf(template.toJSON(), "Custom::AWS").find((r) =>
    JSON.stringify(r.Properties.Create ?? "").includes("putBucketCors"),
  );
  // The call is a Fn::Join: the CloudFront origin's name is a token between two strings.
  const [, parts] = cors?.Properties.Create["Fn::Join"] as [string, unknown[]];
  const at = parts.findIndex(
    (p) => JSON.stringify(p) === JSON.stringify({ "Fn::GetAtt": [distribution, "DomainName"] }),
  );

  expect(parts[at - 1]).toMatch(/"AllowedOrigins":\["https:\/\/$/);
  expect(parts[at + 1]).toMatch(/^","https:\/\/data\.example\.org","http:\/\/localhost:5199"\],/);
});

function emailAssembly(region: string): { stage: Json; cert: Json; region: string } {
  const assembly = createApp(configFile(`${domainStage(region)}      email: ses\n`)).synth();
  const stage = assembly.getStackByName("ResearchArchive-prod");
  return {
    stage: stage.template as Json,
    cert: assembly.getStackByName("ResearchArchive-prod-Certificate").template as Json,
    region: stage.environment.region,
  };
}

test("with email: ses the identity, its records and the wait are in the stage's stack, in its region", () => {
  for (const region of ["us-east-1", "eu-west-1"]) {
    const { stage, cert, region: stackRegion } = emailAssembly(region);

    expect(stackRegion).toBe(region);
    expect(resourcesOf(stage, "AWS::SES::EmailIdentity")).toHaveLength(1);
    expect(
      resourcesOf(stage, "AWS::Route53::RecordSet").filter((r) => r.Properties.Type === "CNAME"),
    ).toHaveLength(3);
    expect(resourcesOf(stage, "Custom::SesIdentityVerified")).toHaveLength(1);
    expect(resourcesOf(cert, "AWS::SES::EmailIdentity")).toHaveLength(0);
    expect(resourcesOf(cert, "Custom::SesIdentityVerified")).toHaveLength(0);
  }
});

test("ResearchArchive refuses email: ses without a domain, and in a region without SES", () => {
  const archive = (stage: Stage) => {
    const stack = new Stack(testApp(), "S");
    const certificate = stage.domain
      ? acm.Certificate.fromCertificateArn(stack, "C", "arn:aws:acm:us-east-1:1:certificate/x")
      : undefined;
    const config: ArchiveConfig = {
      publisher: "P",
      infrastructure: { alertEmail: "a@example.org", stages: [stage] },
    };
    return () => new ResearchArchive(stack, "Archive", { config, stage: "prod", certificate });
  };

  expect(archive({ name: "prod", region: "us-east-1", email: "ses" })).toThrow(
    "stage prod sends email through SES from its domain, so it needs a domain",
  );
  expect(
    archive({
      name: "prod",
      region: "eu-central-2",
      domain: { name: DOMAIN, hostedZoneId: ZONE },
      email: "ses",
    }),
  ).toThrow(
    "stage prod is in eu-central-2, where Cognito can't send through SES in its own Region; " +
      "email: ses isn't supported there yet",
  );
});

test("a stage with a domain and no email has no identity, no CNAME and no wait", () => {
  const { stage } = domainAssembly("us-east-1");

  expect(resourcesOf(stage, "AWS::SES::EmailIdentity")).toHaveLength(0);
  expect(
    resourcesOf(stage, "AWS::Route53::RecordSet").filter((r) => r.Properties.Type === "CNAME"),
  ).toHaveLength(0);
  expect(resourcesOf(stage, "Custom::SesIdentityVerified")).toHaveLength(0);
});
