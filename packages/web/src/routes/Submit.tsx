import { useEffect, useRef, useState, type DragEvent } from "react";
import { flushSync } from "react-dom";
import { Link, useNavigate } from "react-router";
import {
  ApiRefused,
  checkManifest,
  createSubmission,
  getDataset,
  getPackageLimit,
  renewUploads,
  submitRound,
  type Finding,
  type Submission,
  type UploadsAnswer,
} from "../api";
import { FieldEditor } from "../FieldEditor";
import { FindingGroups } from "../Findings";
import { formatSize } from "../labels";
import {
  applyEdit,
  checkPackage,
  droppedEntries,
  editableKind,
  fieldValue,
  fromEntries,
  fromFileList,
  uploadFile,
  withEdits,
  type FieldEdit,
  type Manifest,
  type PackageFile,
  type ReadyFile,
} from "../package";
import { PageHeading, useTitle } from "../page";
import { Trail } from "../Trail";

/** A new submission, or the next round (or new links) for one that exists. */
export type FlowMode = { kind: "new" } | { kind: "round"; submission: Submission };

type Ready = {
  files: ReadyFile[];
  left: string[];
  id: string;
  title: string | null;
  /** Whether the dataset is already published: a new version, a new dataset, or unknown. */
  kind: "new" | "version" | "unknown";
  /** The manifest with every edit made here, the checksums as read, and the edits. */
  raw: Manifest;
  checksums: string;
  edits: FieldEdit[];
};

/** The manifest's checks before upload: the last findings, and whether a check is running. */
type Checks = { findings: Finding[] | null; state: "checking" | "done" | "failed" };

/** The edits with `edit` added, one entry per field. */
function merged(edits: FieldEdit[], edit: FieldEdit): FieldEdit[] {
  const same = (e: FieldEdit) => e.resource === edit.resource && e.field === edit.field;
  const before = edits.find(same);
  return [...edits.filter((e) => !same(e)), { ...before, ...edit }];
}

const fields = (count: number) => `${count} field${count === 1 ? "" : "s"} edited here`;

/** What a draft holds after an upload stopped. */
const arrived = (count: number) =>
  count === 0
    ? "Your draft is saved, but none of its files arrived."
    : `Your draft is saved with the ${count} file${count === 1 ? "" : "s"} that did arrive.`;

type Phase =
  | { at: "choose"; problem: string | null }
  | { at: "checking"; done: number; total: number }
  | { at: "ready"; ready: Ready }
  | { at: "sending"; ready: Ready; error: Stopped | null };

/**
 * Why sending stopped: the words, and when a file's upload stopped after the submission was
 * made, which file, so the page can say what arrived and link to the draft.
 */
type Stopped = { text: string; path: string | null; draft: string | null };

/** A file's upload that stopped, as `uploadFile` names it: "the upload of <path> …". */
class UploadStopped extends Error {
  constructor(
    readonly path: string,
    cause: Error,
  ) {
    super(cause.message, { cause });
  }
}

/** The words for a failure while sending: the API's own, or what went wrong with an upload. */
function failure(error: unknown, draft: string | null): Stopped {
  if (error instanceof UploadStopped) {
    const what = error.message.replace(/^the upload of /, "");
    return { text: `The upload stopped: ${what}.`, path: error.path, draft };
  }
  if (error instanceof ApiRefused) {
    const text = error.reason ? `The archive refused it: ${error.reason}.` : error.message;
    return { text, path: null, draft: null };
  }
  return { text: "The archive can't be reached right now.", path: null, draft: null };
}

async function datasetKind(id: string): Promise<Ready["kind"]> {
  try {
    await getDataset(id);
    return "version";
  } catch (error) {
    return error instanceof ApiRefused && error.status === 404 ? "new" : "unknown";
  }
}

/**
 * Choose or drop a package folder, check it, then create the submission (or its next round),
 * upload every file to its link with a progress bar, and submit. `onDone` hears the
 * submission's id once it is submitted.
 */
export function PackageFlow({
  mode,
  onDone,
}: {
  mode: FlowMode;
  onDone: (submissionId: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>({ at: "choose", problem: null });
  const [sent, setSent] = useState<Record<string, number>>({});
  const [dragging, setDragging] = useState(false);
  const [checks, setChecks] = useState<Checks | null>(null);
  const [saved, setSaved] = useState<{ ok: boolean; text: string } | null>(null);
  // The submission once created, so Try again asks for new links rather than a second one.
  const created = useRef<string | null>(
    mode.kind === "round" ? mode.submission.submissionId : null,
  );
  const uploaded = useRef(new Set<string>());
  // The most a package's files may total, in bytes, once the archive has said.
  const [limit, setLimit] = useState<number | null>(null);
  useEffect(() => {
    let current = true;
    getPackageLimit().then(
      (bytes) => current && setLimit(bytes),
      () => {}, // Asked again when a folder is chosen, which says so if it fails.
    );
    return () => {
      current = false;
    };
  }, []);

  async function check(files: PackageFile[]) {
    setPhase({ at: "checking", done: 0, total: files.length });
    let maxBytes: number;
    try {
      maxBytes = limit ?? (await getPackageLimit());
    } catch {
      setPhase({ at: "choose", problem: "The archive can't be reached. Try again." });
      return;
    }
    const checked = await checkPackage(
      files,
      (done, total) => setPhase({ at: "checking", done, total }),
      maxBytes,
    );
    if (!checked.ok) {
      setPhase({ at: "choose", problem: checked.problem });
      return;
    }
    const { id, title } = checked.manifest;
    if (mode.kind === "round" && mode.submission.datasetId && mode.submission.datasetId !== id) {
      setPhase({
        at: "choose",
        problem: `This folder is dataset ${id}, but the submission is for ${mode.submission.datasetId}.`,
      });
      return;
    }
    const kind =
      mode.kind === "round"
        ? mode.submission.newVersion
          ? "version"
          : "new"
        : await datasetKind(id);
    setSaved(null);
    setPhase({
      at: "ready",
      ready: {
        files: checked.files,
        left: checked.left,
        id,
        title,
        kind,
        raw: checked.raw,
        checksums: checked.checksums,
        edits: [],
      },
    });
    void recheck(checked.raw, null);
  }

  /** Ask the archive's manifest checks about `raw`, keeping `shown` on screen meanwhile. */
  async function recheck(raw: Manifest, shown: Finding[] | null) {
    setChecks({ findings: shown, state: "checking" });
    try {
      const answer = await checkManifest(raw);
      setChecks({ findings: answer.findings, state: "done" });
    } catch {
      setChecks({ findings: shown, state: "failed" });
    }
  }

  async function saveEdit(ready: Ready, finding: Finding, value: string) {
    const kind = editableKind(finding)!;
    const edit: FieldEdit = {
      resource: finding.target!.resource!,
      field: finding.target!.field!,
      [kind]: value,
    };
    const raw = applyEdit(ready.raw, edit);
    if (!raw) {
      setSaved({
        ok: false,
        text: `Not saved: datapackage.json has no field ${edit.field} in ${edit.resource}.`,
      });
      return;
    }
    setPhase({ at: "ready", ready: { ...ready, raw, edits: merged(ready.edits, edit) } });
    setSaved({ ok: true, text: `Saved ${edit.field}'s ${kind}.` });
    await recheck(raw, checks?.findings ?? null);
  }

  async function send(ready: Ready) {
    setPhase({ at: "sending", ready, error: null });
    try {
      const files = ready.edits.length
        ? await withEdits(ready.files, ready.raw, ready.checksums)
        : ready.files;
      const meta = files.map(({ path, size, sha256 }) => ({ path, size, sha256 }));
      let answer: UploadsAnswer;
      if (created.current) answer = await renewUploads(created.current, meta);
      else answer = await createSubmission(meta, ready.id);
      created.current = answer.submissionId;
      const byPath = new Map(files.map((file) => [file.path, file]));
      for (const upload of answer.uploads) {
        const file = byPath.get(upload.path);
        if (!file || uploaded.current.has(upload.path)) continue;
        // Shown at once, so the bars are full before the round is submitted.
        await uploadFile(upload, file.file, (loaded) =>
          flushSync(() => setSent((now) => ({ ...now, [upload.path]: loaded }))),
        ).catch((error: Error) => {
          throw new UploadStopped(upload.path, error);
        });
        uploaded.current.add(upload.path);
      }
      await submitRound(answer.submissionId);
      onDone(answer.submissionId);
    } catch (error) {
      // A new submission's first round is a draft until it is submitted: say so and link it.
      const draft = mode.kind === "new" ? created.current : null;
      setPhase({ at: "sending", ready, error: failure(error, draft) });
    }
  }

  function chosen(list: FileList | null) {
    if (list?.length) void check(fromFileList(list));
  }

  function dropped(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    const entries = droppedEntries(event.dataTransfer.items);
    if (entries.length) void fromEntries(entries).then(check);
  }

  if (phase.at === "choose" || phase.at === "checking") {
    return (
      <div
        className={dragging ? "dropzone over" : "dropzone"}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={dropped}
      >
        <p>Drop the package folder here, or choose it.</p>
        <label className="button primary choose">
          Choose folder
          <input
            type="file"
            multiple
            className="visually-hidden"
            ref={(input) => input?.setAttribute("webkitdirectory", "")}
            onChange={(event) => chosen(event.target.files)}
          />
        </label>
        <p className="hint">
          The folder needs datapackage.json and checksums.sha256 at its top, as cruise writes them.
          Nothing leaves your computer until you press Upload and submit. Choosing a folder makes
          some browsers ask whether to upload it; dropping the folder here doesn't.
        </p>
        {limit !== null && <p className="hint">Packages up to {limit / 1024 ** 3} GiB.</p>}
        {phase.at === "checking" ? (
          <p role="status" className="muted">
            Checking the files: {phase.done} of {phase.total}
          </p>
        ) : (
          phase.problem && (
            <p role="alert" className="problem">
              {phase.problem}
            </p>
          )
        )}
      </div>
    );
  }

  const ready = phase.ready;
  const total = ready.files.reduce((sum, file) => sum + file.size, 0);
  const sending = phase.at === "sending";
  const bytes = ready.files.reduce((sum, file) => sum + (sent[file.path] ?? 0), 0);
  const percent = total === 0 ? (sending ? 100 : 0) : Math.floor((bytes * 100) / total);

  return (
    <div className="package">
      <dl className="facts">
        <div>
          <dt>Dataset</dt>
          <dd>
            {ready.title && (
              <>
                <span>{ready.title}</span>
                <br />
              </>
            )}
            <code>{ready.id}</code>
          </dd>
        </div>
        <div>
          <dt>Kind</dt>
          <dd>
            {ready.kind === "version" ? (
              <>
                New version of{" "}
                <Link to={`/datasets/${encodeURIComponent(ready.id)}`}>{ready.id}</Link>
              </>
            ) : ready.kind === "new" ? (
              "New dataset"
            ) : (
              "Unknown: the archive couldn't say whether it is published"
            )}
          </dd>
        </div>
        <div>
          <dt>Files</dt>
          <dd>
            {ready.files.length} files, {formatSize(total)}, each matching checksums.sha256
          </dd>
        </div>
        {ready.edits.length > 0 && (
          <div>
            <dt>Edited</dt>
            <dd>{fields(new Set(ready.edits.map((e) => `${e.resource}/${e.field}`)).size)}</dd>
          </div>
        )}
      </dl>
      {ready.left.length > 0 && (
        <p className="hint">
          Not sent, since checksums.sha256 doesn't list them: {ready.left.join(", ")}.
        </p>
      )}
      {sending ? (
        <>
          {phase.error ? (
            <div className="callout failed">
              <p role="alert" className="lead">
                {phase.error.text}
              </p>
              {phase.error.draft && (
                <p>
                  {arrived(uploaded.current.size)} Open it and choose the folder again to send the
                  rest, or try again here now.
                </p>
              )}
              <p className="actions">
                {phase.error.draft && (
                  <Link
                    className="button primary"
                    to={`/submissions/${encodeURIComponent(phase.error.draft)}`}
                  >
                    Open the draft
                  </Link>
                )}
                <button
                  type="button"
                  className={phase.error.draft ? undefined : "primary"}
                  onClick={() => void send(ready)}
                >
                  Try again
                </button>
              </p>
            </div>
          ) : (
            <div className="overall">
              <label htmlFor="all-files">All files</label>
              <progress id="all-files" max={100} value={percent} aria-label="All files" />
              <span className="muted">{percent}%</span>
            </div>
          )}
          <ul className="uploads" aria-label="Uploads">
            {ready.files.map((file) => (
              <li key={file.path}>
                <code>{file.path}</code>
                {phase.error?.path === file.path ? (
                  <span className="small stopped">Didn't arrive</span>
                ) : (
                  <progress
                    max={Math.max(file.size, 1)}
                    value={file.size === 0 ? (file.path in sent ? 1 : 0) : (sent[file.path] ?? 0)}
                    aria-label={file.path}
                  />
                )}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <section className="pre-checks" aria-labelledby="pre-checks-heading">
            <h2 id="pre-checks-heading">Checks before upload</h2>
            <p className="hint">
              These checks read only datapackage.json. Fix a description or a unit here and it goes
              into the upload; the checks that read the data run after upload.
            </p>
            {saved &&
              (saved.ok ? (
                <p role="status" className="saved">
                  {saved.text}
                </p>
              ) : (
                <p role="alert" className="problem">
                  {saved.text}
                </p>
              ))}
            {checks?.state === "checking" && (
              <p role="status" className="muted">
                {checks.findings ? "Checking again…" : "Checking the manifest…"}
              </p>
            )}
            {checks?.state === "failed" && (
              <p role="alert">
                The checks can't be run right now. You can still upload: the archive checks
                everything after upload.
              </p>
            )}
            {checks?.findings?.length === 0 && <p className="muted">No findings.</p>}
            {checks?.findings && (
              <FindingGroups
                findings={checks.findings}
                editor={(finding) => {
                  const kind = editableKind(finding);
                  if (!kind) return null;
                  const { resource, field } = finding.target as { resource: string; field: string };
                  return (
                    <FieldEditor
                      key={`${finding.ruleId}/${resource}/${field}`}
                      finding={finding}
                      current={fieldValue(ready.raw, resource, field, kind)}
                      onSave={(value) => saveEdit(ready, finding, value)}
                    />
                  );
                }}
              />
            )}
          </section>
          <p className="actions">
            <button type="button" className="primary" onClick={() => void send(ready)}>
              Upload and submit
            </button>
            <button type="button" onClick={() => setPhase({ at: "choose", problem: null })}>
              Choose another folder
            </button>
          </p>
        </>
      )}
    </div>
  );
}

/** `/submit`: send a package made with cruise for review. */
export function Submit() {
  useTitle("Submit");
  const navigate = useNavigate();
  return (
    <>
      <Trail
        steps={[{ label: "Submissions", to: "/submissions" }, { label: "Submit a package" }]}
      />
      <PageHeading>Submit a package</PageHeading>
      <p className="lede">
        Send a package made with cruise. The archive checks it, and a curator reviews it before it
        is published.
      </p>
      <PackageFlow
        mode={{ kind: "new" }}
        onDone={(id) => void navigate(`/submissions/${encodeURIComponent(id)}`)}
      />
    </>
  );
}
