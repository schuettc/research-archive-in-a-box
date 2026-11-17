import { fileURLToPath } from "node:url";
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import type { CfnUserPool } from "aws-cdk-lib/aws-cognito";
import type { CfnDistribution } from "aws-cdk-lib/aws-cloudfront";
import { Construct } from "constructs";
import { expect, test } from "vitest";
import { createApp } from "../bin/app";
import { Auth } from "../src/auth";
import { loginBrand } from "../src/brand";
import { ResearchArchive } from "../src/research-archive";
import { domainArchive, testApp } from "./test-app";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const BRAND = loginBrand(
  {
    publisher: "Invented Research Cooperative",
    brand: {
      name: "Lake Archive",
      primaryColor: "#0b5cad",
      logo: "examples/brand/logo.svg",
      favicon: "examples/brand/favicon.svg",
    },
  },
  REPO,
);

function archive(stage = "prod"): Template {
  const stack = new Stack(testApp(), "S");
  new ResearchArchive(stack, "Archive", {
    config: {
      publisher: "P",
      infrastructure: { alertEmail: "a@example.org", stages: [{ name: "prod" }, { name: "dev" }] },
    },
    stage,
  });
  return Template.fromStack(stack);
}

function authWithClients(): Template {
  const stack = new Stack(testApp(), "S");
  const auth = new Auth(stack, "Auth", { isProd: false, brand: BRAND });
  auth.addAppClients();
  return Template.fromStack(stack);
}

test("the user pool signs in with email, lets anyone sign up with an emailed code, and has contributor, curator and admin groups", () => {
  const template = archive();

  template.resourceCountIs("AWS::Cognito::UserPool", 1);
  template.hasResourceProperties("AWS::Cognito::UserPool", {
    UsernameAttributes: ["email"],
    AutoVerifiedAttributes: ["email"],
    AdminCreateUserConfig: { AllowAdminCreateUserOnly: false },
    VerificationMessageTemplate: { DefaultEmailOption: "CONFIRM_WITH_CODE" },
    AccountRecoverySetting: {
      RecoveryMechanisms: [{ Name: "verified_email", Priority: 1 }],
    },
  });
  const groups = Object.values(template.findResources("AWS::Cognito::UserPoolGroup")).map(
    (group) => group.Properties.GroupName,
  );
  expect(groups.sort()).toEqual(["admin", "contributor", "curator"]);
});

function clients(template: Template) {
  const all = template.findResources("AWS::Cognito::UserPoolClient");
  const web = Object.entries(all).find(([id]) => id.includes("WebClient"));
  if (!web) throw new Error("the web client expected");
  return { web: { id: web[0], Properties: web[1].Properties } };
}

test("there is no managed login: no user pool domain, no branding, and the web client is the one app client", () => {
  for (const template of [authWithClients(), archive("prod")]) {
    template.resourceCountIs("AWS::Cognito::UserPoolDomain", 0);
    template.resourceCountIs("AWS::Cognito::ManagedLoginBranding", 0);
    template.resourceCountIs("AWS::Cognito::UserPoolClient", 1);
    expect(Object.keys(template.findResources("AWS::Cognito::UserPoolClient"))).toEqual([
      clients(template).web.id,
    ]);
  }
});

test("the web client signs in through Cognito's API: choice-based sign-in and refresh, no OAuth, no secret", () => {
  const { web } = clients(authWithClients());

  expect(web.Properties.ExplicitAuthFlows).toEqual(["ALLOW_USER_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]);
  expect(web.Properties.AllowedOAuthFlowsUserPoolClient).toBe(false);
  expect(web.Properties.AllowedOAuthFlows).toBeUndefined();
  expect(web.Properties.CallbackURLs).toBeUndefined();
  expect(web.Properties.GenerateSecret).toBe(false);
  expect(web.Properties.PreventUserExistenceErrors).toBe("ENABLED");
  // Revoking the refresh token at sign-out needs revocation on, Cognito's default.
  expect(web.Properties.EnableTokenRevocation).not.toBe(false);
});

// Cognito treats an empty WriteAttributes like none set: every attribute writable. So each client
// names one harmless attribute, and the pool keeps a verified email until a new one is verified.
test("no client can write a person's email, so the self-service scope can't change it", () => {
  for (const template of [authWithClients(), archive("dev"), archive("prod")]) {
    const clients = template.findResources("AWS::Cognito::UserPoolClient");
    for (const client of Object.values(clients)) {
      expect(client.Properties.WriteAttributes).toEqual(["locale"]);
    }
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      UserAttributeUpdateSettings: { AttributesRequireVerificationBeforeUpdate: ["email"] },
    });
  }
});

test("the pool offers password and passkey sign-in, preferring user verification", () => {
  const template = authWithClients();

  template.hasResourceProperties("AWS::Cognito::UserPool", {
    Policies: { SignInPolicy: { AllowedFirstAuthFactors: ["PASSWORD", "WEB_AUTHN"] } },
    WebAuthnUserVerification: "preferred",
  });
  // The relying party can't be named on the pool: the distribution depends on the pool.
  const [pool] = Object.values(template.findResources("AWS::Cognito::UserPool"));
  expect(pool?.Properties.WebAuthnRelyingPartyID).toBeUndefined();
});

function relyingParty(template: Template) {
  const [resource, ...others] = Object.values(template.findResources("Custom::AWS")).filter((r) =>
    JSON.stringify(r.Properties.Create ?? "").includes("setUserPoolMfaConfig"),
  );
  expect(others).toEqual([]);
  return resource;
}

test("after deploy the pool's passkey relying party is the distribution's domain, with MFA off", () => {
  const stack = new Stack(testApp(), "S");
  const a = new ResearchArchive(stack, "Archive", {
    config: {
      publisher: "P",
      infrastructure: { alertEmail: "a@example.org", stages: [{ name: "prod" }, { name: "dev" }] },
    },
    stage: "dev",
  });
  const template = Template.fromStack(stack);
  const distribution = stack.getLogicalId(a.distribution.node.defaultChild as CfnDistribution);
  const pool = stack.getLogicalId(a.userPool.node.defaultChild as CfnUserPool);
  const resource = relyingParty(template);

  for (const event of ["Create", "Update"]) {
    const call = resource?.Properties[event];
    // The call is a JSON string with the tokens joined in.
    const joined = JSON.stringify(call);
    expect(joined).toContain('\\"service\\":\\"CognitoIdentityServiceProvider\\"');
    expect(joined).toContain('\\"action\\":\\"setUserPoolMfaConfig\\"');
    expect(joined).toContain('\\"MfaConfiguration\\":\\"OFF\\"');
    expect(joined).toContain('\\"UserVerification\\":\\"preferred\\"');
    expect(joined).toContain(JSON.stringify({ "Fn::GetAtt": [distribution, "DomainName"] }));
    expect(joined).toContain(JSON.stringify({ Ref: pool }));
  }
  expect(resource?.Properties.PoolFingerprint).toMatch(/^[0-9a-f]{16}$/);
  const policies = Object.values(template.findResources("AWS::IAM::Policy"));
  const statements = policies.flatMap((p) => p.Properties.PolicyDocument.Statement);
  const grant = statements.filter((s) =>
    JSON.stringify(s.Action).includes("cognito-idp:SetUserPoolMfaConfig"),
  );
  expect(grant).toEqual([
    {
      Action: "cognito-idp:SetUserPoolMfaConfig",
      Effect: "Allow",
      Resource: { "Fn::GetAtt": [pool, "Arn"] },
    },
  ]);
});

test("a change to the pool's settings calls SetUserPoolMfaConfig again", () => {
  const fingerprint = (subject: string) => {
    const stack = new Stack(testApp(), "S");
    const auth = new Auth(stack, "Auth", {
      isProd: false,
      brand: { ...BRAND, name: subject },
    });
    auth.setRelyingParty("d123.cloudfront.net");
    return relyingParty(Template.fromStack(stack))?.Properties.PoolFingerprint;
  };

  expect(fingerprint("Lake Archive")).toBe(fingerprint("Lake Archive"));
  expect(fingerprint("Lake Archive")).not.toBe(fingerprint("River Archive"));
});

test("the invitation email speaks in the archive's name", () => {
  const template = authWithClients();

  const [pool] = Object.values(template.findResources("AWS::Cognito::UserPool"));
  const invite = pool?.Properties.AdminCreateUserConfig.InviteMessageTemplate;
  expect(invite.EmailSubject).toBe("Your Lake Archive account");
  expect(invite.EmailMessage).toContain("Lake Archive");
  expect(invite.EmailMessage).toContain("{username}");
  expect(invite.EmailMessage).toContain("{####}");
});

test("the sign-up code email speaks in the archive's name, escaped in its HTML body", () => {
  const stack = new Stack(testApp(), "S");
  new Auth(stack, "Auth", {
    isProd: false,
    brand: { ...BRAND, name: "Lake & <Archive>" },
  });
  const [pool] = Object.values(Template.fromStack(stack).findResources("AWS::Cognito::UserPool"));

  const verification = pool?.Properties.VerificationMessageTemplate;
  expect(verification.EmailSubject).toBe("Your Lake & <Archive> code");
  expect(verification.EmailMessage).toContain("Lake &amp; &lt;Archive&gt;");
  expect(verification.EmailMessage).toContain("{####}");
  expect(pool?.Properties.EmailVerificationSubject).toBe(verification.EmailSubject);
});

test("a non-prod stage has the e2e client, with admin password sign-in and no secret, and its outputs", () => {
  const template = archive("dev");

  template.resourceCountIs("AWS::Cognito::UserPoolClient", 2);
  template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
    ClientName: "e2e",
    ExplicitAuthFlows: ["ALLOW_ADMIN_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
    GenerateSecret: false,
    AllowedOAuthFlowsUserPoolClient: false,
  });
  const outputs = Object.keys(template.findOutputs("*"));
  expect(outputs).toEqual(expect.arrayContaining(["E2eClientId", "UserPoolId", "SiteDomain"]));
});

test("a prod stage has no e2e client, no admin password sign-in on any client, and no e2e outputs", () => {
  const template = archive("prod");

  const clients = Object.values(template.findResources("AWS::Cognito::UserPoolClient"));
  expect(clients).toHaveLength(1);
  for (const client of clients) {
    expect(client.Properties.ClientName).not.toBe("e2e");
    expect(JSON.stringify(client.Properties.ExplicitAuthFlows ?? [])).not.toContain(
      "ADMIN_USER_PASSWORD_AUTH",
    );
  }
  const outputs = Object.keys(template.findOutputs("*"));
  expect(outputs).not.toContain("E2eClientId");
  expect(outputs).not.toContain("UserPoolId");
});

test("the ingest-test config makes only the ingest-test stack, with the e2e client", () => {
  const config = fileURLToPath(
    new URL("../../../examples/ingest-test-stage/archive.yaml", import.meta.url),
  );
  const app = createApp(config);

  const stacks = app.node.children.filter((child): child is Stack => child instanceof Stack);
  expect(stacks.map((stack) => stack.stackName)).toEqual(["ResearchArchive-ingest-test"]);
  const [stack] = stacks;
  Template.fromStack(stack as Stack).hasResourceProperties("AWS::Cognito::UserPoolClient", {
    ClientName: "e2e",
  });
});

test("the e2e client refuses a prod pool", () => {
  const auth = new Auth(new Stack(testApp(), "S"), "Auth", {
    isProd: true,
    brand: BRAND,
  });

  expect(() => auth.addTestClient()).toThrow(/prod/);
});

test("the prod user pool is retained with deletion protection; a dev stage's is not", () => {
  const [prod] = Object.values(archive("prod").findResources("AWS::Cognito::UserPool"));
  const [dev] = Object.values(archive("dev").findResources("AWS::Cognito::UserPool"));

  expect(prod?.DeletionPolicy).toBe("Retain");
  expect(prod?.Properties.DeletionProtection).toBe("ACTIVE");
  expect(dev?.DeletionPolicy).toBe("Delete");
  expect(dev?.Properties.DeletionProtection).not.toBe("ACTIVE");
});

test("the app's archive.yaml synthesizes no user pool domain and no managed login branding", () => {
  const committed = fileURLToPath(new URL("../../../archive.yaml", import.meta.url));
  const app = createApp(committed);

  for (const stack of app.node.children.filter((child): child is Stack => child instanceof Stack)) {
    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::Cognito::UserPoolDomain", 0);
    template.resourceCountIs("AWS::Cognito::ManagedLoginBranding", 0);
  }
});

function inviteBody(siteAddress?: string, name = "Lake Archive"): string {
  const stack = new Stack(testApp(), "S");
  new Auth(stack, "Auth", { isProd: false, brand: { ...BRAND, name }, siteAddress });
  const [pool] = Object.values(Template.fromStack(stack).findResources("AWS::Cognito::UserPool"));
  return pool?.Properties.AdminCreateUserConfig.InviteMessageTemplate.EmailMessage as string;
}

test("with no site address the invitation body is exactly today's", () => {
  expect(inviteBody()).toBe(
    "You've been invited to Lake Archive.<br><br>Sign in with your email address, {username}, " +
      "and this temporary password: {####}<br><br>You'll choose your own password when you " +
      "first sign in, and can add a passkey after.",
  );
});

test("with the stage's domain the invitation says where to sign in", () => {
  expect(inviteBody("data.example.org")).toBe(
    "You've been invited to Lake Archive.<br><br>Sign in with your email address, {username}, " +
      "and this temporary password: {####}<br><br>Sign in at " +
      '<a href="https://data.example.org">https://data.example.org</a>.<br><br>' +
      "You'll choose your own password when you first sign in, and can add a passkey after.",
  );
});

test("with a domain the archive's invitation names it, and the passkey relying party is the domain", () => {
  const { template } = domainArchive();
  const [pool] = Object.values(template.findResources("AWS::Cognito::UserPool"));

  expect(pool?.Properties.AdminCreateUserConfig.InviteMessageTemplate.EmailMessage).toContain(
    '<a href="https://data.example.org">https://data.example.org</a>',
  );
  for (const event of ["Create", "Update"]) {
    expect(JSON.stringify(relyingParty(template)?.Properties[event])).toContain(
      '\\"RelyingPartyId\\":\\"data.example.org\\"',
    );
  }
});

test("with email: ses the pool sends from no-reply@<domain> in the brand's name, after SES verifies it", () => {
  const { template } = domainArchive("prod", { email: "ses" });
  const waiter = Object.keys(template.findResources("Custom::SesIdentityVerified"));
  expect(waiter).toHaveLength(1);

  const pools = Object.values(template.findResources("AWS::Cognito::UserPool"));
  expect(pools).toHaveLength(1);
  expect(pools[0]?.Properties.EmailConfiguration).toEqual({
    EmailSendingAccount: "DEVELOPER",
    From: "P <no-reply@data.example.org>",
    SourceArn: {
      "Fn::Join": [
        "",
        [
          "arn:",
          { Ref: "AWS::Partition" },
          ":ses:us-east-1:",
          { Ref: "AWS::AccountId" },
          ":identity/data.example.org",
        ],
      ],
    },
  });
  expect(pools[0]?.DependsOn).toEqual(expect.arrayContaining(waiter));
});

test("the brand's name on the From line is the one the emails speak in", () => {
  const stack = new Stack(testApp(), "S", { env: { region: "us-east-1" } });
  const ready = new Construct(stack, "Ready");
  new Auth(stack, "Auth", {
    isProd: false,
    brand: BRAND,
    email: { domain: "data.example.org", ready },
  });

  Template.fromStack(stack).hasResourceProperties("AWS::Cognito::UserPool", {
    EmailConfiguration: { From: "Lake Archive <no-reply@data.example.org>" },
  });
});

test("without email the pool keeps Cognito's own email and waits on nothing for it", () => {
  for (const template of [archive(), domainArchive().template]) {
    const pools = Object.values(template.findResources("AWS::Cognito::UserPool"));
    expect(pools).toHaveLength(1);
    expect(pools[0]?.Properties.EmailConfiguration).toBeUndefined();
    expect(pools[0]?.DependsOn).toBeUndefined();
    template.resourceCountIs("AWS::SES::EmailIdentity", 0);
  }
});
