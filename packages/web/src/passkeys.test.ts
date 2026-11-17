import { afterEach, beforeEach, expect, test, vi, type Mock } from "vitest";

const ENDPOINT = "https://cognito-idp.eu-west-2.amazonaws.com/";
const bytes = (...values: number[]) => new Uint8Array(values).buffer;
const now = Math.floor(Date.now() / 1000);
const part = (value: object) => btoa(JSON.stringify(value)).replace(/=+$/, "");
const ID_TOKEN = `${part({ alg: "RS256" })}.${part({ sub: "r-1", email: "reader@example.org", exp: now + 3600 })}.sig`;
const TOKENS = {
  AuthenticationResult: {
    IdToken: ID_TOKEN,
    AccessToken: "access",
    RefreshToken: "refresh",
    ExpiresIn: 3600,
  },
};

// What Cognito's WEB_AUTHN challenge carries: the request options as a JSON string, base64url.
const REQUEST_OPTIONS = {
  challenge: "AQID-_8",
  rpId: "d123.cloudfront.net",
  timeout: 180000,
  userVerification: "preferred",
  allowCredentials: [{ id: "BAU", type: "public-key", transports: ["internal"] }],
};
// What StartWebAuthnRegistration answers: a JSON value, base64url.
const CREATION_OPTIONS = {
  rp: { id: "d123.cloudfront.net", name: "d123.cloudfront.net" },
  user: { id: "dXNlcg", name: "reader@example.org", displayName: "reader@example.org" },
  challenge: "CQgH",
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
  timeout: 180000,
  excludeCredentials: [{ id: "BAU", type: "public-key" }],
  authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
};

type Answer = { body: object } | { error: string; message?: string };
let answers: Record<string, Answer>;
let calls: { action: string; body: Record<string, unknown> }[];
let get: Mock;
let create: Mock;

beforeEach(() => {
  vi.resetModules();
  sessionStorage.clear();
  calls = [];
  answers = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/auth-config.json") {
        return Response.json({ region: "eu-west-2", webClientId: "web" });
      }
      if (url === ENDPOINT) {
        const action = (new Headers(init?.headers).get("X-Amz-Target") ?? "").split(".")[1] ?? "";
        calls.push({ action, body: JSON.parse(String(init?.body)) });
        const answer = answers[action];
        if (!answer) return Response.json({}, { status: 500 });
        if ("error" in answer) {
          return Response.json({ __type: answer.error, message: answer.message }, { status: 400 });
        }
        return Response.json(answer.body);
      }
      return Response.json({}, { status: 404 });
    }),
  );
  get = vi.fn(async () => ({
    id: "BAU",
    rawId: bytes(4, 5),
    type: "public-key",
    authenticatorAttachment: "platform",
    response: {
      clientDataJSON: bytes(1),
      authenticatorData: bytes(2),
      signature: bytes(3),
      userHandle: bytes(0xfb, 0xff),
    },
    getClientExtensionResults: () => ({}),
  }));
  create = vi.fn(async () => ({
    id: "BgcI",
    rawId: bytes(6, 7, 8),
    type: "public-key",
    authenticatorAttachment: "platform",
    response: {
      clientDataJSON: bytes(1),
      attestationObject: bytes(0xfe),
      getTransports: () => ["internal", "hybrid"],
    },
    getClientExtensionResults: () => ({ credProps: { rk: true } }),
  }));
  vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
  Object.defineProperty(navigator, "credentials", {
    configurable: true,
    value: { get, create },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "credentials");
});

test("base64url round-trips bytes Cognito sends, with no padding", async () => {
  const { fromBase64url, toBase64url } = await import("./passkeys");

  expect([...new Uint8Array(fromBase64url("AQID-_8"))]).toEqual([1, 2, 3, 251, 255]);
  expect(toBase64url(bytes(1, 2, 3, 251, 255))).toBe("AQID-_8");
});

test("Use a passkey asks for the WEB_AUTHN challenge, decodes its options and answers as Cognito expects", async () => {
  answers.InitiateAuth = {
    body: {
      ChallengeName: "WEB_AUTHN",
      Session: "session-1",
      ChallengeParameters: { CREDENTIAL_REQUEST_OPTIONS: JSON.stringify(REQUEST_OPTIONS) },
    },
  };
  answers.RespondToAuthChallenge = { body: TOKENS };
  const { signInWithPasskey } = await import("./passkeys");
  const auth = await import("./auth");

  await signInWithPasskey("reader@example.org");

  expect(calls[0]?.body).toEqual({
    AuthFlow: "USER_AUTH",
    ClientId: "web",
    AuthParameters: { USERNAME: "reader@example.org", PREFERRED_CHALLENGE: "WEB_AUTHN" },
  });
  const { publicKey } = get.mock.calls[0]?.[0] as { publicKey: PublicKeyCredentialRequestOptions };
  expect([...new Uint8Array(publicKey.challenge as ArrayBuffer)]).toEqual([1, 2, 3, 251, 255]);
  expect(publicKey.rpId).toBe("d123.cloudfront.net");
  expect(publicKey.userVerification).toBe("preferred");
  const allowed = publicKey.allowCredentials?.[0];
  expect([...new Uint8Array(allowed?.id as ArrayBuffer)]).toEqual([4, 5]);
  expect(allowed?.transports).toEqual(["internal"]);

  const answer = calls[1];
  expect(answer?.action).toBe("RespondToAuthChallenge");
  expect(answer?.body).toMatchObject({
    ChallengeName: "WEB_AUTHN",
    ClientId: "web",
    Session: "session-1",
    ChallengeResponses: { USERNAME: "reader@example.org" },
  });
  const credential = JSON.parse(
    (answer?.body.ChallengeResponses as Record<string, string>).CREDENTIAL ?? "",
  );
  expect(credential).toEqual({
    id: "BAU",
    rawId: "BAU",
    type: "public-key",
    authenticatorAttachment: "platform",
    response: { clientDataJSON: "AQ", authenticatorData: "Ag", signature: "Aw", userHandle: "-_8" },
    clientExtensionResults: {},
  });
  expect(auth.apiToken()).toBe(ID_TOKEN);
});

test("a cancelled passkey prompt says so and signs nothing in", async () => {
  answers.InitiateAuth = {
    body: {
      ChallengeName: "WEB_AUTHN",
      Session: "session-1",
      ChallengeParameters: { CREDENTIAL_REQUEST_OPTIONS: JSON.stringify(REQUEST_OPTIONS) },
    },
  };
  get.mockRejectedValueOnce(new DOMException("The operation was cancelled.", "NotAllowedError"));
  const { passkeyProblem, signInWithPasskey } = await import("./passkeys");

  const error = await signInWithPasskey("reader@example.org").catch((e: unknown) => e);

  expect(passkeyProblem(error)).toBe(
    "The passkey prompt was closed before it finished. Try again, or use your password.",
  );
  expect(calls.map((call) => call.action)).toEqual(["InitiateAuth"]);
});

test("an account with no passkey here is told to sign in with the password and add one", async () => {
  answers.InitiateAuth = {
    body: { ChallengeName: "SELECT_CHALLENGE", Session: "s", AvailableChallenges: ["PASSWORD"] },
  };
  const { passkeyProblem, signInWithPasskey } = await import("./passkeys");

  const error = await signInWithPasskey("reader@example.org").catch((e: unknown) => e);

  expect(passkeyProblem(error)).toContain("no passkey for this archive");
  expect(get).not.toHaveBeenCalled();
});

test("Add a passkey starts registration, decodes its options and completes with the browser's answer", async () => {
  answers.StartWebAuthnRegistration = { body: { CredentialCreationOptions: CREATION_OPTIONS } };
  answers.CompleteWebAuthnRegistration = { body: {} };
  const { addPasskey } = await import("./passkeys");

  await addPasskey("access-token");

  expect(calls[0]).toEqual({
    action: "StartWebAuthnRegistration",
    body: { AccessToken: "access-token" },
  });
  const { publicKey } = create.mock.calls[0]?.[0] as {
    publicKey: PublicKeyCredentialCreationOptions;
  };
  expect([...new Uint8Array(publicKey.challenge as ArrayBuffer)]).toEqual([9, 8, 7]);
  expect([...new Uint8Array(publicKey.user.id as ArrayBuffer)]).toEqual([
    ...new TextEncoder().encode("user"),
  ]);
  expect(publicKey.user.name).toBe("reader@example.org");
  expect(publicKey.rp.id).toBe("d123.cloudfront.net");
  expect([...new Uint8Array(publicKey.excludeCredentials?.[0]?.id as ArrayBuffer)]).toEqual([4, 5]);
  expect(publicKey.authenticatorSelection?.residentKey).toBe("required");

  expect(calls[1]).toEqual({
    action: "CompleteWebAuthnRegistration",
    body: {
      AccessToken: "access-token",
      Credential: {
        id: "BgcI",
        rawId: "BgcI",
        type: "public-key",
        authenticatorAttachment: "platform",
        response: {
          clientDataJSON: "AQ",
          attestationObject: "_g",
          transports: ["internal", "hybrid"],
        },
        clientExtensionResults: { credProps: { rk: true } },
      },
    },
  });
});

test("a browser without passkeys doesn't offer them", async () => {
  vi.stubGlobal("PublicKeyCredential", undefined);
  const { passkeysSupported } = await import("./passkeys");

  expect(passkeysSupported()).toBe(false);
});
