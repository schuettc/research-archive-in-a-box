import { createHash } from "node:crypto";
import { CfnOutput, Lazy, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as iam from "aws-cdk-lib/aws-iam";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct, type IDependable } from "constructs";
import type { LoginBrand } from "./brand";

/**
 * What a signed-in person may change about themselves: nothing that matters. Cognito reads an
 * empty list as "every attribute", so the list names locale, which the archive never reads; the
 * web app's access token (aws.cognito.signin.user.admin, which every API sign-in carries)
 * therefore can't change an email, which curators see people by.
 */
const ONLY_LOCALE = new cognito.ClientAttributes().withStandardAttributes({ locale: true });

export interface AuthProps {
  readonly keepData: boolean;
  /** The archive's brand: the invitation and code emails' name. */
  readonly brand: LoginBrand;
  /**
   * The stage's domain, which the invitation names as where to sign in. It is known before the
   * deploy; CloudFront's address isn't, and the pool can't wait on the distribution.
   */
  readonly siteAddress?: string;
  /**
   * Send the account emails through SES from no-reply@`domain`, once `ready` (the identity's
   * verification) completes: Cognito refuses an identity SES hasn't verified.
   */
  readonly email?: { readonly domain: string; readonly ready: IDependable };
}

/**
 * The user pool with email sign-in, offering a password or a passkey, and its role groups. People
 * sign in on the archive's own page, the command line too, through Cognito's API; Cognito shows no
 * page of its own and has no domain. Anyone may sign up, confirming their email
 * with an emailed code, and gets no role; an admin may still invite a person with
 * `just invite-user`, as the first admin of a new deploy is. Its emails come from Cognito's own
 * no-reply@verificationemail.com, or with `email` from `<brand name> <no-reply@<domain>>` through
 * the account's SES.
 */
export class Auth extends Construct {
  readonly userPool: cognito.UserPool;
  private readonly keepData: boolean;

  constructor(scope: Construct, id: string, props: AuthProps) {
    super(scope, id);
    this.keepData = props.keepData;
    const name = props.brand.name;
    // The email is HTML; the subject is plain text.
    const escape = (text: string) =>
      text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const html = escape(name);
    const address = props.siteAddress ? escape(`https://${props.siteAddress}`) : undefined;
    const signInAt = address ? `Sign in at <a href="${address}">${address}</a>.<br><br>` : "";
    this.userPool = new cognito.UserPool(this, "UserPool", {
      // Sign-up confirms the email with a code, so an unconfirmed account can't sign in.
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      // A changed email takes effect only once its owner verifies it; until then the old one stays.
      keepOriginal: { email: true },
      // Choice-based sign-in: a password or a passkey. The passkey relying party is the site's
      // address (the stage's domain when it has one, else the distribution's name), set by
      // setRelyingParty after the distribution: it can't go in here, since with no domain the
      // distribution depends on the API, whose authorizer depends on this pool.
      signInPolicy: { allowedFirstAuthFactors: { password: true, passkey: true } },
      passkeyUserVerification: cognito.PasskeyUserVerification.PREFERRED,
      userInvitation: {
        emailSubject: `Your ${name} account`,
        emailBody:
          `You've been invited to ${html}.<br><br>Sign in with your email address, {username}, ` +
          `and this temporary password: {####}<br><br>${signInAt}You'll choose your own password when ` +
          `you first sign in, and can add a passkey after.`,
      },
      userVerification: {
        emailStyle: cognito.VerificationEmailStyle.CODE,
        emailSubject: `Your ${name} code`,
        emailBody:
          `Your code for ${html} is {####}<br><br>Enter it on the archive's page to confirm ` +
          `your email address.`,
      },
      ...(props.email
        ? {
            email: cognito.UserPoolEmail.withSES({
              fromEmail: `no-reply@${props.email.domain}`,
              fromName: name,
              // Without it the ARN names the address, which SES hasn't verified on its own.
              sesVerifiedDomain: props.email.domain,
            }),
          }
        : {}),
      ...(props.keepData
        ? { removalPolicy: RemovalPolicy.RETAIN, deletionProtection: true }
        : { removalPolicy: RemovalPolicy.DESTROY }),
    });
    if (props.email) {
      this.userPool.node.addDependency(props.email.ready);
    }
    for (const group of ["contributor", "curator", "admin"]) {
      new cognito.CfnUserPoolGroup(this, `${group}Group`, {
        userPoolId: this.userPool.userPoolId,
        groupName: group,
      });
    }
  }

  /**
   * The web app's client, which signs people in on the archive's own page through Cognito's API
   * (choice-based sign-in, renewed with the refresh token), with no OAuth and no secret. The
   * command line takes its tokens from that page, so it needs no client of its own.
   */
  addAppClients(): { web: cognito.UserPoolClient } {
    const web = this.userPool.addClient("WebClient", {
      generateSecret: false,
      disableOAuth: true,
      // CDK adds ALLOW_REFRESH_TOKEN_AUTH to these; token revocation is on by default.
      authFlows: { user: true },
      // An unknown email is refused like a wrong password, and Forgot your password? answers
      // the same for both, so the sign-in page can't be used to learn who has an account.
      preventUserExistenceErrors: true,
      writeAttributes: ONLY_LOCALE,
    });
    return { web };
  }

  /**
   * Make the site's address (the stage's domain when it has one, else the distribution's name)
   * the pool's passkey relying party, so passkeys are made and used on the archive's own page:
   * a SetUserPoolMfaConfig call after deploy, keeping MFA off and user verification preferred. It runs again whenever the pool's own settings change, since
   * CloudFormation's update of the pool may set its passkey settings back to Cognito's default.
   */
  setRelyingParty(siteDomain: string): void {
    const pool = this.userPool.node.defaultChild as cognito.CfnUserPool;
    const stack = Stack.of(this);
    const call: cr.AwsSdkCall = {
      service: "CognitoIdentityServiceProvider",
      action: "setUserPoolMfaConfig",
      parameters: {
        UserPoolId: this.userPool.userPoolId,
        MfaConfiguration: "OFF",
        WebAuthnConfiguration: { RelyingPartyId: siteDomain, UserVerification: "preferred" },
      },
      physicalResourceId: cr.PhysicalResourceId.of(`${this.node.path}/RelyingParty`),
    };
    const relyingParty = new cr.AwsCustomResource(this, "RelyingParty", {
      onCreate: call,
      onUpdate: call,
      installLatestAwsSdk: false,
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ["cognito-idp:SetUserPoolMfaConfig"],
          resources: [this.userPool.userPoolArn],
        }),
      ]),
    });
    // A change to the pool's template changes this property, so CloudFormation calls again.
    const resource = relyingParty.node.findChild("Resource") as unknown as {
      node: { defaultChild: { addPropertyOverride(path: string, value: unknown): void } };
    };
    resource.node.defaultChild.addPropertyOverride(
      "PoolFingerprint",
      Lazy.string({
        produce: () => {
          const template = (pool as unknown as { _toCloudFormation(): object })._toCloudFormation();
          const json = JSON.stringify(stack.resolve(template));
          return createHash("sha256").update(json).digest("hex").slice(0, 16);
        },
      }),
    );
  }

  /**
   * The test-only `e2e` client, for stages with keepData: false: admin password sign-in, so `just
   * ingest-e2e` signs in the throwaway users it creates. Its outputs are what the run reads.
   */
  addTestClient(): cognito.UserPoolClient {
    if (this.keepData) {
      throw new Error("the e2e client is never created on a stage that keeps its data");
    }
    const client = this.userPool.addClient("E2eClient", {
      userPoolClientName: "e2e",
      generateSecret: false,
      authFlows: { adminUserPassword: true },
      disableOAuth: true,
      writeAttributes: ONLY_LOCALE,
    });
    const stack = Stack.of(this);
    new CfnOutput(stack, "E2eClientId", { key: "E2eClientId", value: client.userPoolClientId });
    new CfnOutput(stack, "UserPoolId", { key: "UserPoolId", value: this.userPool.userPoolId });
    return client;
  }
}
