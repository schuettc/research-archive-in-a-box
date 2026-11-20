import { useEffect, useState } from "react";
import { Link } from "react-router";
import { getSubmission, listSubmissions, type Submission } from "../api";
import { PageHeading, useTitle } from "../page";
import { PACKAGES_GUIDE } from "../site";
import { StatusBadge } from "../StatusBadge";
import { useDatasetTitle } from "./Submission";

const day = (at: string) =>
  new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** The time of a submission's latest event, read from its own page's answer. */
function LastChange({ submission }: { submission: Submission }) {
  const [at, setAt] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    getSubmission(submission.submissionId).then(
      (read) => {
        const last = read.events
          .map((event) => event.at)
          .toSorted()
          .at(-1);
        if (current) setAt(last ?? submission.createdAt);
      },
      () => current && setAt(submission.createdAt),
    );
    return () => {
      current = false;
    };
  }, [submission.submissionId, submission.createdAt]);
  return at ? <time dateTime={at}>{day(at)}</time> : <span className="muted">…</span>;
}

/** A row's dataset: its title where the archive has one, the id under it. */
function DatasetCell({ submission }: { submission: Submission }) {
  const title = useDatasetTitle(submission.datasetId);
  return (
    <td className="title-cell" data-label="Dataset">
      <Link to={`/submissions/${encodeURIComponent(submission.submissionId)}`}>
        {title ?? submission.datasetId ?? submission.submissionId}
      </Link>
      {title && <span className="sub">{submission.datasetId}</span>}
    </td>
  );
}

/** `/submissions`: the contributor's own submissions, newest first, with where each stands. */
export function MySubmissions() {
  useTitle("Submissions");
  const [list, setList] = useState<Submission[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    listSubmissions({ mine: true }).then(
      (answer) => {
        if (!current) return;
        setList(answer.submissions.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)));
        setFailed(false);
      },
      () => current && setFailed(true),
    );
    return () => {
      current = false;
    };
  }, [attempt]);

  const empty = list !== null && list.length === 0;
  return (
    <>
      <div className="page-head">
        <div>
          <PageHeading>Submissions</PageHeading>
          {!empty && <p className="muted">Everything you have submitted, newest first.</p>}
        </div>
        {!empty && (
          <Link className="button primary" to="/submit">
            Submit a package
          </Link>
        )}
      </div>
      {failed ? (
        <div className="callout failed">
          <p role="alert" className="lead">
            Your submissions can't be loaded right now.
          </p>
          <p className="actions">
            <button type="button" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </p>
        </div>
      ) : list === null ? (
        <p role="status" className="loading">
          Loading your submissions…
        </p>
      ) : empty ? (
        <div className="empty">
          <p className="lead">You haven't submitted a package yet.</p>
          <p className="muted">
            Make a package with cruise, then send it here. A curator reviews it before it's
            published.{" "}
            <a href={PACKAGES_GUIDE} target="_blank" rel="noreferrer">
              How to make a package <span className="visually-hidden">(opens in a new tab)</span>
            </a>
          </p>
          <p className="actions">
            <Link className="button primary" to="/submit">
              Submit a package
            </Link>
          </p>
        </div>
      ) : (
        <table className="cols listing to-cards">
          <thead>
            <tr>
              <th scope="col">Dataset</th>
              <th scope="col">Status</th>
              <th scope="col">Kind</th>
              <th scope="col">Started</th>
              <th scope="col">Last change</th>
            </tr>
          </thead>
          <tbody>
            {list.map((submission) => (
              <tr key={submission.submissionId}>
                <DatasetCell submission={submission} />
                <td data-label="Status">
                  <StatusBadge status={submission.status} />
                </td>
                <td data-label="Kind">{submission.newVersion ? "New version" : "New dataset"}</td>
                <td data-label="Started">
                  <time dateTime={submission.createdAt}>{day(submission.createdAt)}</time>
                </td>
                <td data-label="Last change">
                  <LastChange submission={submission} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
