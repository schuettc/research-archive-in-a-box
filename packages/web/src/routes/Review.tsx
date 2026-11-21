import { useEffect, useState } from "react";
import { Link } from "react-router";
import {
  ApiRefused,
  decide,
  heldFiles,
  type Decision,
  type HeldFile,
  type Submission,
  type SubmissionEvent,
} from "../api";
import { signedInSub } from "../auth";
import { History } from "../History";
import { FAILED_NEXT, FINAL_STATUSES, formatSize, statusLine, type Status } from "../labels";
import { Modal, PageHeading, useTitle } from "../page";
import { usePeople } from "../People";
import { Preview } from "../Preview";
import { StatusBadge } from "../StatusBadge";
import { Trail } from "../Trail";
import { Checks, useDatasetTitle, useFieldEdits, useSubmission } from "./Submission";
import { enteredReview, heldManifest, isHeld, type HeldManifest } from "./ReviewQueue";

/**
 * Whether the curator's page should read the submission again: the pipeline is at work, or a
 * submission in review isn't ready for a decision yet (after a first approval, until the
 * pipeline waits for the second).
 */
function moving(submission: Submission): boolean {
  if (FINAL_STATUSES.includes(submission.status)) return false;
  if (submission.status === "in-review") return !submission.waiting;
  return submission.status === "checking" || submission.status === "publishing";
}

/** Held links last five minutes: they are asked for again a little before. */
const HELD_REFRESH_MS = 4 * 60_000;

/** The held files as the dataset page lists them: a set's parts under its main file. */
type Entry = { file: HeldFile; parts: HeldFile[] };

function entries(files: HeldFile[], manifest: HeldManifest | null): Entry[] {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const inSet = new Set<string>();
  const sets = new Map<string, HeldFile[]>();
  for (const resource of manifest?.resources ?? []) {
    const parts = (resource["archive:files"] ?? [])
      .map((part) => byPath.get(part.path))
      .filter((part): part is HeldFile => part !== undefined);
    if (parts.length < 2) continue;
    sets.set(parts[0]!.path, parts);
    for (const part of parts) inSet.add(part.path);
  }
  return files
    .filter((file) => !inSet.has(file.path) || sets.has(file.path))
    .map((file) => ({ file, parts: sets.get(file.path) ?? [] }));
}

function useHeld(id: string, status: Submission["status"] | null) {
  const [held, setHeld] = useState<{ entries: Entry[]; title: string | null } | null>(null);
  const holding = status !== null && isHeld(status);
  useEffect(() => {
    if (!holding) return;
    let current = true;
    const read = () => {
      Promise.all([heldFiles(id), heldManifest(id).catch(() => null)]).then(
        ([answer, manifest]) =>
          current &&
          setHeld({
            entries: entries(answer.files, manifest),
            title: typeof manifest?.title === "string" ? manifest.title : null,
          }),
        () => {},
      );
    };
    read();
    const timer = setInterval(read, HELD_REFRESH_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [id, holding]);
  return holding ? held : null;
}

const ACTIONS: { decision: Decision; label: string; heading: string; needsNote: boolean }[] = [
  { decision: "approve", label: "Approve", heading: "Approve this submission?", needsNote: false },
  {
    decision: "request-changes",
    label: "Request changes",
    heading: "Ask for changes?",
    needsNote: true,
  },
  { decision: "reject", label: "Reject", heading: "Reject this submission?", needsNote: true },
];

/** The reader's own decision on this round, if they made one. */
function myDecision(
  events: SubmissionEvent[],
  round: number,
  me: string | null,
): SubmissionEvent | null {
  if (!me) return null;
  return (
    events
      .filter((e) => e.type === "decided" && e.round === round && e.actor === me)
      .toSorted((a, b) => a.eventKey.localeCompare(b.eventKey))
      .at(-1) ?? null
  );
}

/**
 * What the reader's decision did, in one sentence for the summary that replaces the buttons, or
 * nothing when the submission's status isn't the outcome of that decision (another curator
 * decided after them, or publishing failed).
 */
function summary(decision: string | null | undefined, status: Status): string | null {
  if (decision === "approve") {
    if (status !== "publishing" && status !== "published") return null;
    return status === "published"
      ? "You approved it; it's published."
      : "You approved it; it's being published.";
  }
  if (decision === "request-changes" && status === "needs-changes")
    return "You asked for changes; it's back with the contributor.";
  if (decision === "reject" && status === "rejected") return "You rejected it.";
  return null;
}

/** A held file's Preview and Download. */
function FileActions({ file, onPreview }: { file: HeldFile; onPreview: (file: HeldFile) => void }) {
  return (
    <>
      {file.path.toLowerCase().endsWith(".csv") && (
        <button type="button" aria-label={`Preview ${file.path}`} onClick={() => onPreview(file)}>
          Preview
        </button>
      )}
      <a className="button download" href={file.url} aria-label={`Download ${file.path}`}>
        Download
      </a>
    </>
  );
}

/** The modal that asks for a decision's note and confirms it, or shows why it was refused. */
function DecisionModal({
  id,
  action,
  onClose,
  onDecided,
}: {
  id: string;
  action: (typeof ACTIONS)[number];
  onClose: () => void;
  onDecided: () => void;
}) {
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const missing = action.needsNote && note.trim() === "";

  function confirm() {
    setSending(true);
    decide(id, action.decision, note.trim() || undefined).then(onDecided, (error: unknown) => {
      setSending(false);
      setRefused(
        error instanceof ApiRefused
          ? (error.reason ?? error.message)
          : "The archive can't be reached right now.",
      );
    });
  }

  return (
    <Modal label="decision-heading" onClose={onClose}>
      <h2 id="decision-heading">{action.heading}</h2>
      {refused ? (
        <>
          <p role="alert" className="problem">
            The archive didn't take it: {refused}.
          </p>
          <p className="actions">
            <button type="button" className="primary" autoFocus onClick={onDecided}>
              Reload
            </button>
            <button type="button" onClick={onClose}>
              Close
            </button>
          </p>
        </>
      ) : (
        <>
          <label className="field wide">
            <span>
              Note to the contributor{" "}
              <span className="muted">{action.needsNote ? "(required)" : "(optional)"}</span>
            </span>
            <textarea
              rows={4}
              value={note}
              required={action.needsNote}
              autoFocus
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <p className="actions">
            <button
              type="button"
              className="primary"
              disabled={missing || sending}
              onClick={confirm}
            >
              {action.label}
            </button>
            <button type="button" onClick={onClose}>
              Cancel
            </button>
          </p>
        </>
      )}
    </Modal>
  );
}

/** `/review/<id>`: a curator's view of one submission, and its decision. */
export function Review({ id }: { id: string }) {
  const { read, failed, reload } = useSubmission(id, moving);
  const held = useHeld(id, read?.submission.status ?? null);
  const [asking, setAsking] = useState<(typeof ACTIONS)[number] | null>(null);
  const [preview, setPreview] = useState<HeldFile | null>(null);
  const me = signedInSub();
  const inReview = read?.submission.status === "in-review";
  const edits = useFieldEdits(
    id,
    read,
    reload,
    inReview && me !== null && read?.submission.submitter !== me,
  );
  const name = usePeople(read ? [read.submission.submitter] : []);
  const datasetTitle = useDatasetTitle(read?.submission.datasetId ?? null, held?.title ?? null);
  const title = datasetTitle ?? read?.submission.datasetId ?? "Review";
  useTitle(read ? `Review: ${title}` : "Review");
  const queue = { label: "Review queue", to: "/review" };

  if (!read) {
    if (failed === 403 || failed === 404) {
      return (
        <>
          <Trail steps={[queue, { label: "Not found" }]} />
          <PageHeading>Submission not found</PageHeading>
          <p>
            There's no submission {id}. <Link to="/review">See the review queue</Link>.
          </p>
        </>
      );
    }
    return (
      <>
        <Trail steps={[queue, { label: "Review" }]} />
        <PageHeading>Review</PageHeading>
        {failed === null ? (
          <p role="status" className="loading">
            Loading the submission…
          </p>
        ) : (
          <div className="callout failed">
            <p role="alert" className="lead">
              This submission can't be loaded right now.
            </p>
            <p className="actions">
              <button type="button" className="primary" onClick={reload}>
                Try again
              </button>
            </p>
          </div>
        )}
      </>
    );
  }

  const submission = read.submission;
  const entered = enteredReview(read.events, submission.round);
  const needed = entered?.outcome === "two" ? 2 : 1;
  const approvedByMe = me !== null && submission.approvals.includes(me);
  // Once the reader's approval is the last one needed, the page reads it as publishing at once.
  const settled = inReview && approvedByMe && submission.approvals.length >= needed;
  const shownStatus: Status = settled ? "publishing" : submission.status;
  const mine = myDecision(read.events, submission.round, me);
  const done = settled
    ? summary("approve", shownStatus)
    : inReview
      ? null
      : summary(mine?.decision, submission.status);
  const dataset = `/datasets/${encodeURIComponent(submission.datasetId ?? "")}`;
  const published = submission.newVersion || submission.status === "published";
  return (
    <>
      <Trail steps={[queue, { label: title }]} />
      <PageHeading>{title}</PageHeading>
      <p className="id-line">
        {submission.datasetId}
        {published && submission.datasetId && (
          <>
            {" · "}
            <Link to={dataset}>public page</Link>
          </>
        )}
      </p>
      <div className="status-row">
        <StatusBadge status={shownStatus} />
        {submission.stale && <span className="tag stale">Stale</span>}
        <p className="meta">
          From {name(submission.submitter)} · round {submission.round} ·{" "}
          {submission.newVersion ? "a new version" : "a new dataset"}
          {inReview && (
            <>
              {" "}
              · needs {needed === 2 ? "two curators" : "one curator"}, {submission.approvals.length}{" "}
              approved
            </>
          )}
        </p>
      </div>
      {submission.status === "failed" && (
        <>
          <p className="muted">{statusLine(submission.status)}</p>
          <div className="callout">
            <p>{FAILED_NEXT.curator}</p>
          </div>
        </>
      )}
      {done ? (
        <div className="callout done">
          <p>
            <b>{done}</b>
          </p>
        </div>
      ) : (
        inReview && (
          <div className="callout">
            {approvedByMe ? (
              <p>You approved it; it waits for a second curator.</p>
            ) : submission.approvals.length > 0 ? (
              <p>One curator approved it; a second approval publishes it.</p>
            ) : (
              <p>Read the findings and the files, then decide.</p>
            )}
            <p className="actions">
              {ACTIONS.filter((action) => !(action.decision === "approve" && approvedByMe)).map(
                (action) => (
                  <button
                    key={action.decision}
                    type="button"
                    className={action.decision === "approve" ? "primary" : undefined}
                    disabled={!submission.waiting}
                    onClick={() => setAsking(action)}
                  >
                    {action.label}
                  </button>
                ),
              )}
              {!submission.waiting && (
                <span className="muted" role="status">
                  One moment…
                </span>
              )}
            </p>
          </div>
        )
      )}
      <Checks
        read={read}
        fresh={edits.fresh}
        elsewhere="Ask the contributor to"
        editor={edits.editor}
      />
      {isHeld(submission.status) && (
        <section className="block" aria-labelledby="files-heading">
          <h2 id="files-heading">Held files</h2>
          {held === null ? (
            <p role="status" className="loading">
              Reading the held files…
            </p>
          ) : (
            <ul className="files held" aria-label="Held files">
              {held.entries.map(({ file, parts }) => (
                <li key={file.path} className="file">
                  <p className="file-head">
                    <code>{file.path}</code>
                  </p>
                  <p className="file-about">
                    {parts.length
                      ? `${parts.length} files, ${formatSize(parts.reduce((sum, part) => sum + part.size, 0))}`
                      : formatSize(file.size)}
                  </p>
                  {parts.length > 0 ? (
                    <details className="members">
                      <summary>Files in this set ({parts.length})</summary>
                      <ul>
                        {parts.map((part) => (
                          <li key={part.path}>
                            <code>{part.path}</code>{" "}
                            <span className="muted small">{formatSize(part.size)}</span>{" "}
                            <FileActions file={part} onPreview={setPreview} />
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : (
                    <p className="file-action">
                      <FileActions file={file} onPreview={setPreview} />
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <section className="block" aria-labelledby="history-heading">
        <h2 id="history-heading">History</h2>
        <History events={read.events} />
      </section>
      {asking && (
        <DecisionModal
          id={id}
          action={asking}
          onClose={() => setAsking(null)}
          onDecided={() => {
            setAsking(null);
            reload();
          }}
        />
      )}
      {preview && (
        <Modal label="preview-heading" wide onClose={() => setPreview(null)}>
          <h2 id="preview-heading">{preview.path}: the first rows</h2>
          <Preview url={preview.url} size={preview.size} />
          <p className="actions">
            <button type="button" autoFocus onClick={() => setPreview(null)}>
              Close
            </button>
          </p>
        </Modal>
      )}
    </>
  );
}
