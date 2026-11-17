import { afterEach, beforeEach, expect, test, vi, type Mock } from "vitest";

const ENDPOINT = "https://cognito-idp.us-east-1.amazonaws.com/";
const CONFIG = {
  region: "us-east-1",
  webClientId: "web-client-id",
};
const ACCESS_TOKEN = "eyJhbGciOiJSUzI1NiJ9.access-token-body.signature";
const REFRESH_TOKEN = "refresh-token-value";
const SESSION_KEY = "archive-sign-in";

function jwt(claims: object): string {
  const part = (value: object) =>
    btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${part({ alg: "RS256" })}.${part(claims)}.signature`;
}
const now = Math.floor(Date.now() / 1000);
const ID_TOKEN = jwt({
  sub: "reader-1",
  aud: "web-client-id",
  iat: now,
  exp: now + 3600,
  email: "reader@example.org",
  "cognito:groups": ["contributor", "curator"],
});
const RENEWED_ID_TOKEN = jwt({ sub: "reader-1", email: "reader@example.org", renewed: true });

/** What each Cognito action answers next: a body, or an error `__type` with a message. */
type Answer = { body: object } | { error: string; message?: string };
let answers: Record<string, Answer>;
let calls: { action: string; body: Record<string, unknown> }[];
let fetchMock: Mock;

const TOKENS = {
  AuthenticationResult: {
    AccessToken: ACCESS_TOKEN,
    IdToken: ID_TOKEN,
    RefreshToken: REFRESH_TOKEN,
    ExpiresIn: 3600,
    TokenType: "Bearer",
  },
};

beforeEach(() => {
  vi.resetModules();
  sessionStorage.clear();
  localStorage.clear();
  calls = [];
  answers = {
    InitiateAuth: { body: TOKENS },
    RevokeToken: { body: {} },
  };
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/auth-config.json") return Response.json(CONFIG);
    if (url === ENDPOINT) {
      const headers = new Headers(init?.headers);
      expect(headers.get("Content-Type")).toBe("application/x-amz-json-1.1");
      const action = (headers.get("X-Amz-Target") ?? "").replace(
        "AWSCognitoIdentityProviderService.",
        "",
      );
      calls.push({ action, body: JSON.parse(String(init?.body)) });
      const answer = answers[action];
      if (!answer) return Response.json({}, { status: 500 });
      if ("error" in answer) {
        return Response.json(
          { __type: answer.error, message: answer.message ?? "" },
          { status: 400 },
        );
      }
      return Response.json(answer.body);
    }
    if (url.startsWith("/api/datasets/ds-1/versions/2/download")) {
      return Response.json({ url: "https://bucket.example/restricted/ds-1/2/a.csv?sig" });
    }
    return Response.json({}, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function signedIn() {
  const auth = await import("./auth");
  await auth.signInWithPassword("reader@example.org", "correct horse");
  return auth;
}

test("a password sign-in asks Cognito's choice-based sign-in for the password challenge", async () => {
  await signedIn();

  expect(calls[0]).toEqual({
    action: "InitiateAuth",
    body: {
      AuthFlow: "USER_AUTH",
      ClientId: "web-client-id",
      AuthParameters: {
        USERNAME: "reader@example.org",
        PREFERRED_CHALLENGE: "PASSWORD",
        PASSWORD: "correct horse",
      },
    },
  });
});

test("a password sign-in keeps the tokens in sessionStorage and nothing in localStorage", async () => {
  const auth = await signedIn();

  expect(auth.apiToken()).toBe(ID_TOKEN);
  expect(auth.accessToken()).toBe(ACCESS_TOKEN);
  expect(sessionStorage.getItem(SESSION_KEY)).toContain(REFRESH_TOKEN);
  expect(localStorage.length).toBe(0);
});

test("the download request carries the ID token, which the API's Cognito authorizer checks", async () => {
  const auth = await signedIn();
  const { downloadLink } = await import("./api");

  await downloadLink("ds-1", 2, "data/a.csv", auth.apiToken() ?? "");

  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  expect(url).toBe("/api/datasets/ds-1/versions/2/download?path=data%2Fa.csv");
  expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${ID_TOKEN}`);
});

test("a reload (a fresh module) is still signed in, from the tab's session storage", async () => {
  await signedIn();
  vi.resetModules();

  const auth = await import("./auth");

  expect(auth.apiToken()).toBe(ID_TOKEN);
  expect(auth.signedInEmail()).toBe("reader@example.org");
});

test("signed in, the reader's email, groups and id come from the ID token and listeners hear", async () => {
  const auth = await import("./auth");
  const heard = vi.fn();
  auth.subscribe(heard);
  expect(auth.signedInEmail()).toBeNull();
  expect(auth.groups()).toEqual([]);

  await auth.signInWithPassword("reader@example.org", "correct horse");

  expect(heard).toHaveBeenCalled();
  expect(auth.signedInEmail()).toBe("reader@example.org");
  expect(auth.groups()).toEqual(["contributor", "curator"]);
  // The same array each time, so React's external store sees no change.
  expect(auth.groups()).toBe(auth.groups());
  expect(auth.signedInSub()).toBe("reader-1");
});

function storeSession(expiresInMs: number) {
  sessionStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      idToken: ID_TOKEN,
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      expiresAt: Date.now() + expiresInMs,
    }),
  );
}

test("a token within a minute of expiry is renewed with the refresh token", async () => {
  storeSession(30_000);
  answers.InitiateAuth = {
    body: {
      AuthenticationResult: {
        AccessToken: "renewed-access",
        IdToken: RENEWED_ID_TOKEN,
        ExpiresIn: 3600,
      },
    },
  };

  const auth = await import("./auth");

  await vi.waitFor(() => expect(auth.apiToken()).toBe(RENEWED_ID_TOKEN));
  expect(calls[0]).toEqual({
    action: "InitiateAuth",
    body: {
      AuthFlow: "REFRESH_TOKEN_AUTH",
      ClientId: "web-client-id",
      AuthParameters: { REFRESH_TOKEN },
    },
  });
  // Cognito sends no new refresh token; the one the tab has is kept.
  expect(sessionStorage.getItem(SESSION_KEY)).toContain(REFRESH_TOKEN);
});

test("a token with time left is renewed a minute before it runs out", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  storeSession(10 * 60_000);
  const auth = await import("./auth");
  await vi.advanceTimersByTimeAsync(8 * 60_000);
  expect(calls).toEqual([]);

  await vi.advanceTimersByTimeAsync(60_000 + 1);

  await vi.waitFor(() => expect(calls.map((call) => call.action)).toEqual(["InitiateAuth"]));
  expect(calls[0]?.body.AuthFlow).toBe("REFRESH_TOKEN_AUTH");
  expect(auth.apiToken()).toBe(ID_TOKEN);
});

test("handing a sign-in to the command line renews tokens with under 50 minutes left first", async () => {
  storeSession(5 * 60_000);
  answers.InitiateAuth = {
    body: {
      AuthenticationResult: {
        AccessToken: "renewed-access",
        IdToken: RENEWED_ID_TOKEN,
        ExpiresIn: 3600,
      },
    },
  };
  const auth = await import("./auth");

  const tokens = await auth.commandLineTokens();

  expect(calls.map((call) => call.action)).toEqual(["InitiateAuth"]);
  expect(tokens?.idToken).toBe(RENEWED_ID_TOKEN);
  expect(tokens?.expiresIn).toBeGreaterThan(3500);
});

test("handing a sign-in to the command line keeps tokens with most of their hour left", async () => {
  storeSession(55 * 60_000);
  const auth = await import("./auth");

  const tokens = await auth.commandLineTokens();

  expect(calls).toEqual([]);
  expect(tokens?.expiresIn).toBeGreaterThan(50 * 60);
});

test("a failed renewal signs out", async () => {
  storeSession(30_000);
  answers.InitiateAuth = { error: "NotAuthorizedException", message: "Refresh Token has expired" };

  const auth = await import("./auth");

  await vi.waitFor(() => expect(auth.apiToken()).toBeNull());
  expect(auth.signedInEmail()).toBeNull();
  expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
});

test("sign-out revokes the refresh token and clears the tab", async () => {
  const auth = await signedIn();
  const heard = vi.fn();
  auth.subscribe(heard);

  await auth.signOut();

  expect(calls.at(-1)).toEqual({
    action: "RevokeToken",
    body: { Token: REFRESH_TOKEN, ClientId: "web-client-id" },
  });
  expect(auth.apiToken()).toBeNull();
  expect(auth.accessToken()).toBeNull();
  expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
  expect(heard).toHaveBeenCalled();
});

test("sign-out clears the tab even when the revocation fails", async () => {
  const auth = await signedIn();
  answers.RevokeToken = { error: "InternalErrorException" };

  await auth.signOut();

  expect(auth.apiToken()).toBeNull();
  expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
});

test("a first sign-in surfaces the new-password step, which choosing a password finishes", async () => {
  answers.InitiateAuth = {
    body: { ChallengeName: "NEW_PASSWORD_REQUIRED", Session: "session-1", ChallengeParameters: {} },
  };
  answers.RespondToAuthChallenge = { body: TOKENS };
  const auth = await import("./auth");

  const step = await auth.signInWithPassword("new@example.org", "Temp-1234");

  expect(step).toEqual({ next: "new-password", email: "new@example.org", session: "session-1" });
  expect(auth.apiToken()).toBeNull();

  await auth.setFirstPassword(step.next === "new-password" ? step : never(), "Mine-5678!");

  expect(calls.at(-1)).toEqual({
    action: "RespondToAuthChallenge",
    body: {
      ChallengeName: "NEW_PASSWORD_REQUIRED",
      ClientId: "web-client-id",
      Session: "session-1",
      ChallengeResponses: { USERNAME: "new@example.org", NEW_PASSWORD: "Mine-5678!" },
    },
  });
  expect(auth.apiToken()).toBe(ID_TOKEN);
});

function never(): never {
  throw new Error("unexpected step");
}

test("Forgot your password sends a code, and the code with a new password sets it", async () => {
  answers.ForgotPassword = {
    body: { CodeDeliveryDetails: { DeliveryMedium: "EMAIL", Destination: "r***@e***" } },
  };
  answers.ConfirmForgotPassword = { body: {} };
  const auth = await import("./auth");

  await auth.forgotPassword("reader@example.org");
  await auth.confirmForgotPassword("reader@example.org", "123456", "Mine-5678!");

  expect(calls).toEqual([
    {
      action: "ForgotPassword",
      body: { ClientId: "web-client-id", Username: "reader@example.org" },
    },
    {
      action: "ConfirmForgotPassword",
      body: {
        ClientId: "web-client-id",
        Username: "reader@example.org",
        ConfirmationCode: "123456",
        Password: "Mine-5678!",
      },
    },
  ]);
});

test("sign-up sends the email as the username with the password, and no user attributes", async () => {
  answers.SignUp = { body: { UserConfirmed: false, UserSub: "new-sub" } };
  answers.ConfirmSignUp = { body: {} };
  answers.ResendConfirmationCode = { body: {} };
  const auth = await import("./auth");

  await auth.signUp("lee@example.org", "Mine-5678!");
  await auth.resendCode("lee@example.org");
  await auth.confirmSignUp("lee@example.org", "482913");

  // The web client may not write the email attribute; Cognito takes it from the username.
  expect(calls).toEqual([
    {
      action: "SignUp",
      body: { ClientId: "web-client-id", Username: "lee@example.org", Password: "Mine-5678!" },
    },
    {
      action: "ResendConfirmationCode",
      body: { ClientId: "web-client-id", Username: "lee@example.org" },
    },
    {
      action: "ConfirmSignUp",
      body: { ClientId: "web-client-id", Username: "lee@example.org", ConfirmationCode: "482913" },
    },
  ]);
  expect(calls[0]?.body).not.toHaveProperty("UserAttributes");
});

test("sign-up for an email that already has an account answers as a new one does", async () => {
  answers.SignUp = { error: "UsernameExistsException", message: "User already exists" };
  answers.ResendConfirmationCode = {
    error: "InvalidParameterException",
    message: "User is already confirmed.",
  };
  const auth = await import("./auth");

  await expect(auth.signUp("ana@example.org", "Mine-5678!")).resolves.toBeUndefined();
  await expect(auth.resendCode("ana@example.org")).resolves.toBeUndefined();
});

test("sign-up still reports a refused password and too many tries", async () => {
  const auth = await import("./auth");

  answers.SignUp = { error: "InvalidPasswordException" };
  const weak = await auth.signUp("lee@example.org", "short").catch((e: unknown) => e);
  answers.ResendConfirmationCode = { error: "LimitExceededException" };
  const resend = await auth.resendCode("lee@example.org").catch((e: unknown) => e);

  expect(auth.signInProblem(weak)).toContain("doesn't meet the rules");
  expect(auth.signInProblem(resend)).toContain("Too many tries");
});

test.each([
  [
    "NotAuthorizedException",
    "Incorrect username or password.",
    "That email and password don't match",
  ],
  ["UserNotFoundException", "User does not exist.", "That email and password don't match"],
  ["NotAuthorizedException", "Password attempts exceeded", "Too many tries"],
  ["LimitExceededException", "", "Too many tries"],
  ["TooManyRequestsException", "", "Too many tries"],
  ["TooManyFailedAttemptsException", "", "Too many tries"],
  ["NotAuthorizedException", "Invalid session for the user, session is expired.", "took too long"],
  ["InvalidPasswordException", "", "doesn't meet the rules"],
  ["CodeMismatchException", "", "That code isn't right"],
  ["ExpiredCodeException", "", "That code has expired"],
  ["PasswordResetRequiredException", "", "Use Forgot your password?"],
  ["InternalErrorException", "", "isn't working right now"],
])("Cognito's %s (%s) becomes a plain sentence", async (type, message, sentence) => {
  answers.InitiateAuth = { error: type, message };
  const auth = await import("./auth");

  const error = await auth.signInWithPassword("reader@example.org", "x").catch((e: unknown) => e);

  expect(auth.signInProblem(error)).toContain(sentence);
});

test("a network failure becomes a plain sentence too", async () => {
  fetchMock.mockImplementation(async (url: string) =>
    url === "/auth-config.json" ? Response.json(CONFIG) : Promise.reject(new TypeError("offline")),
  );
  const auth = await import("./auth");

  const error = await auth.signInWithPassword("reader@example.org", "x").catch((e: unknown) => e);

  expect(auth.signInProblem(error)).toContain("isn't working right now");
});

test("Sign in opens the archive's own sign-in page, returning to where the reader was", async () => {
  const assign = vi.fn();
  vi.spyOn(window, "self", "get").mockReturnValue({
    location: { assign },
  } as unknown as Window & typeof globalThis);
  const auth = await import("./auth");

  await auth.signIn("/datasets/ds-1?tab=files");

  expect(assign).toHaveBeenCalledWith("/sign-in?next=%2Fdatasets%2Fds-1%3Ftab%3Dfiles");
});

test("forgot password for an invited person who hasn't signed in yet points to the invitation", async () => {
  const { CognitoRefused, signInProblem } = await import("./auth");
  const refused = new CognitoRefused(
    "ForgotPassword",
    "NotAuthorizedException",
    "User password cannot be reset in the current state.",
  );
  expect(signInProblem(refused)).toBe(
    "This account hasn't been used yet: sign in with the temporary password from your invitation email.",
  );
});
