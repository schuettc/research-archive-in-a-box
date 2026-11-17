import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AppRoutes } from "../App";
import { cliPort, safeNext } from "./SignIn";

const ENDPOINT = "https://cognito-idp.eu-west-2.amazonaws.com/";
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

/** What each Cognito action answers next: a body, or an error `__type` with a message. */
type Answer = { body: object } | { error: string; message?: string };
let answers: Record<string, Answer>;
let calls: { action: string; body: Record<string, unknown> }[];

beforeEach(async () => {
  sessionStorage.clear();
  calls = [];
  answers = { InitiateAuth: { body: TOKENS }, RevokeToken: { body: {} } };
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
      return new Promise(() => {});
    }),
  );
  // Each test starts signed out.
  await (await import("../auth")).signOut();
  calls = [];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // A hand-back's form is added to the body, outside what cleanup removes.
  for (const form of document.body.querySelectorAll(":scope > form")) form.remove();
  Reflect.deleteProperty(navigator, "credentials");
});

/** A browser with passkeys whose prompt answers with `get`. */
function withPasskeys(get: () => Promise<unknown>) {
  vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
  Object.defineProperty(navigator, "credentials", {
    configurable: true,
    value: { get: vi.fn(get), create: vi.fn() },
  });
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

const main = () => within(screen.getByRole("main"));

function typeEmail(email = "reader@example.org") {
  fireEvent.change(main().getByLabelText("Email"), { target: { value: email } });
  fireEvent.click(main().getByRole("button", { name: "Continue" }));
}

function typePassword(password = "correct horse") {
  fireEvent.change(main().getByLabelText("Password"), { target: { value: password } });
  fireEvent.click(main().getByRole("button", { name: "Sign in" }));
}

test("the sign-in page has no Sign in button of its own in the header", () => {
  renderAt("/sign-in");

  expect(within(screen.getByRole("banner")).queryByRole("button", { name: "Sign in" })).toBeNull();
});

test("Continue with no email says to enter it, and stays on the email step", () => {
  renderAt("/sign-in");
  fireEvent.click(main().getByRole("button", { name: "Continue" }));

  expect(main().getByRole("alert").textContent).toBe("Enter your email");
  expect(main().getByLabelText("Email").getAttribute("aria-invalid")).toBe("true");
  expect(main().queryByLabelText("Password")).toBeNull();
});

test("email, then password, signs in and returns to the page in next", async () => {
  renderAt("/sign-in?next=%2Fabout");

  typeEmail();
  expect(main().getByText("reader@example.org")).toBeDefined();
  typePassword();

  expect(await screen.findByRole("heading", { level: 1, name: "About the archive" })).toBeDefined();
  expect(calls[0]?.body).toMatchObject({
    AuthFlow: "USER_AUTH",
    AuthParameters: {
      USERNAME: "reader@example.org",
      PREFERRED_CHALLENGE: "PASSWORD",
      PASSWORD: "correct horse",
    },
  });
});

test.each([
  ["https://evil.example/", "/"],
  ["//evil.example/", "/"],
  ["/\\evil.example", "/"],
  ["javascript:alert(1)", "/"],
  ["/sign-in?next=/about", "/"],
  // Browsers drop tabs and newlines in a URL, which turns these into //evil.example.
  ["/\t/evil.example", "/"],
  ["/\n/evil.example", "/"],
  ["/\r/evil.example", "/"],
  [null, "/"],
  ["/datasets/ds-1?tab=files", "/datasets/ds-1?tab=files"],
])("next %s is followed as %s", (next, path) => {
  expect(safeNext(next)).toBe(path);
});

test("an outside URL in next is ignored: signing in lands on search", async () => {
  renderAt("/sign-in?next=https%3A%2F%2Fevil.example%2F");

  typeEmail();
  typePassword();

  expect(
    await screen.findByRole("heading", { level: 1, name: "Search the archive" }),
  ).toBeDefined();
});

test("the email field is the username and the password the current password", () => {
  renderAt("/sign-in");

  expect(main().getByLabelText("Email").getAttribute("autocomplete")).toBe("username");
  typeEmail();
  expect(main().getByLabelText("Password").getAttribute("autocomplete")).toBe("current-password");
  // A password manager still sees the email beside the password.
  const username = screen
    .getByRole("main")
    .querySelector('input[autocomplete="username"]') as HTMLInputElement | null;
  expect(username?.value).toBe("reader@example.org");
});

test("a wrong password says so in a sentence under the field and stays on the step", async () => {
  answers.InitiateAuth = {
    error: "NotAuthorizedException",
    message: "Incorrect username or password.",
  };
  renderAt("/sign-in");

  typeEmail();
  typePassword("wrong");

  expect((await main().findByRole("alert")).textContent).toBe(
    "That email and password don't match. Check them and try again.",
  );
  expect(main().getByLabelText("Password").getAttribute("aria-describedby")).toBe("step-problem");
});

test("too many tries says to wait", async () => {
  answers.InitiateAuth = { error: "NotAuthorizedException", message: "Password attempts exceeded" };
  renderAt("/sign-in");

  typeEmail();
  typePassword("wrong");

  expect((await main().findByRole("alert")).textContent).toContain("Too many tries");
});

test("Use another email goes back to the email step", () => {
  renderAt("/sign-in");
  typeEmail();

  fireEvent.click(main().getByRole("button", { name: "Use another email" }));

  expect(main().getByLabelText("Email")).toBeDefined();
});

test("a first sign-in asks the invited person to choose a password, then signs them in", async () => {
  answers.InitiateAuth = {
    body: {
      ChallengeName: "NEW_PASSWORD_REQUIRED",
      Session: "s".repeat(24),
      ChallengeParameters: {},
    },
  };
  answers.RespondToAuthChallenge = { body: TOKENS };
  renderAt("/sign-in?next=%2Fabout");
  typeEmail("new@example.org");
  typePassword("Temp-1234");

  expect(
    await main().findByRole("heading", { level: 2, name: "Choose your password" }),
  ).toBeDefined();
  expect(main().getByLabelText("New password").getAttribute("autocomplete")).toBe("new-password");
  fireEvent.change(main().getByLabelText("New password"), { target: { value: "Mine-5678!" } });
  fireEvent.change(main().getByLabelText("Confirm new password"), {
    target: { value: "Mine-5678?" },
  });
  fireEvent.click(main().getByRole("button", { name: "Set password and sign in" }));
  expect(main().getByRole("alert").textContent).toBe("The passwords don't match.");

  fireEvent.change(main().getByLabelText("Confirm new password"), {
    target: { value: "Mine-5678!" },
  });
  fireEvent.click(main().getByRole("button", { name: "Set password and sign in" }));

  expect(await screen.findByRole("heading", { level: 1, name: "About the archive" })).toBeDefined();
  expect(calls.at(-1)).toMatchObject({
    action: "RespondToAuthChallenge",
    body: { ChallengeResponses: { USERNAME: "new@example.org", NEW_PASSWORD: "Mine-5678!" } },
  });
});

test("a first password that breaks the rules says which rules", async () => {
  answers.InitiateAuth = {
    body: {
      ChallengeName: "NEW_PASSWORD_REQUIRED",
      Session: "s".repeat(24),
      ChallengeParameters: {},
    },
  };
  answers.RespondToAuthChallenge = { error: "InvalidPasswordException" };
  renderAt("/sign-in");
  typeEmail("new@example.org");
  typePassword("Temp-1234");
  await main().findByRole("heading", { level: 2, name: "Choose your password" });

  fireEvent.change(main().getByLabelText("New password"), { target: { value: "short" } });
  fireEvent.change(main().getByLabelText("Confirm new password"), { target: { value: "short" } });
  fireEvent.click(main().getByRole("button", { name: "Set password and sign in" }));

  expect((await main().findByRole("alert")).textContent).toContain("doesn't meet the rules");
});

async function toReset() {
  answers.ForgotPassword = { body: { CodeDeliveryDetails: { DeliveryMedium: "EMAIL" } } };
  renderAt("/sign-in?next=%2Fabout");
  typeEmail();
  fireEvent.click(main().getByRole("button", { name: "Forgot your password?" }));
  expect(main().getByRole("heading", { level: 2, name: "Reset your password" })).toBeDefined();
  fireEvent.click(main().getByRole("button", { name: "Send the code" }));
  await main().findByLabelText("Code from the email");
}

test("Forgot your password sends a code, then the code and a new password set it", async () => {
  answers.ConfirmForgotPassword = { body: {} };
  await toReset();
  expect(calls.at(-1)).toMatchObject({
    action: "ForgotPassword",
    body: { Username: "reader@example.org" },
  });
  expect(main().getByLabelText("Code from the email").getAttribute("autocomplete")).toBe(
    "one-time-code",
  );

  fireEvent.change(main().getByLabelText("Code from the email"), { target: { value: " 123456 " } });
  fireEvent.change(main().getByLabelText("New password"), { target: { value: "Mine-5678!" } });
  fireEvent.change(main().getByLabelText("Confirm new password"), {
    target: { value: "Mine-5678!" },
  });
  fireEvent.click(main().getByRole("button", { name: "Set new password" }));

  expect(await main().findByText("Your password is changed. Sign in with it.")).toBeDefined();
  expect(calls.at(-1)).toMatchObject({
    action: "ConfirmForgotPassword",
    body: { Username: "reader@example.org", ConfirmationCode: "123456", Password: "Mine-5678!" },
  });
  expect(main().getByLabelText("Password")).toBeDefined();
});

test.each([
  ["CodeMismatchException", "That code isn't right"],
  ["ExpiredCodeException", "That code has expired"],
])("a reset refused with %s says so", async (type, sentence) => {
  answers.ConfirmForgotPassword = { error: type };
  await toReset();

  fireEvent.change(main().getByLabelText("Code from the email"), { target: { value: "1" } });
  fireEvent.change(main().getByLabelText("New password"), { target: { value: "Mine-5678!" } });
  fireEvent.change(main().getByLabelText("Confirm new password"), {
    target: { value: "Mine-5678!" },
  });
  fireEvent.click(main().getByRole("button", { name: "Set new password" }));

  expect((await main().findByRole("alert")).textContent).toContain(sentence);
  expect(main().getByRole("button", { name: "Send a new code" })).toBeDefined();
});

test("too many code requests says to wait", async () => {
  answers.ForgotPassword = { error: "LimitExceededException" };
  renderAt("/sign-in");
  typeEmail();
  fireEvent.click(main().getByRole("button", { name: "Forgot your password?" }));
  fireEvent.click(main().getByRole("button", { name: "Send the code" }));

  expect((await main().findByRole("alert")).textContent).toContain("Too many tries");
});

test("the frame doesn't move between steps: the masthead, the h1 and the form stay (PRIN1)", async () => {
  answers.ForgotPassword = { body: {} };
  renderAt("/sign-in");
  const frame = () => ({
    masthead: screen.getByRole("banner").innerHTML,
    h1: screen.getByRole("heading", { level: 1 }).textContent,
    form: screen.getByRole("main").querySelector(".sign-in-form"),
  });
  const first = frame();

  typeEmail();
  expect(frame()).toEqual(first);
  fireEvent.click(main().getByRole("button", { name: "Forgot your password?" }));
  expect(frame()).toEqual(first);
  fireEvent.click(main().getByRole("button", { name: "Send the code" }));
  await main().findByLabelText("Code from the email");
  expect(frame()).toEqual(first);
  expect(first.h1).toBe("Sign in");
});

test("an axe check of each step finds no violations", async () => {
  answers.InitiateAuth = { error: "NotAuthorizedException", message: "Incorrect" };
  answers.ForgotPassword = { body: {} };
  const { container } = renderAt("/sign-in");
  expect((await axe.run(container)).violations).toEqual([]);

  typeEmail();
  typePassword("wrong");
  await main().findByRole("alert");
  expect((await axe.run(container)).violations).toEqual([]);

  fireEvent.click(main().getByRole("button", { name: "Forgot your password?" }));
  fireEvent.click(main().getByRole("button", { name: "Send the code" }));
  await main().findByLabelText("Code from the email");
  expect((await axe.run(container)).violations).toEqual([]);
});

test("signed in already, the page goes straight on to next", async () => {
  await (await import("../auth")).signInWithPassword("reader@example.org", "x");
  renderAt("/sign-in?next=%2Fabout");

  await waitFor(() =>
    expect(screen.getByRole("heading", { level: 1, name: "About the archive" })).toBeDefined(),
  );
});

const WEB_AUTHN = {
  body: {
    ChallengeName: "WEB_AUTHN",
    Session: "s".repeat(24),
    ChallengeParameters: { CREDENTIAL_REQUEST_OPTIONS: JSON.stringify({ challenge: "AQ" }) },
  },
};

test("Use a passkey signs in with the browser's prompt and returns to next", async () => {
  withPasskeys(async () => ({
    id: "AQ",
    rawId: new Uint8Array([1]).buffer,
    type: "public-key",
    authenticatorAttachment: "platform",
    response: {
      clientDataJSON: new Uint8Array([1]).buffer,
      authenticatorData: new Uint8Array([2]).buffer,
      signature: new Uint8Array([3]).buffer,
      userHandle: null,
    },
    getClientExtensionResults: () => ({}),
  }));
  answers.InitiateAuth = WEB_AUTHN;
  answers.RespondToAuthChallenge = { body: TOKENS };
  renderAt("/sign-in?next=%2Fabout");
  typeEmail();

  fireEvent.click(main().getByRole("button", { name: "Use a passkey" }));

  expect(await screen.findByRole("heading", { level: 1, name: "About the archive" })).toBeDefined();
  expect(calls.map((call) => call.action)).toEqual(["InitiateAuth", "RespondToAuthChallenge"]);
});

test("a cancelled passkey prompt says so and leaves the reader on the password step", async () => {
  withPasskeys(async () => Promise.reject(new DOMException("cancelled", "NotAllowedError")));
  answers.InitiateAuth = WEB_AUTHN;
  renderAt("/sign-in");
  typeEmail();

  fireEvent.click(main().getByRole("button", { name: "Use a passkey" }));

  expect((await main().findByRole("alert")).textContent).toBe(
    "The passkey prompt was closed before it finished. Try again, or use your password.",
  );
  expect(main().getByLabelText("Password")).toBeDefined();
});

test("a browser without passkeys isn't offered Use a passkey", () => {
  vi.stubGlobal("PublicKeyCredential", undefined);
  renderAt("/sign-in");
  typeEmail();

  expect(main().queryByRole("button", { name: "Use a passkey" })).toBeNull();
});

/** A browser with passkeys whose prompt makes one with `create`. */
function makingPasskeys(create: () => Promise<unknown>) {
  vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
  Object.defineProperty(navigator, "credentials", {
    configurable: true,
    value: { get: vi.fn(), create: vi.fn(create) },
  });
}

/** Fill Create an account and press Create account. */
function createAccount(email = "lee@example.org", password = "Mine-5678!") {
  fireEvent.change(main().getByLabelText("Email"), { target: { value: email } });
  fireEvent.change(main().getByLabelText("Password"), { target: { value: password } });
  fireEvent.click(main().getByRole("button", { name: "Create account" }));
}

function signUpAnswers() {
  answers.SignUp = { body: { UserConfirmed: false, UserSub: "new-sub" } };
  answers.ConfirmSignUp = { body: {} };
  answers.ResendConfirmationCode = { body: {} };
}

async function toCode(path = "/sign-in?view=create&next=%2Fabout") {
  signUpAnswers();
  renderAt(path);
  createAccount();
  await main().findByLabelText("Code");
}

async function confirmCode() {
  fireEvent.change(main().getByLabelText("Code"), { target: { value: " 482913 " } });
  fireEvent.click(main().getByRole("button", { name: "Confirm" }));
  await main().findByRole("heading", { level: 2, name: "You're in" });
}

test("New here? Create an account opens the form, with the password rules and I have an account", () => {
  renderAt("/sign-in");

  fireEvent.click(main().getByRole("button", { name: "Create an account" }));

  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Create an account");
  expect(main().getByLabelText("Password").getAttribute("autocomplete")).toBe("new-password");
  expect(main().getByText(/At least 8 characters, with a lowercase letter/)).toBeDefined();
  fireEvent.click(main().getByRole("button", { name: "I have an account" }));
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Sign in");
  expect(main().queryByLabelText("Password")).toBeNull();
});

test("Create an account links to the privacy page under its button; Sign in doesn't", () => {
  renderAt("/sign-in?view=create");

  const line = main().getByText(/By creating an account you agree to how the archive handles/);
  expect(within(line).getByRole("link", { name: "Privacy" }).getAttribute("href")).toBe("/privacy");
  fireEvent.click(main().getByRole("button", { name: "I have an account" }));
  expect(main().queryByRole("link", { name: "Privacy" })).toBeNull();
});

test("view=create opens Create an account, and the sign-up request carries no user attributes", async () => {
  await toCode();

  expect(calls).toEqual([
    {
      action: "SignUp",
      body: { ClientId: "web", Username: "lee@example.org", Password: "Mine-5678!" },
    },
  ]);
  expect(main().getByText("lee@example.org")).toBeDefined();
});

test("an email that already has an account moves to the code step just as a new one does", async () => {
  answers.SignUp = { error: "UsernameExistsException", message: "User already exists" };
  renderAt("/sign-in?view=create");
  createAccount("ana@example.org");

  expect(await main().findByLabelText("Code")).toBeDefined();
  expect(main().queryByRole("alert")).toBeNull();
  expect(main().getByText("ana@example.org")).toBeDefined();
});

test("Create account with no email says to enter it, and a weak password says which rules", async () => {
  answers.SignUp = { error: "InvalidPasswordException" };
  renderAt("/sign-in?view=create");
  fireEvent.click(main().getByRole("button", { name: "Create account" }));
  expect(main().getByRole("alert").textContent).toBe("Enter your email");
  expect(calls).toEqual([]);
  fireEvent.change(main().getByLabelText("Email"), { target: { value: "lee@example.org" } });
  fireEvent.click(main().getByRole("button", { name: "Create account" }));
  expect(main().getByRole("alert").textContent).toBe("Choose a password");
  expect(calls).toEqual([]);

  createAccount("lee@example.org", "short");

  expect((await main().findByRole("alert")).textContent).toContain("doesn't meet the rules");
  expect(main().getByLabelText("Password")).toBeDefined();
});

test("confirming signs in with the password just given, then offers a passkey", async () => {
  makingPasskeys(async () => null);
  await toCode();
  await confirmCode();

  expect(calls.map((call) => call.action)).toEqual(["SignUp", "ConfirmSignUp", "InitiateAuth"]);
  expect(calls[1]?.body).toMatchObject({ Username: "lee@example.org", ConfirmationCode: "482913" });
  expect(calls[2]?.body).toMatchObject({
    AuthFlow: "USER_AUTH",
    AuthParameters: {
      USERNAME: "lee@example.org",
      PREFERRED_CHALLENGE: "PASSWORD",
      PASSWORD: "Mine-5678!",
    },
  });
  // Signed in, the page stays to offer the passkey rather than going on to next.
  expect(main().getByRole("button", { name: "Add a passkey" })).toBeDefined();
  expect(main().getByRole("button", { name: "Not now" })).toBeDefined();
});

test("Not now goes on to the page in next", async () => {
  makingPasskeys(async () => null);
  await toCode();
  await confirmCode();

  fireEvent.click(main().getByRole("button", { name: "Not now" }));

  expect(await screen.findByRole("heading", { level: 1, name: "About the archive" })).toBeDefined();
});

test("Add a passkey uses the Account page's passkey code, then goes on to next", async () => {
  makingPasskeys(async () => ({
    id: "AQ",
    rawId: new Uint8Array([1]).buffer,
    type: "public-key",
    authenticatorAttachment: "platform",
    response: {
      clientDataJSON: new Uint8Array([1]).buffer,
      attestationObject: new Uint8Array([2]).buffer,
      getTransports: () => ["internal"],
    },
    getClientExtensionResults: () => ({}),
  }));
  answers.StartWebAuthnRegistration = {
    body: {
      CredentialCreationOptions: {
        challenge: "AQ",
        rp: { name: "Archive" },
        user: { id: "AQ", name: "lee@example.org", displayName: "lee@example.org" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      },
    },
  };
  answers.CompleteWebAuthnRegistration = { body: {} };
  await toCode();
  await confirmCode();

  fireEvent.click(main().getByRole("button", { name: "Add a passkey" }));

  expect(await screen.findByRole("heading", { level: 1, name: "About the archive" })).toBeDefined();
  expect(calls.slice(-2).map((call) => call.action)).toEqual([
    "StartWebAuthnRegistration",
    "CompleteWebAuthnRegistration",
  ]);
  expect(calls.at(-1)?.body).toMatchObject({ AccessToken: "access" });
});

test("a closed passkey prompt says no passkey was added and keeps the offer", async () => {
  makingPasskeys(async () => Promise.reject(new DOMException("cancelled", "NotAllowedError")));
  answers.StartWebAuthnRegistration = {
    body: {
      CredentialCreationOptions: {
        challenge: "AQ",
        user: { id: "AQ", name: "lee@example.org", displayName: "lee@example.org" },
      },
    },
  };
  await toCode();
  await confirmCode();

  fireEvent.click(main().getByRole("button", { name: "Add a passkey" }));

  expect((await main().findByRole("alert")).textContent).toContain("no passkey was added");
  expect(main().getByRole("button", { name: "Not now" })).toBeDefined();
});

test.each([
  ["CodeMismatchException", ""],
  // An email whose account is already confirmed: the same sentence, so nothing says it has one.
  ["NotAuthorizedException", "User cannot be confirmed. Current status is CONFIRMED"],
])(
  "a code refused with %s says the code isn't right and stays on the step",
  async (type, message) => {
    await toCode();
    answers.ConfirmSignUp = { error: type, message };

    fireEvent.change(main().getByLabelText("Code"), { target: { value: "1" } });
    fireEvent.click(main().getByRole("button", { name: "Confirm" }));

    expect((await main().findByRole("alert")).textContent).toContain("That code isn't right");
    expect(main().getByLabelText("Code")).toBeDefined();
  },
);

test("Send a new code asks Cognito again and says a new one is on its way", async () => {
  await toCode();

  fireEvent.click(main().getByRole("button", { name: "Send a new code" }));

  expect(await main().findByText(/A new code is on its way/)).toBeDefined();
  expect(calls.at(-1)).toEqual({
    action: "ResendConfirmationCode",
    body: { ClientId: "web", Username: "lee@example.org" },
  });
});

test("no code yet: the help offers Sign in, Reset password and Send a new code", async () => {
  answers.ForgotPassword = { body: {} };
  await toCode();

  fireEvent.click(main().getByRole("button", { name: "Didn't get a code?" }));
  expect(main().getByText(/already has an account, no code is sent/)).toBeDefined();
  expect(main().getByRole("button", { name: "Send a new code" })).toBeDefined();
  expect(main().getByRole("button", { name: "Reset password" })).toBeDefined();

  fireEvent.click(main().getByRole("button", { name: "Sign in" }));
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Sign in");
  expect(main().getByText("lee@example.org")).toBeDefined();
  expect(main().getByLabelText("Password")).toBeDefined();
});

test("after Didn't get a code? and Send a new code, confirming still signs in with the password just given", async () => {
  makingPasskeys(async () => null);
  await toCode();
  fireEvent.click(main().getByRole("button", { name: "Didn't get a code?" }));
  fireEvent.click(main().getByRole("button", { name: "Send a new code" }));
  await main().findByText(/A new code is on its way/);
  await confirmCode();

  expect(calls.at(-1)).toMatchObject({
    action: "InitiateAuth",
    body: { AuthParameters: { PASSWORD: "Mine-5678!" } },
  });
  expect(main().getByRole("button", { name: "Add a passkey" })).toBeDefined();
});

test("Reset password from the no-code help opens Forgot your password for that email", async () => {
  await toCode();

  fireEvent.click(main().getByRole("button", { name: "Didn't get a code?" }));
  fireEvent.click(main().getByRole("button", { name: "Reset password" }));

  expect(main().getByRole("heading", { level: 2, name: "Reset your password" })).toBeDefined();
  expect(main().getByText(/We'll email a code to lee@example.org/)).toBeDefined();
});

test.each([
  ["SignUp", "TooManyRequestsException"],
  ["SignUp", "LimitExceededException"],
  ["ResendConfirmationCode", "LimitExceededException"],
])("%s refused with %s shows the page's rate-limit message", async (action, type) => {
  signUpAnswers();
  answers[action] = { error: type };
  renderAt("/sign-in?view=create");
  createAccount();
  if (action === "ResendConfirmationCode") {
    await main().findByLabelText("Code");
    fireEvent.click(main().getByRole("button", { name: "Send a new code" }));
  }

  expect((await main().findByRole("alert")).textContent).toBe(
    "Too many tries. Wait a few minutes, then try again.",
  );
});

test("an outside next is ignored after creating an account: Not now lands on search", async () => {
  makingPasskeys(async () => null);
  await toCode("/sign-in?view=create&next=https%3A%2F%2Fevil.example%2F");
  await confirmCode();

  fireEvent.click(main().getByRole("button", { name: "Not now" }));

  expect(
    await screen.findByRole("heading", { level: 1, name: "Search the archive" }),
  ).toBeDefined();
});

test("an axe check of each Create an account step finds no violations", async () => {
  makingPasskeys(async () => null);
  signUpAnswers();
  const { container } = renderAt("/sign-in?view=create");
  expect((await axe.run(container)).violations).toEqual([]);

  createAccount();
  await main().findByLabelText("Code");
  expect((await axe.run(container)).violations).toEqual([]);
  fireEvent.click(main().getByRole("button", { name: "Didn't get a code?" }));
  expect((await axe.run(container)).violations).toEqual([]);
  fireEvent.click(main().getByRole("button", { name: "Send a new code" }));
  await main().findByLabelText("Code");
  await confirmCode();
  expect((await axe.run(container)).violations).toEqual([]);
});

/** The forms the page submits to leave the site, each with its address and fields. */
function handBacks() {
  const sent: { method: string; action: string; fields: Record<string, string> }[] = [];
  vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(function (
    this: HTMLFormElement,
  ) {
    sent.push({
      method: this.method,
      action: this.action,
      fields: Object.fromEntries(
        [...new FormData(this).entries()].map(([name, value]) => [name, String(value)]),
      ),
    });
  });
  return sent;
}

test("with cli, signing in asks to sign in the command line as the account, then posts the tokens to localhost", async () => {
  const sent = handBacks();
  renderAt("/sign-in?cli=8765&state=abc123&next=%2Fabout");

  typeEmail();
  typePassword();

  expect(
    await main().findByText("Sign in the command line on this computer as reader@example.org?"),
  ).toBeDefined();
  expect(sent).toEqual([]);
  fireEvent.click(main().getByRole("button", { name: "Sign in the command line" }));

  await vi.waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]?.method).toBe("post");
  expect(sent[0]?.action).toBe("http://localhost:8765/callback");
  expect(sent[0]?.fields).toMatchObject({
    id_token: ID_TOKEN,
    access_token: "access",
    state: "abc123",
  });
  const expiresIn = Number(sent[0]?.fields.expires_in);
  expect(expiresIn).toBeGreaterThan(3500);
  expect(expiresIn).toBeLessThanOrEqual(3600);
  // The refresh token stays in the tab.
  expect(Object.keys(sent[0]?.fields ?? {}).sort()).toEqual([
    "access_token",
    "expires_in",
    "id_token",
    "state",
  ]);
});

test("with cli, signed in already, the page asks straight away", async () => {
  await (await import("../auth")).signInWithPassword("reader@example.org", "x");
  handBacks();
  renderAt("/sign-in?cli=1024&state=s");

  expect(
    await main().findByText("Sign in the command line on this computer as reader@example.org?"),
  ).toBeDefined();
});

test("Cancel posts nothing and goes back to the archive", async () => {
  await (await import("../auth")).signInWithPassword("reader@example.org", "x");
  const sent = handBacks();
  renderAt("/sign-in?cli=8765&state=abc123");

  fireEvent.click(await main().findByRole("button", { name: "Cancel" }));

  expect(
    await screen.findByRole("heading", { level: 1, name: "Search the archive" }),
  ).toBeDefined();
  expect(sent).toEqual([]);
  expect(document.querySelector("form[action*='localhost']")).toBeNull();
});

test.each([
  "8765@evil.example",
  "evil.example",
  "0",
  "1023",
  "70000",
  "65536",
  "-8765",
  "8765.0",
  " 8765",
  "0x2000",
  "",
])("cli %j is ignored: no confirm screen and no form, the page goes on to next", async (cli) => {
  await (await import("../auth")).signInWithPassword("reader@example.org", "x");
  const sent = handBacks();
  renderAt(`/sign-in?${new URLSearchParams({ cli, state: "abc123", next: "/about" })}`);

  expect(await screen.findByRole("heading", { level: 1, name: "About the archive" })).toBeDefined();
  expect(main().queryByRole("button", { name: "Sign in the command line" })).toBeNull();
  expect(sent).toEqual([]);
  expect(document.querySelector("form[action*='localhost']")).toBeNull();
});

test("cli with no state is ignored", async () => {
  await (await import("../auth")).signInWithPassword("reader@example.org", "x");
  const sent = handBacks();
  renderAt("/sign-in?cli=8765&next=%2Fabout");

  expect(await screen.findByRole("heading", { level: 1, name: "About the archive" })).toBeDefined();
  expect(sent).toEqual([]);
});

test.each([
  ["1024", 1024],
  ["8765", 8765],
  ["65535", 65535],
  ["8765@evil.example", null],
  ["0", null],
  ["70000", null],
  ["08765", null],
  [null, null],
])("cliPort(%j) is %j", (cli, port) => {
  expect(cliPort(cli)).toBe(port);
});

test("an axe check of the command-line confirm screen finds no violations", async () => {
  await (await import("../auth")).signInWithPassword("reader@example.org", "x");
  handBacks();
  const { container } = renderAt("/sign-in?cli=8765&state=abc123");
  await main().findByRole("button", { name: "Sign in the command line" });

  expect((await axe.run(container)).violations).toEqual([]);
});

test("cli=done says the command line is signed in, on the archive's own page, and builds no form", async () => {
  await (await import("../auth")).signInWithPassword("reader@example.org", "x");
  const sent = handBacks();
  renderAt("/sign-in?cli=done");

  expect(
    await screen.findByRole("heading", { level: 1, name: "The command line is signed in" }),
  ).toBeDefined();
  expect(main().getByText("You can close this tab and go back to your terminal.")).toBeDefined();
  expect(main().getByRole("link", { name: "Go to the archive" }).getAttribute("href")).toBe("/");
  expect(screen.getByRole("banner")).toBeDefined();
  expect(main().queryByRole("button", { name: "Sign in the command line" })).toBeNull();
  expect(main().queryByRole("textbox")).toBeNull();
  expect(sent).toEqual([]);
  expect(document.querySelector("form")).toBeNull();
});

test("cli=done shows the same message signed out, and asks for nothing", async () => {
  renderAt("/sign-in?cli=done");

  expect(
    await screen.findByRole("heading", { level: 1, name: "The command line is signed in" }),
  ).toBeDefined();
  expect(main().queryByRole("textbox")).toBeNull();
  expect(document.querySelector("form")).toBeNull();
});

test("an axe check of the command line's signed-in page finds no violations", async () => {
  await (await import("../auth")).signInWithPassword("reader@example.org", "x");
  const { container } = renderAt("/sign-in?cli=done");
  await screen.findByRole("heading", { level: 1, name: "The command line is signed in" });

  expect((await axe.run(container)).violations).toEqual([]);
});
