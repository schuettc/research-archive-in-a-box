import { acceptTokens, asWebClient, callCognito, CognitoRefused, type AuthAnswer } from "./auth";

/** The reader closed or refused the browser's passkey prompt, or it timed out. */
export class PasskeyCancelled extends Error {}

/** Cognito has no passkey to offer for this email: none was added on this archive's address. */
export class NoPasskey extends Error {}

/** Whether this browser can sign in with a passkey and make one. */
export function passkeysSupported(): boolean {
  return (
    typeof window.PublicKeyCredential !== "undefined" &&
    typeof navigator.credentials?.get === "function" &&
    typeof navigator.credentials.create === "function"
  );
}

/** Bytes from WebAuthn's base64url (no padding), as Cognito sends them. */
export function fromBase64url(text: string): ArrayBuffer {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)).buffer;
}

/** Bytes as WebAuthn's base64url, as Cognito takes them. */
export function toBase64url(buffer: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface DescriptorJSON {
  id: string;
  type: "public-key";
  transports?: AuthenticatorTransport[];
}

const descriptor = (json: DescriptorJSON): PublicKeyCredentialDescriptor => ({
  ...json,
  id: fromBase64url(json.id),
});

/** Ask the browser, turning a closed or refused prompt into PasskeyCancelled. */
async function prompt(ask: () => Promise<Credential | null>): Promise<PublicKeyCredential> {
  let credential: Credential | null;
  try {
    credential = await ask();
  } catch (error) {
    if (
      error instanceof DOMException &&
      (error.name === "NotAllowedError" || error.name === "AbortError")
    ) {
      throw new PasskeyCancelled(error.message);
    }
    throw error;
  }
  if (!credential) throw new PasskeyCancelled("no credential");
  return credential as PublicKeyCredential;
}

/** Sign in with a passkey: Cognito's WEB_AUTHN challenge, answered by the browser's prompt. */
export async function signInWithPasskey(email: string): Promise<void> {
  const challenge = (await asWebClient("InitiateAuth", {
    AuthFlow: "USER_AUTH",
    AuthParameters: { USERNAME: email, PREFERRED_CHALLENGE: "WEB_AUTHN" },
  })) as AuthAnswer;
  const options = challenge.ChallengeParameters?.CREDENTIAL_REQUEST_OPTIONS;
  if (challenge.ChallengeName !== "WEB_AUTHN" || !options || !challenge.Session) {
    // Cognito offers the other ways in (SELECT_CHALLENGE) when the person has no passkey here.
    throw new NoPasskey(String(challenge.ChallengeName));
  }
  const json = JSON.parse(options) as Omit<
    PublicKeyCredentialRequestOptions,
    "challenge" | "allowCredentials"
  > & { challenge: string; allowCredentials?: DescriptorJSON[] };
  const credential = await prompt(() =>
    navigator.credentials.get({
      publicKey: {
        ...json,
        challenge: fromBase64url(json.challenge),
        allowCredentials: json.allowCredentials?.map(descriptor),
      },
    }),
  );
  const response = credential.response as AuthenticatorAssertionResponse;
  const answer = (await asWebClient("RespondToAuthChallenge", {
    ChallengeName: "WEB_AUTHN",
    Session: challenge.Session,
    ChallengeResponses: {
      USERNAME: email,
      // WebAuthn's AuthenticationResponseJSON, as a string.
      CREDENTIAL: JSON.stringify({
        id: credential.id,
        rawId: toBase64url(credential.rawId),
        type: credential.type,
        authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
        response: {
          clientDataJSON: toBase64url(response.clientDataJSON),
          authenticatorData: toBase64url(response.authenticatorData),
          signature: toBase64url(response.signature),
          userHandle: response.userHandle ? toBase64url(response.userHandle) : undefined,
        },
        clientExtensionResults: credential.getClientExtensionResults(),
      }),
    },
  })) as AuthAnswer;
  if (!acceptTokens(answer)) throw new CognitoRefused("RespondToAuthChallenge", "Unexpected", "");
}

/**
 * Add a passkey for the signed-in reader on this archive's address: Cognito's registration
 * options, the browser's prompt, and the browser's answer back to Cognito.
 */
export async function addPasskey(accessToken: string): Promise<void> {
  const started = (await callCognito("StartWebAuthnRegistration", {
    AccessToken: accessToken,
  })) as { CredentialCreationOptions: Record<string, unknown> };
  const json = started.CredentialCreationOptions as unknown as Omit<
    PublicKeyCredentialCreationOptions,
    "challenge" | "user" | "excludeCredentials"
  > & {
    challenge: string;
    user: { id: string; name: string; displayName: string };
    excludeCredentials?: DescriptorJSON[];
  };
  const credential = await prompt(() =>
    navigator.credentials.create({
      publicKey: {
        ...json,
        challenge: fromBase64url(json.challenge),
        user: { ...json.user, id: fromBase64url(json.user.id) },
        excludeCredentials: json.excludeCredentials?.map(descriptor),
      },
    }),
  );
  const response = credential.response as AuthenticatorAttestationResponse;
  await callCognito("CompleteWebAuthnRegistration", {
    AccessToken: accessToken,
    // WebAuthn's RegistrationResponseJSON, as a JSON value.
    Credential: {
      id: credential.id,
      rawId: toBase64url(credential.rawId),
      type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
      response: {
        clientDataJSON: toBase64url(response.clientDataJSON),
        attestationObject: toBase64url(response.attestationObject),
        transports: response.getTransports?.(),
      },
      clientExtensionResults: credential.getClientExtensionResults(),
    },
  });
}

/** What the reader is told when signing in with (or, `adding`, making) a passkey doesn't finish. */
export function passkeyProblem(error: unknown, adding = false): string {
  if (error instanceof PasskeyCancelled) {
    return adding
      ? "The passkey prompt was closed before it finished, so no passkey was added."
      : "The passkey prompt was closed before it finished. Try again, or use your password.";
  }
  if (error instanceof NoPasskey) {
    return "There's no passkey for this archive on that account yet. Sign in with your password, then add one on your Account page.";
  }
  if (error instanceof DOMException && error.name === "InvalidStateError") {
    return "This device already has a passkey for your account.";
  }
  const type = error instanceof CognitoRefused ? error.type : "";
  if (type === "NotAuthorizedException") {
    return "That passkey didn't sign you in. Try again, or use your password.";
  }
  if (type === "LimitExceededException" || type === "TooManyRequestsException") {
    return "Too many tries. Wait a few minutes, then try again.";
  }
  return adding
    ? "Your passkey couldn't be added right now. Try again."
    : "Passkeys aren't working right now. Try again, or use your password.";
}
