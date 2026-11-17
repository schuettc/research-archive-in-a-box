import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test, vi, type Mock } from "vitest";
import { AppRoutes } from "../App";
import { accessToken, groups, signedInEmail, signIn, signOut } from "../auth";

vi.mock("../auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth")>()),
  signedInEmail: vi.fn(() => "reader@example.org"),
  groups: vi.fn(() => ["contributor", "curator"]),
  accessToken: vi.fn(() => "access-token"),
  apiToken: vi.fn(() => "id-token"),
  signIn: vi.fn(async () => {}),
  signOut: vi.fn(async () => {}),
}));

const ENDPOINT = "https://cognito-idp.eu-west-2.amazonaws.com/";
const LAPTOP = {
  CredentialId: "cred-1",
  FriendlyCredentialName: "MacBook Touch ID",
  RelyingPartyId: "archive-dev.auth.eu-west-2.amazoncognito.com",
  AuthenticatorAttachment: "platform",
  AuthenticatorTransports: ["internal"],
  CreatedAt: 1_762_000_000,
};
const KEY = {
  CredentialId: "cred-2",
  FriendlyCredentialName: "YubiKey",
  RelyingPartyId: "archive-dev.auth.eu-west-2.amazoncognito.com",
  AuthenticatorAttachment: "cross-platform",
  AuthenticatorTransports: ["usb"],
  CreatedAt: 1_763_000_000,
};

let credentials: unknown[];
let listFails: boolean;
// What ChangePassword answers: an error type, or null for success.
let changeFails: string | null;
let calls: { target: string; body: Record<string, unknown>; headers: Headers }[];
let fetchMock: Mock;
let create: Mock;
const NEW_KEY = {
  CredentialId: "cred-3",
  FriendlyCredentialName: "Pixel",
  AuthenticatorAttachment: "cross-platform",
  CreatedAt: 1_764_000_000,
};

beforeEach(() => {
  credentials = [LAPTOP, KEY];
  listFails = false;
  changeFails = null;
  calls = [];
  vi.mocked(signedInEmail).mockReturnValue("reader@example.org");
  vi.mocked(groups).mockReturnValue(["contributor", "curator"]);
  vi.mocked(accessToken).mockReturnValue("access-token");
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/auth-config.json") {
      return Response.json({
        region: "eu-west-2",
        webClientId: "web-client",
      });
    }
    if (url === ENDPOINT) {
      const headers = new Headers(init?.headers);
      const target = headers.get("X-Amz-Target") ?? "";
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ target, body, headers });
      if (target.endsWith(".ListWebAuthnCredentials")) {
        if (listFails) return Response.json({ __type: "InternalErrorException" }, { status: 500 });
        return Response.json({ Credentials: credentials });
      }
      if (target.endsWith(".DeleteWebAuthnCredential")) {
        credentials = credentials.filter(
          (credential) => (credential as typeof LAPTOP).CredentialId !== body.CredentialId,
        );
        return Response.json({});
      }
      if (target.endsWith(".StartWebAuthnRegistration")) {
        return Response.json({
          CredentialCreationOptions: {
            rp: { id: "localhost", name: "localhost" },
            user: { id: "dXNlcg", name: "reader@example.org", displayName: "reader@example.org" },
            challenge: "CQgH",
            pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          },
        });
      }
      if (target.endsWith(".CompleteWebAuthnRegistration")) {
        credentials = [...credentials, NEW_KEY];
        return Response.json({});
      }
      if (target.endsWith(".ChangePassword")) {
        if (changeFails) {
          return Response.json({ __type: changeFails, message: "from Cognito" }, { status: 400 });
        }
        return Response.json({});
      }
    }
    // The rest of the app's API is not this page's concern.
    return new Promise(() => {});
  });
  vi.stubGlobal("fetch", fetchMock);
  create = vi.fn(async () => ({
    id: "AQ",
    rawId: new Uint8Array([1]).buffer,
    type: "public-key",
    authenticatorAttachment: "cross-platform",
    response: {
      clientDataJSON: new Uint8Array([2]).buffer,
      attestationObject: new Uint8Array([3]).buffer,
      getTransports: () => ["hybrid"],
    },
    getClientExtensionResults: () => ({}),
  }));
  vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
  Object.defineProperty(navigator, "credentials", {
    configurable: true,
    value: { get: vi.fn(), create },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "credentials");
});

function renderAccount() {
  return render(
    <MemoryRouter initialEntries={["/account"]}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

const main = () => within(screen.getByRole("main"));

test("the page shows the reader's email and roles, and their passkeys from ListWebAuthnCredentials", async () => {
  renderAccount();

  expect(screen.getByRole("heading", { level: 1, name: "Account" })).toBeDefined();
  expect(main().getByText("reader@example.org", { selector: "dd" })).toBeDefined();
  expect(main().getByRole("link", { name: "Contributor" }).getAttribute("href")).toBe(
    "/submissions",
  );
  expect(main().getByRole("link", { name: "Curator" }).getAttribute("href")).toBe("/review");
  const rows = await main().findAllByRole("row");
  // A header row, then one per passkey, each with its name, device kind and date added.
  expect(rows).toHaveLength(3);
  expect(rows[1]?.textContent).toContain("MacBook Touch ID");
  expect(rows[1]?.textContent).toContain("Built into a device");
  expect(rows[1]?.textContent).toContain("1 Nov 2025");
  expect(rows[2]?.textContent).toContain("YubiKey");
  expect(rows[2]?.textContent).toContain("Security key or phone");

  const list = calls.find((call) => call.target.endsWith(".ListWebAuthnCredentials"));
  expect(list?.target).toBe("AWSCognitoIdentityProviderService.ListWebAuthnCredentials");
  expect(list?.headers.get("Content-Type")).toBe("application/x-amz-json-1.1");
  expect(list?.body.AccessToken).toBe("access-token");
  expect(list?.headers.get("Authorization")).toBeNull();
});

/** Open the Change password modal and fill it in. */
async function fillPassword(current: string, proposed: string, confirm = proposed) {
  fireEvent.click(await main().findByRole("button", { name: "Change password" }));
  const dialog = within(screen.getByRole("dialog", { name: "Change your password" }));
  fireEvent.change(dialog.getByLabelText("Current password"), { target: { value: current } });
  fireEvent.change(dialog.getByLabelText("New password"), { target: { value: proposed } });
  fireEvent.change(dialog.getByLabelText("Confirm new password"), { target: { value: confirm } });
  return dialog;
}

const changeCalls = () => calls.filter((call) => call.target.endsWith(".ChangePassword"));

test("Change password opens a modal with the three fields and Cognito's rules, calling nothing yet", async () => {
  renderAccount();

  fireEvent.click(await main().findByRole("button", { name: "Change password" }));
  const dialog = within(screen.getByRole("dialog", { name: "Change your password" }));

  expect(dialog.getByLabelText("Current password").getAttribute("autocomplete")).toBe(
    "current-password",
  );
  expect(dialog.getByLabelText("Current password").getAttribute("type")).toBe("password");
  // Password managers match the login to update by a username field in the same form.
  const username = document.querySelector('dialog input[autocomplete="username"]');
  expect(username?.getAttribute("value")).toBe("reader@example.org");
  expect(dialog.getByLabelText("New password").getAttribute("autocomplete")).toBe("new-password");
  expect(dialog.getByLabelText("Confirm new password").getAttribute("autocomplete")).toBe(
    "new-password",
  );
  // The user pool's policy: CDK's defaults, which packages/infra/src/auth.ts keeps.
  expect(dialog.getByText(/at least 8 characters/i).textContent).toMatch(
    /lowercase.*uppercase.*number.*symbol/,
  );
  expect(changeCalls()).toEqual([]);
});

test("a right current password and a good new one call ChangePassword, close the modal and say so", async () => {
  renderAccount();

  const dialog = await fillPassword("Old-pass-1", "New-pass-2");
  fireEvent.click(dialog.getByRole("button", { name: "Change password" }));

  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const [call] = changeCalls();
  expect(call?.target).toBe("AWSCognitoIdentityProviderService.ChangePassword");
  expect(call?.body).toEqual({
    AccessToken: "access-token",
    PreviousPassword: "Old-pass-1",
    ProposedPassword: "New-pass-2",
  });
  expect(call?.headers.get("Authorization")).toBeNull();
  expect(main().getByRole("status").textContent).toBe("Password changed.");
});

test("a confirmation that doesn't match is said in the modal before anything is sent", async () => {
  renderAccount();

  const dialog = await fillPassword("Old-pass-1", "New-pass-2", "New-pass-3");
  fireEvent.click(dialog.getByRole("button", { name: "Change password" }));

  expect(dialog.getByRole("alert").textContent).toBe("The new passwords don't match.");
  expect(changeCalls()).toEqual([]);
});

test.each([
  ["NotAuthorizedException", "Your current password isn't right."],
  [
    "InvalidPasswordException",
    "The new password doesn't meet the rules: at least 8 characters, with a lowercase letter, an uppercase letter, a number and a symbol.",
  ],
  ["LimitExceededException", "Too many attempts. Wait a few minutes, then try again."],
  ["TooManyRequestsException", "Too many attempts. Wait a few minutes, then try again."],
  ["InternalErrorException", "Your password couldn't be changed right now. Try again."],
])("Cognito's %s is said in the modal, which stays open", async (type, sentence) => {
  changeFails = type;
  renderAccount();

  const dialog = await fillPassword("Old-pass-1", "New-pass-2");
  fireEvent.click(dialog.getByRole("button", { name: "Change password" }));

  expect((await dialog.findByRole("alert")).textContent).toBe(sentence);
  expect(screen.getByRole("dialog", { name: "Change your password" })).toBeDefined();
  expect(main().getByRole("status").textContent).toBe("");
});

test("Cancel closes the password modal without calling Cognito", async () => {
  renderAccount();

  const dialog = await fillPassword("Old-pass-1", "New-pass-2");
  fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));

  expect(screen.queryByRole("dialog")).toBeNull();
  expect(changeCalls()).toEqual([]);
});

test("Add another passkey uses the browser's prompt, then lists the new one", async () => {
  renderAccount();

  fireEvent.click(await main().findByRole("button", { name: "Add another passkey" }));

  expect(await main().findByText("Pixel")).toBeDefined();
  expect(create).toHaveBeenCalled();
  expect(calls.map((call) => call.target.split(".")[1])).toEqual([
    "ListWebAuthnCredentials",
    "StartWebAuthnRegistration",
    "CompleteWebAuthnRegistration",
    "ListWebAuthnCredentials",
  ]);
  expect(calls[2]?.body.AccessToken).toBe("access-token");
  expect(main().queryByRole("button", { name: "Add a passkey" })).toBeNull();
});

test("with no passkeys the page says so and offers Add a passkey", async () => {
  credentials = [];
  renderAccount();

  fireEvent.click(await main().findByRole("button", { name: "Add a passkey" }));
  expect(main().getByText(/no passkeys yet/)).toBeDefined();
  expect(await main().findByText("Pixel")).toBeDefined();
  expect(main().queryByRole("button", { name: "Add a passkey" })).toBeNull();
});

test("a cancelled passkey prompt says so and leaves the list as it was", async () => {
  create.mockRejectedValueOnce(new DOMException("cancelled", "NotAllowedError"));
  renderAccount();

  fireEvent.click(await main().findByRole("button", { name: "Add another passkey" }));

  expect((await main().findByRole("alert")).textContent).toBe(
    "The passkey prompt was closed before it finished, so no passkey was added.",
  );
  expect(main().queryByText("Pixel")).toBeNull();
  expect(calls.some((call) => call.target.endsWith(".CompleteWebAuthnRegistration"))).toBe(false);
});

test("a browser without passkeys isn't offered Add a passkey", async () => {
  vi.stubGlobal("PublicKeyCredential", undefined);
  renderAccount();

  expect(await main().findByText("This browser can't make passkeys.")).toBeDefined();
  expect(main().queryByRole("button", { name: /Add .*passkey/ })).toBeNull();
});

test("Remove asks in a modal, then calls DeleteWebAuthnCredential and lists what's left", async () => {
  renderAccount();

  fireEvent.click(await main().findByRole("button", { name: "Remove YubiKey" }));
  const dialog = within(screen.getByRole("dialog", { name: "Remove this passkey?" }));
  expect(dialog.getByText(/YubiKey/)).toBeDefined();
  expect(calls.some((call) => call.target.endsWith(".DeleteWebAuthnCredential"))).toBe(false);

  fireEvent.click(dialog.getByRole("button", { name: "Remove" }));

  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const deleted = calls.find((call) => call.target.endsWith(".DeleteWebAuthnCredential"));
  expect(deleted?.body).toEqual({ AccessToken: "access-token", CredentialId: "cred-2" });
  await waitFor(() => expect(main().queryByText("YubiKey")).toBeNull());
  expect(main().getByText("MacBook Touch ID")).toBeDefined();
});

test("Cancel in the modal removes nothing", async () => {
  renderAccount();

  fireEvent.click(await main().findByRole("button", { name: "Remove YubiKey" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

  expect(screen.queryByRole("dialog")).toBeNull();
  expect(calls.some((call) => call.target.endsWith(".DeleteWebAuthnCredential"))).toBe(false);
});

test("a failed list says so with Try again, which lists them once it answers", async () => {
  listFails = true;
  renderAccount();

  expect((await main().findByRole("alert")).textContent).toContain("can't be listed");
  listFails = false;
  fireEvent.click(main().getByRole("button", { name: "Try again" }));
  expect(await main().findByText("YubiKey")).toBeDefined();
});

test("Sign out is on the page, in a section of its own", async () => {
  renderAccount();
  const section = main().getByRole("region", { name: "Sign out" });
  expect(section.textContent).toContain("reader@example.org");

  fireEvent.click(main().getByRole("button", { name: "Sign out" }));
  expect(signOut).toHaveBeenCalled();
});

test("signed out, the page keeps its heading and offers Sign in back to itself", () => {
  vi.mocked(signedInEmail).mockReturnValue(null);
  vi.mocked(accessToken).mockReturnValue(null);
  renderAccount();

  expect(screen.getByRole("heading", { level: 1, name: "Account" })).toBeDefined();
  fireEvent.click(main().getByRole("button", { name: "Sign in" }));
  expect(signIn).toHaveBeenCalledWith("/account");
});

test("the frame doesn't move: the masthead and the h1 in main are the same in every state (PRIN1)", async () => {
  const frame = () => {
    const inner = screen.getByRole("banner").querySelector(".inner");
    const heading = screen.getByRole("heading", { level: 1 });
    return {
      masthead: [...(inner?.children ?? [])].map((child) => child.className),
      account: within(screen.getByRole("banner")).getByRole("button", { name: /Account/ })
        .className,
      h1: heading.textContent,
      h1First: screen.getByRole("main").firstElementChild === heading,
    };
  };
  const expected = {
    masthead: ["mark", "nav", "account", "menu-button"],
    account: "account-button",
    h1: "Account",
    h1First: true,
  };

  const loading = renderAccount();
  expect(frame()).toEqual(expected);
  await main().findByText("YubiKey");
  expect(frame()).toEqual(expected);
  loading.unmount();

  listFails = true;
  const failed = renderAccount();
  await main().findByRole("alert");
  expect(frame()).toEqual(expected);
  failed.unmount();

  listFails = false;
  credentials = [];
  renderAccount();
  await main().findByRole("button", { name: "Add a passkey" });
  expect(frame()).toEqual(expected);

  // The password modal overlays the page: open, refused, and after success.
  changeFails = "NotAuthorizedException";
  const dialog = await fillPassword("Old-pass-1", "New-pass-2");
  expect(frame()).toEqual(expected);
  fireEvent.click(dialog.getByRole("button", { name: "Change password" }));
  await dialog.findByRole("alert");
  expect(frame()).toEqual(expected);
  changeFails = null;
  fireEvent.click(dialog.getByRole("button", { name: "Change password" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(frame()).toEqual(expected);
});

test("an axe check of the page and its Remove and Change password modals finds no violations", async () => {
  const { container } = renderAccount();
  await main().findByText("YubiKey");
  expect((await axe.run(container)).violations).toEqual([]);

  fireEvent.click(main().getByRole("button", { name: "Remove YubiKey" }));
  expect((await axe.run(container)).violations).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

  changeFails = "InvalidPasswordException";
  const dialog = await fillPassword("Old-pass-1", "weak");
  fireEvent.click(dialog.getByRole("button", { name: "Change password" }));
  await dialog.findByRole("alert");
  expect((await axe.run(container)).violations).toEqual([]);
});
