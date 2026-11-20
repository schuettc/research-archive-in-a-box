import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test, vi, type Mock } from "vitest";
import type { FindingsReport, SubmissionRead } from "../api";
import { checksFor, EDITABLE, event, FakeXhr, item, REPORT, sampleFiles } from "../test-fixtures";
import { Submission } from "./Submission";

vi.mock("../auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth")>()),
  apiToken: vi.fn(() => "token"),
  signedInSub: vi.fn(() => "me-1"),
  groups: vi.fn(() => CONTRIBUTOR),
}));
const CONTRIBUTOR = ["contributor"];

const REPORT_URL = "https://staging.example/reports/s-1/1.json?sig";

let fetchMock: Mock;
let reads: SubmissionRead[];
let report: FindingsReport;
let edits: (() => Response) | null;
let edited: unknown[];

function answer(...answers: SubmissionRead[]) {
  reads = answers;
}

beforeEach(() => {
  FakeXhr.sent = [];
  FakeXhr.status = 200;
  report = REPORT;
  edits = null;
  edited = [];
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  answer({
    submission: item(),
    events: [event("created", { actor: "me-1" })],
    reportUrl: REPORT_URL,
  });
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === REPORT_URL) return Response.json(report);
    const path = new URL(url, "https://site").pathname;
    if (path === "/archive-checks.json") {
      return Response.json({ profiles: ["core"], required: [], maxPackageGiB: 9 });
    }
    if (path === "/api/checks") {
      return Response.json({ findings: checksFor(JSON.parse(String(init?.body))) });
    }
    if (path === "/api/submissions/s-1")
      return Response.json(reads.length > 1 ? reads.shift() : reads[0]);
    if (path === "/api/submissions/s-1/uploads") {
      const { files } = JSON.parse(String(init?.body)) as { files: { path: string }[] };
      return Response.json({
        submissionId: "s-1",
        round: 2,
        uploads: files.map((file) => ({
          path: file.path,
          url: `https://staging.example/incoming/s-1/2/${file.path}`,
          headers: { "x-amz-checksum-sha256": "c2lnbg==" },
        })),
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
    if (path === "/api/submissions/s-1/submit") {
      return Response.json({ submissionId: "s-1", round: 2, status: "checking" }, { status: 202 });
    }
    if (path.startsWith("/api/datasets/")) return Response.json({}, { status: 404 });
    return Response.json({ error: "unexpected" }, { status: 400 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderPage() {
  return render(
    <MemoryRouter>
      <Submission id="s-1" />
    </MemoryRouter>,
  );
}

const reads$ = () =>
  fetchMock.mock.calls.filter(
    ([url]) => new URL(String(url), "https://site").pathname === "/api/submissions/s-1",
  ).length;

test("the page says where the submission stands, in one line", async () => {
  renderPage();

  expect(await screen.findByText("Waiting for a curator")).toBeDefined();
  expect(
    screen.getByRole("heading", { level: 1, name: "stream-temperature-sample" }),
  ).toBeDefined();
});

test("the page is headed by the dataset's title, its id under it, a Submissions trail and the badge", async () => {
  const dataset = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
    new URL(url, "https://site").pathname === "/api/datasets/stream-temperature-sample"
      ? Response.json({ id: "stream-temperature-sample", title: "Stream temperature" })
      : dataset(url, init),
  );
  renderPage();

  const heading = await screen.findByRole("heading", { level: 1, name: "Stream temperature" });
  expect(heading.nextElementSibling?.textContent).toBe("stream-temperature-sample");
  const trail = within(screen.getByRole("navigation", { name: "Breadcrumb" }));
  expect(trail.getByRole("link", { name: "Submissions" }).getAttribute("href")).toBe(
    "/submissions",
  );
  expect(trail.getByText("Stream temperature").getAttribute("aria-current")).toBe("page");
  expect(screen.getByText("Waiting for a curator").className).toBe("badge wait");
  expect(screen.queryByRole("link", { name: "My submissions" })).toBeNull();
});

test("findings are grouped error, warning, note, each with its target and suggested fix", async () => {
  renderPage();

  const groups = await screen.findAllByRole("heading", { level: 3 });
  expect(groups.map((heading) => heading.textContent)).toEqual([
    "Errors (1)",
    "Warnings (1)",
    "Notes (1)",
  ]);
  const errors = screen.getByRole("list", { name: "Errors" });
  expect(errors.textContent).toContain("Column site_id has values outside its codelist.");
  expect(errors.textContent).toContain("logger › site_id");
  expect(errors.textContent).toContain("Add S9 and S0 to the site codes.");
  expect(errors.textContent).toContain("rows 14, 98");
  expect(screen.getByRole("list", { name: "Notes" }).textContent).toContain("docs/methods.md");
  expect(screen.getByText(/87%/)).toBeDefined();
});

test("on changes requested, the curator's note shows and Resubmit sends round 2's files to its new links", async () => {
  answer({
    submission: item({ status: "needs-changes", waiting: true }),
    events: [
      event("created", { actor: "me-1" }),
      event("decided", { actor: "cur-1", decision: "request-changes", note: "Give the units." }),
    ],
    reportUrl: REPORT_URL,
  });
  renderPage();

  const said = await screen.findByText("The curator's note");
  expect(said.nextElementSibling?.textContent).toBe("Give the units.");
  fireEvent.click(screen.getByRole("button", { name: "Resubmit" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("Choose folder"), {
    target: { files: sampleFiles() },
  });
  fireEvent.click(await within(dialog).findByRole("button", { name: "Upload and submit" }));

  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/s-1/submit"))).toBe(true),
  );
  expect(FakeXhr.sent.length).toBeGreaterThan(0);
  expect(
    FakeXhr.sent.every((sent) => sent.url.startsWith("https://staging.example/incoming/s-1/2/")),
  ).toBe(true);
  const uploads = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/s-1/uploads"));
  expect(uploads?.[1]?.method).toBe("POST");
});

test("Resubmit fixes a description the same way: the round's manifest and checksums carry the edit", async () => {
  answer({
    submission: item({ status: "needs-changes", waiting: true }),
    events: [
      event("created", { actor: "me-1" }),
      event("decided", { actor: "cur-1", decision: "request-changes", note: "Describe depth." }),
    ],
    reportUrl: REPORT_URL,
  });
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "Resubmit" }));
  const dialog = within(await screen.findByRole("dialog"));
  fireEvent.change(dialog.getByLabelText("Choose folder"), { target: { files: sampleFiles() } });

  const box = await dialog.findByRole("textbox", { name: "Description of logger › depth_cm" });
  fireEvent.change(box, { target: { value: "Depth of the logger below the surface." } });
  fireEvent.click(within(box.closest("form")!).getByRole("button", { name: "Save" }));
  await dialog.findByText("1 field edited here");
  expect(dialog.queryByText("Column depth_cm's description only repeats its name.")).toBeNull();
  fireEvent.click(dialog.getByRole("button", { name: "Upload and submit" }));
  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/s-1/submit"))).toBe(true),
  );

  const sent = (path: string) =>
    (FakeXhr.sent.find((r) => r.url.endsWith(`/s-1/2/${path}`))!.body as Blob).text();
  expect(await sent("datapackage.json")).toContain("Depth of the logger below the surface.");
  const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/s-1/uploads"))!;
  const { files } = JSON.parse(String(call[1]!.body)) as {
    files: { path: string; sha256: string }[];
  };
  const digest = files.find((file) => file.path === "datapackage.json")!.sha256;
  expect(await sent("checksums.sha256")).toContain(`${digest}  datapackage.json`);
});

test("while the pipeline isn't ready for the next round, Resubmit waits", async () => {
  answer({
    submission: item({ status: "needs-changes", waiting: false }),
    events: [event("decided", { actor: "cur-1", decision: "request-changes", note: "Fix it." })],
    reportUrl: REPORT_URL,
  });
  renderPage();

  const button = await screen.findByRole("button", { name: "Resubmit" });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/getting ready for your next round/)).toBeDefined();
});

test("a round-1 draft whose upload didn't finish can choose the folder again for new links", async () => {
  answer({
    submission: item({ status: "draft", reportKey: null }),
    events: [event("created")],
    reportUrl: null,
  });
  renderPage();

  const button = await screen.findByRole("button", { name: "Choose the folder again" });
  expect(button.closest(".callout")).not.toBeNull();
  expect(screen.getByText("Draft").className).toBe("badge neutral");
});

test("it reloads every 10 s while checking, and stops once published", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  answer(
    { submission: item({ status: "checking" }), events: [], reportUrl: null },
    { submission: item({ status: "published" }), events: [], reportUrl: null },
  );
  renderPage();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(reads$()).toBe(1);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(reads$()).toBe(2);
  expect(screen.getByText("Published")).toBeDefined();

  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(reads$()).toBe(2);
});

test("a draft isn't read again: it changes only when the contributor acts", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  answer({ submission: item({ status: "draft", reportKey: null }), events: [], reportUrl: null });
  renderPage();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(reads$()).toBe(1);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(reads$()).toBe(1);
});

test("the history lists each event once, the reader as you", async () => {
  const created = event("created", { actor: "me-1" });
  answer({
    submission: item(),
    events: [created, event("checked", { errors: 0, warnings: 1, notes: 0 }), { ...created }],
    reportUrl: null,
  });
  renderPage();

  const history = await screen.findByRole("list", { name: "History" });
  expect(within(history).getAllByRole("listitem")).toHaveLength(2);
  expect(history.textContent).toContain("Created by you");
});

test("the submitter sees a box beside each text finding while it is in review, and none beside the rest", async () => {
  report = EDITABLE;
  renderPage();

  expect(
    await screen.findByRole("textbox", { name: "Description of logger › battery_v" }),
  ).toBeDefined();
  expect(screen.getByRole("textbox", { name: "Description of logger › depth_cm" })).toBeDefined();
  const constant = screen.getByText("Column logger_model holds one value.").closest("li")!;
  expect(within(constant).queryByRole("textbox")).toBeNull();
  expect(within(constant).getByText("Fix with cruise:")).toBeDefined();
});

test.each(["draft", "checking", "needs-changes", "publishing", "published"] as const)(
  "there is no box while the submission is %s",
  async (status) => {
    report = EDITABLE;
    answer({
      submission: item({ status, waiting: false }),
      events: [event("created", { actor: "me-1" })],
      reportUrl: REPORT_URL,
    });
    renderPage();

    await screen.findByText("Column battery_v has no description.");
    expect(screen.queryByRole("textbox", { name: /Description of/ })).toBeNull();
  },
);

test("a save sends the edit, shows the findings checked again and reads the history again", async () => {
  report = EDITABLE;
  answer(
    { submission: item(), events: [event("created", { actor: "me-1" })], reportUrl: REPORT_URL },
    {
      submission: item(),
      events: [
        event("created", { actor: "me-1" }),
        event("edited", {
          actor: "me-1",
          changes: [
            {
              resource: "logger",
              field: "battery_v",
              property: "description",
              before: null,
              after: "Battery voltage at the reading.",
            },
          ],
        }),
      ],
      reportUrl: REPORT_URL,
    },
  );
  renderPage();
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
  const history = screen.getByRole("list", { name: "History" });
  await waitFor(() => expect(history.textContent).toContain("Battery voltage at the reading."));
});

test("an edit answered 409 says the submission moved on and reads it again", async () => {
  report = EDITABLE;
  edits = () => Response.json({ error: "not in review (publishing)" }, { status: 409 });
  renderPage();
  const box = await screen.findByRole("textbox", { name: "Description of logger › battery_v" });
  const before = reads$();
  fireEvent.change(box, { target: { value: "Battery voltage." } });
  fireEvent.click(within(box.closest("form")!).getByRole("button", { name: "Save" }));

  expect((await screen.findByRole("alert")).textContent).toMatch(/moved on/);
  await waitFor(() => expect(reads$()).toBeGreaterThan(before));
});

test("an axe check of the submission page finds no violations", async () => {
  const { container } = renderPage();
  await screen.findByText("Errors (1)");

  expect((await axe.run(container)).violations).toEqual([]);
});
