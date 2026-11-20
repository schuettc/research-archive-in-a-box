import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from "react";
import { Link, useLocation } from "react-router";
import {
  ApiRefused,
  downloadLink,
  getDataset,
  getVersion,
  getVersions,
  myAccess,
  requestAccess,
  restoreDataset,
  withdrawDataset,
  type DatasetAccess,
  type VersionsAnswer,
  type Withdrawal,
} from "../api";
import { apiToken, groups, selfSignUp, signIn, subscribe } from "../auth";
import { bibtex, citation, citedAddress, creatorNames, doiOf, personName, ris } from "../citation";
import { Coverage } from "../Coverage";
import type {
  Contributor,
  Field,
  Manifest,
  MetadataEdit,
  Resource,
  TableSchema,
} from "../generated/manifest";
import { accessClass, accessLabel, formatSize, kindsOf, licenceLabel } from "../labels";
import { Modal, PageHeading, useTitle } from "../page";
import { BRAND } from "../site";
import { Trail, type Step } from "../Trail";
import { UsagePanel, usagePanelDone } from "../UsagePanel";

/** Called once the page has the dataset, so a static dataset page's content can give way. */
export const ShownContext = createContext<() => void>(() => {});

type VersionEntry = VersionsAnswer["versions"][number];

interface View {
  version: number;
  manifest: Manifest;
  access: string;
  project: string | null;
  published: string | null;
  newer: number | null;
  /** Every version, oldest first; null when the list couldn't be had. */
  versions: VersionEntry[] | null;
  /** The dataset's download total, absent at 0, while embargoed and once withdrawn. */
  downloads: number | null;
  /** When, by whom and why the dataset was withdrawn; null while it is published. */
  withdrawn: Withdrawal | null;
  /** The dataset's own embargo date, `YYYY-MM-DD`, if it has one. */
  embargoUntil: string | null;
  /** Whether people can create their own account on this stage, which the access box words by. */
  selfSignUp: boolean;
}

/** The dataset is there but not this version: the page links to the current one. */
class NoSuchVersion extends Error {}

const byVersion = (a: VersionEntry, b: VersionEntry) => a.version - b.version;

/** The dataset and the stage's sign-up setting together, so the access box is drawn once. */
async function load(id: string, version: number | undefined): Promise<View> {
  const [view, signUp] = await Promise.all([loadDataset(id, version), selfSignUp()]);
  return { ...view, selfSignUp: signUp };
}

async function loadDataset(
  id: string,
  version: number | undefined,
): Promise<Omit<View, "selfSignUp">> {
  if (version === undefined) {
    const [answer, versions] = await Promise.all([
      getDataset(id),
      getVersions(id).catch(() => null),
    ]);
    const manifest = answer.manifest as Manifest;
    const list = versions?.versions.toSorted(byVersion) ?? null;
    const entry = list?.find((v) => v.version === answer.currentVersion);
    return {
      version: answer.currentVersion,
      manifest,
      access: answer.access,
      project: answer.project ?? manifest["archive:project"] ?? null,
      published: entry?.publishedAt ?? manifest["archive:published"] ?? null,
      newer: null,
      versions: list,
      downloads: answer.downloads ?? null,
      withdrawn: answer.withdrawn ?? null,
      embargoUntil: answer.embargoUntil ?? null,
    };
  }
  let answer, versions, dataset;
  try {
    // The versioned answer has no withdrawal, embargo or total: the dataset's answer has them.
    [answer, versions, dataset] = await Promise.all([
      getVersion(id, version),
      getVersions(id),
      getDataset(id),
    ]);
  } catch (error) {
    // Only a 404 says the version isn't there; any other refusal is a failure to try again.
    if (
      error instanceof ApiRefused &&
      error.status === 404 &&
      (await getDataset(id).then(
        () => true,
        () => false,
      ))
    ) {
      throw new NoSuchVersion();
    }
    throw error;
  }
  const manifest = answer.manifest as Manifest;
  const latest = Math.max(...versions.versions.map((entry) => entry.version));
  // Where the files are stored decides public or not; the manifest only tells limited,
  // restricted and description-only apart, and a manifest that doesn't say is public.
  const said = manifest["archive:access"];
  const access =
    answer.prefix.split("/")[0] === "restricted"
      ? said && said !== "public"
        ? said
        : "limited"
      : "public";
  return {
    version: answer.version,
    manifest,
    access,
    project: manifest["archive:project"] ?? null,
    published: answer.publishedAt ?? manifest["archive:published"] ?? null,
    newer: latest > answer.version ? latest : null,
    versions: versions.versions.toSorted(byVersion),
    downloads: dataset.downloads ?? null,
    withdrawn: dataset.withdrawn ?? null,
    embargoUntil: dataset.embargoUntil ?? null,
  };
}

type Loaded = { key: string } & (
  { view: View } | { failed: "missing" | "no-version" | "unreachable" }
);

function kindOf(resource: Resource): string {
  return resource["archive:kind"] ?? (resource.type === "table" ? "table" : "file");
}

/** Every file of a resource, with its size when known, its main file first. */
function filesOf(resource: Resource): { path: string; bytes: number | null }[] {
  const members = resource["archive:files"];
  if (members?.length) {
    return members.map((file) => ({ path: file.path, bytes: file.bytes ?? null }));
  }
  const paths = Array.isArray(resource.path) ? resource.path : [resource.path];
  return paths
    .filter((path): path is string => typeof path === "string")
    .map((path) => ({ path, bytes: paths.length === 1 ? (resource.bytes ?? null) : null }));
}

function bytesOf(resource: Resource): number | null {
  if (typeof resource.bytes === "number") return resource.bytes;
  const sizes = resource["archive:files"]?.map((file) => file.bytes);
  if (!sizes?.length || sizes.some((size) => typeof size !== "number")) return null;
  return (sizes as number[]).reduce((total, size) => total + size, 0);
}

const sized = (bytes: number | null) => (bytes === null ? "" : ` (${formatSize(bytes)})`);

function temporal(manifest: Manifest): string | null {
  const coverage = manifest["archive:temporalCoverage"];
  if (!coverage) return null;
  let end = coverage.end ?? "an unknown end";
  if (coverage.ongoing) end = "ongoing";
  else if (coverage.end === "unknown") end = "an unknown end";
  return `${coverage.start} to ${end}`;
}

/** What each access level means, for the callout on a dataset that isn't public. */
const ACCESS_MEANS: Record<string, string> = {
  limited:
    "The files need an account. Anyone can create one; the description and the columns stay public.",
  restricted:
    "The files are shared with people an admin approves. The description and the columns stay public.",
  "description-only": "This archive holds the description of this dataset, not its files.",
};

/** What limited means on a stage where accounts come only by invitation. */
const LIMITED_BY_INVITATION =
  "The files need an account. Accounts for this archive are by invitation; the description and the columns stay public.";

/** The sign-in page's create-account view, coming back here once the account is made. */
export const createAccountHref = (next: string) =>
  `/sign-in?${new URLSearchParams({ view: "create", next })}`;

/** A request's or decision's day, as the admins' list shows it: "15 Nov". */
const day = (at: string) =>
  new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** A day with its year; an approval's `until` is a `YYYY-MM-DD` day in UTC. */
function fullDay(at: string): string {
  const options = { day: "numeric", month: "short", year: "numeric" } as const;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(at)) return new Date(at).toLocaleDateString("en-GB", options);
  return new Date(`${at}T12:00:00Z`).toLocaleDateString("en-GB", { ...options, timeZone: "UTC" });
}

/** The signed-in reader's standing for a restricted dataset, once asked for. */
type Standing = DatasetAccess | "loading" | "failed";

/** `GET /api/datasets/{id}/access`, only when `ask` (signed in, on a restricted dataset). */
function useStanding(id: string, ask: boolean): [Standing | null, (next: DatasetAccess) => void] {
  const [loaded, setLoaded] = useState<{ id: string; standing: Standing } | null>(null);
  useEffect(() => {
    if (!ask) return;
    let current = true;
    myAccess(id).then(
      (answer) => current && setLoaded({ id, standing: answer }),
      () => current && setLoaded({ id, standing: "failed" }),
    );
    return () => {
      current = false;
    };
  }, [id, ask]);
  if (!ask) return [null, () => {}];
  const standing = loaded?.id === id ? loaded.standing : "loading";
  return [standing, (next) => setLoaded({ id, standing: next })];
}

/** Whether the reader can download the dataset's files, as far as the page knows. */
function canDownload(access: string, signedIn: boolean, standing: Standing | null): boolean {
  if (access === "public") return true;
  if (access === "limited") return signedIn;
  if (access === "restricted")
    return typeof standing === "object" && standing?.state === "approved";
  return false;
}

/** The reason box: what the reader will use the files for, sent to the admins. */
function RequestForm({
  id,
  onSent,
  onCancel,
}: {
  id: string;
  onSent: (answer: DatasetAccess) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!reason.trim()) return;
    setSending(true);
    setProblem(null);
    try {
      onSent(await requestAccess(id, reason.trim()));
    } catch (error) {
      setProblem(
        error instanceof ApiRefused && error.reason
          ? `The request wasn't sent: ${error.reason}.`
          : "The request couldn't be sent. Try again.",
      );
      setSending(false);
    }
  }

  return (
    <form onSubmit={(event) => void send(event)}>
      <label className="field wide">
        What will you use it for? <span className="muted">(the admins read this)</span>
        <textarea rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />
      </label>
      {problem && <p role="alert">{problem}</p>}
      <p className="actions">
        <button type="submit" className="primary" disabled={sending || !reason.trim()}>
          Send request
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </p>
    </form>
  );
}

/** What a signed-in reader's standing for a restricted dataset adds to its callout. */
function StandingPart({
  id,
  standing,
  onChange,
}: {
  id: string;
  standing: DatasetAccess | "failed";
  onChange: (next: DatasetAccess) => void;
}) {
  const [asking, setAsking] = useState(false);
  if (standing === "failed") {
    return <p>Your access can't be checked right now. Reload the page to try again.</p>;
  }
  if (asking) {
    return (
      <RequestForm
        id={id}
        onSent={(answer) => {
          setAsking(false);
          onChange(answer);
        }}
        onCancel={() => setAsking(false)}
      />
    );
  }
  const ask = (label: string, primary = true) => (
    <p className="actions">
      <button
        type="button"
        className={primary ? "primary" : undefined}
        onClick={() => setAsking(true)}
      >
        {label}
      </button>
    </p>
  );
  switch (standing.state) {
    case "waiting":
      return (
        <p className="note" role="status">
          {standing.requestedAt
            ? `You asked for access on ${day(standing.requestedAt)}. `
            : "You asked for access. "}
          The answer will show here.
        </p>
      );
    case "declined":
      return (
        <>
          <p>
            An admin declined your request
            {standing.decidedAt ? ` on ${day(standing.decidedAt)}` : ""}
            {standing.note ? (
              <>
                : <q>{standing.note}</q>
              </>
            ) : (
              "."
            )}
          </p>
          {ask("Ask again", false)}
        </>
      );
    case "ended":
    case "taken-back": {
      const ended = standing.state === "taken-back" ? standing.takenBackAt : standing.until;
      return (
        <>
          <p>Your access ended{ended ? ` on ${fullDay(ended)}` : ""}.</p>
          {ask("Request access again")}
        </>
      );
    }
    case "approved":
      return null;
    default:
      return ask("Request access");
  }
}

/** The callout on a dataset whose files the reader can't download yet. */
function AccessCallout({
  id,
  access,
  signedIn,
  selfSignUp,
  standing,
  onStanding,
}: {
  id: string;
  access: string;
  signedIn: boolean;
  /** Whether people can create their own account on this stage. */
  selfSignUp: boolean;
  standing: Standing | null;
  onStanding: (next: DatasetAccess) => void;
}) {
  const location = useLocation();
  const here = location.pathname + location.search;
  const label = accessLabel(access);
  const hasFiles = access !== "description-only";
  return (
    <section className="callout" aria-label={label}>
      <p>
        <span className={accessClass(access)}>{label}</span>{" "}
        {access === "limited" && !selfSignUp
          ? LIMITED_BY_INVITATION
          : (ACCESS_MEANS[access] ?? "The files aren't open to everyone.")}
      </p>
      {hasFiles && !signedIn && (
        <>
          {access === "restricted" && (
            <p>
              {selfSignUp
                ? "Sign in or create an account to ask for access."
                : "Sign in to ask for access."}
            </p>
          )}
          <p className="actions">
            <button type="button" className="primary" onClick={() => void signIn(here)}>
              Sign in
            </button>
            {selfSignUp && (
              <Link className="button" to={createAccountHref(here)}>
                Create an account
              </Link>
            )}
          </p>
        </>
      )}
      {access === "restricted" && signedIn && standing !== null && standing !== "loading" && (
        <StandingPart id={id} standing={standing} onChange={onStanding} />
      )}
    </section>
  );
}

function codeList(schema: TableSchema, field: Field, tables: Set<string>): ReactNode {
  const key = schema.foreignKeys?.find((fk) => {
    const fields = Array.isArray(fk.fields) ? fk.fields : [fk.fields];
    return fields.length === 1 && fields[0] === field.name && fk.reference.resource;
  });
  const resource = key?.reference.resource;
  if (resource) {
    const target = tables.has(resource) ? `columns-${resource}` : `file-${resource}`;
    return <a href={`#${target}`}>{resource}</a>;
  }
  if (field["archive:codeList"] === "undocumented") {
    return <span className="missing">No code list</span>;
  }
  return "";
}

/** A description that only repeats the column's name says nothing. */
function described(field: Field): string | null {
  const text = field.description?.trim();
  if (!text || text.toLowerCase() === field.name.toLowerCase()) return null;
  return text;
}

interface FileProps {
  id: string;
  version: number;
  access: string;
  path: string;
  label: string;
  bytes: number | null;
  onDownload: () => void;
  /** The visible words before the label, "Download" unless given. */
  lead?: string;
  /** Visible words after the label, before the size. */
  tail?: string;
  /** The day an embargo releases the file, as words; the file shows it instead of a download. */
  held?: string | null;
}

/** The archive path of the version's zip of every file, and of one multi-file resource's. */
const PACKAGE_ZIP = "_zips/all/package.zip";
const zipOf = (resource: Resource) => `_zips/${resource.name}.zip`;

/** A file of a dataset that isn't open: signed in, its link comes from the API. */
function SignedDownload({
  id,
  version,
  path,
  label,
  bytes,
  onDownload,
  lead = "Download",
  tail = "",
}: Omit<FileProps, "access" | "held">) {
  const location = useLocation();
  const [problem, setProblem] = useState<"expired" | "refused" | "failed" | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const token = apiToken();
  const hidden = <span className="visually-hidden">{label}</span>;

  if (problem === "expired") {
    return (
      <span className="file-note">
        Your sign-in has expired.{" "}
        <button
          type="button"
          className="link-button"
          onClick={() => void signIn(location.pathname + location.search)}
        >
          Sign in again {hidden}
        </button>
      </span>
    );
  }
  if (!token) {
    return (
      <span className="file-note locked">
        <span aria-hidden="true">🔒 </span>Sign in above
      </span>
    );
  }
  if (problem === "refused") {
    return (
      <span className="file-note">
        {refusal
          ? `${refusal.charAt(0).toUpperCase()}${refusal.slice(1)}.`
          : "This file isn't available to this account."}
      </span>
    );
  }

  async function download(token: string) {
    try {
      const url = await downloadLink(id, version, path, token);
      onDownload();
      window.location.assign(url);
    } catch (error) {
      if (error instanceof ApiRefused && error.status === 401) setProblem("expired");
      else if (error instanceof ApiRefused && error.status === 403) {
        setRefusal(error.reason);
        setProblem("refused");
      } else setProblem("failed");
    }
  }

  return (
    <>
      <button type="button" className="button download" onClick={() => void download(token)}>
        <span>
          {lead} {hidden}
          {tail}
          {sized(bytes)}
        </span>
      </button>
      {problem === "failed" && (
        <span className="file-note">The download couldn't start. Try again.</span>
      )}
    </>
  );
}

function FileDownload({
  id,
  version,
  access,
  path,
  label,
  bytes,
  onDownload,
  lead = "Download",
  tail = "",
  held = null,
}: FileProps) {
  if (held) return <span className="file-note">From {held}</span>;
  if (access !== "public") {
    return (
      <SignedDownload
        id={id}
        version={version}
        path={path}
        label={label}
        bytes={bytes}
        onDownload={onDownload}
        lead={lead}
        tail={tail}
      />
    );
  }
  const href = `/data/${encodeURIComponent(id)}/${version}/${path.split("/").map(encodeURIComponent).join("/")}`;
  return (
    <a className="button download" href={href} download onClick={onDownload}>
      <span>
        {lead} <span className="visually-hidden">{label}</span>
        {tail}
        {sized(bytes)}
      </span>
    </a>
  );
}

/** A text file as a `data:` URL, for a link that downloads it. */
const dataUrl = (type: string, text: string) =>
  `data:${type};charset=utf-8,${encodeURIComponent(text)}`;

/** Copy, then the citation as BibTeX and RIS files, built here from the same data. */
function CiteFormats({
  id,
  version,
  manifest,
  text,
  versionUrl,
}: {
  id: string;
  version: number;
  manifest: Manifest;
  text: string;
  versionUrl: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <p className="cite-formats">
      <button
        type="button"
        onClick={() => navigator.clipboard.writeText(text).then(() => setCopied(true))}
      >
        Copy
      </button>
      <a
        className="button"
        download={`${id}-v${version}.bib`}
        href={dataUrl("application/x-bibtex", bibtex(manifest, versionUrl))}
      >
        BibTeX
      </a>
      <a
        className="button"
        download={`${id}-v${version}.ris`}
        href={dataUrl("application/x-research-info-systems", ris(manifest, versionUrl))}
      >
        RIS
      </a>
      <span className="copied" aria-live="polite">
        {copied ? "Copied ✓" : ""}
      </span>
    </p>
  );
}

/** Cite this dataset: the citation text, Copy, BibTeX and RIS; nothing without a citation. */
function CitePanel({ id, version, manifest }: { id: string; version: number; manifest: Manifest }) {
  const versionUrl = `${location.origin}/datasets/${encodeURIComponent(id)}/v${version}`;
  const cited = citation(manifest, versionUrl);
  if (!cited) return null;
  return (
    <section className="panel" aria-labelledby="cite-heading">
      <h2 id="cite-heading">Cite this dataset</h2>
      <div className="citation">
        <CitationText text={cited} url={citedAddress(manifest, versionUrl)} />
        <CiteFormats
          id={id}
          version={version}
          manifest={manifest}
          text={cited}
          versionUrl={versionUrl}
        />
      </div>
    </section>
  );
}

/** The version's DOI, linked to its address, when it has one. */
function DoiLine({ manifest }: { manifest: Manifest }) {
  const doi = doiOf(manifest);
  if (!doi) return null;
  return (
    <p className="doi">
      DOI <a href={doi.address}>{doi.doi}</a>
    </p>
  );
}

/** The Browse address the reader came from, carried in the link's state, if any. */
function useFrom(): string | null {
  const state = useLocation().state as { from?: unknown } | null;
  return typeof state?.from === "string" ? state.from : null;
}

/** The trail: Browse, then the results the reader came from (query and filters kept), then here. */
function trailSteps(from: string | null, title: string): Step[] {
  const steps: Step[] = [{ label: "Browse", to: "/" }];
  if (from) {
    const q = new URLSearchParams(from).get("q");
    steps.push({ label: q ? `results for “${q}”` : "filtered results", to: `/${from}` });
  }
  return [...steps, { label: title }];
}

/** A citation with its address breakable only after a slash, so it never splits mid-word. */
function CitationText({ text, url }: { text: string; url: string }) {
  if (!text.endsWith(url)) return <p>{text}</p>;
  const parts = url.split(/(?<=\/)/);
  return (
    <p>
      {text.slice(0, -url.length)}
      <span className="url">
        {parts.map((part, index) => (
          <span key={index}>
            {part}
            {index < parts.length - 1 && <wbr />}
          </span>
        ))}
      </span>
    </p>
  );
}

function Versions({ id, view }: { id: string; view: View }) {
  const state = useLocation().state as unknown;
  if (!view.versions?.length) return null;
  return (
    <section className="panel" aria-labelledby="versions-heading">
      <h2 id="versions-heading">Versions</h2>
      <ol className="versions">
        {view.versions.map((entry) => (
          <li key={entry.version}>
            <Link to={`/datasets/${encodeURIComponent(id)}/v${entry.version}`} state={state}>
              Version {entry.version}
            </Link>
            {entry.publishedAt && (
              <span className="muted"> · {entry.publishedAt.slice(0, 10)}</span>
            )}
            {entry.version === view.version && <span className="muted"> · cited above</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Whether the signed-in reader may correct details (curators, admins) and withdraw (admins). */
function useCuration(): { correct: boolean; withdraw: boolean } {
  const mine = useSyncExternalStore(subscribe, groups);
  return {
    correct: mine.includes("curator") || mine.includes("admin"),
    withdraw: mine.includes("admin"),
  };
}

/** Under the meta line, for curators and admins: Correct details, and Withdraw… for admins. */
function CuratorBar({
  id,
  version,
  onWithdraw,
}: {
  id: string;
  version: number;
  onWithdraw: () => void;
}) {
  const may = useCuration();
  if (!may.correct) return null;
  return (
    <div className="curator-bar">
      <p>You can correct this dataset's details. Files and access stay as published.</p>
      <Link className="button" to={`/datasets/${encodeURIComponent(id)}/v${version}/correct`}>
        Correct details
      </Link>
      {may.withdraw && (
        <button type="button" className="danger" onClick={onWithdraw}>
          Withdraw…
        </button>
      )}
    </div>
  );
}

/** The API's refusal as a sentence: capitalised, with a full stop. */
function problemOf(error: unknown): string {
  if (error instanceof ApiRefused && error.reason) {
    const text = error.reason.charAt(0).toUpperCase() + error.reason.slice(1);
    return /[.!?]$/.test(text) ? text : `${text}.`;
  }
  return "The archive can't be reached right now. Try again.";
}

type Curation = "withdraw" | "restore";

/**
 * The withdraw and restore dialogs. Done, the dialog closes and the page loads again; a refusal
 * shows the API's words, and a 409 (already withdrawn, or not withdrawn) also reloads the page
 * behind the dialog.
 */
function CurationDialog({
  kind,
  id,
  title,
  hasDoi,
  onClose,
  onDone,
  onStale,
}: {
  kind: Curation;
  id: string;
  title: string;
  /** Whether the dataset has a DOI, which stays once it is withdrawn. */
  hasDoi: boolean;
  onClose: () => void;
  onDone: () => void;
  onStale: () => void;
}) {
  const [reason, setReason] = useState("");
  const [missing, setMissing] = useState(false);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const withdraw = kind === "withdraw";

  function send(event: FormEvent) {
    event.preventDefault();
    if (withdraw && !reason.trim()) {
      setMissing(true);
      return;
    }
    setSending(true);
    setProblem(null);
    const call = withdraw ? withdrawDataset(id, reason.trim()) : restoreDataset(id);
    call.then(onDone, (error: unknown) => {
      setSending(false);
      setProblem(problemOf(error));
      if (error instanceof ApiRefused && error.status === 409) onStale();
    });
  }

  const heading = `${kind}-heading`;
  return (
    <Modal label={heading} onClose={onClose}>
      <h2 id={heading}>{withdraw ? "Withdraw this dataset?" : "Restore this dataset?"}</h2>
      <form className="password-form" noValidate onSubmit={send}>
        <p>
          <strong>{title}</strong>, all versions.
        </p>
        {withdraw ? (
          <>
            <p>
              {hasDoi ? "Its page and its DOI stay" : "Its page stays"}, saying it was withdrawn and
              why. Its files stop being served but are kept, and an admin can restore it.
            </p>
            <label className="field">
              <span>
                Reason <span className="muted">shown on the page</span>
              </span>
              <textarea
                rows={3}
                required
                value={reason}
                aria-invalid={missing || undefined}
                aria-describedby={missing ? "withdraw-reason-error" : undefined}
                onChange={(event) => {
                  setReason(event.target.value);
                  setMissing(false);
                }}
              />
            </label>
            {missing && (
              <p id="withdraw-reason-error" className="field-error">
                Give a reason; it's shown on the page.
              </p>
            )}
          </>
        ) : (
          <p>
            Its files are served again within a few minutes, and it returns to search, the catalog
            and the sitemap.
          </p>
        )}
        {problem && (
          <p role="alert" className="problem">
            {problem}
          </p>
        )}
        <p className="actions">
          <button
            type="submit"
            className={withdraw ? "primary danger" : "primary"}
            disabled={sending}
          >
            {withdraw ? "Withdraw" : "Restore"}
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </p>
      </form>
    </Modal>
  );
}

/** A `YYYY-MM-DD` day as words: "1 June 2027". */
const longDay = (day: string) =>
  new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day.slice(0, 10)}T00:00:00Z`));

/**
 * The day an embargo holds the shown version's files until: the later of the dataset's date and
 * the version's own, while it is after today in UTC (on the day itself the files are out, as the
 * download route rules). Null when nothing holds them.
 */
function embargoOf(view: View): string | null {
  const days = [view.embargoUntil, view.manifest["archive:embargoUntil"]]
    .filter((day): day is string => typeof day === "string" && day.length >= 10)
    .map((day) => day.slice(0, 10));
  if (!days.length) return null;
  const until = days.toSorted().at(-1) as string;
  return until > new Date().toISOString().slice(0, 10) ? until : null;
}

/** "1 download", "412 downloads", "1,204 downloads". */
const downloadWords = (n: number) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? "download" : "downloads"}`;

/** A creator's affiliation: the name linked to its ROR page, the ROR address alone, or the name. */
function Affiliation({ creator }: { creator: Contributor }) {
  const { organization, organizationId } = creator;
  if (organizationId) return <a href={organizationId}>{organization ?? organizationId}</a>;
  return organization ? <>{organization}</> : null;
}

/** About's creators, one line each: the name, the ORCID iD link and the affiliation. */
function Creators({ creators }: { creators: Contributor[] }) {
  return (
    <ul>
      {creators.map((creator, index) => {
        const name = personName(creator);
        if (!name) return null;
        const affiliation = creator.organization || creator.organizationId;
        return (
          <li key={index}>
            {name}
            {creator.orcid && (
              <>
                {" "}
                <a
                  className="orcid"
                  href={`https://orcid.org/${creator.orcid}`}
                  aria-label={`ORCID iD ${creator.orcid}`}
                >
                  <i aria-hidden="true">iD</i> {creator.orcid}
                </a>
              </>
            )}
            {affiliation && (
              <>
                {" · "}
                <Affiliation creator={creator} />
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** A corrected field in words. */
const FIELD_WORDS: Record<string, string> = {
  description: "Description",
  keywords: "Keywords",
  contributors: "Creators",
  "archive:relatedIdentifiers": "Related",
  "archive:funding": "Funding",
  "archive:methods": "Methods",
  "archive:embargoUntil": "Embargo",
};

/** The version's metadata corrections, newest first; nothing when it has none. */
function Corrections({ history }: { history: MetadataEdit[] }) {
  if (!history.length) return null;
  const newest = history.toSorted((a, b) => b.when.localeCompare(a.when));
  return (
    <section className="block" aria-labelledby="corrections-heading">
      <h2 id="corrections-heading">Corrections</h2>
      <ul className="corrections">
        {newest.map((edit, index) => {
          const day = edit.when.slice(0, 10);
          const fields = edit.fields.map((field) => FIELD_WORDS[field] ?? field).join(", ");
          return (
            <li key={index}>
              <time dateTime={day}>{day}</time>
              <span>{edit.note ? `${fields}: ${edit.note}` : fields}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function DatasetPage({ id, view, onWithdraw }: { id: string; view: View; onWithdraw: () => void }) {
  const { manifest } = view;
  const title = manifest.title ?? manifest.name ?? id;
  useTitle(title);
  const [usageFor, setUsageFor] = useState<string | null>(null);
  const downloaded = (resource: string) => () => {
    if (!usagePanelDone()) setUsageFor(resource);
  };
  const from = useFrom();
  const embargo = embargoOf(view);
  const held = embargo ? longDay(embargo) : null;
  const signedIn = apiToken() !== null;
  const [standing, setStanding] = useStanding(id, signedIn && view.access === "restricted");
  const open = canDownload(view.access, signedIn, standing);
  // A signed-in reader's restricted callout waits for their standing, so it never flickers.
  const decided = standing !== "loading";
  const approval = typeof standing === "object" && standing?.state === "approved" ? standing : null;
  const licences = (manifest.licenses ?? []).map((l) =>
    licenceLabel(l.name ?? l.title ?? l.path ?? ""),
  );
  const rights = manifest["archive:rightsStatus"];
  const creators = creatorNames(manifest);
  const resources = manifest.resources ?? [];
  const tables = resources.filter((r) => kindOf(r) === "table" && r.schema?.fields?.length);
  const tableNames = new Set(tables.map((r) => r.name));
  const stored = resources.filter((r) => kindOf(r) !== "linked");
  const storedFiles = stored.flatMap(filesOf);
  const sizes = stored.map(bytesOf);
  const total = sizes.every((size) => size !== null)
    ? (sizes as number[]).reduce((sum, size) => sum + size, 0)
    : null;
  const kinds = kindsOf(storedFiles.map((file) => file.path.split(".").pop() ?? ""));
  const when = temporal(manifest);
  const spatial = manifest["archive:spatialCoverage"];

  const meta = [
    creators.join(", "),
    view.published ? `Published ${view.published.slice(0, 10)}` : "",
    `Version ${view.version}`,
    licences.join(", ") || (rights ? rights.status : ""),
    view.downloads ? downloadWords(view.downloads) : "",
  ].filter(Boolean);
  const summary = [
    `${storedFiles.length} ${storedFiles.length === 1 ? "file" : "files"}`,
    total === null ? "" : formatSize(total),
    kinds.join(", "),
    when ?? "",
  ].filter(Boolean);

  const about: [string, ReactNode][] = [];
  const creatorList = (manifest.contributors ?? []).filter((c) => c.roles?.includes("creator"));
  if (creators.length) about.push(["Creators", <Creators creators={creatorList} />]);
  if (manifest["archive:purpose"]) about.push(["Purpose", manifest["archive:purpose"]]);
  if (manifest["archive:methods"]) about.push(["Methods", manifest["archive:methods"]]);
  const funding = manifest["archive:funding"];
  if (funding?.length) {
    about.push([
      "Funding",
      <ul>
        {funding.map((grant, index) => (
          <li key={index}>
            {grant.funder}
            {grant.awardTitle ? `: ${grant.awardTitle}` : ""}
            {grant.awardNumber ? ` (${grant.awardNumber})` : ""}
          </li>
        ))}
      </ul>,
    ]);
  }
  const related = manifest["archive:relatedIdentifiers"];
  if (related?.length) {
    about.push([
      "Related works",
      <ul>
        {related.map((work, index) => (
          <li key={index}>
            {work.relationType}{" "}
            {/^https?:\/\//.test(work.identifier) ? (
              <a href={work.identifier}>{work.identifier}</a>
            ) : (
              `${work.identifierType} ${work.identifier}`
            )}
          </li>
        ))}
      </ul>,
    ]);
  }
  if (manifest.licenses?.length || rights) {
    about.push([
      "Rights",
      <ul>
        {(manifest.licenses ?? []).map((l, index) => {
          const label = l.name ?? l.title ?? l.path ?? "";
          return (
            <li key={index}>
              Licensed {licenceLabel(label)}
              {l.title && l.name ? ` (${l.title})` : ""}
              {l.path && l.path !== label && (
                <>
                  : <a href={l.path}>{l.path}</a>
                </>
              )}
            </li>
          );
        })}
        {rights && (
          <li>
            Rights status {rights.status}
            {rights.statement ? `: ${rights.statement}` : ""}
          </li>
        )}
      </ul>,
    ]);
  }
  if (view.project) about.push(["Project", view.project]);
  if (manifest.keywords?.length) about.push(["Keywords", manifest.keywords.join(", ")]);
  if (when) about.push(["Temporal coverage", when]);
  if (spatial) about.push(["Spatial coverage", <Coverage coverage={spatial} />]);

  return (
    <article className="dataset">
      {usageFor && <UsagePanel datasetId={id} onClose={() => setUsageFor(null)} />}
      <div className="ds-grid">
        <div className="ds-head">
          <Trail steps={trailSteps(from, title)} />
          <PageHeading>{title}</PageHeading>
          <p className="ds-meta" data-testid="meta">
            {view.access !== "public" && open && (
              <>
                <span className={accessClass(view.access)}>{accessLabel(view.access)}</span> ·{" "}
              </>
            )}
            {meta.join(" · ")}
          </p>
          <DoiLine manifest={manifest} />
          <CuratorBar id={id} version={view.version} onWithdraw={onWithdraw} />
          {approval?.until && (
            <p className="note">You have access until {fullDay(approval.until)}.</p>
          )}
          {view.newer !== null && (
            <p className="note">
              A newer version of this dataset exists:{" "}
              <Link to={`/datasets/${encodeURIComponent(id)}/v${view.newer}`}>
                version {view.newer}
              </Link>
              .
            </p>
          )}
          {!open && decided && (
            <AccessCallout
              id={id}
              access={view.access}
              signedIn={signedIn}
              selfSignUp={view.selfSignUp}
              standing={standing}
              onStanding={setStanding}
            />
          )}
          {manifest.description && <p className="lede">{manifest.description}</p>}
          {held && (
            <section className="callout" aria-label="Embargoed">
              <p>
                <strong>Files available from {held}.</strong> The description, columns and citation
                are public now; the files are released on that date.
              </p>
            </section>
          )}
          <div className="summary-strip" data-testid="summary-strip">
            <p className="summary" data-testid="summary">
              {summary.join(" · ")}
            </p>
            {storedFiles.length > 0 && view.access !== "description-only" && !held && (
              <FileDownload
                id={id}
                version={view.version}
                access={view.access}
                path={PACKAGE_ZIP}
                label="every file as one zip"
                bytes={null}
                lead="Download all"
                onDownload={downloaded(PACKAGE_ZIP)}
              />
            )}
          </div>
        </div>

        <section className="block ds-files" aria-labelledby="files-heading">
          <h2 id="files-heading">Files</h2>
          <ul className="files" aria-labelledby="files-heading">
            {resources.map((resource) => {
              const label = resource.title ?? resource.name;
              const kind = kindOf(resource);
              const files = filesOf(resource);
              const main = files[0];
              const fileProps = {
                id,
                version: view.version,
                access: view.access,
                onDownload: downloaded(resource.name),
                held,
              };
              return (
                <li key={resource.name} id={`file-${resource.name}`} className="file">
                  <p className="file-head">
                    <span className="file-title">{label}</span>{" "}
                    <span className="label">{kind}</span>
                  </p>
                  <div className="file-action">
                    {held ? (
                      <span className="file-note">From {held}</span>
                    ) : kind === "linked" && typeof resource.path === "string" ? (
                      <a className="button download" href={resource.path}>
                        Open link <span className="visually-hidden">{label}</span>
                      </a>
                    ) : (
                      main &&
                      (files.length > 1 ? (
                        <FileDownload
                          {...fileProps}
                          path={zipOf(resource)}
                          label={label}
                          bytes={null}
                          tail=" as a zip"
                        />
                      ) : (
                        <FileDownload
                          {...fileProps}
                          path={main.path}
                          label={label}
                          bytes={bytesOf(resource)}
                        />
                      ))
                    )}
                  </div>
                  {resource.description && <p className="file-about">{resource.description}</p>}
                  {kind === "linked" ? (
                    <p className="file-path muted">External</p>
                  ) : (
                    main && <code className="file-path">{main.path}</code>
                  )}
                  {files.length > 1 && (
                    <details className="members">
                      <summary>Files in this set ({files.length})</summary>
                      <ul>
                        {files.map((file) => (
                          <li key={file.path}>
                            <code>{file.path}</code>{" "}
                            <FileDownload
                              {...fileProps}
                              path={file.path}
                              label={file.path}
                              bytes={file.bytes}
                            />
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        <aside className="ds-side" aria-label="Cite and versions">
          <CitePanel id={id} version={view.version} manifest={manifest} />
          <Versions id={id} view={view} />
        </aside>

        <div className="ds-rest">
          {tables.length > 0 && (
            <section className="block" aria-labelledby="columns-heading">
              <h2 id="columns-heading">Columns</h2>
              {tables.map((resource) => {
                const schema = resource.schema as TableSchema;
                const label = resource.title ?? resource.name;
                const fields = schema.fields ?? [];
                return (
                  <details key={resource.name} id={`columns-${resource.name}`} open>
                    <summary>
                      <h3>{label}</h3>{" "}
                      <span className="muted">
                        {fields.length} {fields.length === 1 ? "column" : "columns"}
                      </span>
                    </summary>
                    <div
                      className="table-scroll cards-on-phone"
                      role="region"
                      aria-label={`Columns of ${label}, scrolls sideways`}
                      tabIndex={0}
                    >
                      <table className="cols to-cards" aria-label={`Columns of ${label}`}>
                        <thead>
                          <tr>
                            <th scope="col">Column</th>
                            <th scope="col">Title</th>
                            <th scope="col">Type</th>
                            <th scope="col">Unit</th>
                            <th scope="col">Description</th>
                            <th scope="col">Codes</th>
                          </tr>
                        </thead>
                        <tbody>
                          {fields.map((field) => (
                            <tr key={field.name}>
                              <th scope="row" className="title-cell">
                                <code>{field.name}</code>
                              </th>
                              <td data-label="Title">{field.title ?? ""}</td>
                              <td data-label="Type">{field.type ?? ""}</td>
                              <td data-label="Unit">{field["archive:unit"] ?? ""}</td>
                              <td data-label="Description">
                                {described(field) ?? (
                                  <span className="missing">No description</span>
                                )}
                              </td>
                              <td data-label="Codes">{codeList(schema, field, tableNames)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                );
              })}
            </section>
          )}

          {about.length > 0 && (
            <section className="block" aria-labelledby="about-heading">
              <h2 id="about-heading">About</h2>
              <dl className="facts">
                {about.map(([term, detail]) => (
                  <div key={term}>
                    <dt>{term}</dt>
                    <dd>{detail}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
          <Corrections history={manifest["archive:metadataHistory"] ?? []} />
        </div>
      </div>
    </article>
  );
}

/** "Version 1, withdrawn", "Versions 1 and 2, both withdrawn", "Versions 1, 2 and 3, all withdrawn". */
function withdrawnVersions(numbers: number[]): string {
  if (numbers.length === 1) return `Version ${numbers[0]}, withdrawn`;
  const listed = `${numbers.slice(0, -1).join(", ")} and ${numbers.at(-1)}`;
  return `Versions ${listed}, ${numbers.length === 2 ? "both" : "all"} withdrawn`;
}

/** A withdrawn dataset's page at every version's address: why, the citation, and no files. */
function WithdrawnPage({
  id,
  view,
  withdrawn,
  onRestore,
}: {
  id: string;
  view: View;
  withdrawn: Withdrawal;
  onRestore: () => void;
}) {
  const may = useCuration();
  const { manifest } = view;
  const title = manifest.title ?? manifest.name ?? id;
  useTitle(title);
  const from = useFrom();
  const numbers = view.versions?.map((entry) => entry.version) ?? [view.version];
  const meta = [
    creatorNames(manifest).join(", "),
    view.published ? `Published ${view.published.slice(0, 10)}` : "",
    withdrawnVersions(numbers),
  ].filter(Boolean);
  return (
    <article className="dataset withdrawn">
      <Trail steps={trailSteps(from, title)} />
      <PageHeading>{title}</PageHeading>
      <p className="status-row">
        <span className="badge no">Withdrawn</span>
        <span className="muted small">{withdrawn.at.slice(0, 10)}</span>
      </p>
      <section className="callout failed" aria-label="Withdrawn">
        <p className="lead">This dataset has been withdrawn.</p>
        <p>Reason: {withdrawn.reason}</p>
        {may.withdraw && (
          <p className="actions">
            <button type="button" onClick={onRestore}>
              Restore…
            </button>
          </p>
        )}
        <p className="muted small">
          Its files are no longer available. This page stays so that citations of it still lead
          somewhere.
        </p>
      </section>
      <CitePanel id={id} version={view.version} manifest={manifest} />
      <p className="ds-meta" data-testid="meta">
        {meta.join(" · ")}
      </p>
      <DoiLine manifest={manifest} />
    </article>
  );
}

function Title({ page }: { page: string }) {
  useTitle(page);
  return null;
}

function Loading() {
  useTitle("Loading dataset");
  return (
    <>
      <PageHeading>Loading dataset…</PageHeading>
      <p role="status" className="muted">
        One moment.
      </p>
    </>
  );
}

export function Dataset({ id, version }: { id: string; version?: number }) {
  const [attempt, setAttempt] = useState(0);
  const key = `${id}@${version ?? "current"}#${attempt}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [dialog, setDialog] = useState<Curation | null>(null);
  /** Bumped once the page reloads after a withdraw or restore, to move focus to its heading. */
  const [reloaded, setReloaded] = useState(0);
  const shown = useContext(ShownContext);

  /** Load the page again behind whatever is open, without the loading line. */
  function refresh() {
    load(id, version).then(
      (view) => setLoaded({ key, view }),
      () => {},
    );
  }

  /**
   * After a withdraw or restore: load the page again and put focus on its heading, since the
   * button focus went back to is gone; a failed load shows that the dataset can't be loaded.
   */
  function reload() {
    load(id, version)
      .then(
        (view) => setLoaded({ key, view }),
        () => setLoaded({ key, failed: "unreachable" }),
      )
      .finally(() => setReloaded((n) => n + 1));
  }

  useEffect(() => {
    if (reloaded) document.querySelector<HTMLElement>("h1")?.focus();
  }, [reloaded]);

  useEffect(() => {
    let current = true;
    load(id, version).then(
      (view) => current && setLoaded({ key, view }),
      (error: unknown) => {
        const failed =
          error instanceof NoSuchVersion
            ? "no-version"
            : error instanceof ApiRefused && error.status === 404
              ? "missing"
              : "unreachable";
        if (current) setLoaded({ key, failed });
      },
    );
    return () => {
      current = false;
    };
  }, [id, version, key]);

  const result = loaded?.key === key ? loaded : null;
  const view = result && "view" in result ? result.view : null;
  useEffect(() => {
    if (view) shown();
  }, [view, shown]);

  const current = `/datasets/${encodeURIComponent(id)}`;
  if (!result) return <Loading />;
  if ("failed" in result) {
    if (result.failed === "missing") {
      return (
        <>
          <Title page="Not found" />
          <PageHeading>Dataset not found</PageHeading>
          <p>
            There's no dataset {id}. <Link to="/">Search the archive</Link>.
          </p>
        </>
      );
    }
    if (result.failed === "no-version") {
      return (
        <>
          <Title page="Not found" />
          <PageHeading>Version not found</PageHeading>
          <p>
            Dataset {id} has no version {version}. <Link to={current}>See the current version</Link>{" "}
            or <Link to="/">search the archive</Link>.
          </p>
        </>
      );
    }
    return (
      <>
        <Title page="Dataset unavailable" />
        <PageHeading>Dataset unavailable</PageHeading>
        <p role="alert">This dataset can't be loaded right now.</p>
        <p className="actions">
          <button type="button" className="primary" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
          <Link className="button" to="/">
            Search the archive
          </Link>
        </p>
        <p>
          The dataset's current version has a page that reads without the archive's search:{" "}
          {/* A full page load, so the static page answers even with the API down. */}
          <a href={current}>{id}, current version</a>.
          {BRAND.contact && (
            <>
              {" "}
              If this keeps happening, contact{" "}
              <a href={`mailto:${BRAND.contact}`}>{BRAND.contact}</a>.
            </>
          )}
        </p>
      </>
    );
  }
  const { manifest } = result.view;
  return (
    <>
      {result.view.withdrawn ? (
        <WithdrawnPage
          id={id}
          view={result.view}
          withdrawn={result.view.withdrawn}
          onRestore={() => setDialog("restore")}
        />
      ) : (
        <DatasetPage id={id} view={result.view} onWithdraw={() => setDialog("withdraw")} />
      )}
      {dialog && (
        <CurationDialog
          kind={dialog}
          id={id}
          title={manifest.title ?? manifest.name ?? id}
          hasDoi={doiOf(manifest) !== null}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            reload();
          }}
          onStale={refresh}
        />
      )}
    </>
  );
}
