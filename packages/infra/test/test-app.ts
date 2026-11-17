import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import { ResearchArchive } from "../src/research-archive";

/**
 * An App that fingerprints the Lambda asset but does not copy it into each synth's output: the
 * packaged archive-backend is tens of megabytes, and copying it per test makes the suite crawl.
 */
export function testApp(): App {
  return new App({ context: { "aws:cdk:disable-asset-staging": true } });
}

/** The domain the domain tests give a stage, and its hosted zone. */
export const TEST_DOMAIN = { name: "data.example.org", hostedZoneId: "Z0123456789ABCDEF" };

/**
 * A stage with TEST_DOMAIN and an imported certificate, as bin/app.ts would build it; with
 * `email: "ses"`, it also sends its account emails through SES.
 */
export function domainArchive(
  stage = "prod",
  options: { email?: "ses" } = {},
): {
  stack: Stack;
  archive: ResearchArchive;
  template: Template;
} {
  const stack = new Stack(testApp(), "S", { env: { region: "us-east-1" } });
  const certificate = acm.Certificate.fromCertificateArn(
    stack,
    "Certificate",
    "arn:aws:acm:us-east-1:123456789012:certificate/test",
  );
  const archive = new ResearchArchive(stack, "Archive", {
    config: {
      publisher: "P",
      infrastructure: {
        alertEmail: "a@example.org",
        stages: [
          {
            name: stage,
            region: "us-east-1",
            domain: TEST_DOMAIN,
            ...(options.email ? { email: options.email } : {}),
          },
        ],
      },
    },
    stage,
    certificate,
  });
  return { stack, archive, template: Template.fromStack(stack) };
}
