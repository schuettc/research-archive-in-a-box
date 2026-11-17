import { useEffect, useState } from "react";
import { Link } from "react-router";
import {
  ApiRefused,
  decideAccess,
  listAccessRequests,
  takeBackAccess,
  type AccessRequest,
} from "../api";
import { Modal, PageHeading, useTitle } from "../page";
import { usePeople } from "../People";
import { SettingsTabs } from "./Settings";

type Open = { kind: "approve" | "decline" | "take-back"; request: AccessRequest } | null;

/** The approvals the list shows: current, ended and taken back. */
const APPROVALS = new Set<AccessRequest["state"]>(["approved", "ended", "taken-back"]);

const day = (at: string) =>
  new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** An approval's end, a `YYYY-MM-DD` day in UTC, with its year. */
const endDay = (until: string) =>
  new Date(`${until}T12:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

/** Today as the date box's `YYYY-MM-DD`, the earliest end an approval can have. */
function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The API's refusal as a sentence: capitalised, with a full stop. */
function problemOf(error: unknown): string {
  if (error instanceof ApiRefused && error.reason) {
    const text = error.reason.charAt(0).toUpperCase() + error.reason.slice(1);
    return /[.!?]$/.test(text) ? text : `${text}.`;
  }
  return "The archive can't be reached right now. Try again.";
}

const same = (a: AccessRequest, b: AccessRequest) =>
  a.datasetId === b.datasetId && a.userId === b.userId;

const optional = (text: string) => text.trim() || null;

/**
 * A dialog's send. A 409 means another admin acted first: the page reads the list again and
 * says so (`onConflict`); any other refusal shows in the dialog.
 */
function useSend(onDone: (request: AccessRequest) => void, onConflict: (words: string) => void) {
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  function send(call: () => Promise<AccessRequest>) {
    setSending(true);
    setProblem(null);
    call().then(onDone, (error: unknown) => {
      setSending(false);
      if (error instanceof ApiRefused && error.status === 409) onConflict(problemOf(error));
      else setProblem(problemOf(error));
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

interface DialogProps {
  request: AccessRequest;
  onClose: () => void;
  onDone: (request: AccessRequest) => void;
  onConflict: (words: string) => void;
}

function ApproveModal({ request, onClose, onDone, onConflict }: DialogProps) {
  const [until, setUntil] = useState("");
  const [note, setNote] = useState("");
  const { sending, problem, send } = useSend(onDone, onConflict);
  return (
    <Modal label="approve-heading" onClose={onClose}>
      <h2 id="approve-heading">Approve {request.email}?</h2>
      <form
        className="password-form"
        onSubmit={(event) => {
          event.preventDefault();
          send(() => decideAccess(request, "approve", optional(note), until || null));
        }}
      >
        <p>
          For <strong>{request.datasetTitle}</strong>, every version.
        </p>
        <label className="field">
          <span>
            Until <span className="muted">(optional; blank means until you take it back)</span>
          </span>
          <input
            type="date"
            min={today()}
            value={until}
            onChange={(event) => setUntil(event.target.value)}
          />
        </label>
        <label className="field">
          <span>
            Note to {request.email}{" "}
            <span className="muted">(optional; they see it on the dataset page)</span>
          </span>
          <textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
        </label>
        <Problem text={problem} />
        <p className="actions">
          <button type="submit" className="primary" disabled={sending}>
            Approve
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </p>
      </form>
    </Modal>
  );
}

function DeclineModal({ request, onClose, onDone, onConflict }: DialogProps) {
  const [note, setNote] = useState("");
  const { sending, problem, send } = useSend(onDone, onConflict);
  return (
    <Modal label="decline-heading" onClose={onClose}>
      <h2 id="decline-heading">Decline {request.email}?</h2>
      <form
        className="password-form"
        onSubmit={(event) => {
          event.preventDefault();
          send(() => decideAccess(request, "decline", optional(note)));
        }}
      >
        <p>
          For <strong>{request.datasetTitle}</strong>. They can ask again.
        </p>
        <label className="field">
          <span>
            Why <span className="muted">(optional; they see it on the dataset page)</span>
          </span>
          <textarea
            rows={2}
            autoFocus
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        <Problem text={problem} />
        <p className="actions">
          <button type="submit" className="primary danger" disabled={sending}>
            Decline
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </p>
      </form>
    </Modal>
  );
}

function TakeBackModal({ request, onClose, onDone, onConflict }: DialogProps) {
  const { sending, problem, send } = useSend(onDone, onConflict);
  return (
    <Modal label="take-back-heading" onClose={onClose}>
      <h2 id="take-back-heading">
        Take back {request.email}'s access to {request.datasetTitle}?
      </h2>
      <p>
        They can't download it from now on. The dataset page tells them it was taken back, and they
        can ask again.
      </p>
      <Problem text={problem} />
      <p className="actions">
        <button
          type="button"
          className="primary danger"
          disabled={sending}
          onClick={() => send(() => takeBackAccess(request))}
        >
          Take back
        </button>
        <button type="button" autoFocus onClick={onClose}>
          Cancel
        </button>
      </p>
    </Modal>
  );
}

/** An approval's end, or who took it back and when. */
function Until({ request, name }: { request: AccessRequest; name: (sub: string) => string }) {
  switch (request.state) {
    case "ended":
      return <span className="badge no">Ended {request.until ? endDay(request.until) : ""}</span>;
    case "taken-back":
      return (
        <span className="badge no">
          Taken back
          {request.takenBackAt ? ` ${day(request.takenBackAt)}` : ""}
          {request.takenBackBy ? ` by ${name(request.takenBackBy)}` : ""}
        </span>
      );
    default:
      return <>{request.until ? endDay(request.until) : "Until taken back"}</>;
  }
}

/** `/settings/access`: the waiting requests, each to approve or decline, and the approvals. */
export function AccessRequests() {
  useTitle("Access requests");
  const [requests, setRequests] = useState<AccessRequest[] | "failed" | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState<Open>(null);
  const [said, setSaid] = useState("");
  const [conflict, setConflict] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    listAccessRequests().then(
      (read) => current && setRequests(read),
      () => current && setRequests("failed"),
    );
    return () => {
      current = false;
    };
  }, [attempt]);

  const loaded = Array.isArray(requests) ? requests : [];
  const waiting = loaded.filter((request) => request.state === "waiting");
  const approvals = loaded.filter((request) => APPROVALS.has(request.state));
  const name = usePeople(
    approvals.flatMap((request) => (request.takenBackBy ? [request.takenBackBy] : [])),
  );

  function done(answer: AccessRequest, words: string) {
    setRequests((before) =>
      Array.isArray(before) ? before.map((r) => (same(r, answer) ? answer : r)) : before,
    );
    setOpen(null);
    setConflict(null);
    setSaid(words);
  }

  /** Another admin acted first: read the list again and say so. */
  function refresh(words: string) {
    setOpen(null);
    setSaid("");
    setConflict(`${words} The list now shows the latest.`);
    setAttempt((n) => n + 1);
  }

  const dialog = open && {
    request: open.request,
    onClose: () => setOpen(null),
    onConflict: refresh,
  };

  return (
    <>
      <PageHeading>Settings</PageHeading>
      <SettingsTabs
        current="/settings/access"
        waiting={Array.isArray(requests) ? waiting.length : null}
      />
      {requests === "failed" ? (
        <div className="callout failed">
          <p role="alert" className="lead">
            Couldn't load the access requests.
          </p>
          <p className="actions">
            <button type="button" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </p>
        </div>
      ) : requests === null ? (
        <p role="status" className="loading">
          Loading access requests…
        </p>
      ) : (
        <>
          <Problem text={conflict} />
          <p role="status" className="visually-hidden">
            {said}
          </p>
          <section className="block" aria-labelledby="waiting-heading">
            <h2 id="waiting-heading">Waiting</h2>
            {waiting.length === 0 ? (
              <p className="muted">No requests waiting.</p>
            ) : (
              <ul className="requests">
                {waiting.map((request) => (
                  <li key={`${request.datasetId} ${request.userId}`} className="request">
                    <div className="request-body">
                      <p>
                        <strong>{request.email}</strong> asks for{" "}
                        <Link to={`/datasets/${encodeURIComponent(request.datasetId)}`}>
                          {request.datasetTitle}
                        </Link>
                      </p>
                      {request.reason && <p className="reason">{request.reason}</p>}
                      {request.requestedAt && (
                        <p className="muted small">Asked {day(request.requestedAt)}</p>
                      )}
                    </div>
                    <p className="actions">
                      <button
                        type="button"
                        className="primary"
                        onClick={() => setOpen({ kind: "approve", request })}
                      >
                        Approve…
                      </button>
                      <button
                        type="button"
                        className="danger"
                        onClick={() => setOpen({ kind: "decline", request })}
                      >
                        Decline…
                      </button>
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="block" aria-labelledby="approvals-heading">
            <h2 id="approvals-heading">Approvals</h2>
            {approvals.length === 0 ? (
              <p className="muted">No one has been approved yet.</p>
            ) : (
              <table className="cols listing to-cards people">
                <thead>
                  <tr>
                    <th scope="col">Person</th>
                    <th scope="col">Dataset</th>
                    <th scope="col">Until</th>
                    <th scope="col">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {approvals.map((request) => (
                    <tr key={`${request.datasetId} ${request.userId}`}>
                      <td className="title-cell">{request.email}</td>
                      <td data-label="Dataset">{request.datasetTitle}</td>
                      <td data-label="Until">
                        <Until request={request} name={name} />
                      </td>
                      <td className="row-actions">
                        {request.state === "approved" && (
                          <button
                            type="button"
                            className="danger"
                            onClick={() => setOpen({ kind: "take-back", request })}
                          >
                            Take back
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
      {open?.kind === "approve" && dialog && (
        <ApproveModal
          {...dialog}
          onDone={(answer) => done(answer, `Approved ${answer.email} for ${answer.datasetTitle}.`)}
        />
      )}
      {open?.kind === "decline" && dialog && (
        <DeclineModal
          {...dialog}
          onDone={(answer) =>
            done(answer, `Declined ${answer.email}'s request for ${answer.datasetTitle}.`)
          }
        />
      )}
      {open?.kind === "take-back" && dialog && (
        <TakeBackModal
          {...dialog}
          onDone={(answer) =>
            done(answer, `Took back ${answer.email}'s access to ${answer.datasetTitle}.`)
          }
        />
      )}
    </>
  );
}
