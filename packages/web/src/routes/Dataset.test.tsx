import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import type { Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test, vi, type Mock } from "vitest";
import type { DatasetAccess, DatasetAnswer, VersionAnswer, VersionsAnswer } from "../api";
import { apiToken, groups, selfSignUp, signIn } from "../auth";
import type { Manifest } from "../generated/manifest";
import { mount } from "../main";
import { Dataset } from "./Dataset";

const NO_GROUPS: string[] = [];
vi.mock("../auth", () => ({
  apiToken: vi.fn(() => null),
  signIn: vi.fn(async () => {}),
  subscribe: vi.fn(() => () => {}),
  signedInEmail: vi.fn(() => null),
  groups: vi.fn(() => NO_GROUPS),
  selfSignUp: vi.fn(),
}));

const SAMPLE = join(import.meta.dirname, "../../../../examples/sample-package");
const MANIFEST = JSON.parse(readFileSync(join(SAMPLE, "datapackage.json"), "utf-8")) as Manifest;
const ID = "stream-temperature-sample";

const DATASET: DatasetAnswer = {
  id: ID,
  title: MANIFEST.title ?? "",
  access: "public",
  currentVersion: 1,
  prefix: `open/${ID}/1/`,
  manifest: MANIFEST,
  files: [],
  project: null,
};
const VERSION: VersionAnswer = {
  version: 1,
  prefix: `open/${ID}/1/`,
  manifest: MANIFEST,
  files: [],
  publishedAt: "2024-07-01T12:00:00Z",
};
const VERSIONS: VersionsAnswer = {
  versions: [
    { version: 1, prefix: `open/${ID}/1/` },
    { version: 2, prefix: `open/${ID}/2/` },
  ],
};

const RESTRICTED_ID = "restricted-sample";
const RESTRICTED: DatasetAnswer = {
  ...DATASET,
  id: RESTRICTED_ID,
  access: "limited",
  prefix: `restricted/${RESTRICTED_ID}/1/`,
  manifest: { ...MANIFEST, "archive:access": "limited" },
};

const CLOSED_ID = "closed-sample";
const CLOSED: DatasetAnswer = {
  ...DATASET,
  id: CLOSED_ID,
  access: "restricted",
  prefix: `restricted/${CLOSED_ID}/1/`,
  manifest: { ...MANIFEST, "archive:access": "restricted" },
};

const NONE: DatasetAccess = {
  datasetId: CLOSED_ID,
  state: "none",
  decidedAt: null,
  note: null,
  reason: null,
  requestedAt: null,
  takenBackAt: null,
  until: null,
};

let fetchMock: Mock;
/** What `/api/datasets/{ID}` and its version 1 answer; a test may change them. */
let dataset: DatasetAnswer = DATASET;
let version1: VersionAnswer = VERSION;
let downloadStatus = 200;
let downloadReason: string | null = null;
/** What the withdraw and restore routes answer with: 200 (and the change), or a refusal. */
let curationStatus = 200;
let access: DatasetAccess = NONE;

function apiAnswers(): Mock {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, "https://site").pathname;
    if (path === `/api/datasets/${CLOSED_ID}/access-requests`) {
      const { reason } = JSON.parse(String(init?.body)) as { reason: string };
      access = { ...NONE, state: "waiting", reason, requestedAt: "2026-11-15T10:00:00Z" };
      return Response.json(access, { status: 201 });
    }
    if (
      path === `/api/admin/datasets/${ID}/withdraw` ||
      path === `/api/admin/datasets/${ID}/restore`
    ) {
      if (curationStatus !== 200) {
        return Response.json({ error: "dataset is already withdrawn" }, { status: curationStatus });
      }
      const withdrawn = path.endsWith("/withdraw")
        ? {
            at: "2026-12-03T10:00:00Z",
            by: "sub-admin",
            reason: (JSON.parse(String(init?.body)) as { reason: string }).reason,
          }
        : null;
      dataset = { ...dataset, withdrawn };
      return Response.json({ datasetId: ID, withdrawn });
    }
    if (init?.method === "POST") return new Response(null, { status: 204 });
    if (path === `/api/datasets/${CLOSED_ID}`) return Response.json(CLOSED);
    if (path === `/api/datasets/${CLOSED_ID}/access`) return Response.json(access);
    if (path === `/api/datasets/${ID}`) return Response.json(dataset);
    if (path === `/api/datasets/${ID}/versions/1`) return Response.json(version1);
    if (path === `/api/datasets/${ID}/versions`) return Response.json(VERSIONS);
    if (path === `/api/datasets/${RESTRICTED_ID}`) return Response.json(RESTRICTED);
    if (path === `/api/datasets/${RESTRICTED_ID}/versions/1/download`) {
      if (downloadStatus !== 200) {
        return Response.json(downloadReason ? { error: downloadReason } : {}, {
          status: downloadStatus,
        });
      }
      return Response.json({ url: "https://bucket.example/restricted/logger.csv?sig" });
    }
    return Response.json({ message: "not found" }, { status: 404 });
  });
}

function renderDataset(version?: number, id = ID, from?: string) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: `/datasets/${id}`, state: from ? { from } : null }]}>
      <Dataset id={id} version={version} />
    </MemoryRouter>,
  );
}

/** The Files list's item whose title is `title`. */
function itemOf(files: HTMLElement, title: string): HTMLElement {
  const item = [...files.querySelectorAll(":scope > li")].find(
    (li) => li.querySelector(".file-title")?.textContent === title,
  );
  if (!item) throw new Error(`no file item titled ${title}`);
  return item as HTMLElement;
}

async function filesList(): Promise<HTMLElement> {
  await screen.findByRole("heading", { level: 1, name: MANIFEST.title ?? "" });
  return screen.getByRole("list", { name: "Files" });
}

const LOGGER = /^Download Logger readings \(\d/;

beforeEach(() => {
  fetchMock = apiAnswers();
  vi.stubGlobal("fetch", fetchMock);
  sessionStorage.clear();
  dataset = DATASET;
  version1 = VERSION;
  curationStatus = 200;
  vi.mocked(groups).mockReturnValue(NO_GROUPS);
  downloadStatus = 200;
  downloadReason = null;
  access = NONE;
  vi.mocked(apiToken).mockReturnValue(null);
  vi.mocked(signIn).mockClear();
  vi.mocked(selfSignUp).mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

test("every resource is a card with its kind, size and one download button", async () => {
  renderDataset();
  const files = await filesList();

  for (const resource of MANIFEST.resources ?? []) {
    const item = itemOf(files, resource.title ?? resource.name);
    expect(item.className).toContain("file");
    expect(item.textContent).toContain(resource["archive:kind"] ?? "");
  }
  const logger = within(files).getByRole("link", { name: LOGGER });
  expect(logger.getAttribute("href")).toBe(`/data/${ID}/1/data/logger.csv`);
  expect(logger.className).toContain("button");
  expect(logger.textContent).toContain("3.4 kB");
  const sites = itemOf(files, "Sites");
  expect(within(sites).getByText("Files in this set (4)").closest("details")).not.toBeNull();
  expect(
    within(sites).getByRole("link", { name: /^Download data\/sites\/sites.dbf/ }),
  ).toBeDefined();
  const linked = within(files).getByRole("link", { name: "Open link Discharge" });
  expect(linked.getAttribute("href")).toBe("https://example.org/stream-temperature/discharge.csv");
});

test("Download all and a multi-file row's Download fetch the version's zips", async () => {
  renderDataset();
  const files = await filesList();

  const all = within(screen.getByTestId("summary-strip")).getByRole("link", {
    name: /^Download all/,
  });
  expect(all.getAttribute("href")).toBe(`/data/${ID}/1/_zips/all/package.zip`);
  const sites = itemOf(files, "Sites");
  const whole = within(sites).getByRole("link", { name: /^Download Sites/ });
  expect(whole.getAttribute("href")).toBe(`/data/${ID}/1/_zips/sites.zip`);
  expect(whole.textContent).toContain("zip");
  expect(within(sites).getByText("Files in this set (4)").closest("details")).not.toBeNull();
  const logger = within(files).getByRole("link", { name: LOGGER });
  expect(logger.getAttribute("href")).toBe(`/data/${ID}/1/data/logger.csv`);
});

test("signed in on a limited page, Download all asks the API for the package zip", async () => {
  vi.mocked(apiToken).mockReturnValue("TOKEN");
  renderDataset(undefined, RESTRICTED_ID);
  await filesList();

  fireEvent.click(
    within(screen.getByTestId("summary-strip")).getByRole("button", { name: /^Download all/ }),
  );

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  const [url] = fetchMock.mock.calls[2] as [string, RequestInit];
  expect(url).toBe(
    `/api/datasets/${RESTRICTED_ID}/versions/1/download?path=_zips%2Fall%2Fpackage.zip`,
  );
});

test("the page leads with the meta line, then the summary strip, files, columns and about", async () => {
  renderDataset();
  await filesList();

  const meta = screen.getByTestId("meta");
  for (const text of ["Ada Invented", "Version 1", "CC BY 4.0"]) {
    expect(meta.textContent).toContain(text);
  }
  const summary = screen.getByTestId("summary");
  expect(summary.textContent).toMatch(/12 files · 50\.\d kB/);
  const order = ["Files", "Columns", "About"].map((name) =>
    screen.getByRole("heading", { level: 2, name }),
  );
  expect(
    order[0]!.compareDocumentPosition(order[1]!) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    order[1]!.compareDocumentPosition(order[2]!) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

test("the citation is the README's with the versioned URL, and Copy inside its box writes it", async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  renderDataset();
  await filesList();

  const readme = readFileSync(join(SAMPLE, "README.md"), "utf-8").split("\n");
  const expected = `${readme[readme.indexOf("## Citation") + 2]} ${location.origin}/datasets/${ID}/v1`;
  const section = screen.getByRole("region", { name: "Cite this dataset" });
  // The address is split into pieces to break after slashes; the paragraph reads whole.
  const cite = within(section).getByText(
    (_, element) => element?.tagName === "P" && element.textContent === expected,
  );
  const box = cite.closest(".citation") as HTMLElement;
  fireEvent.click(within(box).getByRole("button", { name: "Copy" }));

  await waitFor(() => expect(writeText).toHaveBeenCalledWith(expected));
  expect(await within(box).findByText("Copied ✓")).toBeDefined();
});

test("arriving from Browse, the trail leads back to the results, keeping the query and filters", async () => {
  renderDataset(undefined, ID, "?q=temperature&access=open");
  await filesList();

  const trail = within(screen.getByRole("navigation", { name: "Breadcrumb" }));
  expect(trail.getByRole("link", { name: "Browse" }).getAttribute("href")).toBe("/");
  expect(trail.getByRole("link", { name: "results for “temperature”" }).getAttribute("href")).toBe(
    "/?q=temperature&access=open",
  );
  expect(trail.getByText(MANIFEST.title ?? "").getAttribute("aria-current")).toBe("page");
});

test("reached directly, the trail is Browse, then the dataset", async () => {
  renderDataset();
  await filesList();

  const trail = within(screen.getByRole("navigation", { name: "Breadcrumb" }));
  expect(trail.getAllByRole("link").map((link) => link.textContent)).toEqual(["Browse"]);
});

test("Cite and Versions come after Files and before Columns, so a phone reads them in that order", async () => {
  renderDataset();
  await filesList();

  const [files, cite, columns] = ["Files", "Cite this dataset", "Columns"].map((name) =>
    screen.getByRole("heading", { level: 2, name }),
  );
  expect(files!.compareDocumentPosition(cite!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(cite!.compareDocumentPosition(columns!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("the citation's address may break only after its slashes", async () => {
  renderDataset();
  await filesList();

  const url = screen.getByRole("region", { name: "Cite this dataset" }).querySelector(".url")!;
  expect(url.textContent).toBe(`${location.origin}/datasets/${ID}/v1`);
  const breaks = [...url.querySelectorAll("wbr")].map((wbr) => wbr.previousSibling?.textContent);
  expect(breaks.length).toBeGreaterThan(0);
  expect(breaks.every((text) => text?.endsWith("/"))).toBe(true);
});

test("each column's cells carry their heading's name, for the phone's cards", async () => {
  renderDataset();
  await filesList();

  const table = screen.getByRole("table", { name: "Columns of Logger readings" });
  const row = within(table).getAllByRole("row")[1]!;
  expect([...row.querySelectorAll("td")].map((cell) => cell.dataset.label)).toEqual([
    "Title",
    "Type",
    "Unit",
    "Description",
    "Codes",
  ]);
});

test("About shows the facts and Methods, and the columns tidy their dictionary", async () => {
  renderDataset();
  await filesList();

  const about = screen.getByRole("region", { name: "About" });
  for (const text of ["Ada Invented", "CC BY 4.0", "stream temperature", "2024-06-01 to ongoing"]) {
    expect(about.textContent).toContain(text);
  }
  expect(within(about).getByText("Methods")).toBeDefined();
  expect(about.textContent).toContain("Hourly loggers with field checks");

  const logger = screen.getByRole("table", { name: "Columns of Logger readings" });
  expect(logger.closest("details")?.open).toBe(true);
  expect(logger.closest("details")?.querySelector("summary")?.textContent).toContain("9 columns");
  const row = (name: string) => within(logger).getByText(name).closest("tr") as HTMLElement;
  expect(row("battery_v").textContent).toContain("No description");
  expect(row("depth_cm").textContent).toContain("No description");
  expect(row("qc_flag").textContent).toContain("No code list");
  const codes = within(row("condition")).getByRole("link", { name: "condition-codes" });
  const target = document.getElementById(codes.getAttribute("href")?.slice(1) ?? "");
  expect(target?.textContent).toContain("Logger condition codes");
});

test("spatial coverage shows its description, then the box on an outline, then the numbers", async () => {
  renderDataset();
  await filesList();

  const about = screen.getByRole("region", { name: "About" });
  const map = within(about).getByRole("img", { name: /area the data covers/ });
  expect(map.tagName.toLowerCase()).toBe("svg");
  const text = about.textContent ?? "";
  expect(text.indexOf("Three invented sites")).toBeLessThan(text.indexOf("West -72.74"));
});

test("the versions list marks the version the citation points at", async () => {
  renderDataset(1);

  const versions = await screen.findByRole("region", { name: "Versions" });
  const items = within(versions).getAllByRole("listitem");
  expect(items).toHaveLength(2);
  expect(items[0]?.textContent).toContain("cited above");
  expect(items[1]?.textContent).not.toContain("cited above");
  expect(within(items[1]!).getByRole("link").getAttribute("href")).toBe(`/datasets/${ID}/v2`);
});

test("the versioned route shows a note linking to the newer version", async () => {
  renderDataset(1);

  const note = await screen.findByText(/A newer version of this dataset exists/);
  expect(within(note).getByRole("link").getAttribute("href")).toBe(`/datasets/${ID}/v2`);
  expect(screen.getByTestId("meta").textContent).toContain("Published 2024-07-01");
});

test("on the versioned route, an open prefix with no archive:access gives a plain /data link", async () => {
  const unsaid = { ...MANIFEST };
  delete unsaid["archive:access"];
  version1 = { ...VERSION, manifest: unsaid };
  renderDataset(1);
  const files = await filesList();

  const logger = within(files).getByRole("link", { name: LOGGER });
  expect(logger.getAttribute("href")).toBe(`/data/${ID}/1/data/logger.csv`);
});

test("after a download the usage question opens as a modal dialog, outside the page, and sends the answers", async () => {
  renderDataset();
  const files = await filesList();
  expect(screen.queryByRole("dialog", { name: /how will you use this data/ })).toBeNull();

  fireEvent.click(within(files).getByRole("link", { name: LOGGER }));
  const panel = screen.getByRole("dialog", { name: /how will you use this data/ });
  // Opened modally, so it overlays the page instead of pushing the files down.
  expect(panel.tagName).toBe("DIALOG");
  expect(panel.hasAttribute("open")).toBe(true);
  expect(files.contains(panel)).toBe(false);
  expect(within(panel).getByText(/Your download has started/)).toBeDefined();
  fireEvent.change(within(panel).getByLabelText("Kind of organisation"), {
    target: { value: "university" },
  });
  fireEvent.change(within(panel).getByLabelText("Purpose"), { target: { value: "teaching" } });
  fireEvent.change(within(panel).getByLabelText(/^Note/), { target: { value: "A class" } });
  fireEvent.click(within(panel).getByRole("button", { name: "Send" }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  const [url, init] = fetchMock.mock.calls[2] as [string, RequestInit];
  expect(url).toBe(`/api/datasets/${ID}/usage`);
  expect(init.method).toBe("POST");
  expect(JSON.parse(String(init.body))).toEqual({
    organisation: "university",
    purpose: "teaching",
    note: "A class",
  });
  expect(await screen.findByText("Thanks, your answers were sent anonymously.")).toBeDefined();
});

test("after No thanks the usage panel stays gone for the visit", async () => {
  renderDataset();
  const files = await filesList();
  const download = within(files).getByRole("link", { name: LOGGER });

  fireEvent.click(download);
  fireEvent.click(screen.getByRole("button", { name: "No thanks" }));
  expect(screen.queryByRole("dialog", { name: /how will you use this data/ })).toBeNull();
  fireEvent.click(download);

  expect(screen.queryByRole("dialog", { name: /how will you use this data/ })).toBeNull();
  cleanup();
  renderDataset();
  fireEvent.click(within(await filesList()).getByRole("link", { name: LOGGER }));
  expect(screen.queryByRole("dialog", { name: /how will you use this data/ })).toBeNull();
});

/** The access callout, by its label. */
const callout = (label: string) => screen.queryByRole("region", { name: label });

/** The paths the page fetched, in order. */
const fetched = () =>
  fetchMock.mock.calls.map(([url]) => new URL(url as string, "https://site").pathname);

test("signed out, a limited page offers Sign in and Create an account", async () => {
  renderDataset(undefined, RESTRICTED_ID);
  const files = await filesList();

  const banner = callout("Limited")!;
  expect(banner.className).toBe("callout");
  expect(banner.textContent).toContain(
    "The files need an account. Anyone can create one; the description and the columns stay public.",
  );
  const actions = within(banner).getByRole("button", { name: "Sign in" }).closest(".actions");
  expect(actions).not.toBeNull();
  const create = within(actions as HTMLElement).getByRole("link", { name: "Create an account" });
  expect(create.getAttribute("href")).toBe(
    `/sign-in?view=create&next=${encodeURIComponent(`/datasets/${RESTRICTED_ID}`)}`,
  );
  const signIns = screen.getAllByRole("button", { name: /sign in/i });
  expect(signIns).toHaveLength(1);
  expect(within(itemOf(files, "Logger readings")).getByText("Sign in above")).toBeDefined();
  expect(within(files).queryByRole("link", { name: LOGGER })).toBeNull();
  expect(fetched()).not.toContain(`/api/datasets/${RESTRICTED_ID}/access`);

  fireEvent.click(signIns[0]!);
  expect(signIn).toHaveBeenCalledWith(`/datasets/${RESTRICTED_ID}`);
});

test("on a stage with sign-up off, a limited page says accounts are by invitation and offers only Sign in", async () => {
  vi.mocked(selfSignUp).mockResolvedValue(false);
  renderDataset(undefined, RESTRICTED_ID);
  await filesList();

  const banner = callout("Limited")!;
  expect(banner.textContent).toContain(
    "The files need an account. Accounts for this archive are by invitation; the description and the columns stay public.",
  );
  expect(within(banner).getByRole("button", { name: "Sign in" })).toBeDefined();
  expect(within(banner).queryByRole("link", { name: "Create an account" })).toBeNull();
});

test("on a stage with sign-up off, a restricted page says to sign in to ask for access", async () => {
  vi.mocked(selfSignUp).mockResolvedValue(false);
  renderDataset(undefined, CLOSED_ID);
  await filesList();

  const banner = callout("Restricted")!;
  expect(within(banner).getByText("Sign in to ask for access.")).toBeDefined();
  expect(banner.textContent).toContain(
    "The files are shared with people an admin approves. The description and the columns stay public.",
  );
  expect(within(banner).getByRole("button", { name: "Sign in" })).toBeDefined();
  expect(within(banner).queryByRole("link", { name: "Create an account" })).toBeNull();
});

test("the page no longer says accounts are by invitation", async () => {
  renderDataset(undefined, RESTRICTED_ID);
  await filesList();
  expect(document.body.textContent).not.toContain("by invitation");
  expect(document.body.textContent).not.toContain("no sign-up");
});

test("signed in, a limited page has no callout, only the label in the meta line", async () => {
  vi.mocked(apiToken).mockReturnValue("TOKEN");
  renderDataset(undefined, RESTRICTED_ID);
  await filesList();

  expect(callout("Limited")).toBeNull();
  const meta = screen.getByTestId("meta");
  expect(meta.querySelector(".access")?.textContent).toBe("Limited");
  expect(fetched()).not.toContain(`/api/datasets/${RESTRICTED_ID}/access`);
});

test("signed out, a restricted page asks the reader to sign in or create an account to ask", async () => {
  renderDataset(undefined, CLOSED_ID);
  await filesList();

  const banner = await screen.findByRole("region", { name: "Restricted" });
  expect(banner.textContent).toContain(
    "The files are shared with people an admin approves. The description and the columns stay public.",
  );
  expect(banner.textContent).toContain("Sign in or create an account to ask for access.");
  expect(within(banner).getByRole("button", { name: "Sign in" })).toBeDefined();
  expect(within(banner).getByRole("link", { name: "Create an account" })).toBeDefined();
  expect(fetched()).not.toContain(`/api/datasets/${CLOSED_ID}/access`);
  expect(screen.getByTestId("meta").querySelector(".access")).toBeNull();
});

test("signed in and not asked yet, Request access opens a reason box and Send request asks", async () => {
  vi.mocked(apiToken).mockReturnValue("TOKEN");
  renderDataset(undefined, CLOSED_ID);
  await filesList();

  const banner = await screen.findByRole("region", { name: "Restricted" });
  fireEvent.click(await within(banner).findByRole("button", { name: "Request access" }));
  const reason = within(banner).getByRole("textbox", { name: /What will you use it for\?/ });
  expect(within(banner).getByRole("button", { name: "Cancel" })).toBeDefined();
  fireEvent.change(reason, { target: { value: "For my thesis on winter range." } });
  fireEvent.click(within(banner).getByRole("button", { name: "Send request" }));

  expect(await within(banner).findByRole("status")).toBeDefined();
  const post = fetchMock.mock.calls.find(([url]) =>
    String(url).endsWith(`/api/datasets/${CLOSED_ID}/access-requests`),
  ) as [string, RequestInit];
  expect(post[1].method).toBe("POST");
  expect(JSON.parse(String(post[1].body))).toEqual({ reason: "For my thesis on winter range." });
  expect(new Headers(post[1].headers).get("Authorization")).toBe("Bearer TOKEN");
});

test("Cancel closes the reason box without asking", async () => {
  vi.mocked(apiToken).mockReturnValue("TOKEN");
  renderDataset(undefined, CLOSED_ID);
  await filesList();

  const banner = await screen.findByRole("region", { name: "Restricted" });
  fireEvent.click(await within(banner).findByRole("button", { name: "Request access" }));
  fireEvent.click(within(banner).getByRole("button", { name: "Cancel" }));

  expect(within(banner).queryByRole("textbox")).toBeNull();
  expect(within(banner).getByRole("button", { name: "Request access" })).toBeDefined();
  expect(fetched()).not.toContain(`/api/datasets/${CLOSED_ID}/access-requests`);
});

test("a waiting request says when the reader asked and that the answer will show here", async () => {
  vi.mocked(apiToken).mockReturnValue("TOKEN");
  access = { ...NONE, state: "waiting", requestedAt: "2026-11-15T10:00:00Z" };
  renderDataset(undefined, CLOSED_ID);
  await filesList();

  const status = await within(await screen.findByRole("region", { name: "Restricted" })).findByRole(
    "status",
  );
  expect(status.textContent).toBe("You asked for access on 15 Nov. The answer will show here.");
  expect(within(callout("Restricted")!).queryByRole("button")).toBeNull();
});

test("a declined request shows the admin's note and Ask again", async () => {
  vi.mocked(apiToken).mockReturnValue("TOKEN");
  access = {
    ...NONE,
    state: "declined",
    decidedAt: "2026-11-16T09:00:00Z",
    note: "Please ask through Audubon VT's data agreement.",
  };
  renderDataset(undefined, CLOSED_ID);
  await filesList();

  const banner = await screen.findByRole("region", { name: "Restricted" });
  const again = await within(banner).findByRole("button", { name: "Ask again" });
  expect(banner.textContent).toContain(
    "An admin declined your request on 16 Nov: Please ask through Audubon VT's data agreement.",
  );
  expect(banner.querySelector("q")?.textContent).toBe(
    "Please ask through Audubon VT's data agreement.",
  );
  fireEvent.click(again);
  expect(within(banner).getByRole("textbox", { name: /What will you use it for\?/ })).toBeDefined();
});

test.each([
  ["ended", { until: "2026-08-01" }],
  ["taken-back", { until: "2027-05-31", takenBackAt: "2026-08-01T15:00:00Z" }],
] as const)("an approval %s offers Request access again", async (state, dates) => {
  vi.mocked(apiToken).mockReturnValue("TOKEN");
  access = { ...NONE, state, ...dates };
  renderDataset(undefined, CLOSED_ID);
  await filesList();

  const banner = await screen.findByRole("region", { name: "Restricted" });
  const again = await within(banner).findByRole("button", { name: "Request access again" });
  expect(banner.textContent).toContain("Your access ended on 1 Aug 2026.");
  fireEvent.click(again);
  expect(within(banner).getByRole("textbox", { name: /What will you use it for\?/ })).toBeDefined();
});

test("approved until a date, there's no callout, only the label and the end date", async () => {
  vi.mocked(apiToken).mockReturnValue("TOKEN");
  access = { ...NONE, state: "approved", until: "2027-05-31" };
  renderDataset(undefined, CLOSED_ID);
  await filesList();

  expect(await screen.findByText("You have access until 31 May 2027.")).toBeDefined();
  expect(callout("Restricted")).toBeNull();
  expect(screen.getByTestId("meta").querySelector(".access")?.textContent).toBe("Restricted");
});

test("approved with no end, there's no callout and nothing beyond the label", async () => {
  vi.mocked(apiToken).mockReturnValue("TOKEN");
  access = { ...NONE, state: "approved" };
  renderDataset(undefined, CLOSED_ID);
  await filesList();

  await waitFor(() =>
    expect(screen.getByTestId("meta").querySelector(".access")?.textContent).toBe("Restricted"),
  );
  expect(callout("Restricted")).toBeNull();
  expect(screen.queryByText(/You have access/)).toBeNull();
});

test("a description-only page keeps its callout", async () => {
  vi.mocked(apiToken).mockReturnValue("TOKEN");
  const only = { ...CLOSED, access: "description-only" };
  fetchMock.mockImplementation(async (url: string) => {
    const path = new URL(url, "https://site").pathname;
    if (path === `/api/datasets/${CLOSED_ID}`) return Response.json(only);
    return Response.json({}, { status: 404 });
  });
  renderDataset(undefined, CLOSED_ID);
  await filesList();

  expect(callout("Description only")?.textContent).toContain(
    "This archive holds the description of this dataset, not its files.",
  );
  expect(fetched()).not.toContain(`/api/datasets/${CLOSED_ID}/access`);
});

test("signed in, a limited download asks the API for its link with the access token", async () => {
  vi.mocked(apiToken).mockReturnValue("TOKEN");
  renderDataset(undefined, RESTRICTED_ID);
  const files = await filesList();

  fireEvent.click(within(files).getByRole("button", { name: LOGGER }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  const [url, init] = fetchMock.mock.calls[2] as [string, RequestInit];
  expect(url).toBe(`/api/datasets/${RESTRICTED_ID}/versions/1/download?path=data%2Flogger.csv`);
  expect(new Headers(init.headers).get("Authorization")).toBe("Bearer TOKEN");
  expect(await screen.findByRole("dialog", { name: /how will you use this data/ })).toBeDefined();
});

test("a 401 asks the reader to sign in again", async () => {
  vi.mocked(apiToken).mockReturnValue("TOKEN");
  downloadStatus = 401;
  renderDataset(undefined, RESTRICTED_ID);
  const files = await filesList();

  fireEvent.click(within(files).getByRole("button", { name: LOGGER }));

  expect(await within(files).findByText("Your sign-in has expired.")).toBeDefined();
  fireEvent.click(within(files).getByRole("button", { name: "Sign in again Logger readings" }));
  expect(signIn).toHaveBeenCalledWith(`/datasets/${RESTRICTED_ID}`);
});

test.each([
  ["sign in first", "Sign in first."],
  ["your account is disabled", "Your account is disabled."],
  ["ask for access", "Ask for access."],
  ["your request is waiting", "Your request is waiting."],
  ["your request was declined", "Your request was declined."],
  ["your access ended", "Your access ended."],
])("a download refused with %j says so", async (reason, shown) => {
  vi.mocked(apiToken).mockReturnValue("TOKEN");
  downloadStatus = 403;
  downloadReason = reason;
  renderDataset(undefined, RESTRICTED_ID);
  const files = await filesList();

  fireEvent.click(within(files).getByRole("button", { name: LOGGER }));

  expect(await within(files).findByText(shown)).toBeDefined();
});

test("a 403 without a reason says the file isn't available to this account", async () => {
  vi.mocked(apiToken).mockReturnValue("TOKEN");
  downloadStatus = 403;
  renderDataset(undefined, RESTRICTED_ID);
  const files = await filesList();

  fireEvent.click(within(files).getByRole("button", { name: LOGGER }));

  expect(
    await within(files).findByText("This file isn't available to this account."),
  ).toBeDefined();
});

test("an unreachable API keeps an h1 and offers Try again, search and the current page", async () => {
  fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  renderDataset(1);

  expect(
    await screen.findByRole("heading", { level: 1, name: "Dataset unavailable" }),
  ).toBeDefined();
  expect(screen.getByRole("link", { name: "Search the archive" }).getAttribute("href")).toBe("/");
  expect(screen.getByRole("link", { name: /current version/ }).getAttribute("href")).toBe(
    `/datasets/${ID}`,
  );
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));

  expect(
    await screen.findByRole("heading", { level: 1, name: MANIFEST.title ?? "" }),
  ).toBeDefined();
});

test("a version that isn't there links to the current one", async () => {
  renderDataset(9);

  expect(await screen.findByRole("heading", { level: 1, name: "Version not found" })).toBeDefined();
  expect(screen.getByRole("link", { name: /current version/ }).getAttribute("href")).toBe(
    `/datasets/${ID}`,
  );
});

// 5xx is ApiUnreachable already; any other refusal (429 here) isn't a missing version either.
test("a refusal other than 404 on a versioned link offers Try again, not Version not found", async () => {
  const answers = apiAnswers();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
    new URL(url, "https://site").pathname === `/api/datasets/${ID}/versions/1`
      ? Response.json({ message: "slow down" }, { status: 429 })
      : answers(url, init),
  );
  renderDataset(1);

  expect(
    await screen.findByRole("heading", { level: 1, name: "Dataset unavailable" }),
  ).toBeDefined();
  expect(screen.queryByText("Version not found")).toBeNull();
  fetchMock.mockImplementation(answers);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));

  expect(
    await screen.findByRole("heading", { level: 1, name: MANIFEST.title ?? "" }),
  ).toBeDefined();
});

test("a refusal other than 404 on a dataset reads as unavailable, not as no such dataset", async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ message: "slow down" }, { status: 429 }));
  renderDataset();

  expect(
    await screen.findByRole("heading", { level: 1, name: "Dataset unavailable" }),
  ).toBeDefined();
});

test("on a static dataset page, the static content stays when the API can't be reached", async () => {
  fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
  document.body.innerHTML = '<div id="app"><h1>Static title</h1></div>';
  history.pushState({}, "", `/datasets/${ID}`);
  const app = document.getElementById("app") as HTMLElement;

  let root: Root | undefined;
  await act(async () => {
    root = mount(app);
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  expect(fetchMock).toHaveBeenCalled();
  expect(app.innerHTML).toBe("<h1>Static title</h1>");
  act(() => root?.unmount());
});

test("on a static dataset page, the app renders over it once it has the dataset", async () => {
  document.body.innerHTML = '<div id="app"><h1>Static title</h1></div>';
  history.pushState({}, "", `/datasets/${ID}`);
  const app = document.getElementById("app") as HTMLElement;

  let root: Root | undefined;
  act(() => {
    root = mount(app);
  });

  await waitFor(() => expect(app.querySelector("h1")?.textContent).toBe(MANIFEST.title ?? ""));
  expect(app.textContent).not.toContain("Static title");
  act(() => root?.unmount());
});

const DOI = "10.5072/irc.stream-temperature-sample.v1";
const WITH_DOI: Manifest = {
  ...MANIFEST,
  "archive:citation": null,
  created: "2024-06-01T00:00:00Z",
  "archive:identifier": `https://doi.org/${DOI}`,
};

/** A `data:` URL's text. */
const dataText = (href: string) => decodeURIComponent(href.slice(href.indexOf(",") + 1));

test("with a DOI, the page shows it under the meta line and cites its address", async () => {
  dataset = { ...DATASET, manifest: WITH_DOI };
  renderDataset();
  await filesList();

  const doi = screen.getByRole("link", { name: DOI });
  expect(doi.getAttribute("href")).toBe(`https://doi.org/${DOI}`);
  const line = doi.closest("p") as HTMLElement;
  expect(line.className).toBe("doi");
  expect(line.textContent).toBe(`DOI ${DOI}`);
  expect(
    screen.getByTestId("meta").compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  const section = screen.getByRole("region", { name: "Cite this dataset" });
  expect(section.textContent).toContain(`https://doi.org/${DOI}`);
  expect(section.textContent).not.toContain(`/datasets/${ID}/v1`);
});

test("without a DOI, there's no DOI line", async () => {
  renderDataset();
  await filesList();

  expect(document.querySelector(".doi")).toBeNull();
});

test("BibTeX and RIS sit beside Copy, as files named for the dataset's version", async () => {
  dataset = { ...DATASET, manifest: WITH_DOI };
  renderDataset();
  await filesList();

  const section = screen.getByRole("region", { name: "Cite this dataset" });
  const row = within(section).getByRole("button", { name: "Copy" }).closest(".cite-formats");
  expect(row).not.toBeNull();
  const bib = within(row as HTMLElement).getByRole("link", { name: "BibTeX" });
  expect(bib.getAttribute("download")).toBe(`${ID}-v1.bib`);
  expect(bib.getAttribute("href")).toMatch(/^data:application\/x-bibtex;charset=utf-8,/);
  const bibText = dataText(bib.getAttribute("href") ?? "");
  expect(bibText).toContain(`@misc{${ID}_v1,`);
  expect(bibText).toContain("  author = {{Ada Invented}},");
  expect(bibText).toContain(`  doi = {${DOI}},`);
  const risLink = within(row as HTMLElement).getByRole("link", { name: "RIS" });
  expect(risLink.getAttribute("download")).toBe(`${ID}-v1.ris`);
  expect(risLink.getAttribute("href")).toMatch(
    /^data:application\/x-research-info-systems;charset=utf-8,/,
  );
  const risText = dataText(risLink.getAttribute("href") ?? "");
  expect(risText.startsWith("TY  - DATA\r\nAU  - Ada Invented\r\n")).toBe(true);
  expect(risText).toContain(`UR  - https://doi.org/${DOI}\r\n`);
});

test("an axe check of a page with a DOI and the citation files finds no violations", async () => {
  dataset = { ...DATASET, manifest: WITH_DOI };
  const { container } = renderDataset();
  await filesList();

  const results = await axe.run(container);
  expect(results.violations).toEqual([]);
});

test.each([
  [1, "1 download"],
  [412, "412 downloads"],
  [1204, "1,204 downloads"],
])("a total of %i reads %s, last in the meta line", async (downloads, words) => {
  dataset = { ...DATASET, downloads };
  renderDataset();
  await filesList();

  const meta = screen.getByTestId("meta").textContent ?? "";
  expect(meta.endsWith(` · ${words}`)).toBe(true);
});

test("with no total, the meta line says nothing of downloads", async () => {
  renderDataset();
  await filesList();

  expect(screen.getByTestId("meta").textContent).not.toContain("download");
});

test("the versioned page reads the total from the dataset too", async () => {
  dataset = { ...DATASET, downloads: 7 };
  renderDataset(1);
  await filesList();

  expect(screen.getByTestId("meta").textContent).toContain("7 downloads");
});

const CREATORS: Manifest = {
  ...MANIFEST,
  contributors: [
    {
      title: "Ada Invented",
      orcid: "0000-0002-1825-0097",
      organization: "Example Lab",
      organizationId: "https://ror.org/03yrm5c26",
      roles: ["creator"],
    },
    { title: "Bo Example", roles: ["creator"] },
    { title: "Cy Placeholder", organization: "Invented University", roles: ["creator"] },
    { title: "Di Solo", organizationId: "https://ror.org/05dxps055", roles: ["creator"] },
    { title: "Ben Placeholder", roles: ["data-curator"] },
  ],
};

test("About's creators each have a line with their ORCID iD and affiliation", async () => {
  dataset = { ...DATASET, manifest: CREATORS };
  renderDataset();
  await filesList();

  const about = screen.getByRole("region", { name: "About" });
  const lines = [...within(about).getByText("Creators").nextElementSibling!.querySelectorAll("li")];
  expect(lines.map((li) => li.textContent)).toEqual([
    "Ada Invented iD 0000-0002-1825-0097 · Example Lab",
    "Bo Example",
    "Cy Placeholder · Invented University",
    "Di Solo · https://ror.org/05dxps055",
  ]);
  const orcid = within(lines[0]!).getByRole("link", { name: "ORCID iD 0000-0002-1825-0097" });
  expect(orcid.getAttribute("href")).toBe("https://orcid.org/0000-0002-1825-0097");
  expect(orcid.className).toBe("orcid");
  expect(orcid.querySelector("[aria-hidden='true']")?.textContent).toBe("iD");
  // Its accessible name holds all of its visible text, the iD mark's included.
  expect(orcid.getAttribute("aria-label")).toContain(orcid.textContent);
  expect(within(lines[0]!).getByRole("link", { name: "Example Lab" }).getAttribute("href")).toBe(
    "https://ror.org/03yrm5c26",
  );
  expect(within(lines[2]!).queryByRole("link")).toBeNull();
  expect(
    within(lines[3]!).getByRole("link", { name: "https://ror.org/05dxps055" }).getAttribute("href"),
  ).toBe("https://ror.org/05dxps055");
  expect(screen.getByTestId("meta").textContent).not.toContain("0000-0002");
});

const CORRECTED: Manifest = {
  ...MANIFEST,
  "archive:metadataHistory": [
    {
      when: "2026-11-18T09:00:00Z",
      who: "sub-1",
      fields: ["description"],
      note: "fixed the site count (three, not four).",
    },
    {
      when: "2026-11-20T10:00:00Z",
      who: "sub-2",
      fields: ["archive:relatedIdentifiers", "contributors", "colour"],
      note: "added the paper that cites it.",
    },
  ],
};

test("Corrections follow About, newest first: the date, the fields in words and the note", async () => {
  dataset = { ...DATASET, manifest: CORRECTED };
  renderDataset();
  await filesList();

  const section = screen.getByRole("region", { name: "Corrections" });
  const about = screen.getByRole("region", { name: "About" });
  expect(about.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const items = within(section).getAllByRole("listitem");
  expect(items.map((li) => li.textContent)).toEqual([
    "2026-11-20Related, Creators, colour: added the paper that cites it.",
    "2026-11-18Description: fixed the site count (three, not four).",
  ]);
  expect(items[0]!.querySelector("time")?.getAttribute("datetime")).toBe("2026-11-20");
});

test("with no corrections, there's no Corrections section", async () => {
  renderDataset();
  await filesList();

  expect(screen.queryByRole("region", { name: "Corrections" })).toBeNull();
});

test("an axe check of creators' iDs, the total and Corrections finds no violations", async () => {
  dataset = {
    ...DATASET,
    downloads: 412,
    manifest: { ...CREATORS, "archive:metadataHistory": CORRECTED["archive:metadataHistory"] },
  };
  const { container } = renderDataset();
  await filesList();

  // label-content-name-mismatch is experimental, so off unless asked for (jsdom has no layout,
  // so axe leaves it incomplete here; the creators test checks the name holds the visible text).
  const results = await axe.run(container, {
    rules: { "label-content-name-mismatch": { enabled: true } },
  });
  expect(results.violations).toEqual([]);
});

/** A `YYYY-MM-DD` day `days` from today, in UTC. */
function dayFromToday(days: number): string {
  const day = new Date();
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
}

/** A `YYYY-MM-DD` day as the page writes it: "1 June 2027". */
const longDay = (day: string) =>
  new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00Z`));

test("under an embargo until tomorrow, the notice gives the date and every file says it", async () => {
  const until = dayFromToday(1);
  dataset = { ...DATASET, embargoUntil: until };
  renderDataset();
  const files = await filesList();

  const notice = screen.getByRole("region", { name: "Embargoed" });
  expect(notice.className).toBe("callout");
  expect(notice.textContent).toBe(
    `Files available from ${longDay(until)}. The description, columns and citation are public now; the files are released on that date.`,
  );
  const lede = document.querySelector(".lede") as HTMLElement;
  expect(lede.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(files).queryAllByRole("link")).toEqual([]);
  expect(within(files).queryAllByRole("button")).toEqual([]);
  for (const resource of MANIFEST.resources ?? []) {
    const item = itemOf(files, resource.title ?? resource.name);
    expect(item.querySelector(".file-action")?.textContent).toBe(`From ${longDay(until)}`);
  }
  const sites = itemOf(files, "Sites");
  for (const member of sites.querySelectorAll(".members li")) {
    expect(member.querySelector(".file-note")?.textContent).toBe(`From ${longDay(until)}`);
  }
  expect(within(screen.getByTestId("summary-strip")).queryByText(/Download all/)).toBeNull();
  expect(document.querySelector('a[href^="/data/"]')).toBeNull();
});

test("on the embargo's own day the files are out and download as usual", async () => {
  dataset = { ...DATASET, embargoUntil: dayFromToday(0) };
  renderDataset();
  const files = await filesList();

  expect(screen.queryByRole("region", { name: "Embargoed" })).toBeNull();
  expect(within(files).getByRole("link", { name: LOGGER })).toBeDefined();
});

test("a version's own embargo date, later than the dataset's, is the one that holds", async () => {
  const later = dayFromToday(30);
  dataset = { ...DATASET, embargoUntil: dayFromToday(2) };
  version1 = { ...VERSION, manifest: { ...MANIFEST, "archive:embargoUntil": later } };
  renderDataset(1);
  await filesList();

  expect(screen.getByRole("region", { name: "Embargoed" }).textContent).toContain(
    `Files available from ${longDay(later)}.`,
  );
});

const WITHDRAWAL = {
  at: "2026-12-03T10:00:00Z",
  by: "sub-admin",
  reason: "the site owners withdrew consent to share the locations.",
};

test("a withdrawn dataset shows the withdrawn page: badge, reason, citation and versions", async () => {
  dataset = { ...DATASET, withdrawn: WITHDRAWAL, downloads: 9 };
  renderDataset();
  await screen.findByRole("heading", { level: 1, name: MANIFEST.title ?? "" });

  expect(screen.getByRole("navigation", { name: "Breadcrumb" }).textContent).toContain("Browse");
  const badge = screen.getByText("Withdrawn", { selector: ".badge" });
  expect(badge.className).toBe("badge no");
  expect(badge.closest(".status-row")?.textContent).toContain("2026-12-03");
  const callout = screen.getByRole("region", { name: "Withdrawn" });
  expect(callout.className).toBe("callout failed");
  expect([...callout.querySelectorAll("p")].map((p) => p.textContent)).toEqual([
    "This dataset has been withdrawn.",
    `Reason: ${WITHDRAWAL.reason}`,
    "Its files are no longer available. This page stays so that citations of it still lead somewhere.",
  ]);
  const cite = screen.getByRole("region", { name: "Cite this dataset" });
  for (const name of ["BibTeX", "RIS"])
    expect(within(cite).getByRole("link", { name })).toBeDefined();
  expect(within(cite).getByRole("button", { name: "Copy" })).toBeDefined();
  const meta = screen.getByTestId("meta").textContent;
  expect(meta).toBe("Ada Invented · Versions 1 and 2, both withdrawn");
  for (const name of ["Files", "Columns", "About", "Versions", "Corrections"]) {
    expect(screen.queryByRole("heading", { level: 2, name })).toBeNull();
  }
  expect(document.querySelector('a[href^="/data/"], a.download, button.download')).toBeNull();
  expect(document.body.textContent).not.toContain("download");
});

test.each([
  [[1], "Version 1, withdrawn"],
  [[1, 2], "Versions 1 and 2, both withdrawn"],
  [[1, 2, 3], "Versions 1, 2 and 3, all withdrawn"],
])("withdrawn with versions %j, the meta line says %s", async (numbers, words) => {
  dataset = { ...DATASET, withdrawn: WITHDRAWAL };
  fetchMock.mockImplementation(async (url: string) => {
    const path = new URL(url, "https://site").pathname;
    if (path === `/api/datasets/${ID}`) return Response.json(dataset);
    if (path === `/api/datasets/${ID}/versions`) {
      return Response.json({
        versions: numbers.map((version) => ({
          version,
          prefix: `open/${ID}/${version}/`,
          publishedAt: version === 1 ? "2024-07-01T12:00:00Z" : null,
        })),
      });
    }
    return Response.json({ message: "not found" }, { status: 404 });
  });
  renderDataset();
  await screen.findByRole("heading", { level: 1, name: MANIFEST.title ?? "" });

  expect(screen.getByTestId("meta").textContent).toBe(
    `Ada Invented · Published 2024-07-01 · ${words}`,
  );
});

test("every version's address shows the withdrawn page", async () => {
  dataset = { ...DATASET, withdrawn: WITHDRAWAL };
  renderDataset(1);
  await screen.findByRole("heading", { level: 1, name: MANIFEST.title ?? "" });

  expect(screen.getByRole("region", { name: "Withdrawn" })).toBeDefined();
  expect(screen.queryByRole("heading", { level: 2, name: "Files" })).toBeNull();
});

test("an axe check of the embargoed page finds no violations", async () => {
  dataset = { ...DATASET, embargoUntil: dayFromToday(5) };
  const { container } = renderDataset();
  await filesList();

  const results = await axe.run(container);
  expect(results.violations).toEqual([]);
});

test("an axe check of the withdrawn page finds no violations", async () => {
  dataset = { ...DATASET, withdrawn: WITHDRAWAL };
  const { container } = renderDataset();
  await screen.findByRole("heading", { level: 1, name: MANIFEST.title ?? "" });

  const results = await axe.run(container);
  expect(results.violations).toEqual([]);
});

/** The calls made to a path, with their method, body and Authorization header. */
function callsTo(path: string) {
  return (fetchMock.mock.calls as [string, RequestInit?][])
    .filter(([url]) => new URL(url, "https://site").pathname === path)
    .map(([, init]) => ({
      method: init?.method ?? "GET",
      body: init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined,
      auth: new Headers(init?.headers).get("Authorization"),
    }));
}

const BAR = "You can correct this dataset's details. Files and access stay as published.";

test("a curator sees the bar with Correct details, and no Withdraw", async () => {
  vi.mocked(groups).mockReturnValue(["curator"]);
  renderDataset();
  await filesList();

  const bar = screen.getByText(BAR).closest(".curator-bar") as HTMLElement;
  expect(within(bar).getByRole("link", { name: "Correct details" }).getAttribute("href")).toBe(
    `/datasets/${ID}/v1/correct`,
  );
  expect(within(bar).queryByRole("button", { name: "Withdraw…" })).toBeNull();
  const meta = screen.getByTestId("meta");
  expect(meta.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("an admin sees Correct details and Withdraw…, in the danger style", async () => {
  vi.mocked(groups).mockReturnValue(["admin"]);
  renderDataset();
  await filesList();

  const bar = screen.getByText(BAR).closest(".curator-bar") as HTMLElement;
  expect(within(bar).getByRole("link", { name: "Correct details" })).toBeDefined();
  expect(within(bar).getByRole("button", { name: "Withdraw…" }).className).toBe("danger");
});

test.each([[[]], [["contributor"]]])("a reader in %j sees no bar", async (mine) => {
  vi.mocked(groups).mockReturnValue(mine);
  renderDataset();
  await filesList();

  expect(screen.queryByText(BAR)).toBeNull();
  expect(screen.queryByRole("link", { name: "Correct details" })).toBeNull();
});

test("a withdrawn page has no bar", async () => {
  vi.mocked(groups).mockReturnValue(["admin", "curator"]);
  dataset = { ...DATASET, withdrawn: WITHDRAWAL };
  renderDataset();
  await screen.findByRole("region", { name: "Withdrawn" });

  expect(screen.queryByText(BAR)).toBeNull();
});

async function openWithdraw() {
  vi.mocked(groups).mockReturnValue(["admin"]);
  vi.mocked(apiToken).mockReturnValue("TOKEN");
  const { container } = renderDataset();
  await filesList();
  const button = screen.getByRole("button", { name: "Withdraw…" });
  button.focus();
  fireEvent.click(button);
  const dialog = await screen.findByRole("dialog", { name: "Withdraw this dataset?" });
  return { button, dialog, container };
}

test("with a DOI, the withdraw dialog says the page and its DOI stay", async () => {
  dataset = { ...DATASET, manifest: WITH_DOI };
  const { dialog } = await openWithdraw();

  expect(dialog.textContent).toContain(
    "Its page and its DOI stay, saying it was withdrawn and why.",
  );
});

test("Withdraw sends the reason with the ID token, then the page shows it withdrawn", async () => {
  const { dialog } = await openWithdraw();

  expect(dialog.textContent).toContain(`${MANIFEST.title}, all versions.`);
  expect(dialog.textContent).toContain(
    "Its page stays, saying it was withdrawn and why. Its files stop being served but are kept, and an admin can restore it.",
  );
  fireEvent.change(within(dialog).getByLabelText(/^Reason/), {
    target: { value: "Consent withdrawn." },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Withdraw" }));

  await screen.findByRole("region", { name: "Withdrawn" });
  expect(callsTo(`/api/admin/datasets/${ID}/withdraw`)).toEqual([
    { method: "POST", body: { reason: "Consent withdrawn." }, auth: "Bearer TOKEN" },
  ]);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByText("Reason: Consent withdrawn.")).toBeDefined();
});

test("an empty reason says to give one, and sends nothing", async () => {
  const { dialog } = await openWithdraw();

  fireEvent.click(within(dialog).getByRole("button", { name: "Withdraw" }));

  const field = within(dialog).getByLabelText(/^Reason/);
  const error = await within(dialog).findByText("Give a reason; it's shown on the page.");
  expect(field.getAttribute("aria-invalid")).toBe("true");
  expect(field.getAttribute("aria-describedby")).toBe(error.id);
  expect(callsTo(`/api/admin/datasets/${ID}/withdraw`)).toEqual([]);
});

test("a 409 shows the API's words in the dialog and reloads the page behind it", async () => {
  curationStatus = 409;
  const { dialog } = await openWithdraw();
  const reads = callsTo(`/api/datasets/${ID}`).length;

  fireEvent.change(within(dialog).getByLabelText(/^Reason/), { target: { value: "Again." } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Withdraw" }));

  expect(await within(dialog).findByRole("alert")).toHaveProperty(
    "textContent",
    "Dataset is already withdrawn.",
  );
  await waitFor(() => expect(callsTo(`/api/datasets/${ID}`).length).toBeGreaterThan(reads));
  expect(screen.getByRole("dialog", { name: "Withdraw this dataset?" })).toBe(dialog);
});

test("Escape closes the withdraw dialog and returns focus to its button", async () => {
  const { button, dialog } = await openWithdraw();

  fireEvent(dialog, new Event("cancel", { cancelable: true }));

  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(button);
});

test("on the withdrawn page an admin can Restore, and the page comes back", async () => {
  vi.mocked(groups).mockReturnValue(["admin"]);
  vi.mocked(apiToken).mockReturnValue("TOKEN");
  dataset = { ...DATASET, withdrawn: WITHDRAWAL };
  renderDataset();
  const callout = await screen.findByRole("region", { name: "Withdrawn" });

  fireEvent.click(within(callout).getByRole("button", { name: "Restore…" }));
  const dialog = await screen.findByRole("dialog", { name: "Restore this dataset?" });
  expect(dialog.textContent).toContain(`${MANIFEST.title}, all versions.`);
  expect(dialog.textContent).toContain(
    "Its files are served again within a few minutes, and it returns to search, the catalog and the sitemap.",
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Restore" }));

  await filesList();
  expect(callsTo(`/api/admin/datasets/${ID}/restore`)).toEqual([
    { method: "POST", body: undefined, auth: "Bearer TOKEN" },
  ]);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("after Withdraw or Restore and the reload, focus is on the page's heading", async () => {
  const { dialog } = await openWithdraw();
  fireEvent.change(within(dialog).getByLabelText(/^Reason/), { target: { value: "Gone." } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Withdraw" }));

  const callout = await screen.findByRole("region", { name: "Withdrawn" });
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 })),
  );

  fireEvent.click(within(callout).getByRole("button", { name: "Restore…" }));
  const restore = await screen.findByRole("dialog", { name: "Restore this dataset?" });
  fireEvent.click(within(restore).getByRole("button", { name: "Restore" }));

  await filesList();
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 })),
  );
});

test("a reload that fails after a Withdraw shows that the dataset can't be loaded", async () => {
  const { dialog } = await openWithdraw();
  const answers = fetchMock.getMockImplementation()!;
  let withdrawn = false;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = new URL(url, "https://site").pathname;
    if (withdrawn && path.startsWith(`/api/datasets/${ID}`)) {
      return Response.json({}, { status: 500 });
    }
    const response = (await answers(url, init)) as Response;
    if (path === `/api/admin/datasets/${ID}/withdraw`) withdrawn = true;
    return response;
  });
  fireEvent.change(within(dialog).getByLabelText(/^Reason/), { target: { value: "Gone." } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Withdraw" }));

  expect(await screen.findByText("This dataset can't be loaded right now.")).toBeDefined();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("a curator who isn't an admin gets no Restore", async () => {
  vi.mocked(groups).mockReturnValue(["curator"]);
  dataset = { ...DATASET, withdrawn: WITHDRAWAL };
  renderDataset();
  await screen.findByRole("region", { name: "Withdrawn" });

  expect(screen.queryByRole("button", { name: "Restore…" })).toBeNull();
});

test("an axe check with the withdraw dialog open finds no violations", async () => {
  const { container } = await openWithdraw();
  fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
  await screen.findByText("Give a reason; it's shown on the page.");

  const results = await axe.run(container);
  expect(results.violations).toEqual([]);
});

test("an axe check with the restore dialog open finds no violations", async () => {
  vi.mocked(groups).mockReturnValue(["admin"]);
  dataset = { ...DATASET, withdrawn: WITHDRAWAL };
  const { container } = renderDataset();
  fireEvent.click(await screen.findByRole("button", { name: "Restore…" }));
  await screen.findByRole("dialog", { name: "Restore this dataset?" });

  const results = await axe.run(container);
  expect(results.violations).toEqual([]);
});

test.each([ID, RESTRICTED_ID, CLOSED_ID])("an axe check of %s finds no violations", async (id) => {
  const { container } = renderDataset(undefined, id);
  const files = await filesList();
  if (id === ID) fireEvent.click(within(files).getByRole("link", { name: LOGGER }));

  const results = await axe.run(container);
  expect(results.violations).toEqual([]);
});

test("mounted into an empty #app, reaching a dataset page doesn't throw or blank the page", async () => {
  document.body.innerHTML = '<div id="app"></div>';
  history.pushState({}, "", `/datasets/${ID}`);
  const app = document.getElementById("app") as HTMLElement;
  const errors: unknown[] = [];
  const onError = (event: ErrorEvent) => errors.push(event.error);
  window.addEventListener("error", onError);

  let root: Root | undefined;
  act(() => {
    root = mount(app);
  });

  await waitFor(() => expect(app.querySelector("h1")?.textContent).toBe(MANIFEST.title ?? ""));
  window.removeEventListener("error", onError);
  expect(errors).toEqual([]);
  act(() => root?.unmount());
});
