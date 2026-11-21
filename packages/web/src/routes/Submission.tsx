import { useEffect, useState } from "react";
import { Link } from "react-router";
import {
  ApiRefused,
  editSubmission,
  getDataset,
  getSubmission,
  type Finding,
  type FindingsReport,
  type Submission as Item,
  type SubmissionEvent,
  type SubmissionRead,
} from "../api";
import { FieldEditor } from "../FieldEditor";
import { Findings, type Editor } from "../Findings";
import { History } from "../History";
import { FAILED_NEXT, FINAL_STATUSES, statusLine, type Status } from "../labels";
import { editableKind } from "../package";
import { Modal, PageHeading, useTitle } from "../page";
import { StatusBadge } from "../StatusBadge";
import { Trail } from "../Trail";
import { PackageFlow } from "./Submit";

/** How often a submission is read again while something can still change on its own. */
export const POLL_MS = 10_000;

/**
 * Whether the contributor's page should read the submission again: the pipeline is at work.
 * A draft changes only when the contributor acts, and acting reads it again.
 */
function moving(submission: Item): boolean {
  if (FINAL_STATUSES.includes(submission.status)) return false;
  if (submission.status === "draft") return false;
  if (submission.status === "needs-changes") return !submission.waiting;
  return true;
}

/** The latest curator's note asking for changes, if the submission waits on them. */
function changesNote(events: SubmissionEvent[]): string | null {
  const decided = events
    .filter((event) => event.type === "decided" && event.decision === "request-changes")
    .toSorted((a, b) => a.eventKey.localeCompare(b.eventKey))
    .at(-1);
  return decided?.note ?? null;
}

/** Whether the last check of the current round blocked it with errors. */
function blocked(read: SubmissionRead): boolean {
  const checked = read.events
    .filter((event) => event.type === "checked" && event.round === read.submission.round)
    .at(-1);
  return Boolean(checked?.blocked);
}

const day = (at: string) =>
  new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** A submission's findings report, read once per report (its link changes on every read). */
function useReport(read: SubmissionRead | null): FindingsReport | "failed" | null {
  const key = read?.submission.reportKey ?? null;
  const url = read?.reportUrl ?? null;
  const [report, setReport] = useState<{ key: string; report: FindingsReport | "failed" } | null>(
    null,
  );
  const have = report?.key === key;
  useEffect(() => {
    if (!key || !url || have) return;
    let current = true;
    fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json() as Promise<FindingsReport>;
      })
      .then(
        (found) => current && setReport({ key, report: found }),
        () => current && setReport({ key, report: "failed" }),
      );
    return () => {
      current = false;
    };
  }, [key, url, have]);
  return have ? report.report : null;
}

/**
 * A submission read now and every 10 s while the pipeline is still at work on it (`moving`),
 * stopping once nothing can change without the reader. `reload` reads it again at once.
 * `keepReading` should be a module-level function, so it is the same on every render.
 */
export function useSubmission(
  id: string,
  keepReading: (submission: Item) => boolean,
): { read: SubmissionRead | null; failed: number | null; reload: () => void } {
  const [read, setRead] = useState<SubmissionRead | null>(null);
  const [failed, setFailed] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current = true;
    const tick = () => {
      getSubmission(id).then(
        (answer) => {
          if (!current) return;
          setRead(answer);
          setFailed(null);
          if (keepReading(answer.submission)) timer = setTimeout(tick, POLL_MS);
        },
        (error: unknown) => {
          if (!current) return;
          setFailed(error instanceof ApiRefused ? error.status : 0);
        },
      );
    };
    tick();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [id, attempt, keepReading]);
  return { read, failed, reload: () => setAttempt((n) => n + 1) };
}

/** The statuses the badge's words don't explain, kept as their one line under it. */
const EXPLAINED: readonly Status[] = ["abandoned", "expired", "failed"];

/**
 * A dataset's title, read from its published record: null while it is read, or when the
 * dataset isn't published yet (a new dataset in review has no record to read).
 */
export function useDatasetTitle(datasetId: string | null, known: string | null = null) {
  const [found, setFound] = useState<{ id: string; title: string | null } | null>(null);
  useEffect(() => {
    if (!datasetId || known) return;
    let current = true;
    getDataset(datasetId).then(
      (dataset) => current && setFound({ id: datasetId, title: dataset.title || null }),
      () => current && setFound({ id: datasetId, title: null }),
    );
    return () => {
      current = false;
    };
  }, [datasetId, known]);
  if (known) return known;
  return found && found.id === datasetId ? found.title : null;
}

/** What the manifest holds now for a text finding: the repeated name, or nothing yet. */
function heldValue(finding: Finding): string {
  if (finding.ruleId !== "field.description-repeats-name") return "";
  const value = finding.evidence?.values?.[0];
  return typeof value === "string" ? value : "";
}

/**
 * Edits to a submission's held field descriptions and units, from a curator or its submitter
 * while it is in review. `editor` (only when `allowed`) puts a box beside each text finding;
 * a save reads the submission again, and `fresh` is the report the edit answered with until
 * the read catches up. A 409 means the submission moved on: it is read again and the box says so.
 */
export function useFieldEdits(
  id: string,
  read: SubmissionRead | null,
  reload: () => void,
  allowed: boolean,
): { fresh: FindingsReport | null; editor: Editor | undefined } {
  // The report an edit answered with, for the report key it replaced.
  const [fresh, setFresh] = useState<{ key: string; report: FindingsReport } | null>(null);
  const key = read?.submission.reportKey ?? "";

  async function save(finding: Finding, value: string) {
    const kind = editableKind(finding)!;
    const { resource, field } = finding.target as { resource: string; field: string };
    try {
      const answer = await editSubmission(id, [{ resource, field, [kind]: value }]);
      setFresh({ key, report: answer.report });
      reload();
    } catch (error) {
      if (error instanceof ApiRefused && error.status === 409) {
        reload();
        throw new Error(
          `The submission moved on (${error.reason ?? "not in review"}), so it wasn't changed; the page has read it again.`,
          { cause: error },
        );
      }
      throw new Error(
        error instanceof ApiRefused
          ? `The archive didn't take it: ${error.reason ?? error.message}.`
          : "The archive can't be reached right now.",
        { cause: error },
      );
    }
  }

  const editor: Editor | undefined = allowed
    ? (finding) =>
        editableKind(finding) ? (
          <FieldEditor
            key={`${finding.ruleId}/${finding.target?.resource}/${finding.target?.field}`}
            finding={finding}
            current={heldValue(finding)}
            onSave={(value) => save(finding, value)}
          />
        ) : null
    : undefined;
  return { fresh: fresh?.key === key ? fresh.report : null, editor };
}

/**
 * The checks section: the report once read, or why it isn't shown. `fresh` is a report newer
 * than the one at the link (an edit replaced it under the same key); `editor` puts a
 * box beside each finding that can be fixed here.
 */
export function Checks({
  read,
  fresh,
  editor,
  elsewhere,
}: {
  read: SubmissionRead;
  fresh?: FindingsReport | null;
  editor?: Editor;
  elsewhere?: string;
}) {
  const fetched = useReport(read);
  const report = fresh ?? fetched;
  return (
    <section className="block" aria-labelledby="checks-heading">
      <h2 id="checks-heading">Checks</h2>
      {!read.submission.reportKey ? (
        <p className="muted">The files haven't been checked yet.</p>
      ) : report === "failed" ? (
        <p role="alert">The findings report can't be read right now.</p>
      ) : report ? (
        <Findings report={report} editor={editor} elsewhere={elsewhere} />
      ) : (
        <p role="status" className="muted">
          Reading the findings…
        </p>
      )}
    </section>
  );
}

/** `/submissions/<id>`: where the contributor's submission stands, its checks and its history. */
export function Submission({ id }: { id: string }) {
  const { read, failed, reload } = useSubmission(id, moving);
  const [flow, setFlow] = useState(false);
  // The submitter fixes their own field descriptions and units while a curator reviews it.
  const edits = useFieldEdits(id, read, reload, read?.submission.status === "in-review");
  const datasetTitle = useDatasetTitle(read?.submission.datasetId ?? null);
  const title = datasetTitle ?? read?.submission.datasetId ?? "Submission";
  useTitle(read ? title : "Submission");

  if (!read) {
    if (failed === 403 || failed === 404) {
      return (
        <>
          <PageHeading>Submission not found</PageHeading>
          <p>
            There's no submission {id} of yours. <Link to="/submissions">See your submissions</Link>
            .
          </p>
        </>
      );
    }
    return (
      <>
        <Trail steps={[{ label: "Submissions", to: "/submissions" }, { label: "Submission" }]} />
        <PageHeading>Submission</PageHeading>
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
  const note = submission.status === "needs-changes" ? changesNote(read.events) : null;
  const draft = submission.status === "draft";
  return (
    <>
      <Trail steps={[{ label: "Submissions", to: "/submissions" }, { label: title }]} />
      <PageHeading>{title}</PageHeading>
      {datasetTitle && submission.datasetId && <p className="id-line">{submission.datasetId}</p>}
      <div className="status-row">
        <StatusBadge status={submission.status} />
        <p className="meta">
          Round {submission.round} · started {day(submission.createdAt)} ·{" "}
          {submission.newVersion ? "a new version" : "a new dataset"}
        </p>
      </div>
      {EXPLAINED.includes(submission.status) && (
        <p className="muted">{statusLine(submission.status)}</p>
      )}
      {submission.status === "failed" && (
        <div className="callout">
          <p>{FAILED_NEXT.contributor}</p>
        </div>
      )}
      {submission.status === "needs-changes" && (
        <div className="callout">
          {note ? (
            <>
              <p className="label">The curator's note</p>
              <p className="curator-note">{note}</p>
            </>
          ) : (
            blocked(read) && <p>The checks found errors to fix before a curator sees it.</p>
          )}
          <p className="actions">
            <button
              type="button"
              className="primary"
              disabled={!submission.waiting}
              onClick={() => setFlow(true)}
            >
              Resubmit
            </button>
          </p>
          {!submission.waiting && (
            <p className="hint">
              The archive is getting ready for your next round; this page checks again every 10
              seconds.
            </p>
          )}
        </div>
      )}
      {draft && (
        <div className="callout">
          <p>
            This round isn't submitted: not every file was uploaded, or the upload links ran out.
            Choose the folder again for new links.
          </p>
          <p className="actions">
            <button type="button" className="primary" onClick={() => setFlow(true)}>
              Choose the folder again
            </button>
          </p>
        </div>
      )}
      <Checks read={read} fresh={edits.fresh} editor={edits.editor} />
      <section className="block" aria-labelledby="history-heading">
        <h2 id="history-heading">History</h2>
        <History events={read.events} />
      </section>
      {flow && (
        <Modal label="flow-heading" wide onClose={() => setFlow(false)}>
          <h2 id="flow-heading">
            {draft ? "Choose the folder again" : `Round ${submission.round + 1}`}
          </h2>
          <PackageFlow
            mode={{ kind: "round", submission }}
            onDone={() => {
              setFlow(false);
              reload();
            }}
          />
          <p className="actions">
            <button type="button" onClick={() => setFlow(false)}>
              Close
            </button>
          </p>
        </Modal>
      )}
    </>
  );
}
