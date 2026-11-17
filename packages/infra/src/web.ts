import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Duration, IgnoreMode, Stack } from "aws-cdk-lib";
import type * as apigateway from "aws-cdk-lib/aws-apigateway";
import type * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as iam from "aws-cdk-lib/aws-iam";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import type * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";

const WEB_BUILD = fileURLToPath(new URL("../../web/dist", import.meta.url));

/**
 * What /auth-config.json tells the web app: the user pool's region and the web client, which its
 * sign-in page calls Cognito's API with. The plugin reads it to tell an archive from another site.
 */
export interface AuthConfig {
  readonly region: string;
  readonly webClientId: string;
}

/** What /archive-checks.json tells the cruise plugin: the requirement sets ingest checks against. */
export interface ArchiveChecks {
  readonly profiles: readonly string[];
  readonly required: readonly string[];
}

export interface WebProps {
  readonly derivedBucket: s3.IBucket;
  readonly archiveBucket: s3.IBucket;
  /** The bucket the browser reaches through presigned links: uploads, reports, held files. */
  readonly stagingBucket: s3.IBucket;
  readonly restApi: apigateway.RestApi;
  /** The brand's primary colour, lower-case `#rrggbb`, as the static dataset pages write it. */
  readonly brandColor: string;
  /** The stage's own domain: the distribution answers on it with the certificate, and gets aliases. */
  readonly domain?: {
    readonly name: string;
    readonly certificate: acm.ICertificate;
    readonly zone: route53.IHostedZone;
  };
}

// The static dataset pages' one inline <style> after its `#app>header{--brand:<colour>}`: a copy of
// STYLE in packages/backend/src/archive_backend/pages.py, which the infra tests hold it to.
const PAGE_STYLE =
  "#app>main{font-family:system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;" +
  "line-height:1.5;color:#1b1b1b}#app>main h1{line-height:1.2}#app>main code{font-size:.95em}" +
  "#app>main dl{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem}" +
  "#app>main dd{margin:0}" +
  "#app>header{font-family:system-ui,sans-serif;border-top:4px solid var(--brand);" +
  "padding:.75rem 1rem;max-width:46rem;margin:0 auto}" +
  "#app>header a{display:inline-flex;align-items:center;gap:.5rem;color:#1b1b1b;" +
  "font-weight:600;text-decoration:none}#app>header img{height:2rem;width:auto}";

/** The CSP source that allows the static pages' inline style, and no other. */
function pageStyleHash(color: string): string {
  const style = `#app>header{--brand:${color}}${PAGE_STYLE}`;
  return `'sha256-${createHash("sha256").update(style, "utf-8").digest("base64")}'`;
}

// /datasets/<id> and /datasets/<id>/ read the dataset's own page, /datasets/<id>/v<n> and
// /datasets/<id>/v<n>/ that version's page; any other extensionless path is the app's.
const SITE_REWRITE = `function handler(event) {
  var request = event.request;
  var uri = request.uri;
  /*REDIRECT*/var dataset = uri.match(/^\\/datasets\\/([^\\/.]+)\\/?$/);
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

/**
 * The site function. With the stage's domain, a request for the site's pages on any other host
 * (CloudFront's own address) gets a 301 to the same path and query on the domain, so old links
 * land and readers cite and sign in on the name; with none, the function is exactly as it was.
 */
function siteRewrite(domain?: string): string {
  if (!domain) return SITE_REWRITE.replace("/*REDIRECT*/", "");
  const redirect = `var host = request.headers.host ? request.headers.host.value.toLowerCase() : "";
  if (host !== "${domain}") {
    var query = [];
    var params = request.querystring || {};
    for (var key in params) {
      var values = params[key].multiValue || [params[key]];
      for (var i = 0; i < values.length; i++) {
        query.push(key + "=" + values[i].value);
      }
    }
    var location = "https://${domain}" + uri + (query.length ? "?" + query.join("&") : "");
    return {
      statusCode: 301,
      statusDescription: "Moved Permanently",
      headers: { location: { value: location } },
    };
  }
  `;
  return SITE_REWRITE.replace("/*REDIRECT*/", redirect);
}

// /data/<datasetId>/<version>/<path> reads open/<datasetId>/<version>/<path>.
const STRIP_DATA = `function handler(event) {
  var request = event.request;
  request.uri = request.uri.replace(/^\\/data/, "");
  return request;
}`;

/** The app's signed-in areas, which search engines are asked to leave alone. */
const NOT_FOR_ROBOTS = ["/submissions", "/submit", "/review", "/settings", "/account", "/sign-in"];

/** /robots.txt: the sitemap the backend writes, and the signed-in areas kept out of search. */
function robotsTxt(domain: string): string {
  return [
    "User-agent: *",
    ...NOT_FOR_ROBOTS.map((path) => `Disallow: ${path}`),
    "",
    `Sitemap: https://${domain}/sitemap.xml`,
    "",
  ].join("\n");
}

/**
 * One distribution: the app from the derived bucket's `site/`, open data from the archive
 * bucket's `open/` under `/data`, and the API under `/api`. No distribution-wide error
 * responses, so a missing data file or an API 404 stays a 404. The app and the dataset pages
 * carry a strict Content-Security-Policy.
 */
export class Web extends Construct {
  readonly distribution: cloudfront.Distribution;
  /** The site's address: the stage's domain, or the distribution's own name with none. */
  readonly siteDomain: string;
  private readonly derivedBucket: s3.IBucket;

  constructor(scope: Construct, id: string, props: WebProps) {
    super(scope, id);
    this.derivedBucket = props.derivedBucket;
    const viewerRequest = (functionId: string, code: string): cloudfront.FunctionAssociation => ({
      eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
      function: new cloudfront.Function(this, functionId, {
        code: cloudfront.FunctionCode.fromInline(code),
        runtime: cloudfront.FunctionRuntime.JS_2_0,
      }),
    });

    // Scripts, styles, fonts and images only from the site; connections to the site, Cognito's API
    // (sign-in, and the reader's passkeys and password) and the staging bucket's presigned links,
    // at the regional host and at the global one us-east-1 signs for. Forms post to the site, and
    // the sign-in page's hand-back to the command line's listener on this computer.
    const region = Stack.of(this).region;
    const staging = props.stagingBucket.bucketName;
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      `style-src 'self' ${pageStyleHash(props.brandColor)}`,
      "img-src 'self' data:",
      "font-src 'self'",
      `connect-src 'self' https://cognito-idp.${region}.amazonaws.com ` +
        `https://${staging}.s3.${region}.amazonaws.com https://${staging}.s3.amazonaws.com`,
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self' http://localhost:*",
      "object-src 'none'",
    ].join("; ");
    // HTTPS only for a year, and the page's path never leaves the site in a Referer.
    const strictTransportSecurity = { accessControlMaxAge: Duration.days(365), override: true };
    const referrerPolicy = {
      referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
      override: true,
    };
    const siteHeaders = new cloudfront.ResponseHeadersPolicy(this, "SiteHeaders", {
      comment: "The site's security headers",
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: csp, override: true },
        strictTransportSecurity,
        contentTypeOptions: { override: true },
        referrerPolicy,
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
      },
    });

    // Contributors' open files share the site's origin, so an .html or .svg among them must not
    // run script there (it could reach the signed-in app's window).
    const dataHeaders = new cloudfront.ResponseHeadersPolicy(this, "DataHeaders", {
      comment: "Open files: nothing runs",
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy:
            "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'",
          override: true,
        },
        contentTypeOptions: { override: true },
        strictTransportSecurity,
        referrerPolicy,
      },
    });

    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(props.derivedBucket, {
          originPath: "/site",
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: siteHeaders,
        functionAssociations: [viewerRequest("SiteRewrite", siteRewrite(props.domain?.name))],
      },
      additionalBehaviors: {
        "/data/*": {
          origin: origins.S3BucketOrigin.withOriginAccessControl(props.archiveBucket, {
            originPath: "/open",
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          responseHeadersPolicy: dataHeaders,
          functionAssociations: [viewerRequest("StripData", STRIP_DATA)],
        },
        "/api/*": {
          origin: new origins.RestApiOrigin(props.restApi),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
      enableLogging: true,
      logBucket: props.derivedBucket,
      logFilePrefix: "logs/",
      ...(props.domain
        ? { domainNames: [props.domain.name], certificate: props.domain.certificate }
        : {}),
    });

    this.siteDomain = props.domain?.name ?? this.distribution.distributionDomainName;

    // IPv6 is on, so the name needs an A and an AAAA alias. The name ends in a dot, so CDK never
    // reads the imported zone's name.
    if (props.domain) {
      const alias = {
        zone: props.domain.zone,
        recordName: `${props.domain.name}.`,
        target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution)),
      };
      new route53.ARecord(this, "AliasA", alias);
      new route53.AaaaRecord(this, "AliasAaaa", alias);
    }

    // Origin access control grants CloudFront the whole archive bucket; restricted data is
    // reached only through the API's short-lived links, so CloudFront is denied it outright.
    props.archiveBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        principals: [new iam.ServicePrincipal("cloudfront.amazonaws.com")],
        actions: ["s3:GetObject"],
        resources: [props.archiveBucket.arnForObjects("restricted/*")],
      }),
    );
    // Without s3:ListBucket S3 answers 403 for a missing key. A missing-key GET carries no
    // s3:prefix, so the grant can't be conditioned on one; it stays this distribution's alone,
    // which can't send a list: /data/* forces the /open origin path and forwards no query string.
    props.archiveBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal("cloudfront.amazonaws.com")],
        actions: ["s3:ListBucket"],
        resources: [props.archiveBucket.bucketArn],
        conditions: { StringEquals: { "AWS:SourceArn": this.distribution.distributionArn } },
      }),
    );
  }

  /**
   * Upload the web build, /auth-config.json, /archive-checks.json and /robots.txt into the
   * derived bucket's `site/`. Pruning is off in both deployments: catalog.json and datasets/ share the folder.
   * The hashed assets (the brand's logo and favicon among them, named by their content) cache
   * for a year and go first; index.html, app.js, auth-config.json, archive-checks.json and
   * brand/logo.<ext>, the stable logo the static dataset pages name, are no-cache and
   * invalidated, so a release, a rebrand or a change of profiles reaches readers at once. Both
   * use gitignore matching, which can re-include brand/logo.<ext> after `/*`.
   */
  deploySite(authConfig: AuthConfig, checks: ArchiveChecks): void {
    if (!existsSync(WEB_BUILD)) {
      throw new Error("packages/web/dist is missing: run npm run build -w packages/web first");
    }
    const assets = new s3deploy.BucketDeployment(this, "SiteAssets", {
      sources: [
        s3deploy.Source.asset(WEB_BUILD, {
          exclude: ["/index.html", "/app.js", "/brand/logo.*"],
          ignoreMode: IgnoreMode.GIT,
        }),
      ],
      destinationBucket: this.derivedBucket,
      destinationKeyPrefix: "site/",
      prune: false,
      cacheControl: [s3deploy.CacheControl.fromString("public, max-age=31536000, immutable")],
    });
    const site = new s3deploy.BucketDeployment(this, "Site", {
      sources: [
        s3deploy.Source.asset(WEB_BUILD, {
          exclude: ["/*", "!/index.html", "!/app.js", "!/brand/", "/brand/*", "!/brand/logo.*"],
          ignoreMode: IgnoreMode.GIT,
        }),
        s3deploy.Source.jsonData("auth-config.json", { ...authConfig }),
        s3deploy.Source.jsonData("archive-checks.json", {
          profiles: [...checks.profiles],
          required: [...checks.required],
        }),
        s3deploy.Source.data("robots.txt", robotsTxt(this.siteDomain)),
      ],
      destinationBucket: this.derivedBucket,
      destinationKeyPrefix: "site/",
      prune: false,
      cacheControl: [s3deploy.CacheControl.noCache()],
      distribution: this.distribution,
      distributionPaths: [
        "/index.html",
        "/app.js",
        "/auth-config.json",
        "/archive-checks.json",
        "/brand/logo.*",
        "/robots.txt",
      ],
    });
    site.node.addDependency(assets);
  }
}
