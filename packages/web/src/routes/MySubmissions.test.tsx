import { cleanup, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test, vi, type Mock } from "vitest";
import { event, item } from "../test-fixtures";
import { MySubmissions } from "./MySubmissions";

vi.mock("../auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth")>()),
  apiToken: vi.fn(() => "token"),
  signedInSub: vi.fn(() => "me-1"),
}));

let fetchMock: Mock;

beforeEach(() => {
  fetchMock = vi.fn(async (url: string) => {
    const parsed = new URL(url, "https://site");
    if (parsed.pathname === "/api/submissions") {
      return Response.json({
        submissions: [
          item({
            submissionId: "s-1",
            status: "needs-changes",
            round: 2,
            createdAt: "2026-11-10T14:00:00Z",
          }),
          item({
            submissionId: "s-2",
            status: "published",
            datasetId: "lake-levels",
            createdAt: "2026-11-12T09:00:00Z",
          }),
        ],
      });
    }
    if (parsed.pathname === "/api/datasets/lake-levels") {
      return Response.json({ id: "lake-levels", title: "Lake levels" });
    }
    if (parsed.pathname.startsWith("/api/datasets/")) return Response.json({}, { status: 404 });
    const id = parsed.pathname.split("/").pop();
    return Response.json({
      submission: item({ submissionId: id }),
      events: [
        event("created", { at: "2026-11-10T14:00:00Z" }),
        event("checked", { at: id === "s-1" ? "2026-11-13T08:30:00Z" : "2026-11-12T10:00:00Z" }),
      ],
    });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPage() {
  return render(
    <MemoryRouter>
      <MySubmissions />
    </MemoryRouter>,
  );
}

test("Submissions lists the reader's own, newest first, with title, badge, kind and last change", async () => {
  renderPage();

  const rows = await screen.findAllByRole("row");
  expect(new URL(String(fetchMock.mock.calls[0]?.[0]), "https://site").search).toBe("?mine=1");
  const body = rows.slice(1);
  const title = await within(body[0]!).findByRole("link", { name: "Lake levels" });
  expect(title.getAttribute("href")).toBe("/submissions/s-2");
  expect(within(body[0]!).getByText("lake-levels")).toBeDefined();
  expect(within(body[0]!).getByText("Published").className).toBe("badge ok");
  expect(within(body[1]!).getByText("Changes requested").className).toBe("badge no");
  expect(body[1]!.textContent).toContain("New dataset");
  expect(await within(body[1]!).findByText("13 Nov 2026")).toBeDefined();
  // On a phone each row is a card, its cells labelled.
  expect(within(body[1]!).getByText("13 Nov 2026").closest("td")?.dataset.label).toBe(
    "Last change",
  );
  expect(screen.getByRole("link", { name: "Submit a package" }).getAttribute("href")).toBe(
    "/submit",
  );
});

test("with none yet, it says so and offers Submit a package", async () => {
  fetchMock.mockImplementationOnce(async () => Response.json({ submissions: [] }));
  renderPage();

  const lead = await screen.findByText(/haven't submitted/);
  const empty = lead.closest(".empty") as HTMLElement;
  expect(within(empty).getByRole("link", { name: "Submit a package" })).toBeDefined();
  expect(screen.getAllByRole("link", { name: "Submit a package" })).toHaveLength(1);
});

test("an axe check of My submissions finds no violations", async () => {
  const { container } = renderPage();
  await screen.findAllByRole("row");

  expect((await axe.run(container)).violations).toEqual([]);
});
