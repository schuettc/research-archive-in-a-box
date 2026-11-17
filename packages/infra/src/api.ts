import * as apigateway from "aws-cdk-lib/aws-apigateway";
import type * as cognito from "aws-cdk-lib/aws-cognito";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import { Construct } from "constructs";

export interface ApiProps {
  readonly userPool: cognito.IUserPool;
  readonly waf: boolean;
  readonly health: lambda.IFunction;
  readonly whoami: lambda.IFunction;
}

const MANAGED_RULE_GROUPS = [
  "AWSManagedRulesCommonRuleSet",
  "AWSManagedRulesKnownBadInputsRuleSet",
  "AWSManagedRulesAmazonIpReputationList",
];

/** The user pool's sign-up and sign-in calls that send no email, by the X-Amz-Target header of
 * Cognito's API. */
const RATE_LIMITED_CALLS = [
  "ConfirmSignUp",
  "InitiateAuth",
  "RespondToAuthChallenge",
  "ConfirmForgotPassword",
];

/** Sign-up and sign-in calls one address may make in five minutes before WAF refuses more. */
const SIGN_IN_RATE_LIMIT = 100;

/** The calls that make Cognito send an email, which the account may do 50 times a day. */
const EMAIL_CALLS = ["SignUp", "ResendConfirmationCode", "ForgotPassword"];

/** Email-sending calls one address may make in a minute: WAF's lowest limit and window. Only
 * SES lifts the daily cap itself. */
const EMAIL_RATE_LIMIT = 10;
const EMAIL_RATE_WINDOW_SECONDS = 60;

/** A per-address rate rule, blocking, counted only over the named Cognito calls. Only Cognito's
 * own calls carry these targets, so the API's requests never count. */
function cognitoRateRule(
  name: string,
  priority: number,
  calls: string[],
  limit: number,
  evaluationWindowSec?: number,
): wafv2.CfnWebACL.RuleProperty {
  return {
    name,
    priority,
    action: { block: {} },
    statement: {
      rateBasedStatement: {
        aggregateKeyType: "IP",
        limit,
        ...(evaluationWindowSec === undefined ? {} : { evaluationWindowSec }),
        scopeDownStatement: {
          orStatement: {
            statements: calls.map((call) => ({
              byteMatchStatement: {
                fieldToMatch: { singleHeader: { Name: "x-amz-target" } },
                positionalConstraint: "EXACTLY",
                searchString: `AWSCognitoIdentityProviderService.${call}`,
                textTransformations: [{ priority: 0, type: "NONE" }],
              },
            })),
          },
        },
      },
    },
    visibilityConfig: {
      cloudWatchMetricsEnabled: true,
      metricName: name,
      sampledRequestsEnabled: true,
    },
  };
}

/**
 * The REST API under `/api`, with fixed stage throttling and a Cognito authorizer. `whoami`
 * exists because CDK refuses an authorizer attached to no method, and it proves a signed-in call.
 * With the WAF module on, one regional web ACL guards both the API stage and the user pool.
 */
export class Api extends Construct {
  readonly restApi: apigateway.RestApi;
  readonly authorizer: apigateway.CognitoUserPoolsAuthorizer;

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);
    this.restApi = new apigateway.RestApi(this, "RestApi", {
      endpointConfiguration: { types: [apigateway.EndpointType.REGIONAL] },
      deployOptions: {
        throttlingRateLimit: 50,
        throttlingBurstLimit: 100,
        metricsEnabled: true,
      },
    });
    this.authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, "Authorizer", {
      cognitoUserPools: [props.userPool],
    });

    const api = this.restApi.root.addResource("api");
    api.addResource("health").addMethod("GET", new apigateway.LambdaIntegration(props.health), {
      authorizationType: apigateway.AuthorizationType.NONE,
    });
    api.addResource("whoami").addMethod("GET", new apigateway.LambdaIntegration(props.whoami), {
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer: this.authorizer,
    });

    if (props.waf) {
      const acl = new wafv2.CfnWebACL(this, "WebAcl", {
        scope: "REGIONAL",
        defaultAction: { allow: {} },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: "ArchiveApi",
          sampledRequestsEnabled: true,
        },
        rules: [
          ...MANAGED_RULE_GROUPS.map((name, priority) => ({
            name,
            priority,
            overrideAction: { none: {} },
            statement: { managedRuleGroupStatement: { vendorName: "AWS", name } },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: name,
              sampledRequestsEnabled: true,
            },
          })),
          cognitoRateRule(
            "SignInRateLimit",
            MANAGED_RULE_GROUPS.length,
            RATE_LIMITED_CALLS,
            SIGN_IN_RATE_LIMIT,
          ),
          cognitoRateRule(
            "EmailRateLimit",
            MANAGED_RULE_GROUPS.length + 1,
            EMAIL_CALLS,
            EMAIL_RATE_LIMIT,
            EMAIL_RATE_WINDOW_SECONDS,
          ),
        ],
      });
      new wafv2.CfnWebACLAssociation(this, "WebAclAssociation", {
        webAclArn: acl.attrArn,
        resourceArn: this.restApi.deploymentStage.stageArn,
      });
      // A pool takes only a regional web ACL in its own region, which this one is.
      new wafv2.CfnWebACLAssociation(this, "UserPoolWebAclAssociation", {
        webAclArn: acl.attrArn,
        resourceArn: props.userPool.userPoolArn,
      });
    }
  }
}
