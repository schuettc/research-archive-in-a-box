import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import {
  getDataset,
  getSubmission,
  heldFiles,
  listSubmissions,
  type Submission,
  type SubmissionEvent,
} from "../api";
import { signedInSub } from "../auth";
import { FINAL_STATUSES, type Status } from "../labels";
import { PageHeading, useTitle } from "../page";
import { asCell, usePeople } from "../People";
import { StatusBadge } from "../StatusBadge";
import { POLL_MS } from "./Submission";

/** Whether the held copy of a submission is there to read: only in review or publishing. */
export function isHeld(status: Status): boolean {
  return status === "in-review" || status === "publishing";
}

/** What the page reads of a held manifest: its title and its resources' files. */
export type HeldManifest = {
  title?: unknown;
  resources?: { path?: unknown; "archive:files"?: { path: string }[] }[];
};

/** A held submission's manifest, read through its held file's link. */
export async function heldManifest(id: string): Promise<HeldManifest | null> {
  const held = await heldFiles(id);
  const manifest = held.files.find((file) => file.path === "datapackage.json");
  if (!manifest) return null;
  const response = await fetch(manifest.url);
  if (!response.ok) return null;
  return (await response.json()) as HeldManifest;
}

/** The title from a held submission's manifest. */
export async function heldTitle(id: string): Promise<string | null> {
  const parsed = await heldManifest(id);
  return typeof parsed?.title === "string" ? parsed.title : null;
}

/** A finished submission's title, from its published dataset when there is one. */
async function publishedTitle(submission: Submission): Promise<string | null> {
  if (submission.status !== "published" || !submission.datasetId) return null;
  const dataset = await getDataset(submission.datasetId);
  return dataset.title || null;
}

/** The current round's `entered-review` event: how many curators it needs, and whom it asks. */
export function enteredReview(events: SubmissionEvent[], round: number): SubmissionEvent | null {
  return (
    events
      .filter((event) => event.type === "entered-review" && event.round === round)
      .toSorted((a, b) => a.eventKey.localeCompare(b.eventKey))
      .at(-1) ?? null
  );
}

/** The queue's tabs: what a curator does with each status. Drafts are left out. */
const TABS: { id: string; label: string; statuses: readonly Status[]; empty: string }[] = [
  {
    id: "decision",
    label: "Needs a decision",
    statuses: ["in-review"],
    empty: "Nothing needs a decision right now.",
  },
  {
    id: "checking",
    label: "Being checked",
    statuses: ["checking"],
    empty: "Nothing is being checked right now.",
  },
  {
    id: "changes",
    label: "Changes requested",
    statuses: ["needs-changes"],
    empty: "No changes are requested right now.",
  },
  {
    id: "publishing",
    label: "Publishing",
    statuses: ["publishing"],
    empty: "Nothing is publishing right now.",
  },
  {
    id: "finished",
    label: "Finished",
    statuses: FINAL_STATUSES,
    empty: "Nothing has finished yet.",
  },
];
type Tab = (typeof TABS)[number];
const DEFAULT_TAB = TABS[0]!;
const QUEUE_STATUSES = TABS.flatMap((tab) => tab.statuses);

function tabOf(status: Status): Tab | undefined {
  return TABS.find((tab) => tab.statuses.includes(status));
}

/** The chips that narrow a tab's rows, each by its id in the address. */
const CHIPS = [
  { id: "mine", label: "Assigned to me" },
  { id: "new-datasets", label: "New datasets" },
  { id: "new-versions", label: "New versions" },
  { id: "stale", label: "Stale" },
] as const;
type Chip = (typeof CHIPS)[number]["id"];

/** The sortable columns, each by its key in the address (`-` before it for the other way). */
const SORTS = { dataset: "Dataset", submitter: "Submitted by", waiting: "Waiting since" } as const;
type SortKey = keyof typeof SORTS;
const DEFAULT_SORT: SortKey = "waiting";

/** What the address holds of the queue: the tab, the search, the chips on and the sort. */
interface View {
  tab: Tab;
  q: string;
  chips: Chip[];
  sort: SortKey;
  descending: boolean;
}

function readView(params: URLSearchParams): View {
  const sort = params.get("sort") ?? "";
  const key = sort.replace(/^-/, "");
  const known = Object.hasOwn(SORTS, key);
  return {
    tab: TABS.find((each) => each.id === params.get("tab")) ?? DEFAULT_TAB,
    q: params.get("q") ?? "",
    chips: CHIPS.map((chip) => chip.id).filter((id) => params.getAll("chip").includes(id)),
    sort: known ? (key as SortKey) : DEFAULT_SORT,
    descending: known && sort.startsWith("-"),
  };
}

/** A view as its address query, holding only what differs from the defaults. */
function viewQuery(view: View): string {
  const params = new URLSearchParams();
  if (view.tab !== DEFAULT_TAB) params.set("tab", view.tab.id);
  if (view.q) params.set("q", view.q);
  for (const chip of view.chips) params.append("chip", chip);
  if (view.sort !== DEFAULT_SORT || view.descending)
    params.set("sort", `${view.descending ? "-" : ""}${view.sort}`);
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** How long ago a submission was created, in the largest whole unit: "9 days", "1 minute". */
export function waitingFor(createdAt: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(createdAt)) / 60_000);
  const [count, unit] =
    minutes >= 1440
      ? [Math.floor(minutes / 1440), "day"]
      : minutes >= 60
        ? [Math.floor(minutes / 60), "hour"]
        : [minutes, "minute"];
  if (count < 1) return "under a minute";
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/**
 * Every queued submission, read now and every 10 s while the browser tab is visible: one list
 * per status, in parallel. It stops while hidden and reads at once on showing again. `failed`
 * says the last read failed; `submissions` stays the last that answered, read at `readAt`. `arrived` maps each
 * submission that came into the tab on screen after the first read to that tab, for the rest of the visit.
 */
function useQueue(shown: string): {
  submissions: Submission[] | null;
  readAt: number;
  failed: boolean;
  arrived: ReadonlyMap<string, string>;
  reload: () => void;
} {
  const [submissions, setSubmissions] = useState<Submission[] | null>(null);
  const [readAt, setReadAt] = useState(0);
  const [failed, setFailed] = useState(false);
  const [arrived, setArrived] = useState<ReadonlyMap<string, string>>(new Map());
  const tickRef = useRef<() => void>(() => {});
  const shownRef = useRef(shown);
  useEffect(() => {
    shownRef.current = shown;
  }, [shown]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current = true;
    let reading = false;
    // Each submission's tab at the last read; null before the first.
    let lastTab: Map<string, string> | null = null;
    const visible = () => document.visibilityState === "visible";
    const tick = () => {
      clearTimeout(timer);
      if (reading) return;
      reading = true;
      Promise.all(QUEUE_STATUSES.map((status) => listSubmissions({ status })))
        .then(
          (answers) => {
            if (!current) return;
            const all = answers.flatMap((answer) => answer.submissions);
            const tabs = new Map(all.map((s) => [s.submissionId, tabOf(s.status)?.id ?? ""]));
            const before = lastTab;
            if (before) {
              const moved = [...tabs].filter(
                ([id, tab]) => tab === shownRef.current && before.get(id) !== tab,
              );
              if (moved.length) setArrived((was) => new Map([...was, ...moved]));
            }
            lastTab = tabs;
            setSubmissions(all.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt)));
            setReadAt(Date.now());
            setFailed(false);
          },
          () => current && setFailed(true),
        )
        .finally(() => {
          reading = false;
          if (current && visible()) timer = setTimeout(tick, POLL_MS);
        });
    };
    const onVisibility = () => (visible() ? tick() : clearTimeout(timer));
    tickRef.current = tick;
    document.addEventListener("visibilitychange", onVisibility);
    if (visible()) tick();
    return () => {
      current = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return { submissions, readAt, failed, arrived, reload: () => tickRef.current() };
}

/** What a queue row reads beyond the list: the title and the review's needs. */
interface RowDetail {
  title: string | null;
  needed: number | null;
  audience: string | null;
}

/** What a row's details depend on: they're read again only when this changes. */
function detailKey(submission: Submission): string {
  return `${submission.status} ${submission.round} ${submission.approvals.join(",")}`;
}

/** A row's details, and whether they were all read: a failed read is tried again on the next tick. */
async function readDetail(submission: Submission): Promise<{ detail: RowDetail; read: boolean }> {
  const id = submission.submissionId;
  const [read, title] = await Promise.all([
    getSubmission(id).catch(() => null),
    isHeld(submission.status)
      ? heldTitle(id).catch(() => null)
      : publishedTitle(submission).catch(() => null),
  ]);
  const entered = read ? enteredReview(read.events, submission.round) : null;
  return {
    detail: {
      title,
      needed: entered?.outcome === "two" ? 2 : entered?.outcome === "one" ? 1 : null,
      audience: entered?.audience ?? null,
    },
    read: read !== null,
  };
}

/**
 * The details of the rows shown, by submission id: each read when its row first appears and
 * again only when its status, round or approvals change. A row keeps its last details until
 * the new ones answer.
 */
function useDetails(
  rows: Submission[] | undefined,
  readAt: number,
): ReadonlyMap<string, RowDetail> {
  const [details, setDetails] = useState<ReadonlyMap<string, RowDetail>>(new Map());
  // What each row's details were last asked for: its detail key, read again only when that
  // changes; a read that failed is asked again once the queue's next read answers.
  const asked = useRef(new Map<string, string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    for (const submission of rows ?? []) {
      const id = submission.submissionId;
      const key = detailKey(submission);
      const was = asked.current.get(id);
      if (was === key || was === `${key} failed ${readAt}`) continue;
      asked.current.set(id, key);
      readDetail(submission).then(({ detail, read }) => {
        if (!mounted.current || asked.current.get(id) !== key) return;
        if (!read) asked.current.set(id, `${key} failed ${readAt}`);
        setDetails((was) => new Map(was).set(id, detail));
      });
    }
  }, [rows, readAt]);
  return details;
}

function QueueRow({
  submission,
  detail,
  arrived,
  name,
  now,
  finished,
}: {
  submission: Submission;
  detail: RowDetail | undefined;
  arrived: boolean;
  name: (sub: string) => string;
  now: number;
  finished: boolean;
}) {
  const id = submission.submissionId;
  const audience = detail?.audience;
  const kind = submission.newVersion ? "New version" : "New dataset";
  return (
    <tr className={arrived ? "arrived" : undefined}>
      <th scope="row" className="title-cell">
        <Link to={`/review/${encodeURIComponent(id)}`}>
          {detail?.title ?? submission.datasetId ?? id}
        </Link>
        {submission.stale && (
          <>
            {" "}
            <span className="tag stale">Stale</span>
          </>
        )}
        {arrived && (
          <>
            {" "}
            <span className="tag arrived">Just arrived</span>
          </>
        )}
        {detail?.title && submission.datasetId && (
          <span className="sub">{submission.datasetId}</span>
        )}
      </th>
      <td data-label="Submitted by">{asCell(name(submission.submitter))}</td>
      {finished ? (
        <>
          <td data-label="Round">{submission.round}</td>
          <td data-label="Kind">{kind}</td>
          <td data-label="Outcome">
            <StatusBadge status={submission.status} />
          </td>
        </>
      ) : (
        <>
          <td data-label="Waiting since">{waitingFor(submission.createdAt, now)}</td>
          <td data-label="Round">{submission.round}</td>
          <td data-label="Kind">{kind}</td>
          <td data-label="Curators">
            {detail === undefined
              ? "…"
              : detail.needed === null
                ? "—"
                : `${submission.approvals.length} of ${detail.needed} approved`}
          </td>
          <td data-label="Assigned to">
            {audience == null ? "—" : audience === "all" ? "Any curator" : asCell(name(audience))}
          </td>
        </>
      )}
    </tr>
  );
}

/** The Sort by select's choices on a phone: the same `sort` values the headings write. */
const SORT_CHOICES: { value: string; label: string; finished?: string }[] = [
  { value: "waiting", label: "Waiting since, oldest first", finished: "Oldest first" },
  { value: "-waiting", label: "Waiting since, newest first", finished: "Newest first" },
  { value: "dataset", label: "Dataset, A to Z" },
  { value: "-dataset", label: "Dataset, Z to A" },
  { value: "submitter", label: "Submitted by, A to Z" },
  { value: "-submitter", label: "Submitted by, Z to A" },
];

/** The name a row shows for its dataset: the held title, else the dataset id. */
function datasetName(submission: Submission, detail: RowDetail | undefined): string {
  return detail?.title ?? submission.datasetId ?? submission.submissionId;
}

/**
 * Whether a row stays under the search and chips. Before its details load, a row matches the
 * search on its dataset id alone and is left out by Assigned to me.
 */
function matches(
  submission: Submission,
  detail: RowDetail | undefined,
  view: View,
  name: (sub: string) => string,
): boolean {
  const q = view.q.trim().toLowerCase();
  if (q) {
    const held = detail
      ? [detail.title, submission.datasetId, name(submission.submitter)]
      : [submission.datasetId];
    if (!held.some((text) => text?.toLowerCase().includes(q))) return false;
  }
  return view.chips.every((chip) =>
    chip === "mine"
      ? detail?.audience != null && detail.audience === signedInSub()
      : chip === "new-datasets"
        ? !submission.newVersion
        : chip === "new-versions"
          ? submission.newVersion
          : submission.stale,
  );
}

/** `/review`: the curators' queue, in tabs by what each submission needs, kept current. */
export function ReviewQueue() {
  useTitle("Review queue");
  const [params, setParams] = useSearchParams();
  const view = readView(params);
  const { tab } = view;
  const show = (next: Partial<View>, replace = false) =>
    setParams(viewQuery({ ...view, ...next }), { replace });
  const { submissions, readAt, failed, arrived, reload } = useQueue(tab.id);
  const shown = submissions?.filter((s) => tab.statuses.includes(s.status));
  const details = useDetails(shown, readAt);
  const name = usePeople(
    (shown ?? []).flatMap((s) => {
      const audience = details.get(s.submissionId)?.audience;
      return [s.submitter, audience && audience !== "all" ? audience : ""].filter(Boolean);
    }),
  );
  const order = (a: Submission, b: Submission): number => {
    const waited = a.createdAt.localeCompare(b.createdAt);
    const by =
      view.sort === "dataset"
        ? datasetName(a, details.get(a.submissionId)).localeCompare(
            datasetName(b, details.get(b.submissionId)),
            undefined,
            { sensitivity: "base" },
          )
        : view.sort === "submitter"
          ? name(a.submitter).localeCompare(name(b.submitter), undefined, { sensitivity: "base" })
          : 0;
    return (by || waited) * (view.descending ? -1 : 1);
  };
  const rows = shown
    ?.filter((s) => matches(s, details.get(s.submissionId), view, name))
    .toSorted(order);

  const finished = tab.id === "finished";
  const sortValue = `${view.descending ? "-" : ""}${view.sort}`;
  const heading = (key: SortKey) => {
    const on = view.sort === key;
    return (
      <th scope="col" aria-sort={on ? (view.descending ? "descending" : "ascending") : undefined}>
        <button
          type="button"
          className="sort"
          onClick={() => show({ sort: key, descending: on && !view.descending })}
        >
          {SORTS[key]}
          <span className="arrow" aria-hidden="true">
            {on ? (view.descending ? "▼" : "▲") : "↕"}
          </span>
        </button>
      </th>
    );
  };

  return (
    <>
      <PageHeading>Review queue</PageHeading>
      <nav className="queue-tabs" aria-label="Queue" data-scroll>
        {TABS.map((each) => (
          <Link
            key={each.id}
            to={`/review${viewQuery({ ...view, tab: each })}`}
            aria-current={each === tab ? "page" : undefined}
          >
            {each.label}{" "}
            <span className="count">
              {submissions?.filter((s) => each.statuses.includes(s.status)).length ?? "…"}
            </span>
          </Link>
        ))}
      </nav>
      <div className="queue-bar">
        <label className="field">
          Search
          <input
            type="search"
            value={view.q}
            onChange={(event) => show({ q: event.target.value }, view.q !== "")}
          />
        </label>
        <div className="field" role="group" aria-labelledby="queue-chips">
          <span id="queue-chips">Show</span>
          <div className="chips">
            {CHIPS.map((chip) => {
              const on = view.chips.includes(chip.id);
              return (
                <button
                  key={chip.id}
                  type="button"
                  className="chip"
                  aria-pressed={on}
                  onClick={() =>
                    show({
                      chips: on
                        ? view.chips.filter((c) => c !== chip.id)
                        : [...view.chips, chip.id],
                    })
                  }
                >
                  {chip.label}
                </button>
              );
            })}
          </div>
        </div>
        <label className="field sort-by">
          Sort by
          <select
            value={sortValue}
            onChange={(event) => {
              const value = event.target.value;
              show({ sort: value.replace(/^-/, "") as SortKey, descending: value.startsWith("-") });
            }}
          >
            {SORT_CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {finished ? (choice.finished ?? choice.label) : choice.label}
              </option>
            ))}
          </select>
        </label>
        {submissions !== null && (
          <p className="queue-live" role="status">
            {failed ? "The queue couldn't be refreshed" : "Up to date · checks every 10 s"}
          </p>
        )}
      </div>
      {rows === undefined ? (
        failed ? (
          <div className="callout failed">
            <p role="alert" className="lead">
              The queue can't be loaded right now.
            </p>
            <p className="actions">
              <button type="button" onClick={reload}>
                Try again
              </button>
            </p>
          </div>
        ) : (
          <p role="status" className="loading">
            Loading the queue…
          </p>
        )
      ) : shown?.length === 0 ? (
        <div className="empty">
          <p className="lead">{tab.empty}</p>
          {tab !== DEFAULT_TAB && (
            <p className="actions">
              <Link className="button" to={`/review${viewQuery({ ...view, tab: DEFAULT_TAB })}`}>
                See what needs a decision
              </Link>
            </p>
          )}
        </div>
      ) : rows.length === 0 ? (
        <div className="empty">
          <p className="lead">Nothing matches the search and filters.</p>
          <p className="actions">
            <button type="button" onClick={() => show({ q: "", chips: [] })}>
              Clear search and filters
            </button>
          </p>
        </div>
      ) : (
        <table className="cols listing queue to-cards">
          <thead>
            <tr>
              {heading("dataset")}
              {heading("submitter")}
              {finished ? (
                <>
                  <th scope="col">Round</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Outcome</th>
                </>
              ) : (
                <>
                  {heading("waiting")}
                  <th scope="col">Round</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Curators</th>
                  <th scope="col">Assigned to</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((submission) => (
              <QueueRow
                key={submission.submissionId}
                submission={submission}
                detail={details.get(submission.submissionId)}
                arrived={arrived.get(submission.submissionId) === tab.id}
                name={name}
                now={readAt}
                finished={finished}
              />
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
