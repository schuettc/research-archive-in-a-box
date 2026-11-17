import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { afterEach, beforeEach, expect, test, vi, type Mock } from "vitest";
import { forgetPeople } from "../People";
import { event, item } from "../test-fixtures";
import type { Submission } from "../api";
import { ReviewQueue, waitingFor } from "./ReviewQueue";

vi.mock("../auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth")>()),
  apiToken: vi.fn(() => "token"),
  signedInSub: vi.fn(() => "cur-1"),
  groups: vi.fn(() => CURATOR),
}));
const CURATOR = ["curator"];

const EMAILS: Record<string, string> = {
  "con-3": "contributor@example.org",
  "cur-1": "curator@example.org",
  "cur-2": "second@example.org",
};

let fetchMock: Mock;
/** What `/api/submissions?status=…` answers, by status; a status not here answers none. */
let lists: Record<string, Submission[]>;
/** Whether the list reads fail. */
let listsFail: boolean;
let visibility: DocumentVisibilityState;
/** The submissions whose current round asks the signed-in curator, cur-1. */
let mine: Set<string>;

beforeEach(() => {
  forgetPeople();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  listsFail = false;
  mine = new Set(["s-1"]);
  lists = {
    "in-review": [
      item({
        submissionId: "s-1",
        submitter: "con-3",
        newVersion: true,
        stale: true,
        approvals: ["cur-2"],
      }),
      item({ submissionId: "s-2", submitter: "con-3", datasetId: "lake-levels" }),
    ],
    "needs-changes": [item({ submissionId: "s-9", status: "needs-changes", submitter: "con-3" })],
  };
  fetchMock = vi.fn(async (url: string) => {
    const parsed = new URL(url, "https://site");
    const path = parsed.pathname;
    if (parsed.host === "staging.example")
      return Response.json({ title: `Title of ${path.split("/")[2]}` });
    if (path === "/api/submissions") {
      if (listsFail) return Response.json({}, { status: 500 });
      return Response.json({ submissions: lists[parsed.searchParams.get("status")!] ?? [] });
    }
    if (path === "/api/people") {
      const people: Record<string, { email: string }> = {};
      for (const sub of parsed.searchParams.getAll("sub")) people[sub] = { email: EMAILS[sub]! };
      return Response.json({ people });
    }
    const match = /^\/api\/submissions\/([^/]+)(\/files)?$/.exec(path);
    if (match?.[2]) {
      return Response.json({
        round: 1,
        files: [
          {
            path: "datapackage.json",
            size: 10,
            sha256: "a".repeat(64),
            url: `https://staging.example/held/${match[1]}/datapackage.json`,
          },
        ],
      });
    }
    if (match) {
      const two = match[1] === "s-1";
      return Response.json({
        submission: item({ submissionId: match[1] }),
        events: [
          event("entered-review", {
            outcome: two ? "two" : "one",
            audience: mine.has(match[1]!) ? "cur-1" : "all",
          }),
        ],
      });
    }
    return Response.json({}, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (document as { visibilityState?: unknown }).visibilityState;
});

/** Where the page's address stands: its query, and a Back button through its history. */
function Address() {
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="address">{useLocation().search}</output>
      <button type="button" onClick={() => navigate(-1)}>
        Back
      </button>
    </>
  );
}

function renderQueue(path = "/review") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ReviewQueue />
      <Address />
    </MemoryRouter>,
  );
}

const address = () => screen.getByTestId("address").textContent;

const statusAsked = () =>
  fetchMock.mock.calls
    .map(([url]) => new URL(String(url), "https://site"))
    .filter((url) => url.pathname === "/api/submissions")
    .map((url) => url.searchParams.get("status"));

/** The paths read under `/api/submissions/<id>`, for one submission. */
const detailReads = (id: string) =>
  fetchMock.mock.calls
    .map(([url]) => new URL(String(url), "https://site").pathname)
    .filter((path) => path === `/api/submissions/${id}`).length;

/** Lets the reads now due, and those the next `ms` brings, answer. */
async function pass(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const NINE = [
  "checking",
  "needs-changes",
  "in-review",
  "publishing",
  "published",
  "rejected",
  "abandoned",
  "expired",
  "failed",
];

test("the queue opens on what needs a decision, each row saying kind, stale, curators needed and who it's assigned to", async () => {
  renderQueue();

  const first = (await screen.findByRole("link", { name: "Title of s-1" })).closest("tr")!;
  expect(statusAsked().toSorted()).toEqual(NINE.toSorted());
  expect(first.querySelector("a")?.getAttribute("href")).toBe("/review/s-1");
  const row = within(first);
  expect(row.getByText("New version")).toBeDefined();
  expect(row.getByText("Stale")).toBeDefined();
  await waitFor(() => expect(first.textContent).toContain("1 of 2 approved"));
  await waitFor(() => expect(first.textContent).toContain("contributor@example.org"));
  expect(first.textContent).toContain("you");

  const second = (await screen.findByRole("link", { name: "Title of s-2" })).closest("tr")!;
  expect(within(second).getByText("New dataset")).toBeDefined();
  await waitFor(() => expect(second.textContent).toContain("0 of 1 approved"));
  expect(second.textContent).toContain("Any curator");
  expect(within(second).queryByText("Stale")).toBeNull();
  expect(screen.queryByText("Just arrived")).toBeNull();
});

test("each tab shows its statuses with their count, the tab kept in the address", async () => {
  lists.checking = [item({ submissionId: "s-5", status: "checking", datasetId: "snow-depth" })];
  lists.published = [item({ submissionId: "s-6", status: "published", datasetId: "buoys" })];
  lists.rejected = [item({ submissionId: "s-7", status: "rejected", datasetId: "lake-ice" })];
  renderQueue();
  await screen.findByRole("link", { name: "Title of s-1" });

  const tabs = within(screen.getByRole("navigation", { name: "Queue" }));
  const tab = (name: string) => tabs.getByRole("link", { name: new RegExp(`^${name}`) });
  expect(tab("Needs a decision").textContent).toBe("Needs a decision 2");
  expect(tab("Needs a decision").getAttribute("aria-current")).toBe("page");
  expect(tab("Being checked").textContent).toBe("Being checked 1");
  expect(tab("Changes requested").textContent).toBe("Changes requested 1");
  expect(tab("Publishing").textContent).toBe("Publishing 0");
  expect(tab("Finished").textContent).toBe("Finished 2");
  expect(tab("Finished").getAttribute("href")).toBe("/review?tab=finished");
  expect(tab("Needs a decision").getAttribute("href")).toBe("/review");

  fireEvent.click(tab("Changes requested"));
  expect(await screen.findByRole("link", { name: "stream-temperature-sample" })).toBeDefined();
  expect(screen.queryByRole("link", { name: "Title of s-1" })).toBeNull();

  fireEvent.click(tab("Finished"));
  expect(await screen.findByRole("link", { name: "buoys" })).toBeDefined();
  expect(screen.getByRole("link", { name: "lake-ice" })).toBeDefined();

  fireEvent.click(tab("Publishing"));
  expect(await screen.findByText("Nothing is publishing right now.")).toBeDefined();
});

test("a tab can be opened from the address", async () => {
  lists.checking = [item({ submissionId: "s-5", status: "checking", datasetId: "snow-depth" })];
  renderQueue("/review?tab=checking");

  expect(await screen.findByRole("link", { name: "snow-depth" })).toBeDefined();
  expect(screen.queryByRole("link", { name: /s-1/ })).toBeNull();
});

test("the queue reads again every 10 s, and a row that arrives is marked Just arrived", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  renderQueue();
  await pass();
  expect(statusAsked()).toHaveLength(9);
  expect(screen.getByText(/Up to date/)).toBeDefined();

  lists["in-review"] = [
    ...lists["in-review"]!,
    item({ submissionId: "s-4", datasetId: "snow-depth", createdAt: "2026-11-15T14:00:00Z" }),
  ];
  await pass(10_000);
  expect(statusAsked()).toHaveLength(18);
  await pass();

  const arrived = screen.getByRole("link", { name: "Title of s-4" }).closest("tr")!;
  expect(within(arrived).getByText("Just arrived")).toBeDefined();
  const first = screen.getByRole("link", { name: "Title of s-1" }).closest("tr")!;
  expect(within(first).queryByText("Just arrived")).toBeNull();

  await pass(10_000);
  expect(within(arrived).getByText("Just arrived")).toBeDefined();
});

test("a row that moves into a tab not on screen isn't marked Just arrived there", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  renderQueue();
  await pass();

  lists.published = [item({ submissionId: "s-6", status: "published", datasetId: "buoys" })];
  await pass(10_000);
  await pass();
  fireEvent.click(screen.getByRole("link", { name: /^Finished/ }));
  await pass();

  const row = screen.getByRole("link", { name: "buoys" }).closest("tr")!;
  expect(within(row).queryByText("Just arrived")).toBeNull();
});

test("a row whose details failed to read reads them again on the next tick", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const answer = fetchMock.getMockImplementation()!;
  let refuse = true;
  fetchMock.mockImplementation(async (url: string) =>
    refuse && new URL(url, "https://site").pathname === "/api/submissions/s-1"
      ? Response.json({}, { status: 500 })
      : answer(url),
  );
  renderQueue();
  await pass();
  expect(detailReads("s-1")).toBe(1);

  refuse = false;
  await pass(10_000);
  await pass();
  expect(detailReads("s-1")).toBe(2);
  const row = screen.getByRole("link", { name: "Title of s-1" }).closest("tr")!;
  expect(within(row).getByText("1 of 2 approved")).toBeDefined();
});

test("nothing is read while the tab is hidden, and the queue reads at once when it shows again", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  visibility = "hidden";
  renderQueue();
  await pass(30_000);
  expect(statusAsked()).toHaveLength(0);

  visibility = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  await pass();
  expect(statusAsked()).toHaveLength(9);
  expect(screen.getByRole("link", { name: "Title of s-1" })).toBeDefined();

  visibility = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  await pass(60_000);
  expect(statusAsked()).toHaveLength(9);
});

test("a failed read keeps the rows and says the queue couldn't be refreshed", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  renderQueue();
  await pass();

  listsFail = true;
  await pass(10_000);
  expect(screen.getByText("The queue couldn't be refreshed")).toBeDefined();
  expect(screen.getByRole("link", { name: "Title of s-1" })).toBeDefined();

  listsFail = false;
  mine = new Set(["s-1"]);
  await pass(10_000);
  expect(screen.queryByText("The queue couldn't be refreshed")).toBeNull();
  expect(screen.getByText(/Up to date/)).toBeDefined();
});

test("a row's details are read again only when its status, round or approvals change", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  renderQueue();
  await pass();
  expect(detailReads("s-1")).toBe(1);
  expect(detailReads("s-2")).toBe(1);

  lists["in-review"] = [
    item({
      submissionId: "s-1",
      submitter: "con-3",
      newVersion: true,
      stale: true,
      approvals: ["cur-2", "cur-1"],
    }),
    item({ submissionId: "s-2", submitter: "con-3", datasetId: "lake-levels" }),
  ];
  await pass(10_000);
  await pass(10_000);
  expect(detailReads("s-1")).toBe(2);
  expect(detailReads("s-2")).toBe(1);
});

/** Three in review, oldest s-3, then s-2, then s-1; s-3 from another curator, and stale. */
function threeInReview() {
  lists["in-review"] = [
    item({
      submissionId: "s-1",
      submitter: "con-3",
      newVersion: true,
      stale: true,
      createdAt: "2026-11-12T14:00:00Z",
    }),
    item({
      submissionId: "s-2",
      submitter: "con-3",
      datasetId: "lake-levels",
      createdAt: "2026-11-11T14:00:00Z",
    }),
    item({
      submissionId: "s-3",
      submitter: "cur-2",
      datasetId: "aardvark-counts",
      stale: true,
      createdAt: "2026-11-10T14:00:00Z",
    }),
  ];
}

/** The rows shown, by their dataset's name, in order. */
const rowNames = () =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.querySelector("th a")?.textContent);

async function threeShown() {
  threeInReview();
  renderQueue();
  for (const n of [1, 2, 3]) await screen.findByRole("link", { name: `Title of s-${n}` });
  await waitFor(() => expect(screen.getAllByText("second@example.org")).toHaveLength(1));
}

test("the search matches the title, the dataset id and the contributor, without case", async () => {
  await threeShown();
  const search = screen.getByLabelText("Search");

  fireEvent.change(search, { target: { value: "TITLE OF S-2" } });
  expect(rowNames()).toEqual(["Title of s-2"]);
  expect(address()).toBe("?q=TITLE+OF+S-2");

  fireEvent.change(search, { target: { value: "aardvark" } });
  expect(rowNames()).toEqual(["Title of s-3"]);

  fireEvent.change(search, { target: { value: "Contributor@" } });
  expect(rowNames()).toEqual(["Title of s-2", "Title of s-1"]);

  fireEvent.change(search, { target: { value: "" } });
  expect(rowNames()).toHaveLength(3);
  expect(address()).toBe("");
});

test("each chip narrows the rows as labelled, and two narrow together", async () => {
  await threeShown();
  const chip = (name: string) => screen.getByRole("button", { name });
  const press = (name: string) => fireEvent.click(chip(name));

  press("Assigned to me");
  expect(chip("Assigned to me").getAttribute("aria-pressed")).toBe("true");
  expect(rowNames()).toEqual(["Title of s-1"]);
  expect(address()).toBe("?chip=mine");
  press("Assigned to me");
  expect(chip("Assigned to me").getAttribute("aria-pressed")).toBe("false");

  press("New datasets");
  expect(rowNames()).toEqual(["Title of s-3", "Title of s-2"]);
  press("New datasets");

  press("New versions");
  expect(rowNames()).toEqual(["Title of s-1"]);
  press("New versions");

  press("Stale");
  expect(rowNames()).toEqual(["Title of s-3", "Title of s-1"]);
  press("New datasets");
  expect(rowNames()).toEqual(["Title of s-3"]);
  expect(address()).toBe("?chip=stale&chip=new-datasets");
});

test("each sortable heading orders the rows both ways, Waiting since oldest first by default", async () => {
  await threeShown();
  const heading = (name: string) => screen.getByRole("columnheader", { name: new RegExp(name) });
  const sort = (name: string) =>
    fireEvent.click(within(heading(name)).getByRole("button", { name }));

  expect(rowNames()).toEqual(["Title of s-3", "Title of s-2", "Title of s-1"]);
  expect(heading("Waiting since").getAttribute("aria-sort")).toBe("ascending");
  expect(heading("Dataset").getAttribute("aria-sort")).toBeNull();

  sort("Waiting since");
  expect(rowNames()).toEqual(["Title of s-1", "Title of s-2", "Title of s-3"]);
  expect(heading("Waiting since").getAttribute("aria-sort")).toBe("descending");
  expect(address()).toBe("?sort=-waiting");
  sort("Waiting since");
  expect(address()).toBe("");

  sort("Dataset");
  expect(rowNames()).toEqual(["Title of s-1", "Title of s-2", "Title of s-3"]);
  expect(heading("Dataset").getAttribute("aria-sort")).toBe("ascending");
  expect(heading("Waiting since").getAttribute("aria-sort")).toBeNull();
  sort("Dataset");
  expect(rowNames()).toEqual(["Title of s-3", "Title of s-2", "Title of s-1"]);
  expect(address()).toBe("?sort=-dataset");

  sort("Submitted by");
  expect(rowNames().at(-1)).toBe("Title of s-3");
  sort("Submitted by");
  expect(rowNames()[0]).toBe("Title of s-3");
  expect(address()).toBe("?sort=-submitter");
});

test("a view in the address is restored: tab, search, chips and sort", async () => {
  mine = new Set(["s-6", "s-7", "s-9"]);
  lists.published = [
    item({ submissionId: "s-6", status: "published", datasetId: "snow-depth" }),
    item({ submissionId: "s-8", status: "published", datasetId: "snow-melt" }),
    item({ submissionId: "s-9", status: "published", datasetId: "buoys" }),
  ];
  lists.rejected = [item({ submissionId: "s-7", status: "rejected", datasetId: "snow-pits" })];
  renderQueue("/review?tab=finished&q=snow&chip=mine&sort=-dataset");

  await waitFor(() => expect(rowNames()).toEqual(["snow-pits", "snow-depth"]));
  expect(screen.getByRole("link", { name: /^Finished/ }).getAttribute("aria-current")).toBe("page");
  expect((screen.getByLabelText("Search") as HTMLInputElement).value).toBe("snow");
  expect(screen.getByRole("button", { name: "Assigned to me" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect(screen.getByRole("columnheader", { name: /Dataset/ }).getAttribute("aria-sort")).toBe(
    "descending",
  );
});

test("Back after searching returns to the view before the search", async () => {
  await threeShown();
  fireEvent.click(screen.getByRole("link", { name: /^Being checked/ }));
  const search = screen.getByLabelText("Search");
  fireEvent.change(search, { target: { value: "l" } });
  fireEvent.change(search, { target: { value: "la" } });
  expect(address()).toBe("?tab=checking&q=la");

  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(address()).toBe("?tab=checking");
});

test("on a phone, Sort by writes the same sort to the address as the headings", async () => {
  await threeShown();
  const select = screen.getByLabelText("Sort by") as HTMLSelectElement;
  expect(select.value).toBe("waiting");

  fireEvent.change(select, { target: { value: "-dataset" } });
  expect(address()).toBe("?sort=-dataset");
  expect(rowNames()).toEqual(["Title of s-3", "Title of s-2", "Title of s-1"]);
  expect(screen.getByRole("columnheader", { name: /Dataset/ }).getAttribute("aria-sort")).toBe(
    "descending",
  );
});

test("each row's cells carry their column's name, for the phone's cards", async () => {
  renderQueue();
  const link = await screen.findByRole("link", { name: "Title of s-1" });
  const row = link.closest("tr")!;
  expect([...row.querySelectorAll("td")].map((cell) => cell.dataset.label)).toEqual([
    "Submitted by",
    "Waiting since",
    "Round",
    "Kind",
    "Curators",
    "Assigned to",
  ]);
});

test("the Finished tab shows each outcome as a badge, without Waiting since or Assigned to", async () => {
  lists.published = [item({ submissionId: "s-6", status: "published", datasetId: "buoys" })];
  lists.rejected = [
    item({ submissionId: "s-7", status: "rejected", datasetId: "lake-ice", submitter: "gone-9" }),
  ];
  renderQueue("/review?tab=finished");

  const row = (await screen.findByRole("link", { name: "lake-ice" })).closest("tr")!;
  expect(
    screen.getAllByRole("columnheader").map((cell) => cell.textContent?.replace(/[↕▲▼]/, "")),
  ).toEqual(["Dataset", "Submitted by", "Round", "Kind", "Outcome"]);
  expect(within(row).getByText("Rejected").className).toBe("badge no");
  await waitFor(() => expect(within(row).getByText("A deleted account")).toBeDefined());
  const published = screen.getByRole("link", { name: "buoys" }).closest("tr")!;
  expect(within(published).getByText("Published").className).toBe("badge ok");
});

test("while the queue loads, it shows the shared loading line", () => {
  fetchMock.mockImplementation(() => new Promise(() => {}));
  renderQueue();

  expect(screen.getByText("Loading the queue…").className).toBe("loading");
});

test("a sort the queue doesn't know falls back to the default", async () => {
  renderQueue("/review?sort=toString");
  await screen.findByRole("link", { name: "Title of s-1" });
  expect(
    screen.getByRole("columnheader", { name: /Waiting since/ }).getAttribute("aria-sort"),
  ).toBe("ascending");
});

test("when nothing matches, the page says so and clears the search and filters", async () => {
  await threeShown();
  fireEvent.click(screen.getByRole("button", { name: "New versions" }));
  fireEvent.change(screen.getByLabelText("Search"), { target: { value: "lake" } });

  expect(screen.getByText("Nothing matches the search and filters.")).toBeDefined();
  expect(screen.queryByRole("table")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Clear search and filters" }));
  expect(rowNames()).toHaveLength(3);
  expect((screen.getByLabelText("Search") as HTMLInputElement).value).toBe("");
  expect(address()).toBe("");
});

test("waiting since says how long ago, in the largest whole unit", () => {
  const now = Date.parse("2026-11-15T14:00:00Z");
  expect(waitingFor("2026-11-15T13:59:30Z", now)).toBe("under a minute");
  expect(waitingFor("2026-11-15T13:59:00Z", now)).toBe("1 minute");
  expect(waitingFor("2026-11-15T11:00:00Z", now)).toBe("3 hours");
  expect(waitingFor("2026-11-06T14:00:00Z", now)).toBe("9 days");
});

test("an axe check of the queue finds no violations", async () => {
  const { container } = renderQueue();
  await screen.findByRole("link", { name: "Title of s-1" });

  expect((await axe.run(container)).violations).toEqual([]);
});
