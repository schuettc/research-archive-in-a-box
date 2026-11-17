import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, expect, test, vi, type Mock } from "vitest";
import type { DownloadsAnswer } from "../api";
import { Downloads } from "./Downloads";

vi.mock("../auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth")>()),
  apiToken: vi.fn(() => "token"),
  groups: vi.fn(() => ["admin"]),
}));

const ANSWER: DownloadsAnswer = {
  months: ["2026-09", "2026-10", "2026-11"],
  rows: [
    {
      id: "stream-temp",
      title: "Stream temperature at three invented sites",
      access: "public",
      counts: { "2026-09": 82, "2026-10": 118, "2026-11": 212 },
      total: 412,
    },
    {
      id: "soil-cores",
      title: 'Soil cores, the "north" plots',
      access: "restricted",
      counts: { "2026-10": 4, "2026-11": 6 },
      total: 10,
    },
  ],
};

let fetchMock: Mock;
let answer: () => Response;

beforeEach(() => {
  answer = () => Response.json(ANSWER);
  fetchMock = vi.fn(async (url: string) => {
    const path = new URL(url, "https://site").pathname;
    if (path === "/api/admin/downloads") return answer();
    // The tab row reads the waiting access requests for its count.
    if (path === "/api/admin/access-requests") return Response.json({ requests: [] });
    return Response.json({}, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Where() {
  const { pathname, search } = useLocation();
  return <p data-testid="where">{`${pathname}${search}`}</p>;
}

function renderAt(path = "/settings/downloads") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/settings/downloads"
          element={
            <>
              <Downloads />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

/** The months each call to the downloads route asked for. */
const asked = () =>
  (fetchMock.mock.calls as [string][])
    .map(([url]) => new URL(url, "https://site"))
    .filter((url) => url.pathname === "/api/admin/downloads")
    .map((url) => url.searchParams.get("months"));

const table = () => screen.findByRole("table", { name: "Downloads per dataset per month" });

test("Downloads is the last tab, current on its page, scrolled into view", async () => {
  const scrolled: Element[] = [];
  Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
    scrolled.push(this);
  });
  renderAt();
  await table();

  const tabs = within(screen.getByRole("navigation", { name: "Settings" })).getAllByRole("link");
  expect(tabs.map((tab) => tab.textContent)).toEqual([
    "Review policy",
    "People",
    "Access requests",
    "Downloads",
  ]);
  expect(tabs.at(-1)?.getAttribute("aria-current")).toBe("page");
  expect(tabs.at(-1)?.getAttribute("href")).toBe("/settings/downloads");
  expect(scrolled).toEqual([tabs.at(-1)]);
});

test("the intro says what is counted and when", async () => {
  renderAt();
  await table();

  expect(
    screen.getByText(
      "Downloads per dataset per month. Public files are counted from the site's logs once a day; limited and restricted files when a download link is given out. Download as CSV for reports.",
    ),
  ).toBeDefined();
});

test("with no months chosen it asks for 3; each choice asks for its own and goes in the URL", async () => {
  renderAt();
  await table();
  const months = screen.getByRole("group", { name: "Months" });
  expect((within(months).getByLabelText("Last 3 months") as HTMLInputElement).checked).toBe(true);

  fireEvent.click(within(months).getByLabelText("Last 12 months"));
  await screen.findByText("/settings/downloads?months=12");
  fireEvent.click(within(months).getByLabelText("All time"));
  await screen.findByText("/settings/downloads?months=all");
  await table();

  expect(asked()).toEqual(["3", "12", "all"]);
});

test("months chosen in the URL are the ones asked for", async () => {
  renderAt("/settings/downloads?months=12");
  await table();

  expect(asked()).toEqual(["12"]);
  expect((screen.getByLabelText("Last 12 months") as HTMLInputElement).checked).toBe(true);
});

test("the table has a column per month, newest first, and a missing count reads 0", async () => {
  renderAt();
  const shown = await table();

  const headings = within(shown)
    .getAllByRole("columnheader")
    .map((th) => th.textContent);
  expect(headings).toEqual(["Dataset", "Access", "Nov 2026", "Oct 2026", "Sep 2026", "Total"]);
  const rows = within(shown).getAllByRole("row").slice(1);
  expect(rows.map((row) => [...row.children].map((cell) => cell.textContent))).toEqual([
    ["Stream temperature at three invented sitesstream-temp", "Public", "212", "118", "82", "412"],
    ['Soil cores, the "north" plotssoil-cores', "Restricted", "6", "4", "0", "10"],
  ]);
  const link = within(rows[0]!).getByRole("link", { name: ANSWER.rows[0]!.title });
  expect(link.getAttribute("href")).toBe("/datasets/stream-temp");
  expect(within(rows[1]!).getByText("0").getAttribute("data-label")).toBe("Sep 2026");
  expect(shown.closest(".table-scroll")?.getAttribute("role")).toBe("region");
});

test("Download as CSV gives every month oldest first, quoted as RFC 4180 says, named for the day", async () => {
  renderAt();
  await table();

  const link = screen.getByRole("link", { name: "Download as CSV" });
  const today = new Date().toISOString().slice(0, 10);
  expect(link.getAttribute("download")).toBe(`downloads-3-${today}.csv`);
  const href = link.getAttribute("href") ?? "";
  expect(href.startsWith("data:text/csv;charset=utf-8,")).toBe(true);
  expect(decodeURIComponent(href.slice(href.indexOf(",") + 1))).toBe(
    [
      "id,title,access,2026-09,2026-10,2026-11,total",
      "stream-temp,Stream temperature at three invented sites,public,82,118,212,412",
      'soil-cores,"Soil cores, the ""north"" plots",restricted,0,4,6,10',
      "",
    ].join("\r\n"),
  );
});

test("with no rows, the empty state says counts come the day after a first download", async () => {
  answer = () => Response.json({ months: ["2026-11"], rows: [] });
  renderAt();

  expect(await screen.findByText("No downloads yet.")).toBeDefined();
  expect(
    screen.getByText("Counts appear here the day after the first download of a published dataset."),
  ).toBeDefined();
  expect(screen.queryByRole("table")).toBeNull();
  expect(screen.queryByRole("link", { name: "Download as CSV" })).toBeNull();
});

test("when the counts can't be read, it says so and Try again asks again", async () => {
  answer = () => Response.json({}, { status: 503 });
  renderAt();

  expect((await screen.findByRole("alert")).textContent).toBe("Couldn't load the downloads.");
  answer = () => Response.json(ANSWER);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await table();
});

test("while the counts load, the shared loading line shows", () => {
  fetchMock.mockImplementation(() => new Promise(() => {}));
  renderAt();

  expect(screen.getByRole("status").textContent).toBe("Loading downloads…");
});

test("an axe check of the Downloads tab finds no violations", async () => {
  const { container } = renderAt();
  await table();

  const results = await axe.run(container);
  expect(results.violations).toEqual([]);
});
