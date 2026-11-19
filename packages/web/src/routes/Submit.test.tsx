import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { afterEach, beforeEach, expect, test, vi, type Mock } from "vitest";
import type { Finding } from "../api";
import { AppRoutes } from "../App";
import { checksFor, editedSample, FakeXhr, sampleFiles } from "../test-fixtures";
import { Submit } from "./Submit";

vi.mock("../auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth")>()),
  apiToken: vi.fn(() => "token"),
  signedInSub: vi.fn(() => "me-1"),
  groups: vi.fn(() => CONTRIBUTOR),
  signedInEmail: vi.fn(() => "me@example.org"),
}));
const CONTRIBUTOR = ["contributor"];

/** What the next `/api/checks` adds to the findings it works out from the manifest. */
let extraFindings: Finding[] = [];
let checked: Record<string, unknown>[] = [];
/** The limit the archive publishes in `/archive-checks.json`. */
let maxPackageGiB = 9;
/** Whether the sample's dataset is already in the catalog. */
let published = false;

const STAGING = "https://staging.example/incoming/s-1/1/";
const b64 = (hex: string) =>
  btoa(String.fromCharCode(...hex.match(/../g)!.map((h) => parseInt(h, 16))));

let fetchMock: Mock;
let progressAtSubmit: string | null = null;
let created: { files: { path: string; size: number; sha256: string }[]; datasetId: string } | null;

beforeEach(() => {
  FakeXhr.sent = [];
  FakeXhr.status = 200;
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  created = null;
  progressAtSubmit = null;
  extraFindings = [];
  checked = [];
  maxPackageGiB = 9;
  published = false;
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, "https://site").pathname;
    if (path === "/archive-checks.json") {
      return Response.json({ profiles: ["core"], required: [], maxPackageGiB });
    }
    if (path === "/api/checks" && init?.method === "POST") {
      const manifest = JSON.parse(String(init.body)) as Record<string, unknown>;
      checked.push(manifest);
      return Response.json({ findings: [...checksFor(manifest), ...extraFindings] });
    }
    if (path === "/api/datasets/stream-temperature-sample")
      return published
        ? Response.json({ id: "stream-temperature-sample" })
        : Response.json({}, { status: 404 });
    if (path === "/api/submissions" && init?.method === "POST") {
      created = JSON.parse(String(init.body));
      return Response.json(
        {
          submissionId: "s-1",
          round: 1,
          uploads: created!.files.map((file) => ({
            path: file.path,
            url: STAGING + file.path,
            headers: { "x-amz-checksum-sha256": b64(file.sha256) },
          })),
        },
        { status: 201 },
      );
    }
    if (path === "/api/submissions/s-1/submit") {
      progressAtSubmit = screen
        .getByRole("progressbar", { name: "All files" })
        .getAttribute("value");
      return Response.json({ submissionId: "s-1", round: 1, status: "checking" }, { status: 202 });
    }
    return Response.json({ error: "unexpected" }, { status: 400 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Arrived() {
  const { id } = useParams();
  return <p>Arrived at {id}</p>;
}

function renderSubmit() {
  return render(
    <MemoryRouter initialEntries={["/submit"]}>
      <Routes>
        <Route path="/submit" element={<Submit />} />
        <Route path="/submissions/:id" element={<Arrived />} />
      </Routes>
    </MemoryRouter>,
  );
}

function choose(files: File[]) {
  fireEvent.change(screen.getByLabelText("Choose folder"), { target: { files } });
}

test("the sample folder is checked, created as a new dataset, uploaded with each checksum and submitted", async () => {
  renderSubmit();
  choose(sampleFiles());

  expect(await screen.findByText("New dataset")).toBeDefined();
  expect(screen.getByText("Stream temperature at three invented sites")).toBeDefined();
  expect(screen.getByText(/_build\/make\.py/)).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Upload and submit" }));

  expect(await screen.findByText("Arrived at s-1")).toBeDefined();
  expect(created?.datasetId).toBe("stream-temperature-sample");
  expect(created?.files.map((file) => file.path)).toContain("checksums.sha256");
  expect(FakeXhr.sent).toHaveLength(created!.files.length);
  for (const sent of FakeXhr.sent) {
    const file = created!.files.find((f) => STAGING + f.path === sent.url)!;
    expect(sent.method).toBe("PUT");
    expect(sent.headers["x-amz-checksum-sha256"]).toBe(b64(file.sha256));
  }
  expect(progressAtSubmit).toBe("100");
});

test("a folder that is already published reads as a new version", async () => {
  published = true;
  renderSubmit();
  choose(sampleFiles());

  expect(await screen.findByText(/New version of/)).toBeDefined();
});

test("a folder without checksums.sha256 is refused before anything is sent", async () => {
  renderSubmit();
  choose(sampleFiles({}, ["checksums.sha256"]));

  expect((await screen.findByRole("alert")).textContent).toMatch(/no checksums\.sha256/);
  expect(screen.queryByRole("button", { name: "Upload and submit" })).toBeNull();
  // Nothing but the read of the archive's limit.
  expect(new Set(fetchMock.mock.calls.map(([url]) => url))).toEqual(
    new Set(["/archive-checks.json"]),
  );
});

/** The bytes of the file sent to `path`'s link. */
async function sentText(path: string): Promise<string> {
  const sent = FakeXhr.sent.find((request) => request.url === STAGING + path);
  return (sent!.body as Blob).text();
}

test("a missing description gets a box; saving it re-checks, clears it, and the upload carries the text", async () => {
  renderSubmit();
  choose(sampleFiles());

  const box = await screen.findByRole("textbox", { name: "Description of logger › battery_v" });
  expect(screen.getByText("Column battery_v has no description.")).toBeDefined();
  fireEvent.change(box, { target: { value: "Battery voltage at the reading." } });
  fireEvent.click(within(box.closest("form")!).getByRole("button", { name: "Save" }));

  await waitFor(() =>
    expect(screen.queryByText("Column battery_v has no description.")).toBeNull(),
  );
  expect(checked).toHaveLength(2);
  expect(screen.getByText("1 field edited here")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Upload and submit" }));
  await screen.findByText("Arrived at s-1");

  const manifest = JSON.parse(await sentText("datapackage.json")) as {
    resources: { name: string; schema?: { fields: { name: string; description?: string }[] } }[];
  };
  const logger = manifest.resources.find((r) => r.name === "logger")!;
  expect(logger.schema!.fields.find((f) => f.name === "battery_v")!.description).toBe(
    "Battery voltage at the reading.",
  );
});

test("saving a field the manifest doesn't have shows an error, not Saved, and edits nothing", async () => {
  extraFindings = [
    {
      ruleId: "field.description-missing",
      severity: "warning",
      message: "Column ghost has no description.",
      target: { resource: "logger", field: "ghost", path: null },
      evidence: null,
      suggestedFix: null,
    },
  ];
  renderSubmit();
  choose(sampleFiles());

  const box = await screen.findByRole("textbox", { name: "Description of logger › ghost" });
  fireEvent.change(box, { target: { value: "A ghost." } });
  fireEvent.click(within(box.closest("form")!).getByRole("button", { name: "Save" }));

  expect((await screen.findByRole("alert")).textContent).toMatch(/ghost/);
  expect(screen.queryByText(/^Saved/)).toBeNull();
  expect(screen.queryByText(/edited here/)).toBeNull();
  expect(checked).toHaveLength(1);
});

test("the uploaded checksums line for datapackage.json matches the edited bytes, and no other line changes", async () => {
  renderSubmit();
  choose(sampleFiles());
  const box = await screen.findByRole("textbox", { name: "Description of logger › battery_v" });
  fireEvent.change(box, { target: { value: "Battery voltage." } });
  fireEvent.click(within(box.closest("form")!).getByRole("button", { name: "Save" }));
  await screen.findByText("1 field edited here");
  fireEvent.click(screen.getByRole("button", { name: "Upload and submit" }));
  await screen.findByText("Arrived at s-1");

  const original = (
    await sampleFiles()
      .find((f) => f.name === "checksums.sha256")!
      .text()
  ).split("\n");
  const sums = (await sentText("checksums.sha256")).split("\n");
  const digest = created!.files.find((file) => file.path === "datapackage.json")!.sha256;
  const bytes = new TextEncoder().encode(await sentText("datapackage.json"));
  const hashed = await crypto.subtle.digest("SHA-256", bytes);
  expect(digest).toBe(
    [...new Uint8Array(hashed)].map((b) => b.toString(16).padStart(2, "0")).join(""),
  );
  expect(sums).toHaveLength(original.length);
  for (const [index, line] of sums.entries()) {
    expect(line).toBe(
      line.endsWith("  datapackage.json") ? `${digest}  datapackage.json` : original[index],
    );
  }
  expect(created!.files.find((file) => file.path === "checksums.sha256")!.sha256).not.toBe(
    original.join("\n"),
  );
});

test("a unit finding gets a unit box", async () => {
  renderSubmit();
  choose(
    editedSample((fields) => delete fields.find((f) => f.name === "water_temp_c")!["archive:unit"]),
  );

  const box = await screen.findByRole("textbox", { name: "Unit of logger › water_temp_c" });
  expect(box.tagName).toBe("INPUT");
});

test("a finding the editor can't fix has no box and says Fix with cruise", async () => {
  extraFindings = [
    {
      ruleId: "values.constant",
      severity: "warning",
      message: "Column logger_model holds one value in every row.",
      target: { resource: "logger", field: "logger_model", path: null },
      evidence: null,
      suggestedFix: "Drop logger_model, or move its value to the description.",
    },
  ];
  renderSubmit();
  choose(sampleFiles());

  const message = await screen.findByText("Column logger_model holds one value in every row.");
  const finding = message.closest("li")!;
  expect(within(finding).queryByRole("textbox")).toBeNull();
  expect(within(finding).getByText("Fix with cruise:")).toBeDefined();
  expect(within(finding).getByText(/Drop logger_model/)).toBeDefined();
});

test("the frame doesn't move while a folder is read, checked and edited (PRIN1)", async () => {
  render(
    <MemoryRouter initialEntries={["/submit"]}>
      <AppRoutes />
    </MemoryRouter>,
  );
  const frame = () => {
    const heading = screen.getByRole("heading", { level: 1 });
    return {
      masthead: [...(screen.getByRole("banner").querySelector(".inner")?.children ?? [])].map(
        (child) => child.className,
      ),
      h1: heading.textContent,
      h1At: [...screen.getByRole("main").children].indexOf(heading),
    };
  };
  const expected = frame();
  expect(expected.h1).toBe("Submit a package");
  expect(expected.h1At).toBe(1);

  choose(sampleFiles());
  const box = await screen.findByRole("textbox", { name: "Description of logger › battery_v" });
  expect(frame()).toEqual(expected);
  fireEvent.change(box, { target: { value: "Battery voltage." } });
  fireEvent.click(within(box.closest("form")!).getByRole("button", { name: "Save" }));
  await screen.findByText("1 field edited here");
  expect(frame()).toEqual(expected);
});

test("a changed file is named and stops the submission", async () => {
  renderSubmit();
  choose(sampleFiles({ "data/logger.csv": "changed\n" }));

  expect((await screen.findByRole("alert")).textContent).toContain(
    "data/logger.csv doesn't match its checksum",
  );
  expect(screen.queryByRole("button", { name: "Upload and submit" })).toBeNull();
});

test("an upload S3 refuses says so and offers Try again", async () => {
  FakeXhr.status = 403;
  renderSubmit();
  choose(sampleFiles());
  fireEvent.click(await screen.findByRole("button", { name: "Upload and submit" }));

  expect((await screen.findByRole("alert")).textContent).toMatch(/upload/i);
  expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
});

test("an upload that stops says how many files arrived, and links to the draft it made", async () => {
  // The first two files arrive; the third is refused.
  let puts = 0;
  vi.stubGlobal(
    "XMLHttpRequest",
    class extends FakeXhr {
      override send(body: Blob) {
        puts += 1;
        FakeXhr.status = puts === 3 ? 403 : 200;
        super.send(body);
      }
    },
  );
  renderSubmit();
  choose(sampleFiles());
  fireEvent.click(await screen.findByRole("button", { name: "Upload and submit" }));

  const alert = await screen.findByRole("alert");
  const box = alert.closest(".callout")!;
  expect(box.className).toBe("callout failed");
  expect(alert.textContent).toMatch(/^The upload stopped: .+ was refused/);
  expect(box.textContent).toContain("Your draft is saved with the 2 files that did arrive.");
  expect(
    within(box as HTMLElement)
      .getByRole("link", { name: "Open the draft" })
      .getAttribute("href"),
  ).toBe("/submissions/s-1");
  expect(within(box as HTMLElement).getByRole("button", { name: "Try again" })).toBeDefined();
  expect(screen.getByText("Didn't arrive")).toBeDefined();
});

test("the submit page sits under Submissions, with a trail back and no intro link", () => {
  renderSubmit();

  const trail = within(screen.getByRole("navigation", { name: "Breadcrumb" }));
  expect(trail.getByRole("link", { name: "Submissions" }).getAttribute("href")).toBe(
    "/submissions",
  );
  expect(trail.getByText("Submit a package").getAttribute("aria-current")).toBe("page");
  expect(screen.queryByRole("link", { name: "My submissions" })).toBeNull();
});

test("an axe check of the choose and ready steps finds no violations", async () => {
  const { container } = renderSubmit();
  expect((await axe.run(container)).violations).toEqual([]);

  choose(sampleFiles());
  await screen.findByText("New dataset");
  await screen.findByRole("textbox", { name: "Description of logger › battery_v" });
  await waitFor(async () => expect((await axe.run(container)).violations).toEqual([]));
});

test("the submit page says nothing is sent until Upload and submit, and that dropping avoids the browser's prompt", async () => {
  renderSubmit();

  expect(
    await screen.findByText(/Nothing leaves your computer until you press Upload and submit/),
  ).toBeDefined();
  expect(screen.getByText(/dropping the folder here doesn't/)).toBeDefined();
});

test("the page says how large a package may be", async () => {
  renderSubmit();

  expect(await screen.findByText("Packages up to 9 GiB.")).toBeDefined();
});

test("a folder over the archive's limit is refused before anything is hashed or sent", async () => {
  maxPackageGiB = 0;
  renderSubmit();
  choose(sampleFiles());

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toMatch(
    /^This package's files total .+, more than the 0 GiB this archive takes\.$/,
  );
  expect(created).toBeNull();
});
