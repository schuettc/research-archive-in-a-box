import { Stack } from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import type * as cognito from "aws-cdk-lib/aws-cognito";
import * as iam from "aws-cdk-lib/aws-iam";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";

export interface ApiProps {
  readonly userPool: cognito.IUserPool;
  readonly waf: boolean;
  readonly health: lambda.IFunction;
  readonly whoami: lambda.IFunction;
  /** With WAF on, the API requests one visitor address may make in five minutes. */
  readonly requestsPerFiveMinutes?: number;
}

/** API requests one visitor address may make in five minutes before WAF refuses more. */
const API_RATE_LIMIT = 2000;

/** The header the distribution sets to the visitor's address, which the per-address limit counts. */
export const VIEWER_ADDRESS_HEADER = "x-viewer-address";

/** The header that carries the API's key, which the distribution sends on every request. */
export const ORIGIN_KEY_HEADER = "x-api-key";

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
 * With the WAF module on, one regional web ACL guards both the API stage and the user pool, the
 * API answers only requests that carry the key the archive's distribution sends, the web ACL
 * refuses the others, and it limits requests per visitor address.
 */
export class Api extends Construct {
  readonly restApi: apigateway.RestApi;
  readonly authorizer: apigateway.CognitoUserPoolsAuthorizer;
  /** With WAF on, the value of the key every request must carry; undefined with WAF off. */
  readonly originKey?: string;

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);
    this.restApi = new apigateway.RestApi(this, "RestApi", {
      endpointConfiguration: { types: [apigateway.EndpointType.REGIONAL] },
      deployOptions: {
        throttlingRateLimit: 50,
        throttlingBurstLimit: 100,
        metricsEnabled: true,
      },
      ...(props.waf ? { defaultMethodOptions: { apiKeyRequired: true } } : {}),
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
      // API Gateway makes the key's value and holds it; one read at deploy hands it to the
      // distribution and the web ACL.
      const key = this.restApi.addApiKey("OriginKey");
      this.restApi
        .addUsagePlan("ThroughCloudFront", {
          apiStages: [{ stage: this.restApi.deploymentStage }],
        })
        .addApiKey(key);
      const stack = Stack.of(this);
      // The call reads and changes nothing, so an update returns the same value.
      const readKey: cr.AwsSdkCall = {
        service: "APIGateway",
        action: "getApiKey",
        parameters: { apiKey: key.keyId, includeValue: true },
        outputPaths: ["value"],
        physicalResourceId: cr.PhysicalResourceId.of(key.keyId),
        logging: cr.Logging.withDataHidden(),
      };
      const keyValue = new cr.AwsCustomResource(this, "OriginKeyValue", {
        onCreate: readKey,
        onUpdate: readKey,
        installLatestAwsSdk: false,
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ["apigateway:GET"],
            resources: [`arn:${stack.partition}:apigateway:${stack.region}::/apikeys/${key.keyId}`],
          }),
        ]),
      });
      this.originKey = keyValue.getResponseField("value");

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
          // A request to the API's own address must carry the key the distribution sends. The
          // user pool's requests carry another host, so this never matches them.
          {
            name: "ApiThroughSite",
            priority: MANAGED_RULE_GROUPS.length,
            action: { block: {} },
            statement: {
              andStatement: {
                statements: [
                  {
                    byteMatchStatement: {
                      fieldToMatch: { singleHeader: { Name: "host" } },
                      positionalConstraint: "ENDS_WITH",
                      searchString: `.execute-api.${stack.region}.${stack.urlSuffix}`,
                      textTransformations: [{ priority: 0, type: "LOWERCASE" }],
                    },
                  },
                  {
                    notStatement: {
                      statement: {
                        byteMatchStatement: {
                          fieldToMatch: { singleHeader: { Name: ORIGIN_KEY_HEADER } },
                          positionalConstraint: "EXACTLY",
                          searchString: this.originKey,
                          textTransformations: [{ priority: 0, type: "NONE" }],
                        },
                      },
                    },
                  },
                ],
              },
            },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: "ApiThroughSite",
              sampledRequestsEnabled: true,
            },
          },
          cognitoRateRule(
            "SignInRateLimit",
            MANAGED_RULE_GROUPS.length + 1,
            RATE_LIMITED_CALLS,
            SIGN_IN_RATE_LIMIT,
          ),
          cognitoRateRule(
            "EmailRateLimit",
            MANAGED_RULE_GROUPS.length + 2,
            EMAIL_CALLS,
            EMAIL_RATE_LIMIT,
            EMAIL_RATE_WINDOW_SECONDS,
          ),
          // Counted only over requests that carry the key, by the address the distribution set.
          {
            name: "ApiRateLimit",
            priority: MANAGED_RULE_GROUPS.length + 3,
            action: { block: {} },
            statement: {
              rateBasedStatement: {
                aggregateKeyType: "CUSTOM_KEYS",
                limit: props.requestsPerFiveMinutes ?? API_RATE_LIMIT,
                evaluationWindowSec: 300,
                customKeys: [
                  {
                    header: {
                      name: VIEWER_ADDRESS_HEADER,
                      textTransformations: [{ priority: 0, type: "NONE" }],
                    },
                  },
                ],
                scopeDownStatement: {
                  byteMatchStatement: {
                    fieldToMatch: { singleHeader: { Name: ORIGIN_KEY_HEADER } },
                    positionalConstraint: "EXACTLY",
                    searchString: this.originKey,
                    textTransformations: [{ priority: 0, type: "NONE" }],
                  },
                },
              },
            },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: "ApiRateLimit",
              sampledRequestsEnabled: true,
            },
          },
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
