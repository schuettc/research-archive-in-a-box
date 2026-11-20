import { CustomResource, Duration, RemovalPolicy } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as ses from "aws-cdk-lib/aws-ses";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";

/**
 * The Regions where a user pool can't send through an SES identity in its own Region (the ones
 * Cognito's page marks Alternate Region). Kept in sync with _REGIONS_WITHOUT_SES in
 * packages/contract/src/archive_contract/config.py, whose validator the loader can't run.
 */
export const REGIONS_WITHOUT_SES = new Set([
  "ca-west-1",
  "mx-central-1",
  "ap-east-1",
  "ap-southeast-5",
  "ap-southeast-7",
  "ap-south-2",
  "ap-southeast-4",
  "eu-central-2",
  "eu-south-2",
  "me-central-1",
]);

const ON_EVENT_SOURCE = `
def on_event(event, context):
    return {"PhysicalResourceId": event["ResourceProperties"]["Identity"]}
`;

/** Complete once SES reports the identity verified for sending; a delete completes at once. */
export const IS_COMPLETE_SOURCE = `
import boto3


def is_complete(event, context):
    if event["RequestType"] == "Delete":
        return {"IsComplete": True}
    name = event["ResourceProperties"]["Identity"]
    identity = boto3.client("sesv2").get_email_identity(EmailIdentity=name)
    return {"IsComplete": identity["VerifiedForSendingStatus"]}
`;

export interface EmailProps {
  readonly domain: { readonly name: string; readonly zone: route53.IHostedZone };
  readonly keepData: boolean;
}

/**
 * The stage's domain as an SES identity with Easy DKIM, its three DKIM CNAMEs in the stage's
 * hosted zone, and `verified`, which completes once SES reports the identity verified: Cognito
 * refuses a pool whose SES identity isn't, so the pool waits on it.
 */
export class Email extends Construct {
  readonly identity: ses.EmailIdentity;
  /** Completes once SES has verified the identity, polling every 30 seconds for up to an hour. */
  readonly verified: CustomResource;

  constructor(scope: Construct, id: string, props: EmailProps) {
    super(scope, id);
    const { name, zone } = props.domain;
    // Easy DKIM with a 2048-bit key is CDK's default. Not Identity.publicHostedZone: it names the
    // identity after the zone, not the stage's name, and needs the zone's name, which a zone
    // imported by id doesn't have. So the records are written here, as CDK's own code does.
    this.identity = new ses.EmailIdentity(this, "Identity", {
      identity: ses.Identity.domain(name),
    });
    const records = this.identity.dkimRecords.map(
      (record, i) =>
        new route53.CfnRecordSet(this, `DkimRecord${i + 1}`, {
          hostedZoneId: zone.hostedZoneId,
          name: record.name,
          type: "CNAME",
          ttl: "1800",
          resourceRecords: [record.value],
        }),
    );

    const onEvent = this.handler("OnEvent", "on_event", ON_EVENT_SOURCE, props.keepData);
    const isComplete = this.handler(
      "IsComplete",
      "is_complete",
      IS_COMPLETE_SOURCE,
      props.keepData,
    );
    isComplete.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:GetEmailIdentity"],
        resources: [this.identity.emailIdentityArn],
      }),
    );
    const provider = new cr.Provider(this, "Provider", {
      onEventHandler: onEvent,
      isCompleteHandler: isComplete,
      queryInterval: Duration.seconds(30),
      // Under CloudFormation's own one-hour wait for a custom resource, so this error is the one shown.
      totalTimeout: Duration.minutes(55),
    });
    this.verified = new CustomResource(this, "IdentityVerified", {
      serviceToken: provider.serviceToken,
      resourceType: "Custom::SesIdentityVerified",
      properties: { Identity: name },
    });
    for (const record of records) {
      this.verified.node.addDependency(record);
    }
  }

  /** An inline Python 3.13 handler on the runtime's boto3, with a one-month log group. */
  private handler(id: string, fn: string, source: string, keepData: boolean): lambda.Function {
    const logGroup = new logs.LogGroup(this, `${id}Logs`, {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: keepData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    return new lambda.Function(this, id, {
      runtime: lambda.Runtime.PYTHON_3_13,
      architecture: lambda.Architecture.ARM_64,
      code: lambda.Code.fromInline(source),
      handler: `index.${fn}`,
      timeout: Duration.seconds(30),
      logGroup,
    });
  }
}
