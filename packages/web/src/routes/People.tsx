import { useEffect, useState, useSyncExternalStore } from "react";
import {
  accountEvents,
  ApiRefused,
  changeAccount,
  invitePerson,
  listAccounts,
  setRoles,
  type Account,
  type AccountEvent,
  type Role,
} from "../api";
import { selfSignUp, signedInSub, subscribe } from "../auth";
import { Modal, PageHeading, useTitle } from "../page";
import { usePeople } from "../People";
import { SettingsTabs } from "./Settings";

/** The roles in the order the dialogs list them, with what each lets a person do. */
const ROLES: { role: Role; label: string; does: string }[] = [
  { role: "contributor", label: "Contributor", does: "submits packages" },
  { role: "curator", label: "Curator", does: "reviews submissions" },
  { role: "admin", label: "Admin", does: "settings, people and access" },
];

const inOrder = (roles: Role[]) => ROLES.map((r) => r.role).filter((role) => roles.includes(role));

/** The changes the People tab tells of; the others belong to datasets and access requests. */
const PEOPLE_ACTIONS = new Set<AccountEvent["action"]>([
  "invited",
  "roles-set",
  "invite-resent",
  "disabled",
  "enabled",
]);
/** Enough changes to find when most accounts were disabled, and by whom. */
const EVENTS_READ = 200;
const EVENTS_SHOWN = 10;

const day = (at: string) =>
  new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

const when = (at: string) =>
  new Date(at).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

/** The API's refusal as a sentence: capitalised, with a full stop. */
function problemOf(error: unknown): string {
  if (error instanceof ApiRefused && error.reason) {
    const text = error.reason.charAt(0).toUpperCase() + error.reason.slice(1);
    return /[.!?]$/.test(text) ? text : `${text}.`;
  }
  return "The archive can't be reached right now. Try again.";
}

const list = (words: string[]) =>
  words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}` : (words[0] ?? "");

const roleWords = (roles: string[]) => `${list(roles)} role${roles.length > 1 ? "s" : ""}`;

/** What one change did, in words, after the name of the admin who made it. */
function sentence(event: AccountEvent, whom: string): string {
  const details = event.details as { roles?: string[]; before?: string[]; after?: string[] };
  switch (event.action) {
    case "invited": {
      const roles = details.roles ?? [];
      return `invited ${whom}${roles.length ? ` as ${list(roles)}` : " with no role"}`;
    }
    case "roles-set": {
      const before = details.before ?? [];
      const after = details.after ?? [];
      const added = after.filter((role) => !before.includes(role));
      const removed = before.filter((role) => !after.includes(role));
      const parts = [
        ...(added.length ? [`gave ${whom} the ${roleWords(added)}`] : []),
        ...(removed.length ? [`removed ${whom}'s ${roleWords(removed)}`] : []),
      ];
      return parts.join(" and ") || `changed ${whom}'s roles`;
    }
    case "invite-resent":
      return `sent the invite to ${whom} again`;
    case "disabled":
      return `disabled ${whom}`;
    case "enabled":
      return `re-enabled ${whom}`;
    default:
      return `changed ${whom}`;
  }
}

/** An account's status in words, as a badge, with who disabled it beside. */
function Status({
  account,
  disabledBy,
}: {
  account: Account;
  disabledBy?: [AccountEvent, string];
}) {
  switch (account.status) {
    case "invited":
      return <span className="badge wait">Invited, hasn't signed in</span>;
    case "signed-up":
      return <span className="badge neutral">Signed up {day(account.created)}</span>;
    case "active":
      return <span className="badge ok">Active</span>;
    case "disabled":
      return disabledBy ? (
        <>
          <span className="badge no">Disabled {day(disabledBy[0].at)}</span>{" "}
          <span className="muted">by {disabledBy[1]}</span>
        </>
      ) : (
        <span className="badge no">Disabled</span>
      );
  }
}

type Change = "resend" | "disable" | "enable";
type Open =
  { kind: "invite" } | { kind: "roles"; account: Account } | { kind: Change; account: Account };

/** The confirming words of each change, and the button that makes it. */
const CHANGES: Record<
  Change,
  { heading: (email: string) => string; text: string; button: string }
> = {
  resend: {
    heading: (email) => `Resend the invite to ${email}?`,
    text: "They'll get a new email with a new temporary password. The old one stops working.",
    button: "Resend invite",
  },
  disable: {
    heading: (email) => `Disable ${email}?`,
    text: "They'll be signed out everywhere and can't sign in or download limited or restricted data. Their approvals are kept and come back if you re-enable them.",
    button: "Disable",
  },
  enable: {
    heading: (email) => `Re-enable ${email}?`,
    text: "They can sign in again, and their roles and approvals work again.",
    button: "Re-enable",
  },
};

/** A dialog's send: its problem, if the call was refused, shown inside it. */
function useSend(onDone: (account: Account) => void) {
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  function send(call: () => Promise<Account>) {
    setSending(true);
    setProblem(null);
    call().then(onDone, (error: unknown) => {
      setSending(false);
      setProblem(problemOf(error));
    });
  }
  return { sending, problem, send };
}

function Problem({ text }: { text: string | null }) {
  return text ? (
    <p role="alert" className="problem">
      {text}
    </p>
  ) : null;
}

function RoleBoxes({
  roles,
  setRoles: set,
  locked = false,
  describe = false,
}: {
  roles: Role[];
  setRoles: (roles: Role[]) => void;
  locked?: boolean;
  describe?: boolean;
}) {
  return (
    <fieldset className="choices">
      <legend className={describe ? undefined : "visually-hidden"}>Roles</legend>
      {ROLES.map(({ role, label, does }) => {
        const fixed = locked && role === "admin";
        return (
          <label key={role} className="facet">
            <input
              type="checkbox"
              checked={roles.includes(role)}
              disabled={fixed}
              onChange={(event) =>
                set(event.target.checked ? [...roles, role] : roles.filter((r) => r !== role))
              }
            />
            {label}
            {describe && <span className="muted">{does}</span>}
            {fixed && <span className="muted">another admin has to remove this</span>}
          </label>
        );
      })}
    </fieldset>
  );
}

function InviteModal({ onClose, onDone }: { onClose: () => void; onDone: (a: Account) => void }) {
  const [email, setEmail] = useState("");
  const [roles, setRolesTo] = useState<Role[]>(["contributor"]);
  const { sending, problem, send } = useSend(onDone);
  return (
    <Modal label="invite-heading" onClose={onClose}>
      <h2 id="invite-heading">Invite someone</h2>
      <form
        className="password-form"
        onSubmit={(event) => {
          event.preventDefault();
          send(() => invitePerson(email.trim(), inOrder(roles)));
        }}
      >
        <label className="field">
          Email
          <input
            type="email"
            required
            autoFocus
            autoComplete="off"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <RoleBoxes roles={roles} setRoles={setRolesTo} describe />
        <p className="hint">They'll get an email with a temporary password.</p>
        <Problem text={problem} />
        <p className="actions">
          <button type="submit" className="primary" disabled={sending}>
            Send invite
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </p>
      </form>
    </Modal>
  );
}

function RolesModal({
  account,
  self,
  onClose,
  onDone,
}: {
  account: Account;
  self: boolean;
  onClose: () => void;
  onDone: (a: Account) => void;
}) {
  const [roles, setRolesTo] = useState<Role[]>(account.roles);
  const { sending, problem, send } = useSend(onDone);
  const addsAdmin = roles.includes("admin") && !account.roles.includes("admin");
  return (
    <Modal label="roles-heading" onClose={onClose}>
      <h2 id="roles-heading">{self ? "Your roles" : `Roles for ${account.email}`}</h2>
      <form
        className="password-form"
        onSubmit={(event) => {
          event.preventDefault();
          send(() => setRoles(account.sub, inOrder(roles)));
        }}
      >
        <RoleBoxes roles={roles} setRoles={setRolesTo} locked={self} />
        {addsAdmin && (
          <p className="note">
            Adding admin lets {account.email} change settings, manage people and approve access.
          </p>
        )}
        <Problem text={problem} />
        <p className="actions">
          <button type="submit" className="primary" disabled={sending}>
            Save roles
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </p>
      </form>
    </Modal>
  );
}

function ChangeModal({
  change,
  account,
  onClose,
  onDone,
}: {
  change: Change;
  account: Account;
  onClose: () => void;
  onDone: (a: Account) => void;
}) {
  const words = CHANGES[change];
  const { sending, problem, send } = useSend(onDone);
  return (
    <Modal label="change-heading" onClose={onClose}>
      <h2 id="change-heading">{words.heading(account.email)}</h2>
      <p>{words.text}</p>
      <Problem text={problem} />
      <p className="actions">
        <button
          type="button"
          className={change === "disable" ? "primary danger" : "primary"}
          disabled={sending}
          onClick={() => send(() => changeAccount(account.sub, change))}
        >
          {words.button}
        </button>
        <button type="button" autoFocus onClick={onClose}>
          Cancel
        </button>
      </p>
    </Modal>
  );
}

function RecentChanges({
  events,
  name,
}: {
  events: AccountEvent[] | null;
  name: (sub: string) => string;
}) {
  const shown = (events ?? [])
    .filter((event) => PEOPLE_ACTIONS.has(event.action))
    .slice(0, EVENTS_SHOWN);
  return (
    <section className="block" aria-labelledby="recent-heading">
      <h2 id="recent-heading">Recent changes</h2>
      {events === null ? (
        <p className="muted">The recent changes can't be shown right now.</p>
      ) : shown.length === 0 ? (
        <p className="muted">No changes yet.</p>
      ) : (
        <ul className="history" aria-label="Recent changes">
          {shown.map((event) => {
            const whom =
              typeof event.details.email === "string" ? event.details.email : name(event.userId);
            return (
              <li key={`${event.at}-${event.userId}-${event.action}`}>
                <time dateTime={event.at}>{when(event.at)}</time>
                <span>
                  {name(event.actor)} {sentence(event, whom)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** `/settings/people`: every account, with invite, roles, resend, disable and re-enable. */
export function People() {
  useTitle("People");
  const me = useSyncExternalStore(subscribe, signedInSub);
  const [accounts, setAccounts] = useState<Account[] | "failed" | null>(null);
  // Whether people can create their own account on this stage, read with the list.
  const [signUp, setSignUp] = useState(true);
  const [events, setEvents] = useState<AccountEvent[] | null>([]);
  const [attempt, setAttempt] = useState(0);
  const [eventsRead, setEventsRead] = useState(0);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Open | null>(null);
  const [said, setSaid] = useState("");

  useEffect(() => {
    let current = true;
    Promise.all([listAccounts(), selfSignUp()]).then(
      ([people, open]) => {
        if (!current) return;
        setSignUp(open);
        setAccounts(people);
      },
      () => current && setAccounts("failed"),
    );
    return () => {
      current = false;
    };
  }, [attempt]);

  useEffect(() => {
    let current = true;
    accountEvents(EVENTS_READ).then(
      (read) => current && setEvents(read),
      () => current && setEvents(null),
    );
    return () => {
      current = false;
    };
  }, [eventsRead]);

  const known = new Map(Array.isArray(accounts) ? accounts.map((a) => [a.sub, a.email]) : []);
  const unknown = (events ?? []).map((event) => event.actor).filter((sub) => !known.has(sub));
  const lookedUp = usePeople(Array.isArray(accounts) ? unknown : []);
  const name = (sub: string) => known.get(sub) ?? lookedUp(sub);

  /** The newest disable of each account, with the admin who made it. */
  const disabledBy = new Map<string, [AccountEvent, string]>();
  for (const event of events ?? []) {
    if (event.action === "disabled" && !disabledBy.has(event.userId)) {
      disabledBy.set(event.userId, [event, name(event.actor)]);
    }
  }

  function done(account: Account, words?: string) {
    setAccounts((before) =>
      Array.isArray(before)
        ? before.some((a) => a.sub === account.sub)
          ? before.map((a) => (a.sub === account.sub ? account : a))
          : [...before, account]
        : before,
    );
    setOpen(null);
    setSaid(words ?? "");
    setEventsRead((n) => n + 1);
  }

  const needle = query.trim().toLowerCase();
  const shown = Array.isArray(accounts)
    ? accounts.filter((a) => a.email.toLowerCase().includes(needle))
    : [];

  return (
    <>
      <PageHeading>Settings</PageHeading>
      <SettingsTabs current="/settings/people" />
      {accounts === "failed" ? (
        <div className="callout failed">
          <p role="alert" className="lead">
            Couldn't load the people list.
          </p>
          <p className="actions">
            <button type="button" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </p>
        </div>
      ) : accounts === null ? (
        <p role="status" className="loading">
          Loading people…
        </p>
      ) : (
        <>
          <div className="queue-bar">
            <input
              type="search"
              placeholder="Find by email"
              aria-label="Find by email"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <button type="button" className="primary" onClick={() => setOpen({ kind: "invite" })}>
              Invite someone
            </button>
            <p role="status" className="queue-live">
              {said}
            </p>
          </div>
          {shown.length === 0 ? (
            <div className="empty">
              <p className="lead">No one's email matches “{query.trim()}”.</p>
            </div>
          ) : (
            <table className="cols listing to-cards people">
              <thead>
                <tr>
                  <th scope="col">Email</th>
                  <th scope="col">Roles</th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((account) => {
                  const self = account.sub === me;
                  const disabled = account.status === "disabled";
                  return (
                    <tr key={account.sub}>
                      <td className="title-cell">
                        {account.email}
                        {self && <span className="muted"> (you)</span>}
                      </td>
                      <td data-label="Roles">
                        {account.roles.length ? (
                          // One element, so a phone card's two-column grid keeps the tags together.
                          <span className="tags">
                            {inOrder(account.roles).map((role) => (
                              <span key={role} className="tag">
                                {role}
                              </span>
                            ))}
                          </span>
                        ) : (
                          <span className="muted">No role</span>
                        )}
                      </td>
                      <td data-label="Status">
                        <Status account={account} disabledBy={disabledBy.get(account.sub)} />
                      </td>
                      <td className="row-actions">
                        {!disabled && (
                          <button type="button" onClick={() => setOpen({ kind: "roles", account })}>
                            Change roles
                          </button>
                        )}
                        {account.status === "invited" && (
                          <button
                            type="button"
                            onClick={() => setOpen({ kind: "resend", account })}
                          >
                            Resend invite
                          </button>
                        )}
                        {!disabled && !self && (
                          <button
                            type="button"
                            className="danger"
                            onClick={() => setOpen({ kind: "disable", account })}
                          >
                            Disable
                          </button>
                        )}
                        {disabled && !self && (
                          <button
                            type="button"
                            onClick={() => setOpen({ kind: "enable", account })}
                          >
                            Re-enable
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <p className="hint">
            {signUp
              ? "Anyone can create an account; it has no role until you give one."
              : "Only people you invite get an account; one has no role until you give it one."}{" "}
            Disabling signs the person out everywhere and stops their downloads. You can't remove
            your own admin role or disable yourself.
          </p>
          <RecentChanges events={events} name={name} />
        </>
      )}
      {open?.kind === "invite" && (
        <InviteModal onClose={() => setOpen(null)} onDone={(account) => done(account)} />
      )}
      {open?.kind === "roles" && (
        <RolesModal
          account={open.account}
          self={open.account.sub === me}
          onClose={() => setOpen(null)}
          onDone={(account) => done(account)}
        />
      )}
      {(open?.kind === "resend" || open?.kind === "disable" || open?.kind === "enable") && (
        <ChangeModal
          change={open.kind}
          account={open.account}
          onClose={() => setOpen(null)}
          onDone={(account) =>
            done(
              account,
              open.kind === "resend" ? `Invite sent again to ${account.email}.` : undefined,
            )
          }
        />
      )}
    </>
  );
}
