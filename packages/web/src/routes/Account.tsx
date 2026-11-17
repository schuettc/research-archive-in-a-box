import { useEffect, useState, useSyncExternalStore } from "react";
import { Link } from "react-router";
import {
  accessToken,
  callCognito,
  CognitoRefused,
  groups,
  PASSWORD_RULES,
  signedInEmail,
  signIn,
  signOut,
  subscribe,
} from "../auth";
import { Modal, PageHeading, useTitle } from "../page";
import { addPasskey, passkeyProblem, passkeysSupported } from "../passkeys";

/** One of the reader's passkeys, as Cognito's ListWebAuthnCredentials answers it. */
interface Passkey {
  CredentialId: string;
  FriendlyCredentialName?: string;
  AuthenticatorAttachment?: string;
  CreatedAt: number;
}

/** One of Cognito's user APIs for the signed-in reader, whose access token authorizes it. */
async function cognito(action: string, body: Record<string, unknown>): Promise<unknown> {
  const token = accessToken();
  if (!token) throw new Error("not signed in");
  return callCognito(action, { AccessToken: token, ...body });
}

async function listPasskeys(): Promise<Passkey[]> {
  const passkeys: Passkey[] = [];
  let next: string | undefined;
  do {
    const page = (await cognito("ListWebAuthnCredentials", {
      MaxResults: 20,
      ...(next ? { NextToken: next } : {}),
    })) as { Credentials?: Passkey[]; NextToken?: string };
    passkeys.push(...(page.Credentials ?? []));
    next = page.NextToken;
  } while (next);
  return passkeys;
}

const removePasskey = (id: string) => cognito("DeleteWebAuthnCredential", { CredentialId: id });

/** What the reader is told when Cognito refuses a new password, by its error type. */
function passwordProblem(error: unknown): string {
  const type = error instanceof CognitoRefused ? error.type : "";
  if (type === "NotAuthorizedException") return "Your current password isn't right.";
  if (type === "InvalidPasswordException") {
    return `The new password doesn't meet the rules: ${PASSWORD_RULES}.`;
  }
  if (type === "LimitExceededException" || type === "TooManyRequestsException") {
    return "Too many attempts. Wait a few minutes, then try again.";
  }
  return "Your password couldn't be changed right now. Try again.";
}

/**
 * The modal that changes the reader's password through Cognito's ChangePassword. The passwords
 * stay in this form's state and the one request; nothing logs or keeps them.
 */
function PasswordModal({
  email,
  onClose,
  onChanged,
}: {
  email: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [current, setCurrent] = useState("");
  const [proposed, setProposed] = useState("");
  const [confirm, setConfirm] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  function submit() {
    if (proposed !== confirm) {
      setProblem("The new passwords don't match.");
      return;
    }
    setSending(true);
    setProblem(null);
    cognito("ChangePassword", { PreviousPassword: current, ProposedPassword: proposed }).then(
      onChanged,
      (error: unknown) => {
        setSending(false);
        setProblem(passwordProblem(error));
      },
    );
  }

  return (
    <Modal label="password-heading" onClose={onClose}>
      <h2 id="password-heading">Change your password</h2>
      <form
        className="password-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {/* Lets a password manager tell which saved login this change updates. */}
        <input type="text" autoComplete="username" value={email} readOnly hidden />
        <label className="field">
          Current password
          <input
            type="password"
            autoComplete="current-password"
            required
            autoFocus
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
          />
        </label>
        <label className="field">
          New password
          <input
            type="password"
            autoComplete="new-password"
            required
            aria-describedby="password-rules"
            value={proposed}
            onChange={(event) => setProposed(event.target.value)}
          />
        </label>
        <p id="password-rules" className="hint">
          {PASSWORD_RULES.charAt(0).toUpperCase() + PASSWORD_RULES.slice(1)}.
        </p>
        <label className="field">
          Confirm new password
          <input
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </label>
        {problem && (
          <p role="alert" className="problem">
            {problem}
          </p>
        )}
        <p className="actions">
          <button type="submit" className="primary" disabled={sending}>
            Change password
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </p>
      </form>
    </Modal>
  );
}

const deviceKind = (attachment?: string) =>
  attachment === "platform"
    ? "Built into a device"
    : attachment === "cross-platform"
      ? "Security key or phone"
      : "Not known";

const passkeyName = (passkey: Passkey) => passkey.FriendlyCredentialName || "Unnamed passkey";

const added = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

const roleLabel = (role: string) => role.charAt(0).toUpperCase() + role.slice(1);

/** Each role's area: where its link on the Roles line goes. */
const ROLE_AREAS: Record<string, { to: string; area: string }> = {
  contributor: { to: "/submissions", area: "Submissions" },
  curator: { to: "/review", area: "Review queue" },
  admin: { to: "/settings", area: "Settings" },
};

/** The Roles line: each role a link to its area, named after it. */
function Roles({ roles }: { roles: string[] }) {
  if (roles.length === 0) return <>None yet</>;
  return (
    <>
      {roles.map((role, index) => {
        const where = ROLE_AREAS[role];
        return (
          <span key={role}>
            {index > 0 && " · "}
            {where ? (
              <>
                <Link to={where.to}>{roleLabel(role)}</Link>{" "}
                <span className="muted">({where.area})</span>
              </>
            ) : (
              roleLabel(role)
            )}
          </span>
        );
      })}
    </>
  );
}

/** The modal that confirms removing a passkey, or says why it couldn't. */
function RemoveModal({
  passkey,
  onClose,
  onRemoved,
}: {
  passkey: Passkey;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);

  function confirm() {
    setSending(true);
    setFailed(false);
    removePasskey(passkey.CredentialId).then(onRemoved, () => {
      setSending(false);
      setFailed(true);
    });
  }

  return (
    <Modal label="remove-heading" onClose={onClose}>
      <h2 id="remove-heading">Remove this passkey?</h2>
      <p>
        <strong>{passkeyName(passkey)}</strong> will no longer sign you in. You can still sign in
        with your password or another passkey.
      </p>
      {failed && (
        <p role="alert" className="problem">
          It couldn't be removed right now. Try again.
        </p>
      )}
      <p className="actions">
        <button type="button" className="primary" disabled={sending} onClick={confirm}>
          Remove
        </button>
        <button type="button" autoFocus onClick={onClose}>
          Cancel
        </button>
      </p>
    </Modal>
  );
}

function Passkeys() {
  const [list, setList] = useState<Passkey[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [removing, setRemoving] = useState<Passkey | null>(null);
  const [adding, setAdding] = useState(false);
  const [addProblem, setAddProblem] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    listPasskeys().then(
      (passkeys) => {
        if (!current) return;
        setList(passkeys.toSorted((a, b) => a.CreatedAt - b.CreatedAt));
        setFailed(false);
      },
      () => current && setFailed(true),
    );
    return () => {
      current = false;
    };
  }, [attempt]);

  const reload = () => {
    setFailed(false);
    setAttempt((n) => n + 1);
  };

  function add() {
    const token = accessToken();
    if (!token) return;
    setAdding(true);
    setAddProblem(null);
    addPasskey(token).then(
      () => {
        setAdding(false);
        reload();
      },
      (error: unknown) => {
        setAdding(false);
        setAddProblem(passkeyProblem(error, true));
      },
    );
  }

  return (
    <section aria-labelledby="passkeys-heading">
      <h2 id="passkeys-heading">Passkeys</h2>
      {failed ? (
        <>
          <p role="alert">Your passkeys can't be listed right now.</p>
          <p className="actions">
            <button type="button" onClick={reload}>
              Try again
            </button>
          </p>
        </>
      ) : list === null ? (
        <p role="status" className="muted">
          Loading your passkeys…
        </p>
      ) : (
        <>
          {list.length === 0 ? (
            <p>You have no passkeys yet. A passkey signs you in without your password.</p>
          ) : (
            <div className="table-scroll">
              <table className="cols listing passkeys">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Device</th>
                    <th scope="col">Added</th>
                    <th scope="col">
                      <span className="visually-hidden">Remove</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((passkey) => (
                    <tr key={passkey.CredentialId}>
                      <th scope="row">{passkeyName(passkey)}</th>
                      <td>{deviceKind(passkey.AuthenticatorAttachment)}</td>
                      <td>
                        <time dateTime={new Date(passkey.CreatedAt * 1000).toISOString()}>
                          {added(passkey.CreatedAt)}
                        </time>
                      </td>
                      <td className="row-action">
                        <button
                          type="button"
                          aria-label={`Remove ${passkeyName(passkey)}`}
                          onClick={() => setRemoving(passkey)}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {addProblem && (
            <p role="alert" className="problem">
              {addProblem}
            </p>
          )}
          {passkeysSupported() ? (
            <p className="actions">
              <button type="button" disabled={adding} onClick={add}>
                {list.length === 0 ? "Add a passkey" : "Add another passkey"}
              </button>
            </p>
          ) : (
            <p className="muted">This browser can't make passkeys.</p>
          )}
        </>
      )}
      {removing && (
        <RemoveModal
          passkey={removing}
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            setRemoving(null);
            reload();
          }}
        />
      )}
    </section>
  );
}

/**
 * `/account`: who is signed in, with which roles, Change password, their passkeys, and Sign out.
 */
export function Account() {
  useTitle("Account");
  const email = useSyncExternalStore(subscribe, signedInEmail);
  const mine = useSyncExternalStore(subscribe, groups);
  const [changing, setChanging] = useState(false);
  const [changed, setChanged] = useState(false);

  if (!email) {
    return (
      <>
        <PageHeading>Account</PageHeading>
        <p>Sign in to see your account.</p>
        <p className="actions">
          <button type="button" className="primary" onClick={() => void signIn("/account")}>
            Sign in
          </button>
        </p>
      </>
    );
  }

  return (
    <>
      <PageHeading>Account</PageHeading>
      <dl className="facts">
        <div>
          <dt>Email</dt>
          <dd>{email}</dd>
        </div>
        <div>
          <dt>Roles</dt>
          <dd>
            <Roles roles={mine} />
          </dd>
        </div>
        <div>
          <dt>Password</dt>
          <dd>
            <button
              type="button"
              onClick={() => {
                setChanged(false);
                setChanging(true);
              }}
            >
              Change password
            </button>{" "}
            <span role="status" className="muted">
              {changed ? "Password changed." : ""}
            </span>
          </dd>
        </div>
      </dl>
      {changing && (
        <PasswordModal
          email={email ?? ""}
          onClose={() => setChanging(false)}
          onChanged={() => {
            setChanging(false);
            setChanged(true);
          }}
        />
      )}
      <Passkeys />
      <section className="block" aria-labelledby="sign-out-heading">
        <h2 id="sign-out-heading">Sign out</h2>
        <p>
          You're signed in as <b>{email}</b> on this browser.
        </p>
        <p className="actions">
          <button type="button" onClick={() => void signOut()}>
            Sign out
          </button>
        </p>
      </section>
    </>
  );
}
