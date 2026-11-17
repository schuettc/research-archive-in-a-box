import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as iam from "aws-cdk-lib/aws-iam";
import * as sns from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";
import type { ResearchArchive } from "./research-archive";

export interface AccessProps {
  readonly archive: ResearchArchive;
}

/**
 * The `AccessFunction` behind the admin people routes (`/api/admin/people…` and
 * `/api/admin/account-events`) and the access routes (`/api/datasets/{id}/access…` and
 * `/api/admin/access-requests…`), and the Admins topic it subscribes each admin's email to and
 * tells of each new request. Its role holds only the Cognito, DynamoDB, SSM and SNS calls those
 * routes make.
 */
export class Access extends Construct {
  readonly adminsTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: AccessProps) {
    super(scope, id);
    const { archive } = props;

    this.adminsTopic = new sns.Topic(this, "Admins", { displayName: "Research archive admins" });

    const fn = archive.pythonFunction("AccessFunction", {
      handler: "archive_backend.access.handler",
      environment: {
        USER_POOL_ID: archive.userPool.userPoolId,
        USER_PROFILES_TABLE: archive.userProfiles.tableName,
        ACCOUNT_EVENTS_TABLE: archive.accountEvents.tableName,
        ADMINS_TOPIC_ARN: this.adminsTopic.topicArn,
        ACCESS_TABLE: archive.access.tableName,
        ACTIVE_CATALOG_PARAMETER: archive.activeCatalogParameter.parameterName,
        CATALOG_TABLE_A: archive.catalogTables.a.tableName,
        CATALOG_TABLE_B: archive.catalogTables.b.tableName,
      },
    });
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "cognito-idp:ListUsers",
          "cognito-idp:AdminListGroupsForUser",
          // Invites, and resends an invite.
          "cognito-idp:AdminCreateUser",
          "cognito-idp:AdminAddUserToGroup",
          "cognito-idp:AdminRemoveUserFromGroup",
          "cognito-idp:AdminDisableUser",
          "cognito-idp:AdminEnableUser",
          "cognito-idp:AdminUserGlobalSignOut",
        ],
        resources: [archive.userPool.userPoolArn],
      }),
    );
    // Disable and enable set the profile's `disabled` mark, which the download and request
    // routes read.
    archive.userProfiles.grant(fn, "dynamodb:GetItem", "dynamodb:UpdateItem");
    archive.accountEvents.grant(fn, "dynamodb:PutItem", "dynamodb:Query");
    // Requests and decisions are conditional puts; the admins' list scans the small table.
    archive.access.grant(fn, "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Scan");
    // A request checks the dataset is restricted, from its item in the active catalog table.
    archive.catalogTables.a.grant(fn, "dynamodb:GetItem");
    archive.catalogTables.b.grant(fn, "dynamodb:GetItem");
    archive.activeCatalogParameter.grantRead(fn);
    // Giving the admin role subscribes the email; removing it finds and ends that subscription.
    // A new access request is published to it. Only email subscriptions, so the role can't
    // point the topic at an HTTP endpoint, SMS or a function.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["sns:Subscribe"],
        resources: [this.adminsTopic.topicArn],
        conditions: { StringEquals: { "sns:Protocol": "email" } },
      }),
    );
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["sns:ListSubscriptionsByTopic", "sns:Unsubscribe", "sns:Publish"],
        resources: [this.adminsTopic.topicArn],
      }),
    );

    const integration = new apigateway.LambdaIntegration(fn);
    const auth: apigateway.MethodOptions = {
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer: archive.authorizer,
    };
    const api = archive.api.root.getResource("api");
    if (!api) {
      throw new Error("Access needs the /api resource");
    }
    // The read API's /api/admin/usage may have made /api/admin already.
    const admin = api.getResource("admin") ?? api.addResource("admin");
    const people = admin.addResource("people");
    people.addMethod("GET", integration, auth);
    people.addMethod("POST", integration, auth);
    const one = people.addResource("{sub}");
    one.addResource("roles").addMethod("PUT", integration, auth);
    for (const action of ["resend", "disable", "enable"]) {
      one.addResource(action).addMethod("POST", integration, auth);
    }
    admin.addResource("account-events").addMethod("GET", integration, auth);

    const requests = admin.addResource("access-requests");
    requests.addMethod("GET", integration, auth);
    const asked = requests.addResource("{dataset}").addResource("{sub}");
    asked.addResource("decision").addMethod("POST", integration, auth);
    asked.addResource("take-back").addMethod("POST", integration, auth);
    // The read API made /api/datasets/{id}.
    const dataset = api.getResource("datasets")?.getResource("{id}");
    if (!dataset) {
      throw new Error("Access needs the read API's /api/datasets/{id} resource");
    }
    dataset.addResource("access").addMethod("GET", integration, auth);
    dataset.addResource("access-requests").addMethod("POST", integration, auth);
  }
}
