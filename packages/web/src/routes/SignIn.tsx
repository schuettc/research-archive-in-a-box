import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import {
  accessToken,
  CognitoRefused,
  commandLineTokens,
  confirmForgotPassword,
  confirmSignUp,
  forgotPassword,
  PASSWORD_RULES,
  resendCode,
  setFirstPassword,
  signedInEmail,
  signInProblem,
  signInWithPassword,
  signUp,
  subscribe,
} from "../auth";
import { PageHeading, useTitle } from "../page";
import { addPasskey, passkeyProblem, passkeysSupported, signInWithPasskey } from "../passkeys";

/**
 * The page to go back to after signing in: a path on this site, never another site's address
 * (`//host`, `/\host` or a full URL) and never this page again.
 */
export function safeNext(next: string | null): string {
  if (!next || !next.startsWith("/")) return "/";
  // Resolve it as the browser would (which drops tabs and newlines, so "/\t/evil" is "//evil")
  // and keep it only if it stays on this site.
  const url = new URL(next, location.origin);
  if (url.origin !== location.origin) return "/";
  const path = url.pathname + url.search + url.hash;
  if (url.pathname === "/sign-in") return "/";
  return path;
}

/**
 * The command line's port from `cli`: a whole number from 1024 to 65535, written plainly, else
 * null. The hand-back is built only as `http://localhost:<port>/callback` from it, so nothing put
 * in `cli` can name another address.
 */
export function cliPort(cli: string | null): number | null {
  if (!cli || !/^[1-9][0-9]{3,4}$/.test(cli)) return null;
  const port = Number(cli);
  return port >= 1024 && port <= 65535 ? port : null;
}

/** A command-line sign-in the page was opened for: its listener's port and its `state`. */
function commandLine(params: URLSearchParams): { port: number; state: string } | null {
  const port = cliPort(params.get("cli"));
  const state = params.get("state");
  return port !== null && state ? { port, state } : null;
}

/**
 * Hand the signed-in reader's ID and access tokens to the command line's listener on this
 * computer, as a form posted to localhost: a plain form needs no CORS, and the listener checks
 * the `state` it made. The refresh token stays in the tab.
 */
async function handBack(cli: { port: number; state: string }): Promise<void> {
  const tokens = await commandLineTokens();
  if (!tokens) return;
  const form = document.createElement("form");
  form.method = "post";
  form.action = `http://localhost:${cli.port}/callback`;
  const fields = {
    id_token: tokens.idToken,
    access_token: tokens.accessToken,
    expires_in: String(tokens.expiresIn),
    state: cli.state,
  };
  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.append(input);
  }
  document.body.append(form);
  form.submit();
}

type Step =
  | { name: "email" }
  | { name: "password"; notice?: string }
  | { name: "new-password"; session: string }
  | { name: "forgot" }
  | { name: "reset" }
  | { name: "create" }
  | { name: "code"; notice?: string }
  | { name: "no-code" }
  | { name: "welcome" };

/** The steps of Create an account, which head the page with its own h1. */
const CREATING = new Set<Step["name"]>(["create", "code", "no-code", "welcome"]);

/**
 * What the reader is told when a sign-up code is refused. Cognito refuses a code for an email
 * whose account is already confirmed as not authorized; that reads as a wrong code too, so the
 * page never says whether the email has an account.
 */
function codeProblem(error: unknown): string {
  const sentence = signInProblem(error);
  const refusedConfirmed =
    error instanceof CognitoRefused &&
    error.type === "NotAuthorizedException" &&
    !sentence.startsWith("Too many");
  return refusedConfirmed ? "That code isn't right. Check the email and try again." : sentence;
}

const capitalised = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** A field inside its label, as the app's other forms have them. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      {label}
      {children}
    </label>
  );
}

/**
 * `/sign-in`: the email, then the password; an invited person's first password; the two
 * forgot-password steps; and Create an account (`?view=create`): the email and a password, the
 * emailed code, then signed in and offered a passkey. Cognito checks every password; this page only asks for them. The
 * passwords stay in this page's state and the one request; nothing logs or keeps them. Opened by
 * the command line (`?cli=<port>&state=<state>`), the page then asks before handing the sign-in to
 * it, so a link from someone else can't take one without the reader pressing the button. The
 * command line's listener sends the tab back to `?cli=done`, which says it is signed in.
 */
export function SignIn() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const cli = commandLine(params);
  const handedBack = params.get("cli") === "done";
  const signedIn = useSyncExternalStore(subscribe, signedInEmail);
  const [step, setStep] = useState<Step>(() =>
    params.get("view") === "create" ? { name: "create" } : { name: "email" },
  );
  const creating = CREATING.has(step.name);
  useTitle(
    handedBack ? "The command line is signed in" : creating ? "Create an account" : "Sign in",
  );
  // Set while a new account signs in, so the page stays to offer a passkey.
  const offering = useRef(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (signedIn && !offering.current && !cli && !handedBack)
      void navigate(next, { replace: true });
  }, [signedIn, next, navigate, cli, handedBack]);

  /** Signed in and done with the passkey offer: on to next, or to the command line's question. */
  function finish() {
    offering.current = false;
    if (cli) go({ name: "email" });
    else void navigate(next, { replace: true });
  }

  function go(to: Step) {
    setStep(to);
    setProblem(null);
    // Moving between the code and its help keeps the new password, which confirming signs in with.
    if (!(CREATING.has(step.name) && (to.name === "code" || to.name === "no-code")))
      setPassword("");
    setConfirm("");
    if (to.name !== "reset" && to.name !== "code") setCode("");
  }

  /** Run one call to Cognito, showing its refusal as a sentence under the field. */
  function send(call: () => Promise<void>, problemOf = signInProblem) {
    setSending(true);
    setProblem(null);
    call().then(
      () => setSending(false),
      (error: unknown) => {
        setSending(false);
        setProblem(problemOf(error));
      },
    );
  }

  /** Confirm the new account's code, then sign in with the password just given. */
  function confirmAndSignIn() {
    const chosen = password;
    setSending(true);
    setProblem(null);
    confirmSignUp(email, code.trim()).then(
      () => {
        offering.current = passkeysSupported();
        signInWithPassword(email, chosen).then(
          () => {
            setSending(false);
            if (offering.current) go({ name: "welcome" });
            else finish();
          },
          (error: unknown) => {
            offering.current = false;
            setSending(false);
            go({ name: "password", notice: "Your account is ready. Sign in with your password." });
            setProblem(signInProblem(error));
          },
        );
      },
      (error: unknown) => {
        setSending(false);
        setProblem(codeProblem(error));
      },
    );
  }

  function offerPasskey() {
    const token = accessToken();
    if (!token) return;
    setSending(true);
    setProblem(null);
    addPasskey(token).then(
      () => {
        setSending(false);
        finish();
      },
      (error: unknown) => {
        setSending(false);
        setProblem(passkeyProblem(error, true));
      },
    );
  }

  function sendNewCode() {
    send(async () => {
      await resendCode(email);
      setStep({ name: "code", notice: `A new code is on its way to ${email}.` });
    });
  }

  /** The form checks the email itself, so an empty one says what it needs. */
  function emailProblem(): string | null {
    if (!email) return "Enter your email";
    if (!/^[^@\s]+@[^@\s]+$/.test(email))
      return "Enter the whole email address, such as name@example.org.";
    return null;
  }

  function usePasskey() {
    setSending(true);
    setProblem(null);
    signInWithPasskey(email).then(
      () => setSending(false),
      (error: unknown) => {
        setSending(false);
        setProblem(passkeyProblem(error));
      },
    );
  }

  function matching(): boolean {
    if (password === confirm) return true;
    setProblem("The passwords don't match.");
    return false;
  }

  function submit() {
    if (step.name === "email") {
      const wrong = emailProblem();
      if (wrong) setProblem(wrong);
      else go({ name: "password" });
    } else if (step.name === "create") {
      const wrong = emailProblem() ?? (password ? null : "Choose a password");
      if (wrong) setProblem(wrong);
      else
        send(async () => {
          await signUp(email, password);
          // Keep the password: confirming signs in with it.
          setStep({ name: "code" });
        });
    } else if (step.name === "code") {
      confirmAndSignIn();
    } else if (step.name === "no-code" || step.name === "welcome") {
      return;
    } else if (step.name === "password") {
      send(async () => {
        const answer = await signInWithPassword(email, password);
        if (answer.next === "new-password") go({ name: "new-password", session: answer.session });
      });
    } else if (step.name === "new-password") {
      if (matching()) send(() => setFirstPassword({ email, session: step.session }, password));
    } else if (step.name === "forgot") {
      send(async () => {
        await forgotPassword(email);
        go({ name: "reset" });
      });
    } else if (matching()) {
      send(async () => {
        await confirmForgotPassword(email, code.trim(), password);
        go({ name: "password", notice: "Your password is changed. Sign in with it." });
      });
    }
  }

  if (handedBack) {
    return (
      <div className="sign-in">
        <PageHeading>The command line is signed in</PageHeading>
        <p>You can close this tab and go back to your terminal.</p>
        <p>
          <Link to="/">Go to the archive</Link>
        </p>
      </div>
    );
  }

  if (cli && signedIn && !offering.current && step.name !== "welcome") {
    return (
      <div className="sign-in">
        <PageHeading>Sign in</PageHeading>
        <form
          className="sign-in-form"
          onSubmit={(event) => {
            event.preventDefault();
            void handBack(cli);
          }}
        >
          <p>{`Sign in the command line on this computer as ${signedIn}?`}</p>
          <p className="hint">
            Only if you just ran a command that opened this page. It stays signed in for about an
            hour.
          </p>
          <p className="actions">
            <button type="submit" className="primary">
              Sign in the command line
            </button>
            <button type="button" onClick={() => void navigate("/", { replace: true })}>
              Cancel
            </button>
          </p>
        </form>
      </div>
    );
  }

  const describedBy = problem ? "step-problem" : undefined;
  const newPasswords = (
    <>
      <Field label="New password">
        <input
          type="password"
          autoComplete="new-password"
          required
          autoFocus={step.name === "new-password"}
          aria-describedby="password-rules"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </Field>
      <p id="password-rules" className="hint">
        {capitalised(PASSWORD_RULES)}.
      </p>
      <Field label="Confirm new password">
        <input
          type="password"
          autoComplete="new-password"
          required
          aria-describedby={describedBy}
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
        />
      </Field>
    </>
  );
  // Lets a password manager tell which saved login a password belongs to.
  const username = <input type="email" autoComplete="username" value={email} readOnly hidden />;
  const whoAmI = (
    <p className="sign-in-who">
      <span className="muted">Email</span> <strong>{email}</strong>{" "}
      <button type="button" className="link-button" onClick={() => go({ name: "email" })}>
        Use another email
      </button>
    </p>
  );

  let body: ReactNode;
  // The submit button's words; the steps that only offer choices have none.
  let action: string | null;
  if (step.name === "email") {
    action = "Continue";
    body = (
      <Field label="Email">
        <input
          type="email"
          autoComplete="username"
          required
          autoFocus
          aria-invalid={problem ? true : undefined}
          aria-describedby={describedBy}
          value={email}
          onChange={(event) => setEmail(event.target.value.trim())}
        />
      </Field>
    );
  } else if (step.name === "create") {
    action = "Create account";
    body = (
      <>
        <p className="hint">
          An account lets you download limited datasets and ask for access to restricted ones.
        </p>
        <Field label="Email">
          <input
            type="email"
            autoComplete="username"
            required
            autoFocus
            aria-invalid={problem ? true : undefined}
            aria-describedby={describedBy}
            value={email}
            onChange={(event) => setEmail(event.target.value.trim())}
          />
        </Field>
        <Field label="Password">
          <input
            type="password"
            autoComplete="new-password"
            required
            aria-describedby="password-rules"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        <p id="password-rules" className="hint">
          {capitalised(PASSWORD_RULES)}.
        </p>
      </>
    );
  } else if (step.name === "code") {
    action = "Confirm";
    body = (
      <>
        <h2>Check your email</h2>
        {step.notice ? (
          <p role="status" className="note">
            {step.notice}
          </p>
        ) : (
          <p>
            We sent a code to <strong>{email}</strong>.
          </p>
        )}
        <Field label="Code">
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            autoFocus
            aria-describedby={describedBy}
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
        </Field>
      </>
    );
  } else if (step.name === "no-code") {
    action = null;
    body = (
      <>
        <h2>Check your email</h2>
        <p className="note">
          No code? If <strong>{email}</strong> already has an account, no code is sent: sign in, or
          reset your password.
        </p>
      </>
    );
  } else if (step.name === "welcome") {
    action = null;
    body = (
      <>
        <h2>You're in</h2>
        <p>
          Your account is ready, and you're signed in as <strong>{email}</strong>.
        </p>
        <p>
          Add a passkey to sign in next time with your fingerprint, face or device PIN instead of
          your password.
        </p>
      </>
    );
  } else if (step.name === "password") {
    action = "Sign in";
    body = (
      <>
        {step.notice && (
          <p role="status" className="note">
            {step.notice}
          </p>
        )}
        {username}
        {whoAmI}
        <Field label="Password">
          <input
            type="password"
            autoComplete="current-password"
            required
            autoFocus
            aria-describedby={describedBy}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
      </>
    );
  } else if (step.name === "new-password") {
    action = "Set password and sign in";
    body = (
      <>
        <h2>Choose your password</h2>
        <p>This is your first sign-in. Choose a password of your own to finish it.</p>
        {username}
        {newPasswords}
      </>
    );
  } else if (step.name === "forgot") {
    action = "Send the code";
    body = (
      <>
        <h2>Reset your password</h2>
        <p>We'll email a code to {email} that lets you choose a new password.</p>
      </>
    );
  } else {
    action = "Set new password";
    body = (
      <>
        <h2>Reset your password</h2>
        <p role="status">
          If {email} has an account here, a code is on its way there. It lasts an hour.
        </p>
        {username}
        <Field label="Code from the email">
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            autoFocus
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
        </Field>
        {newPasswords}
      </>
    );
  }

  return (
    <div className="sign-in">
      <PageHeading>{creating ? "Create an account" : "Sign in"}</PageHeading>
      <form
        className="sign-in-form"
        noValidate={step.name === "email" || step.name === "create"}
        onSubmit={(event) => {
          event.preventDefault();
          if (!sending) submit();
        }}
      >
        {body}
        {problem && (
          <p id="step-problem" role="alert" className="problem">
            {problem}
          </p>
        )}
        <p className="actions">
          {action && (
            <button type="submit" className="primary" disabled={sending}>
              {action}
            </button>
          )}
          {step.name === "create" && (
            <button type="button" className="link-button" onClick={() => go({ name: "email" })}>
              I have an account
            </button>
          )}
          {step.name === "code" && (
            <>
              <button
                type="button"
                className="link-button"
                disabled={sending}
                onClick={sendNewCode}
              >
                Send a new code
              </button>
              <button type="button" className="link-button" onClick={() => go({ name: "no-code" })}>
                Didn't get a code?
              </button>
            </>
          )}
          {step.name === "no-code" && (
            <>
              <button type="button" className="primary" onClick={() => go({ name: "password" })}>
                Sign in
              </button>
              <button type="button" className="link-button" onClick={() => go({ name: "forgot" })}>
                Reset password
              </button>
              <button
                type="button"
                className="link-button"
                disabled={sending}
                onClick={sendNewCode}
              >
                Send a new code
              </button>
            </>
          )}
          {step.name === "welcome" && (
            <>
              <button type="button" className="primary" disabled={sending} onClick={offerPasskey}>
                Add a passkey
              </button>
              <button type="button" className="link-button" onClick={finish}>
                Not now
              </button>
            </>
          )}
          {step.name === "password" && passkeysSupported() && (
            <button type="button" disabled={sending} onClick={usePasskey}>
              Use a passkey
            </button>
          )}
          {step.name === "password" && (
            <button type="button" className="link-button" onClick={() => go({ name: "forgot" })}>
              Forgot your password?
            </button>
          )}
          {(step.name === "forgot" || step.name === "reset") && (
            <button type="button" onClick={() => go({ name: "password" })}>
              Back to sign in
            </button>
          )}
          {step.name === "reset" && (
            <button type="button" className="link-button" onClick={() => go({ name: "forgot" })}>
              Send a new code
            </button>
          )}
        </p>
        {step.name === "create" && (
          <p className="hint">
            By creating an account you agree to how the archive handles your details:{" "}
            <Link to="/privacy">Privacy</Link>.
          </p>
        )}
        {step.name === "email" && (
          <p>
            New here?{" "}
            <button type="button" className="link-button" onClick={() => go({ name: "create" })}>
              Create an account
            </button>
          </p>
        )}
        {step.name === "welcome" && (
          <p className="hint">You can add or remove passkeys any time from Account.</p>
        )}
      </form>
    </div>
  );
}
