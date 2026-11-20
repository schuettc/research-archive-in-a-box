import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FileSystem, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import type { CfnRestApi } from "aws-cdk-lib/aws-apigateway";
import type { CfnDistribution } from "aws-cdk-lib/aws-cloudfront";
import type { CfnUserPoolClient } from "aws-cdk-lib/aws-cognito";
import type { CfnBucket } from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { afterEach, expect, test, vi } from "vitest";
import type { ArchiveConfig } from "../src/generated/archive-config";
import { ResearchArchive } from "../src/research-archive";
import { domainArchive, testApp } from "./test-app";

function archive(extra: Partial<ArchiveConfig> = {}): {
  archive: ResearchArchive;
  stack: Stack;
  template: Template;
} {
  const stack = new Stack(testApp(), "S");
  const built = new ResearchArchive(stack, "Archive", {
    config: {
      publisher: "P",
      infrastructure: { alertEmail: "a@example.org", stages: [{ name: "prod" }] },
      ...extra,
    },
    stage: "prod",
  });
  return { archive: built, stack, template: Template.fromStack(stack) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

function distributionConfig(a: ResearchArchive, stack: Stack, template: Template): Json {
  const id = stack.getLogicalId(a.distribution.node.defaultChild as CfnDistribution);
  return template.toJSON().Resources[id].Properties.DistributionConfig as Json;
}

function bucketId(stack: Stack, bucket: ResearchArchive["archiveBucket"]): string {
  return stack.getLogicalId(bucket.node.defaultChild as CfnBucket);
}

function originOf(config: Json, originId: string): Json {
  const origin = (config.Origins as Json[]).find((o) => o.Id === originId);
  if (!origin) throw new Error(`no origin ${originId}`);
  return origin;
}

function functionCode(template: Template, arn: Json): string {
  const id = arn["Fn::GetAtt"][0] as string;
  return template.toJSON().Resources[id].Properties.FunctionCode as string;
}

/** Run a CloudFront Function's source on a request URI and return the rewritten URI. */
function rewrite(code: string, uri: string): string {
  const handler = new Function(`${code}; return handler;`)() as (event: Json) => Json;
  return handler({ request: { uri } }).uri as string;
}

test("the default behaviour serves site/ from the derived bucket through origin access control", () => {
  const { archive: a, stack, template } = archive();
  const config = distributionConfig(a, stack, template);
  const behaviour = config.DefaultCacheBehavior as Json;
  const origin = originOf(config, behaviour.TargetOriginId);

  expect(origin.DomainName["Fn::GetAtt"]).toEqual([
    bucketId(stack, a.derivedBucket),
    "RegionalDomainName",
  ]);
  expect(origin.OriginPath).toBe("/site");
  expect(origin.OriginAccessControlId).toBeDefined();
  expect(config.DefaultRootObject).toBe("index.html");
  expect(behaviour.ViewerProtocolPolicy).toBe("redirect-to-https");
  expect(behaviour.CachePolicyId).toBe("658327ea-f89d-4fab-a63d-7e88639e58f6");

  const [association] = behaviour.FunctionAssociations as Json[];
  expect(association?.EventType).toBe("viewer-request");
  const code = functionCode(template, association?.FunctionARN);
  expect(rewrite(code, "/docs/")).toBe("/docs/index.html");
  expect(rewrite(code, "/assets/app.js")).toBe("/assets/app.js");
});

test("the site function sends /datasets/<id> to its page and other extensionless paths to the app", () => {
  const { archive: a, stack, template } = archive();
  const behaviour = distributionConfig(a, stack, template).DefaultCacheBehavior as Json;
  const code = functionCode(template, (behaviour.FunctionAssociations as Json[])[0]?.FunctionARN);

  expect(rewrite(code, "/")).toBe("/index.html");
  expect(rewrite(code, "/about")).toBe("/index.html");
  expect(rewrite(code, "/datasets/abc")).toBe("/datasets/abc/index.html");
  expect(rewrite(code, "/datasets/abc/")).toBe("/datasets/abc/index.html");
  expect(rewrite(code, "/app.js")).toBe("/app.js");
});

test("the site function sends /datasets/<id>/v<n> to that version's page", () => {
  const { archive: a, stack, template } = archive();
  const behaviour = distributionConfig(a, stack, template).DefaultCacheBehavior as Json;
  const code = functionCode(template, (behaviour.FunctionAssociations as Json[])[0]?.FunctionARN);

  expect(rewrite(code, "/datasets/x/v2")).toBe("/datasets/x/v2/index.html");
  expect(rewrite(code, "/datasets/x/v2/")).toBe("/datasets/x/v2/index.html");
  expect(rewrite(code, "/datasets/x")).toBe("/datasets/x/index.html");
  expect(rewrite(code, "/datasets/x/other")).toBe("/index.html");
  expect(rewrite(code, "/datasets/x/v2/extra")).toBe("/index.html");
});

test("/data/* serves open/ from the archive bucket and strips /data", () => {
  const { archive: a, stack, template } = archive();
  const config = distributionConfig(a, stack, template);
  const behaviour = (config.CacheBehaviors as Json[]).find((b) => b.PathPattern === "/data/*");
  const origin = originOf(config, behaviour?.TargetOriginId);

  expect(origin.DomainName["Fn::GetAtt"][0]).toBe(bucketId(stack, a.archiveBucket));
  expect(origin.OriginPath).toBe("/open");
  expect(origin.OriginAccessControlId).toBeDefined();
  expect(behaviour?.AllowedMethods).toEqual(["GET", "HEAD"]);
  expect(behaviour?.CachePolicyId).toBe("658327ea-f89d-4fab-a63d-7e88639e58f6");
  const code = functionCode(template, behaviour?.FunctionAssociations[0].FunctionARN);
  expect(rewrite(code, "/data/ds-1/2/data/a.csv")).toBe("/ds-1/2/data/a.csv");
});

test("/api/* goes to the REST API uncached with all methods", () => {
  const { archive: a, stack, template } = archive();
  const config = distributionConfig(a, stack, template);
  const behaviour = (config.CacheBehaviors as Json[]).find((b) => b.PathPattern === "/api/*");
  const origin = originOf(config, behaviour?.TargetOriginId);
  const restApiId = stack.getLogicalId(a.api.node.defaultChild as CfnRestApi);

  expect(JSON.stringify(origin.DomainName)).toContain(restApiId);
  expect(behaviour?.AllowedMethods).toHaveLength(7);
  expect(behaviour?.CachePolicyId).toBe("4135ea2d-6df8-44a3-9df3-4b5a84be39ad");
  expect(behaviour?.OriginRequestPolicyId).toBe("b689b0a8-53d0-40ab-baf2-68738e2966ac");
});

function archiveWithWaf(waf: boolean): ReturnType<typeof archive> {
  return archive({
    infrastructure: {
      alertEmail: "a@example.org",
      stages: [{ name: "prod" }],
      modules: { waf },
    },
  });
}

test("with WAF on, /api/* sends the API its key and the visitor's address as CloudFront saw it", () => {
  const { archive: a, stack, template } = archiveWithWaf(true);
  const config = distributionConfig(a, stack, template);
  const behaviour = (config.CacheBehaviors as Json[]).find((b) => b.PathPattern === "/api/*");
  const origin = originOf(config, behaviour?.TargetOriginId);
  const headers = origin.OriginCustomHeaders as Json[];
  expect(headers).toHaveLength(1);
  expect(headers[0]?.HeaderName).toBe("x-api-key");
  expect(headers[0]?.HeaderValue).toHaveProperty("Fn::GetAtt");

  const [association] = behaviour?.FunctionAssociations as Json[];
  expect(association?.EventType).toBe("viewer-request");
  const code = functionCode(template, association?.FunctionARN);
  const handler = new Function(`${code}; return handler;`)() as (event: unknown) => Json;
  const request = handler({
    viewer: { ip: "203.0.113.9" },
    request: { uri: "/api/search", headers: { "x-viewer-address": { value: "198.51.100.1" } } },
  });
  expect(request.headers["x-viewer-address"]).toEqual({ value: "203.0.113.9" });
});

test("with WAF off, /api/* sends no key and runs no function", () => {
  const { archive: a, stack, template } = archiveWithWaf(false);
  const config = distributionConfig(a, stack, template);
  const behaviour = (config.CacheBehaviors as Json[]).find((b) => b.PathPattern === "/api/*");
  const origin = originOf(config, behaviour?.TargetOriginId);
  expect(origin.OriginCustomHeaders).toBeUndefined();
  expect(behaviour?.FunctionAssociations).toBeUndefined();
});

/** A CloudFormation string as text: each Ref as <id>, AWS::Region as <region>. */
function flatten(value: unknown): string {
  if (typeof value === "string") return value;
  const json = value as Json;
  if (json["Fn::Join"])
    return (json["Fn::Join"][1] as unknown[]).map(flatten).join(json["Fn::Join"][0]);
  if (json.Ref === "AWS::Region") return "<region>";
  if (json.Ref) return `<${json.Ref as string}>`;
  throw new Error(`can't flatten ${JSON.stringify(value)}`);
}

function siteHeaders(template: Template): { id: string; csp: string; override: boolean } {
  const policies = template.findResources("AWS::CloudFront::ResponseHeadersPolicy", {
    Properties: { ResponseHeadersPolicyConfig: { Comment: "The site's security headers" } },
  });
  const [id, ...others] = Object.keys(policies);
  if (!id || others.length > 0) throw new Error("expected one site headers policy");
  const csp = (policies[id] as Json).Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig
    .ContentSecurityPolicy as Json;
  return { id, csp: flatten(csp.ContentSecurityPolicy), override: csp.Override as boolean };
}

const PAGES_PY = fileURLToPath(
  new URL("../../backend/src/archive_backend/pages.py", import.meta.url),
);

/** The static dataset pages' inline <style>, read from pages.py, for a brand colour. */
function pageStyle(color: string): string {
  const source = readFileSync(PAGES_PY, "utf-8");
  const block = /^STYLE = \(\n([\s\S]*?)\n\)/m.exec(source)?.[1];
  if (!block) throw new Error("no STYLE in pages.py");
  const style = [...block.matchAll(/"([^"]*)"/g)].map((match) => match[1]).join("");
  return `#app>header{--brand:${color}}${style}`;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf-8").digest("base64");

test("the site sends a strict Content-Security-Policy: only itself, Cognito's API and the staging bucket's links", () => {
  const { archive: a, stack, template } = archive();
  const staging = bucketId(stack, a.stagingBucket);

  const { csp, override } = siteHeaders(template);

  expect(csp).toBe(
    [
      "default-src 'self'",
      "script-src 'self'",
      `style-src 'self' 'sha256-${sha256(pageStyle("#24395f"))}'`,
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'" +
        " https://cognito-idp.<region>.amazonaws.com" +
        ` https://<${staging}>.s3.<region>.amazonaws.com` +
        ` https://<${staging}>.s3.amazonaws.com`,
      "frame-ancestors 'none'",
      "base-uri 'self'",
      // The sign-in page hands a command-line sign-in to its listener on this computer.
      "form-action 'self' http://localhost:*",
      "object-src 'none'",
    ].join("; "),
  );
  expect(override).toBe(true);
});

test("the static pages' inline style is allowed by its hash for the brand's colour", () => {
  const { template } = archive({ brand: { primaryColor: "#7A1F3D" } });

  // pages.py writes the colour lower-cased, as the hash does.
  expect(siteHeaders(template).csp).toContain(`'sha256-${sha256(pageStyle("#7a1f3d"))}'`);
  expect(siteHeaders(template).csp).not.toContain(sha256(pageStyle("#24395f")));
});

// Contributors' open files are served on the site's origin, so an .html or .svg among them
// must not run script there.
test("/data serves files that can run nothing: no script, no sniffing, no framing", () => {
  const { archive: a, stack, template } = archive();
  const config = distributionConfig(a, stack, template);
  const data = (config.CacheBehaviors as Json[]).find((b) => b.PathPattern === "/data/*");
  const policies = template.findResources("AWS::CloudFront::ResponseHeadersPolicy");
  const id = (data?.ResponseHeadersPolicyId as Json | undefined)?.Ref as string;
  const headers = (policies[id] as Json).Properties.ResponseHeadersPolicyConfig
    .SecurityHeadersConfig as Json;

  expect((headers.ContentSecurityPolicy as Json).ContentSecurityPolicy).toBe(
    "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  );
  expect(headers.ContentTypeOptions).toEqual({ Override: true });
});

/** A response headers policy's SecurityHeadersConfig, by its id. */
function securityHeaders(template: Template, id: string): Json {
  const policies = template.findResources("AWS::CloudFront::ResponseHeadersPolicy");
  return (policies[id] as Json).Properties.ResponseHeadersPolicyConfig
    .SecurityHeadersConfig as Json;
}

const HSTS = { AccessControlMaxAgeSec: 31536000, Override: true };
const REFERRER = { ReferrerPolicy: "strict-origin-when-cross-origin", Override: true };

test("the site sends HSTS for a year, nosniff, a strict-origin referrer and no framing", () => {
  const { template } = archive();
  const headers = securityHeaders(template, siteHeaders(template).id);

  expect(headers.StrictTransportSecurity).toEqual(HSTS);
  expect(headers.ContentTypeOptions).toEqual({ Override: true });
  expect(headers.ReferrerPolicy).toEqual(REFERRER);
  expect(headers.FrameOptions).toEqual({ FrameOption: "DENY", Override: true });
});

test("/data sends HSTS for a year and a strict-origin referrer too", () => {
  const { archive: a, stack, template } = archive();
  const config = distributionConfig(a, stack, template);
  const data = (config.CacheBehaviors as Json[]).find((b) => b.PathPattern === "/data/*");
  const headers = securityHeaders(template, (data?.ResponseHeadersPolicyId as Json).Ref as string);

  expect(headers.StrictTransportSecurity).toEqual(HSTS);
  expect(headers.ReferrerPolicy).toEqual(REFERRER);
});

test("the site's behaviour carries the policy; /api doesn't", () => {
  const { archive: a, stack, template } = archive();
  const config = distributionConfig(a, stack, template);
  const behaviour = (path: string) =>
    (config.CacheBehaviors as Json[]).find((b) => b.PathPattern === path);

  expect((config.DefaultCacheBehavior as Json).ResponseHeadersPolicyId).toEqual({
    Ref: siteHeaders(template).id,
  });
  expect(behaviour("/api/*")?.ResponseHeadersPolicyId).toBeUndefined();
});

test("with no domain the distribution has no aliases and no viewer certificate", () => {
  const { archive: a, stack, template } = archive();
  const config = distributionConfig(a, stack, template);

  expect(config.Aliases).toBeUndefined();
  expect(config.ViewerCertificate).toBeUndefined();
});

test("the distribution has no error responses", () => {
  const { archive: a, stack, template } = archive();

  expect(distributionConfig(a, stack, template).CustomErrorResponses).toBeUndefined();
});

test("standard logs go to the derived bucket under logs/, and the derived bucket accepts the log ACL", () => {
  const { archive: a, stack, template } = archive();
  const derived = bucketId(stack, a.derivedBucket);

  expect(distributionConfig(a, stack, template).Logging).toEqual({
    Bucket: { "Fn::GetAtt": [derived, "RegionalDomainName"] },
    Prefix: "logs/",
  });
  expect(template.toJSON().Resources[derived].Properties).toMatchObject({
    OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerPreferred" }] },
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  });
});

test("the SiteDomain output names the distribution's domain, for just smoke and just seed", () => {
  const { archive: a, stack, template } = archive();
  const distribution = stack.getLogicalId(a.distribution.node.defaultChild as CfnDistribution);

  template.hasOutput("SiteDomain", { Value: { "Fn::GetAtt": [distribution, "DomainName"] } });
});

test("CloudFront is denied the archive bucket's restricted/ prefix, and no policy names publishing/", () => {
  const { archive: a, stack, template } = archive();
  const policies = template.findResources("AWS::S3::BucketPolicy");
  const archivePolicy = Object.values(policies).find(
    (p) => (p as Json).Properties.Bucket.Ref === bucketId(stack, a.archiveBucket),
  ) as Json;
  const statements = archivePolicy.Properties.PolicyDocument.Statement as Json[];
  const deny = statements.find(
    (s) => s.Effect === "Deny" && s.Principal?.Service === "cloudfront.amazonaws.com",
  );

  expect(deny).toBeDefined();
  expect(deny?.Action).toBe("s3:GetObject");
  expect(JSON.stringify(deny?.Resource)).toContain("/restricted/*");
  expect(JSON.stringify(policies)).not.toContain("publishing/");
});

// Without s3:ListBucket, S3 answers 403 for a missing key. A missing-key GET carries no s3:prefix,
// so a prefix condition would keep the 403: each grant is unconditioned but this distribution's alone.
test("this distribution, and no other, may list the archive and derived buckets", () => {
  const { archive: a, stack, template } = archive();
  const distribution = stack.getLogicalId(a.distribution.node.defaultChild as CfnDistribution);
  const policies = template.findResources("AWS::S3::BucketPolicy");
  const statements = Object.values(policies).flatMap(
    (p) => (p as Json).Properties.PolicyDocument.Statement as Json[],
  );
  const lists = statements.filter((s) => [s.Action].flat().includes("s3:ListBucket"));

  expect(lists.map((s) => s.Resource)).toEqual(
    expect.arrayContaining([
      { "Fn::GetAtt": [bucketId(stack, a.archiveBucket), "Arn"] },
      { "Fn::GetAtt": [bucketId(stack, a.derivedBucket), "Arn"] },
    ]),
  );
  expect(lists).toHaveLength(2);
  for (const list of lists) {
    expect(list.Effect).toBe("Allow");
    expect(list.Principal).toEqual({ Service: "cloudfront.amazonaws.com" });
    expect(list.Action).toBe("s3:ListBucket");
    expect(JSON.stringify(list.Condition.StringEquals["AWS:SourceArn"])).toContain(distribution);
    expect(Object.keys(list.Condition as Json)).toEqual(["StringEquals"]);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The bucket deployments writing into the derived bucket's site/. */
function siteDeployments(a: ResearchArchive, stack: Stack, template: Template): Json[] {
  const derived = bucketId(stack, a.derivedBucket);
  return Object.values(template.findResources("Custom::CDKBucketDeployment"))
    .map((resource) => (resource as Json).Properties as Json)
    .filter(
      (p) =>
        JSON.stringify(p.DestinationBucketName).includes(derived) &&
        String(p.DestinationBucketKeyPrefix ?? "").startsWith("site"),
    );
}

test("the app is deployed into site/ by two deployments that never prune", () => {
  const { archive: a, stack, template } = archive();
  const deployments = siteDeployments(a, stack, template);

  expect(deployments).toHaveLength(2);
  for (const deployment of deployments) {
    expect(deployment.Prune).toBe(false);
    expect(deployment.DestinationBucketKeyPrefix).toBe("site/");
  }
  const caching = deployments.map((d) => d.SystemMetadata?.["cache-control"]).sort();
  expect(caching).toEqual(["no-cache", "public, max-age=31536000, immutable"]);
});

test("the no-cache deployment writes auth-config.json, archive-checks.json and robots.txt and invalidates the app's stable files", () => {
  const { archive: a, stack, template } = archive();
  const distribution = stack.getLogicalId(a.distribution.node.defaultChild as CfnDistribution);
  const site = siteDeployments(a, stack, template).find(
    (d) => d.SystemMetadata?.["cache-control"] === "no-cache",
  );

  expect(site?.DistributionId).toEqual({ Ref: distribution });
  expect(site?.DistributionPaths).toEqual([
    "/index.html",
    "/app.js",
    "/auth-config.json",
    "/archive-checks.json",
    "/brand/logo.*",
    "/brand/favicon.*",
    "/robots.txt",
  ]);
  expect(site?.SourceObjectKeys).toHaveLength(4);
});

test("robots.txt names the sitemap and keeps search engines out of the signed-in areas", () => {
  const data = vi.spyOn(s3deploy.Source, "data");
  const { archive: a, stack } = archive();

  const call = data.mock.calls.find(([name]) => name === "robots.txt");
  expect(call).toBeDefined();
  const text = JSON.stringify(stack.resolve(call?.[1]));
  const domain = stack.getLogicalId(a.distribution.node.defaultChild as CfnDistribution);
  expect(text).toContain("User-agent: *");
  expect(text).toContain("Sitemap: https://");
  expect(text).toContain(domain);
  expect(text).toContain("/sitemap.xml");
  for (const path of ["/submissions", "/submit", "/review", "/settings", "/account", "/sign-in"]) {
    expect(text).toContain(`Disallow: ${path}\\n`);
  }
});

test("auth-config.json holds exactly the region and the web client's id", () => {
  const jsonData = vi.spyOn(s3deploy.Source, "jsonData");
  const { archive: a, stack } = archive();

  const call = jsonData.mock.calls.find(([name]) => name === "auth-config.json");
  expect(call).toBeDefined();
  const data = call?.[1] as Json;
  expect(Object.keys(data).sort()).toEqual(["region", "webClientId"]);
  const ref = (client: { node: { defaultChild: unknown } }) => ({
    Ref: stack.getLogicalId(client.node.defaultChild as CfnUserPoolClient),
  });
  expect(stack.resolve(data.webClientId)).toEqual(ref(a.userPoolClients.web));
  expect(stack.resolve(data.region)).toEqual({ Ref: "AWS::Region" });
});

test("archive-checks.json holds exactly the config's profiles, required fields and package limit", () => {
  const jsonData = vi.spyOn(s3deploy.Source, "jsonData");
  archive({
    profiles: ["core", "ecology"],
    required: ["keywords"],
    submissions: { maxPackageGiB: 2 },
  });
  archive();

  const calls = jsonData.mock.calls.filter(([name]) => name === "archive-checks.json");
  expect(calls.map(([, data]) => data)).toEqual([
    { profiles: ["core", "ecology"], required: ["keywords"], maxPackageGiB: 2 },
    { profiles: ["core"], required: [], maxPackageGiB: 9 },
  ]);
});

test("brand files go immutable only under their content-hashed names; the stable logo and favicon are no-cache", () => {
  const asset = vi.spyOn(s3deploy.Source, "asset");
  archive();
  // deploySite calls Source.asset on the web build twice: SiteAssets (immutable) first, then Site
  // (no-cache); the test above shows which cache-control each deployment carries.
  const calls = asset.mock.calls.filter(([path]) => path.endsWith(join("web", "dist")));
  expect(calls).toHaveLength(2);

  const build = mkdtempSync(join(tmpdir(), "dist-"));
  const files = [
    "index.html",
    "app.js",
    "assets/index-Ab12Cd34.js",
    "brand/logo-0a1b2c3d.svg",
    "brand/favicon-4e5f6a7b.svg",
    "brand/logo.svg",
    "brand/favicon.svg",
  ];
  for (const file of files) {
    mkdirSync(dirname(join(build, file)), { recursive: true });
    writeFileSync(join(build, file), "");
  }
  const sent = calls.map(([, options], i) => {
    const out = join(build, `..`, `${String(i)}-${String(Date.now())}`);
    FileSystem.copyDirectory(build, out, options);
    return readdirSync(out, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name).slice(out.length + 1))
      .sort();
  });

  expect(sent[0]).toEqual([
    "assets/index-Ab12Cd34.js",
    "brand/favicon-4e5f6a7b.svg",
    "brand/logo-0a1b2c3d.svg",
  ]);
  expect(sent[1]).toEqual(["app.js", "brand/favicon.svg", "brand/logo.svg", "index.html"]);
});

// The site function as it stood before custom domains: a stage with none must keep it exactly.
const SITE_REWRITE_BEFORE_DOMAINS = `function handler(event) {
  var request = event.request;
  var uri = request.uri;
  var dataset = uri.match(/^\\/datasets\\/([^\\/.]+)\\/?$/);
  var version = uri.match(/^\\/datasets\\/([^\\/.]+)\\/(v[0-9]+)\\/?$/);
  if (dataset) {
    request.uri = "/datasets/" + dataset[1] + "/index.html";
  } else if (version) {
    request.uri = "/datasets/" + version[1] + "/" + version[2] + "/index.html";
  } else if (uri.endsWith("/")) {
    request.uri = uri + "index.html";
  } else if (uri.substring(uri.lastIndexOf("/") + 1).indexOf(".") === -1) {
    request.uri = "/index.html";
  }
  return request;
}`;

function siteFunction(built: {
  archive: ResearchArchive;
  stack: Stack;
  template: Template;
}): string {
  const behaviour = distributionConfig(built.archive, built.stack, built.template)
    .DefaultCacheBehavior as Json;
  return functionCode(built.template, (behaviour.FunctionAssociations as Json[])[0]?.FunctionARN);
}

/** Run a CloudFront Function's source on a whole request and return what it answers. */
function runSite(code: string, request: Json): Json {
  const handler = new Function(`${code}; return handler;`)() as (event: Json) => Json;
  return handler({ request });
}

test("with no domain the site function is exactly today's", () => {
  expect(siteFunction(archive())).toBe(SITE_REWRITE_BEFORE_DOMAINS);
});

const FAVICON = "examples/brand/favicon.svg";

test("with a brand favicon, /favicon.ico reads its stable copy; with none it is left alone", () => {
  const code = siteFunction(archive({ brand: { favicon: FAVICON } }));

  expect(rewrite(code, "/favicon.ico")).toBe("/brand/favicon.svg");
  expect(rewrite(code, "/about")).toBe("/index.html");
  expect(rewrite(siteFunction(archive()), "/favicon.ico")).toBe("/favicon.ico");
});

test("with a domain and a brand favicon, /favicon.ico on the name reads its stable copy", () => {
  const on = (code: string) =>
    runSite(code, {
      uri: "/favicon.ico",
      headers: { host: { value: "data.example.org" } },
      querystring: {},
    }).uri;

  expect(on(siteFunction(domainArchive("prod", { favicon: FAVICON })))).toBe("/brand/favicon.svg");
  expect(on(siteFunction(domainArchive()))).toBe("/favicon.ico");
});

test("with a domain, pages on CloudFront's address move permanently to the name, query and all", () => {
  const answer = runSite(siteFunction(domainArchive()), {
    uri: "/datasets/x/v2",
    headers: { host: { value: "d111.cloudfront.net" } },
    querystring: {
      a: { value: "1", multiValue: [{ value: "1" }, { value: "2" }] },
      b: { value: "x" },
    },
  });

  expect(answer).toEqual({
    statusCode: 301,
    statusDescription: "Moved Permanently",
    headers: { location: { value: "https://data.example.org/datasets/x/v2?a=1&a=2&b=x" } },
  });
});

test("with a domain, a page with no query on CloudFront's address moves to the same path", () => {
  const answer = runSite(siteFunction(domainArchive()), {
    uri: "/about",
    headers: { host: { value: "d111.cloudfront.net" } },
    querystring: {},
  });

  expect(answer.headers.location.value).toBe("https://data.example.org/about");
});

test("with a domain, a request on the name is rewritten as today", () => {
  const code = siteFunction(domainArchive());
  const on = (uri: string) =>
    runSite(code, { uri, headers: { host: { value: "data.example.org" } }, querystring: {} }).uri;

  expect(on("/datasets/x/v2")).toBe("/datasets/x/v2/index.html");
  expect(on("/datasets/x")).toBe("/datasets/x/index.html");
  expect(on("/about")).toBe("/index.html");
  expect(on("/app.js")).toBe("/app.js");
});

test("with a domain, /data and /api keep their own functions, so both addresses serve them", () => {
  const built = domainArchive();
  const config = distributionConfig(built.archive, built.stack, built.template);
  const data = (config.CacheBehaviors as Json[]).find((b) => b.PathPattern === "/data/*");
  const api = (config.CacheBehaviors as Json[]).find((b) => b.PathPattern === "/api/*");

  expect(functionCode(built.template, data?.FunctionAssociations[0].FunctionARN)).not.toContain(
    "301",
  );
  expect(api?.FunctionAssociations).toBeUndefined();
});

test("with a domain, robots.txt names the sitemap on the name", () => {
  const data = vi.spyOn(s3deploy.Source, "data");
  const { stack } = domainArchive();

  const call = data.mock.calls.find(([name]) => name === "robots.txt");
  expect(stack.resolve(call?.[1])).toContain("Sitemap: https://data.example.org/sitemap.xml\n");
});

test("with a domain, SiteDomain is the name and DistributionDomain is CloudFront's", () => {
  const { archive: a, stack, template } = domainArchive();
  const distribution = stack.getLogicalId(a.distribution.node.defaultChild as CfnDistribution);

  expect(a.siteDomain).toBe("data.example.org");
  template.hasOutput("SiteDomain", { Value: "data.example.org" });
  template.hasOutput("DistributionDomain", {
    Value: { "Fn::GetAtt": [distribution, "DomainName"] },
  });
});

test("with no domain there is no DistributionDomain output", () => {
  expect(Object.keys(archive().template.findOutputs("DistributionDomain"))).toEqual([]);
});
