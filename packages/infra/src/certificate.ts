import { Stack } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import type { Construct } from "constructs";
import type { Domain } from "./generated/archive-config";

export interface CertificateStackProps {
  readonly domain: Domain;
  /** The stage's account, when it names one. */
  readonly account?: string;
}

/**
 * A stage's certificate for its own domain, in us-east-1 whatever the stage's region: CloudFront
 * takes viewer certificates only from there. ACM writes its validation CNAME into the hosted zone.
 */
export class CertificateStack extends Stack {
  readonly certificate: acm.Certificate;

  constructor(scope: Construct, id: string, props: CertificateStackProps) {
    super(scope, id, {
      env: { account: props.account, region: "us-east-1" },
      crossRegionReferences: true,
    });
    this.certificate = new acm.Certificate(this, "Certificate", {
      domainName: props.domain.name,
      validation: acm.CertificateValidation.fromDns(
        route53.HostedZone.fromHostedZoneId(this, "Zone", props.domain.hostedZoneId),
      ),
    });
  }
}
