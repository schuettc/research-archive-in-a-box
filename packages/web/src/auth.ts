/** The fields the web app reads from the `/auth-config.json` the stage's deploy writes. */
interface AuthConfig {
  region: string;
  webClientId: string;
  selfSignUp?: boolean;
}

/** The signed-in reader's tokens, kept in the tab's session storage under SESSION_KEY. */
interface Session {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  /** When the ID and access tokens run out, in milliseconds since the epoch. */
  expiresAt: number;
}

/** What Cognito answers a sign-in step: tokens, or the next challenge to answer. */
export interface AuthAnswer {
  AuthenticationResult?: {
    IdToken?: string;
    AccessToken?: string;
    RefreshToken?: string;
    ExpiresIn?: number;
  };
  ChallengeName?: string;
  ChallengeParameters?: Record<string, string>;
  Session?: string;
}

/**
 * Where a password sign-in stands: signed in, an invited person must choose a password, or an
 * account never confirmed has been sent a new code to confirm it with.
 */
export type SignInStep =
  { next: "done" } | { next: "new-password"; email: string; session: string } | { next: "confirm" };

const SESSION_KEY = "archive-sign-in";
// Renew this long before the tokens run out, so a request never carries one that just did.
const RENEW_EARLY_MS = 60_000;

/** Cognito refused a call: `type` is its error's `__type`, such as NotAuthorizedException. */
export class CognitoRefused extends Error {
  constructor(
    action: string,
    readonly type: string,
    readonly detail: string,
  ) {
    super(`${action} answered ${type}`);
  }
}

let configPromise: Promise<AuthConfig> | null = null;

function readConfig(): Promise<AuthConfig> {
  configPromise ??= (async () => {
    const response = await fetch("/auth-config.json");
    if (!response.ok) throw new Error(`/auth-config.json answered ${response.status}`);
    return (await response.json()) as AuthConfig;
  })().catch((error: unknown) => {
    configPromise = null;
    throw error;
  });
  return configPromise;
}

/** The region of the stage's user pool, whose Cognito API answers the reader's own calls. */
export async function cognitoRegion(): Promise<string> {
  return (await readConfig()).region;
}

/** Whether people can create their own account on this stage; a config without the field says yes. */
export async function selfSignUp(): Promise<boolean> {
  try {
    return (await readConfig()).selfSignUp !== false;
  } catch {
    return true;
  }
}

/**
 * Call one of Cognito's user pool APIs from the browser. Sign-in calls name the web client;
 * the reader's own calls carry their access token. Neither is signed, and no Authorization
 * header goes with them.
 */
export async function callCognito(action: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`https://cognito-idp.${await cognitoRegion()}.amazonaws.com/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": `AWSCognitoIdentityProviderService.${action}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as {
      __type?: unknown;
      message?: unknown;
    };
    // The type may come namespaced, as in "com.amazonaws...#NotAuthorizedException".
    const type = typeof error.__type === "string" ? error.__type.replace(/^.*#/, "") : "";
    const detail = typeof error.message === "string" ? error.message : "";
    throw new CognitoRefused(action, type || String(response.status), detail);
  }
  return response.json();
}

/** A Cognito call on the web client's behalf: sign-in, renewal, recovery and revocation. */
export async function asWebClient(action: string, body: Record<string, unknown>): Promise<unknown> {
  return callCognito(action, { ...body, ClientId: (await readConfig()).webClientId });
}

let session: Session | null = readSession();
let renewal: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function readSession(): Session | null {
  try {
    const stored = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "null") as Session | null;
    return stored?.idToken && stored.refreshToken ? stored : null;
  } catch {
    return null;
  }
}

function changed(): void {
  for (const listener of listeners) listener();
}

/** Hear when the reader signs in or out; answers the function that stops listening. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function keep(next: Session | null): void {
  session = next;
  if (renewal) clearTimeout(renewal);
  renewal = null;
  if (next) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
    renewal = setTimeout(
      () => void renew(),
      Math.max(0, next.expiresAt - RENEW_EARLY_MS - Date.now()),
    );
  } else {
    sessionStorage.removeItem(SESSION_KEY);
  }
  changed();
}

/**
 * Take the tokens a sign-in step answered, keeping the refresh token the tab has when Cognito
 * sends none (a renewal), else report the challenge it asks for instead.
 */
export function acceptTokens(answer: AuthAnswer): boolean {
  const result = answer.AuthenticationResult;
  if (!result?.IdToken || !result.AccessToken) return false;
  const refreshToken = result.RefreshToken ?? session?.refreshToken;
  if (!refreshToken) return false;
  keep({
    idToken: result.IdToken,
    accessToken: result.AccessToken,
    refreshToken,
    expiresAt: Date.now() + (result.ExpiresIn ?? 3600) * 1000,
  });
  return true;
}

let renewing: Promise<void> | null = null;

/** Renew the ID and access tokens with the refresh token; a refusal signs the tab out. */
function renew(): Promise<void> {
  const refreshToken = session?.refreshToken;
  if (!refreshToken) return Promise.resolve();
  renewing ??= (async () => {
    try {
      const answer = (await asWebClient("InitiateAuth", {
        AuthFlow: "REFRESH_TOKEN_AUTH",
        AuthParameters: { REFRESH_TOKEN: refreshToken },
      })) as AuthAnswer;
      if (!acceptTokens(answer)) keep(null);
    } catch (error) {
      // Offline or Cognito down: keep the tokens until they run out and try again then.
      if (error instanceof CognitoRefused) keep(null);
    } finally {
      renewing = null;
    }
  })();
  return renewing;
}

function due(): boolean {
  return session !== null && session.expiresAt - RENEW_EARLY_MS <= Date.now();
}

// A reload picks the tab's tokens up; renew now if they are due, else a minute before they run
// out. A hidden tab's timer can fire late, so coming back to it renews too.
if (session) {
  if (due()) void renew();
  else keep(session);
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && due()) void renew();
});

const live = (): Session | null => (session && session.expiresAt > Date.now() ? session : null);

/**
 * Sign in with an email and password through Cognito's choice-based sign-in. An account created
 * but never confirmed is sent a new code, which `confirmSignUp` takes before signing in again.
 */
export async function signInWithPassword(email: string, password: string): Promise<SignInStep> {
  let answer: AuthAnswer;
  try {
    answer = (await asWebClient("InitiateAuth", {
      AuthFlow: "USER_AUTH",
      AuthParameters: { USERNAME: email, PREFERRED_CHALLENGE: "PASSWORD", PASSWORD: password },
    })) as AuthAnswer;
  } catch (error) {
    if (!(error instanceof CognitoRefused && error.type === "UserNotConfirmedException"))
      throw error;
    await resendCode(email);
    return { next: "confirm" };
  }
  return step(email, answer);
}

function step(email: string, answer: AuthAnswer): SignInStep {
  if (acceptTokens(answer)) return { next: "done" };
  if (answer.ChallengeName === "NEW_PASSWORD_REQUIRED" && answer.Session) {
    return { next: "new-password", email, session: answer.Session };
  }
  throw new CognitoRefused("InitiateAuth", `Unexpected${answer.ChallengeName ?? ""}`, "");
}

/** An invited person's first sign-in: answer NEW_PASSWORD_REQUIRED with the password they chose. */
export async function setFirstPassword(
  pending: { email: string; session: string },
  password: string,
): Promise<void> {
  const answer = (await asWebClient("RespondToAuthChallenge", {
    ChallengeName: "NEW_PASSWORD_REQUIRED",
    Session: pending.session,
    ChallengeResponses: { USERNAME: pending.email, NEW_PASSWORD: password },
  })) as AuthAnswer;
  if (step(pending.email, answer).next !== "done") {
    throw new CognitoRefused("RespondToAuthChallenge", "Unexpected", "");
  }
}

/** Send a code by email for choosing a new password. */
export async function forgotPassword(email: string): Promise<void> {
  await asWebClient("ForgotPassword", { Username: email });
}

/** Set a new password with the code `forgotPassword` sent. */
export async function confirmForgotPassword(
  email: string,
  code: string,
  password: string,
): Promise<void> {
  await asWebClient("ConfirmForgotPassword", {
    Username: email,
    ConfirmationCode: code,
    Password: password,
  });
}

/**
 * Create an account: Cognito emails a code that `confirmSignUp` takes. The email is the username,
 * and no attributes go with it: the web client may not write `email`, and Cognito sets it from
 * the username. An email that already has an account answers just as a new one does, so the
 * page never says whether it has one.
 */
export async function signUp(email: string, password: string): Promise<void> {
  try {
    await asWebClient("SignUp", { Username: email, Password: password });
  } catch (error) {
    if (!(error instanceof CognitoRefused && error.type === "UsernameExistsException")) throw error;
  }
}

/** Confirm a new account's email with the code `signUp` sent. */
export async function confirmSignUp(email: string, code: string): Promise<void> {
  await asWebClient("ConfirmSignUp", { Username: email, ConfirmationCode: code });
}

/**
 * Send a new account's code again. An email with a confirmed account, or none, answers as one
 * waiting for its code does.
 */
export async function resendCode(email: string): Promise<void> {
  try {
    await asWebClient("ResendConfirmationCode", { Username: email });
  } catch (error) {
    const quiet = ["InvalidParameterException", "UserNotFoundException"];
    if (!(error instanceof CognitoRefused && quiet.includes(error.type))) throw error;
  }
}

// The user pool's password policy: CDK's defaults, which packages/infra/src/auth.ts leaves as they
// are.
export const PASSWORD_RULES =
  "at least 8 characters, with a lowercase letter, an uppercase letter, a number and a symbol";

/** What the reader is told when a sign-in, recovery or new password is refused. */
export function signInProblem(error: unknown): string {
  const type = error instanceof CognitoRefused ? error.type : "";
  const detail = error instanceof CognitoRefused ? error.detail.toLowerCase() : "";
  const tooMany = "Too many tries. Wait a few minutes, then try again.";
  if (type === "NotAuthorizedException" && detail.includes("attempts exceeded")) return tooMany;
  if (type === "NotAuthorizedException" && detail.includes("cannot be reset")) {
    return "This account hasn't been used yet: sign in with the temporary password from your invitation email.";
  }
  if (type === "NotAuthorizedException" && detail.includes("session")) {
    return "This sign-in took too long. Start again.";
  }
  if (type === "NotAuthorizedException" || type === "UserNotFoundException") {
    return "That email and password don't match. Check them and try again.";
  }
  if (
    type === "LimitExceededException" ||
    type === "TooManyRequestsException" ||
    type === "TooManyFailedAttemptsException"
  ) {
    return tooMany;
  }
  if (type === "InvalidPasswordException") {
    return `That password doesn't meet the rules: ${PASSWORD_RULES}.`;
  }
  if (type === "CodeMismatchException")
    return "That code isn't right. Check the email and try again.";
  if (type === "ExpiredCodeException") return "That code has expired. Send a new one.";
  if (type === "PasswordResetRequiredException") {
    return "Your password needs resetting. Use Forgot your password? to choose a new one.";
  }
  return "Sign-in isn't working right now. Try again in a moment.";
}

// Navigate through window.self, so tests can watch it.
const go = (url: string) => window.self.location.assign(url);

/** Open the archive's sign-in page, coming back to `returnTo` once signed in. */
export async function signIn(returnTo: string): Promise<void> {
  go(`/sign-in?${new URLSearchParams({ next: returnTo })}`);
}

/** Revoke the refresh token and forget the reader in this tab. */
export async function signOut(): Promise<void> {
  const refreshToken = session?.refreshToken;
  keep(null);
  if (!refreshToken) return;
  await asWebClient("RevokeToken", { Token: refreshToken }).catch(() => {});
}

/**
 * The token the API accepts while the reader is signed in, else null: the ID token, since the
 * API's Cognito authorizer has no OAuth scopes and so checks ID tokens, not access tokens.
 */
export function apiToken(): string | null {
  return live()?.idToken ?? null;
}

/**
 * The signed-in reader's access token, or null: Cognito's own user APIs (the reader's passkeys
 * and password) take it, never the archive's API.
 */
export function accessToken(): string | null {
  return live()?.accessToken ?? null;
}

// Tokens handed to the command line with less than this left are renewed first, so a long
// command such as the seed gets most of an hour.
const HAND_BACK_FRESH_MS = 50 * 60_000;

/**
 * The ID and access tokens with the seconds they have left, for handing a sign-in to the command
 * line, or null when signed out. Tokens with under 50 minutes left are renewed first. The refresh
 * token stays in the tab.
 */
export async function commandLineTokens(): Promise<{
  idToken: string;
  accessToken: string;
  expiresIn: number;
} | null> {
  if (session && session.expiresAt - HAND_BACK_FRESH_MS <= Date.now()) await renew();
  const now = live();
  if (!now) return null;
  const expiresIn = Math.floor((now.expiresAt - Date.now()) / 1000);
  return { idToken: now.idToken, accessToken: now.accessToken, expiresIn };
}

let claimsOf: { token: string; claims: Record<string, unknown>; groups: string[] } | null = null;
const NO_GROUPS: string[] = [];

/** The ID token's claims, decoded once per token; nothing here checks its signature. */
function claims(): { claims: Record<string, unknown>; groups: string[] } | null {
  const token = live()?.idToken;
  if (!token) return null;
  if (claimsOf?.token !== token) {
    let decoded: Record<string, unknown>;
    try {
      const part = (token.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/");
      const bytes = Uint8Array.from(atob(part), (char) => char.charCodeAt(0));
      decoded = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    } catch {
      decoded = {};
    }
    const claim = decoded["cognito:groups"];
    const list = Array.isArray(claim)
      ? claim.filter((group): group is string => typeof group === "string")
      : NO_GROUPS;
    claimsOf = { token, claims: decoded, groups: list };
  }
  return claimsOf;
}

/** The signed-in reader's email, or null. */
export function signedInEmail(): string | null {
  const email = claims()?.claims.email;
  return typeof email === "string" ? email : null;
}

/** The signed-in reader's Cognito id (the ID token's `sub`), or null. */
export function signedInSub(): string | null {
  const sub = claims()?.claims.sub;
  return typeof sub === "string" && sub ? sub : null;
}

/**
 * The signed-in reader's groups from the ID token's `cognito:groups`, or none. The same array
 * is answered until the token changes, so React's external store sees no change between reads.
 */
export function groups(): string[] {
  return claims()?.groups ?? NO_GROUPS;
}
