import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test, vi, type Mock } from "vitest";
import type { FindingsReport, SubmissionRead } from "../api";
import { AppRoutes } from "../App";
import { forgetPeople } from "../People";
import { EDITABLE, event, item, REPORT } from "../test-fixtures";
import { Review } from "./Review";

vi.mock("../auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth")>()),
  apiToken: vi.fn(() => "token"),
  signedInSub: vi.fn(() => "cur-1"),
  groups: vi.fn(() => CURATOR),
  signedInEmail: vi.fn(() => "cur@example.org"),
}));
const CURATOR = ["curator"];

const REPORT_URL = "https://staging.example/reports/s-1/1.json?sig";
const CSV = "site,when,temp\nS1,2024-06-01T00:00,11.5\nS2,2024-06-01T00:00,12.25\n";

let fetchMock: Mock;
let read: SubmissionRead;
let decision: (() => Response) | null;
let report: FindingsReport;
let edits: (() => Response) | null;
let edited: unknown[];

beforeEach(() => {
  forgetPeople();
  decision = null;
  report = REPORT;
  edits = null;
  edited = [];
  read = {
    submission: item({ submitter: "con-3" }),
    events: [
      event("created", { actor: "con-3" }),
      event("entered-review", { outcome: "one", audience: "all" }),
    ],
    reportUrl: REPORT_URL,
  };
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === REPORT_URL) return Response.json(report);
    const parsed = new URL(url, "https://site");
    if (parsed.host === "staging.example") {
      if (parsed.pathname.endsWith("datapackage.json"))
        return Response.json({ title: "Lake levels" });
      // A long file: the range answer stops partway through a line.
      return new Response(CSV + "S3,2024-06-01T00:00,1", { status: 206 });
    }
    const path = parsed.pathname;
    if (path === "/api/people") {
      return Response.json({ people: { "con-3": { email: "contributor@example.org" } } });
    }
    if (path === "/api/submissions/s-1") return Response.json(read);
    if (path === "/api/submissions/s-1/files") {
      return Response.json({
        round: 1,
        files: [
          {
            path: "datapackage.json",
            size: 10,
            sha256: "a".repeat(64),
            url: "https://staging.example/held/datapackage.json",
          },
          {
            path: "data/logger.csv",
            size: 70000,
            sha256: "b".repeat(64),
            url: "https://staging.example/held/data/logger.csv",
          },
        ],
      });
    }
    if (path === "/api/submissions/s-1/edits") {
      edited.push(JSON.parse(String(init?.body)));
      if (edits) return edits();
      return Response.json({
        submissionId: "s-1",
        round: 1,
        changes: [],
        report: { ...EDITABLE, findings: EDITABLE.findings.slice(1) },
      });
    }
    if (path === "/api/submissions/s-1/decision") {
      if (decision) return decision();
      const body = JSON.parse(String(init?.body)) as { decision: string };
      return Response.json({ submissionId: "s-1", decision: body.decision }, { status: 202 });
    }
    return Response.json({}, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderReview() {
  return render(
    <MemoryRouter>
      <Review id="s-1" />
    </MemoryRouter>,
  );
}

const decisions = () =>
  fetchMock.mock.calls
    .filter(([url]) => String(url).endsWith("/s-1/decision"))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as unknown);

test("the review page shows the title, the submitter's email, the findings, the held files and the history", async () => {
  renderReview();

  expect(await screen.findByRole("heading", { level: 1, name: "Lake levels" })).toBeDefined();
  expect(await screen.findByText("Errors (1)")).toBeDefined();
  const files = await screen.findByRole("list", { name: "Held files" });
  expect(
    within(files).getByRole("link", { name: "Download data/logger.csv" }).getAttribute("href"),
  ).toBe("https://staging.example/held/data/logger.csv");
  await waitFor(() =>
    expect(screen.getByRole("list", { name: "History" }).textContent).toContain(
      "Created by contributor@example.org",
    ),
  );
});

test("the review is headed by the title, its id under it, a Review queue trail and the badge", async () => {
  renderReview();

  const heading = await screen.findByRole("heading", { level: 1, name: "Lake levels" });
  expect(heading.nextElementSibling?.textContent).toContain("stream-temperature-sample");
  const trail = within(screen.getByRole("navigation", { name: "Breadcrumb" }));
  expect(trail.getByRole("link", { name: "Review queue" }).getAttribute("href")).toBe("/review");
  expect(trail.getByText("Lake levels").getAttribute("aria-current")).toBe("page");
  expect(screen.getByText("Waiting for a curator").className).toBe("badge wait");
  expect(screen.queryByRole("link", { name: "The review queue" })).toBeNull();
  expect(
    screen.getByText("Read the findings and the files, then decide.").closest(".callout"),
  ).not.toBeNull();
});

test("held files that make one set are grouped as the dataset page groups them", async () => {
  const files = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = new URL(url, "https://site").pathname;
    if (path === "/held/datapackage.json") {
      return Response.json({
        title: "Lake levels",
        resources: [
          {
            name: "sites",
            path: "data/sites.shp",
            "archive:files": [{ path: "data/sites.shp" }, { path: "data/sites.dbf" }],
          },
        ],
      });
    }
    if (path === "/api/submissions/s-1/files") {
      const shp = (name: string) => ({
        path: `data/${name}`,
        size: 100,
        sha256: "c".repeat(64),
        url: `https://staging.example/held/data/${name}`,
      });
      const answer = (await (await files(url, init)).json()) as { files: unknown[] };
      return Response.json({
        round: 1,
        files: [...answer.files, shp("sites.shp"), shp("sites.dbf")],
      });
    }
    return files(url, init);
  });
  renderReview();

  const list = await screen.findByRole("list", { name: "Held files" });
  const set = await within(list).findByText("Files in this set (2)");
  const entry = set.closest("li.file") as HTMLElement;
  expect(within(entry).getByRole("link", { name: "Download data/sites.dbf" })).toBeDefined();
  expect(
    within(list)
      .getAllByRole("listitem")
      .filter((li) => li.matches("li.file")),
  ).toHaveLength(3);
});

test("Request changes posts its note", async () => {
  renderReview();
  fireEvent.click(await screen.findByRole("button", { name: "Request changes" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText(/Note to the contributor/), {
    target: { value: "Give the units." },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Request changes" }));

  await waitFor(() =>
    expect(decisions()).toEqual([{ decision: "request-changes", note: "Give the units." }]),
  );
});

test("Request changes and Reject can't be confirmed without a note; Approve can", async () => {
  renderReview();
  for (const name of ["Request changes", "Reject"]) {
    fireEvent.click(await screen.findByRole("button", { name }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/Note to the contributor/), {
      target: { value: "  " },
    });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  }
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));

  await waitFor(() => expect(decisions()).toEqual([{ decision: "approve" }]));
});

test("after a first approval of a two-curator review, Approve is gone for the curator who gave it", async () => {
  read = {
    ...read,
    submission: item({ submitter: "con-3", approvals: ["cur-1"], waiting: true }),
    events: [
      event("entered-review", { outcome: "two", audience: "all" }),
      event("decided", { actor: "cur-1", decision: "approve" }),
    ],
  };
  renderReview();

  expect(await screen.findByText(/waits for a second curator/)).toBeDefined();
  expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  expect(
    (screen.getByRole("button", { name: "Request changes" }) as HTMLButtonElement).disabled,
  ).toBe(false);
});

test("after approving a one-curator review, the page says it's approved and being published, not that it waits for a second curator", async () => {
  read = {
    ...read,
    submission: item({ submitter: "con-3", approvals: ["cur-1"], waiting: false }),
    events: [
      event("entered-review", { outcome: "one", audience: "all" }),
      event("decided", { actor: "cur-1", decision: "approve" }),
    ],
  };
  renderReview();

  const summary = await screen.findByText(/You approved it; it's being published/);
  expect(summary.closest(".callout")?.className).toBe("callout done");
  expect(screen.queryByText(/second curator/)).toBeNull();
  for (const name of ["Approve", "Request changes", "Reject"]) {
    expect(screen.queryByRole("button", { name })).toBeNull();
  }
  expect(screen.getByText("Publishing").className).toBe("badge neutral");
});

test("after a curator's decision moves it on, the summary stays in place of the buttons", async () => {
  read = {
    ...read,
    submission: item({ submitter: "con-3", status: "needs-changes", waiting: true }),
    events: [
      event("entered-review", { outcome: "one", audience: "all" }),
      event("decided", { actor: "cur-1", decision: "request-changes", note: "Units." }),
    ],
  };
  renderReview();

  const summary = await screen.findByText("You asked for changes; it's back with the contributor.");
  expect(summary.closest(".callout")?.className).toBe("callout done");
  expect(screen.getByText("Changes requested").className).toBe("badge no");
});

test("after another curator rejects a review this curator approved, the page doesn't say it's being published", async () => {
  read = {
    ...read,
    submission: item({
      submitter: "con-3",
      status: "rejected",
      approvals: ["cur-1"],
      waiting: false,
    }),
    events: [
      event("entered-review", { outcome: "two", audience: "all" }),
      event("decided", { actor: "cur-1", decision: "approve" }),
      event("decided", { actor: "cur-2", decision: "reject", note: "Wrong site." }),
    ],
  };
  renderReview();

  expect(await screen.findByText("Rejected")).toBeDefined();
  expect(screen.queryByText(/You approved it/)).toBeNull();
});

test("while the pipeline isn't ready for a decision, the decision buttons wait", async () => {
  read = {
    ...read,
    submission: item({ submitter: "con-3", approvals: ["cur-2"], waiting: false }),
  };
  renderReview();

  expect(await screen.findByText("One moment…")).toBeDefined();
  expect(screen.queryByText(/getting ready/)).toBeNull();
  expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});

test("a decision answered 409 shows the API's words and Reload", async () => {
  decision = () =>
    Response.json(
      { error: "a second approval must come from a different curator" },
      { status: 409 },
    );
  renderReview();
  fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
  fireEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", { name: "Approve" }),
  );

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("a second approval must come from a different curator");
  const reads = () =>
    fetchMock.mock.calls.filter(([url]) => String(url) === "/api/submissions/s-1").length;
  const before = reads();
  fireEvent.click(screen.getByRole("button", { name: "Reload" }));
  await waitFor(() => expect(reads()).toBe(before + 1));
});

test("the preview of a CSV shows its first rows, read by range", async () => {
  renderReview();
  const preview = await screen.findByRole("button", { name: "Preview data/logger.csv" });
  expect(preview.className).toBe("");
  fireEvent.click(preview);

  const dialog = await screen.findByRole("dialog");
  const table = await within(dialog).findByRole("table");
  const rows = within(table)
    .getAllByRole("row")
    .map((row) => row.textContent);
  expect(rows).toEqual(["sitewhentemp", "S12024-06-01T00:0011.5", "S22024-06-01T00:0012.25"]);
  const [, init] = fetchMock.mock.calls.find(([url]) => String(url).endsWith("logger.csv"))!;
  expect(new Headers((init as RequestInit).headers).get("Range")).toBe("bytes=0-65535");
});

test("an axe check of the review page and its decision modal finds no violations", async () => {
  const { container } = renderReview();
  await screen.findByText("Errors (1)");
  await screen.findByRole("list", { name: "Held files" });
  expect((await axe.run(container)).violations).toEqual([]);

  fireEvent.click(screen.getByRole("button", { name: "Reject" }));
  await screen.findByRole("dialog");
  expect((await axe.run(container)).violations).toEqual([]);
});

test("a curator sees a box beside each text finding of a submission in review, and none beside the rest", async () => {
  report = EDITABLE;
  renderReview();

  expect(
    await screen.findByRole("textbox", { name: "Description of logger › battery_v" }),
  ).toBeDefined();
  const repeats = screen.getByRole("textbox", { name: "Description of logger › depth_cm" });
  expect((repeats as HTMLTextAreaElement).value).toBe("depth_cm");
  const constant = screen.getByText("Column logger_model holds one value.").closest("li")!;
  expect(within(constant).queryByRole("textbox")).toBeNull();
  // cruise is the contributor's tool: a curator is told who can fix it.
  expect(within(constant).getByText("Ask the contributor to")).toBeDefined();
  expect(screen.queryByText("Fix with cruise")).toBeNull();
});

test("there is no box on the curator's own submission, nor on one not in review", async () => {
  report = EDITABLE;
  read = { ...read, submission: item({ submitter: "cur-1" }) };
  const own = renderReview();
  await screen.findByText("Column battery_v has no description.");
  expect(screen.queryByRole("textbox", { name: /Description of/ })).toBeNull();
  own.unmount();

  read = { ...read, submission: item({ submitter: "con-3", status: "publishing" }) };
  renderReview();
  await screen.findByText("Column battery_v has no description.");
  expect(screen.queryByRole("textbox", { name: /Description of/ })).toBeNull();
});

test("a save sends only the edited field to /edits and shows the findings checked again", async () => {
  report = EDITABLE;
  renderReview();
  const box = await screen.findByRole("textbox", { name: "Description of logger › battery_v" });
  fireEvent.change(box, { target: { value: "Battery voltage at the reading." } });
  fireEvent.click(within(box.closest("form")!).getByRole("button", { name: "Save" }));

  await waitFor(() =>
    expect(screen.queryByText("Column battery_v has no description.")).toBeNull(),
  );
  expect(edited).toEqual([
    {
      edits: [
        { resource: "logger", field: "battery_v", description: "Battery voltage at the reading." },
      ],
    },
  ]);
  expect(screen.getByText("Column depth_cm's description only repeats its name.")).toBeDefined();
});

test("an edit answered 409 says the submission moved on and reads it again", async () => {
  report = EDITABLE;
  edits = () => Response.json({ error: "not in review (publishing)" }, { status: 409 });
  renderReview();
  const box = await screen.findByRole("textbox", { name: "Description of logger › battery_v" });
  const reads = () =>
    fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/api/submissions/s-1")).length;
  const before = reads();
  fireEvent.change(box, { target: { value: "Battery voltage." } });
  fireEvent.click(within(box.closest("form")!).getByRole("button", { name: "Save" }));

  expect((await screen.findByRole("alert")).textContent).toMatch(/moved on/);
  await waitFor(() => expect(reads()).toBeGreaterThan(before));
});

test("the frame doesn't move while a curator edits (PRIN1)", async () => {
  report = EDITABLE;
  render(
    <MemoryRouter initialEntries={["/review/s-1"]}>
      <AppRoutes />
    </MemoryRouter>,
  );
  const frame = () => {
    const heading = screen.getByRole("heading", { level: 1 });
    return {
      masthead: [...(screen.getByRole("banner").querySelector(".inner")?.children ?? [])].map(
        (child) => child.className,
      ),
      h1At: [...screen.getByRole("main").children].indexOf(heading),
    };
  };
  const box = await screen.findByRole("textbox", { name: "Description of logger › battery_v" });
  const expected = { masthead: ["mark", "nav", "account", "menu-button"], h1At: 1 };
  expect(frame()).toEqual(expected);
  fireEvent.change(box, { target: { value: "Battery voltage." } });
  fireEvent.click(within(box.closest("form")!).getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(screen.queryByText("Column battery_v has no description.")).toBeNull(),
  );
  expect(frame()).toEqual(expected);
});

test("an axe check of the review page with the editor finds no violations", async () => {
  report = EDITABLE;
  const { container } = renderReview();
  await screen.findByRole("textbox", { name: "Description of logger › battery_v" });
  await screen.findByRole("list", { name: "Held files" });
  await waitFor(async () => expect((await axe.run(container)).violations).toEqual([]));
});
