import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test, vi, type Mock } from "vitest";
import type { AccessRequest } from "../api";
import { forgetPeople } from "../People";
import { AccessRequests } from "./AccessRequests";
import { SettingsTabs } from "./Settings";

vi.mock("../auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth")>()),
  apiToken: vi.fn(() => "token"),
  signedInSub: vi.fn(() => "adm-1"),
  groups: vi.fn(() => ["admin"]),
}));

const MOOSE = { datasetId: "moose", datasetTitle: "Moose tracking, Mt. Mansfield 2019–2023" };
const RAPTORS = { datasetId: "raptors", datasetTitle: "Nesting sites, rare raptors" };

const request = (fields: Partial<AccessRequest>): AccessRequest => ({
  ...MOOSE,
  email: "someone@example.org",
  userId: "someone",
  state: "waiting",
  reason: null,
  requestedAt: null,
  decidedAt: null,
  decidedBy: null,
  note: null,
  until: null,
  takenBackAt: null,
  takenBackBy: null,
  ...fields,
});

// Noon UTC, so the day shown is the same in every time zone the tests run in.
const STORED: AccessRequest[] = [
  request({
    ...MOOSE,
    email: "ben@lab.example.org",
    userId: "ben-1",
    reason: "For my thesis on winter range. I won't publish the GPS points.",
    requestedAt: "2026-11-15T12:00:00Z",
  }),
  request({
    ...RAPTORS,
    email: "lee.r@example.org",
    userId: "lee-1",
    reason: "Coordinating the state survey this spring with Audubon VT.",
    requestedAt: "2026-11-16T12:00:00Z",
  }),
  request({
    ...MOOSE,
    email: "maria@example.edu",
    userId: "maria-1",
    state: "approved",
    until: "2027-05-31",
  }),
  request({ ...RAPTORS, email: "sam@lab.example.org", userId: "sam-1", state: "approved" }),
  request({
    ...MOOSE,
    email: "jo@lab.example.org",
    userId: "jo-1",
    state: "ended",
    until: "2026-09-01",
  }),
  request({
    ...RAPTORS,
    email: "ana@lab.example.org",
    userId: "ana-1",
    state: "taken-back",
    takenBackAt: "2026-11-10T12:00:00Z",
    takenBackBy: "adm-2",
  }),
];

let fetchMock: Mock;
let calls: { method: string; path: string; body: unknown }[];
let stored: AccessRequest[];
/** A decision another admin made first: the next decision is refused with 409, and the list
 * holds it. */
let beaten: AccessRequest | null;

const find = (dataset: string, sub: string) =>
  stored.find((r) => r.datasetId === dataset && r.userId === sub)!;

beforeEach(() => {
  forgetPeople();
  calls = [];
  stored = STORED.map((r) => ({ ...r }));
  beaten = null;
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const { pathname } = new URL(url, "https://site");
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    calls.push({ method, path: pathname, body });
    if (pathname === "/api/admin/access-requests") return Response.json({ requests: stored });
    if (pathname === "/api/people") {
      return Response.json({ people: { "adm-2": { email: "court@example.org" } } });
    }
    const match = /^\/api\/admin\/access-requests\/([^/]+)\/([^/]+)\/(decision|take-back)$/.exec(
      pathname,
    );
    if (match && method === "POST") {
      const [, dataset, sub, action] = match;
      if (beaten) {
        stored = stored.map((r) =>
          r.datasetId === beaten!.datasetId && r.userId === beaten!.userId ? beaten! : r,
        );
        return Response.json(
          { error: "another admin decided this request first" },
          { status: 409 },
        );
      }
      const before = find(dataset!, sub!);
      const answer: AccessRequest =
        action === "take-back"
          ? {
              ...before,
              state: "taken-back",
              takenBackAt: "2026-11-16T12:00:00Z",
              takenBackBy: "adm-1",
            }
          : (() => {
              const { decision, note, until } = body as {
                decision: string;
                note: string | null;
                until: string | null;
              };
              return {
                ...before,
                state: decision === "approve" ? "approved" : "declined",
                note,
                until,
                decidedAt: "2026-11-16T12:00:00Z",
                decidedBy: "adm-1",
              };
            })();
      stored = stored.map((r) => (r === before ? answer : r));
      return Response.json(answer);
    }
    return Response.json({}, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// jsdom has no modal dialogs: open and close them by their attribute, as a browser does.
if (typeof HTMLDialogElement !== "undefined" && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
}

function renderTab() {
  return render(
    <MemoryRouter initialEntries={["/settings/access"]}>
      <AccessRequests />
    </MemoryRouter>,
  );
}

const waiting = () => within(screen.getByRole("region", { name: "Waiting" }));
const approvals = () => within(screen.getByRole("region", { name: "Approvals" }));
const dialog = () => within(screen.getByRole("dialog"));
const tab = () =>
  within(screen.getByRole("navigation", { name: "Settings" })).getByRole("link", {
    name: /^Access requests/,
  });

/** The waiting request from `email`. */
async function asked(email: string) {
  await screen.findByRole("region", { name: "Waiting" });
  const who = await waiting().findByText(email);
  return within(who.closest("li")!);
}

/** The approvals row naming `email`. */
function approval(email: string) {
  return within(approvals().getByRole("cell", { name: email }).closest("tr")!);
}

const decisions = () => calls.filter((call) => call.method === "POST");

test("Access requests is the tab shown, with the count of waiting requests", async () => {
  renderTab();

  await screen.findByRole("region", { name: "Waiting" });
  expect(tab().getAttribute("aria-current")).toBe("page");
  expect(tab().textContent).toBe("Access requests 2 waiting");
});

test("the other Settings tabs show the waiting count too", async () => {
  render(
    <MemoryRouter>
      <SettingsTabs current="/settings/people" />
    </MemoryRouter>,
  );

  await waitFor(() => expect(tab().textContent).toBe("Access requests 2 waiting"));
});

test("while the list loads, it says so", () => {
  renderTab();

  expect(screen.getByRole("status").textContent).toBe("Loading access requests…");
});

test("each waiting request shows the person, the dataset linked, the reason and when they asked", async () => {
  renderTab();

  const ben = await asked("ben@lab.example.org");
  const link = ben.getByRole("link", { name: MOOSE.datasetTitle });
  expect(link.getAttribute("href")).toBe("/datasets/moose");
  expect(
    ben.getByText("For my thesis on winter range. I won't publish the GPS points."),
  ).toBeDefined();
  expect(ben.getByText("Asked 15 Nov")).toBeDefined();
  expect((await asked("lee.r@example.org")).getByText("Asked 16 Nov")).toBeDefined();
});

test("each approval shows its end or who took it back, and only current ones can be taken back", async () => {
  renderTab();

  await screen.findByRole("region", { name: "Approvals" });
  expect(approval("maria@example.edu").getByText("31 May 2027")).toBeDefined();
  expect(approval("sam@lab.example.org").getByText("Until taken back")).toBeDefined();
  expect(approval("jo@lab.example.org").getByText("Ended 1 Sept 2026")).toBeDefined();
  expect(
    await approval("ana@lab.example.org").findByText("Taken back 10 Nov by court@example.org"),
  ).toBeDefined();
  expect(approval("maria@example.edu").getByRole("button", { name: "Take back" })).toBeDefined();
  expect(approval("sam@lab.example.org").getByRole("button", { name: "Take back" })).toBeDefined();
  expect(approval("jo@lab.example.org").queryByRole("button")).toBeNull();
  expect(approval("ana@lab.example.org").queryByRole("button")).toBeNull();
});

test("Approve with no end date approves until taken back", async () => {
  renderTab();

  fireEvent.click((await asked("ben@lab.example.org")).getByRole("button", { name: "Approve…" }));
  expect(dialog().getByRole("heading", { name: "Approve ben@lab.example.org?" })).toBeDefined();
  expect(dialog().getByText(MOOSE.datasetTitle)).toBeDefined();
  fireEvent.click(dialog().getByRole("button", { name: "Approve" }));

  await waitFor(() =>
    expect(approval("ben@lab.example.org").getByText("Until taken back")).toBeDefined(),
  );
  expect(decisions()).toEqual([
    {
      method: "POST",
      path: "/api/admin/access-requests/moose/ben-1/decision",
      body: { decision: "approve", note: null, until: null },
    },
  ]);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(waiting().queryByText("ben@lab.example.org")).toBeNull();
  expect(tab().textContent).toBe("Access requests 1 waiting");
});

test("Approve with an end date and a note sends both", async () => {
  renderTab();

  fireEvent.click((await asked("ben@lab.example.org")).getByRole("button", { name: "Approve…" }));
  fireEvent.change(dialog().getByLabelText(/^Until/), { target: { value: "2027-05-31" } });
  fireEvent.change(dialog().getByLabelText(/^Note to ben@lab.example.org/), {
    target: { value: "  Thesis use only.  " },
  });
  fireEvent.click(dialog().getByRole("button", { name: "Approve" }));

  await waitFor(() =>
    expect(approval("ben@lab.example.org").getByText("31 May 2027")).toBeDefined(),
  );
  expect(decisions()[0]!.body).toEqual({
    decision: "approve",
    note: "Thesis use only.",
    until: "2027-05-31",
  });
});

test("Decline sends the note, and the request leaves the list", async () => {
  renderTab();

  fireEvent.click((await asked("lee.r@example.org")).getByRole("button", { name: "Decline…" }));
  expect(dialog().getByRole("heading", { name: "Decline lee.r@example.org?" })).toBeDefined();
  fireEvent.change(dialog().getByLabelText(/^Why/), {
    target: { value: "Please ask through Audubon VT's data agreement." },
  });
  fireEvent.click(dialog().getByRole("button", { name: "Decline" }));

  await waitFor(() => expect(waiting().queryByText("lee.r@example.org")).toBeNull());
  expect(decisions()).toEqual([
    {
      method: "POST",
      path: "/api/admin/access-requests/raptors/lee-1/decision",
      body: {
        decision: "decline",
        note: "Please ask through Audubon VT's data agreement.",
        until: null,
      },
    },
  ]);
  expect(approvals().queryByText("lee.r@example.org")).toBeNull();
  expect(tab().textContent).toBe("Access requests 1 waiting");
});

test("Take back asks first, then the approval shows it was taken back", async () => {
  renderTab();

  await screen.findByRole("region", { name: "Approvals" });
  fireEvent.click(approval("maria@example.edu").getByRole("button", { name: "Take back" }));
  expect(
    dialog().getByRole("heading", {
      name: `Take back maria@example.edu's access to ${MOOSE.datasetTitle}?`,
    }),
  ).toBeDefined();
  fireEvent.click(dialog().getByRole("button", { name: "Take back" }));

  await waitFor(() =>
    expect(approval("maria@example.edu").getByText("Taken back 16 Nov by you")).toBeDefined(),
  );
  expect(decisions()).toEqual([
    { method: "POST", path: "/api/admin/access-requests/moose/maria-1/take-back", body: undefined },
  ]);
  expect(approval("maria@example.edu").queryByRole("button")).toBeNull();
});

test("with nothing waiting, it says so and the tab shows no count", async () => {
  stored = STORED.filter((r) => r.state !== "waiting");
  renderTab();

  await screen.findByRole("region", { name: "Waiting" });
  expect(waiting().getByText("No requests waiting.")).toBeDefined();
  expect(tab().textContent).toBe("Access requests");
});

test("a 409 from two admins acting at once refreshes the list and says so", async () => {
  renderTab();

  fireEvent.click((await asked("ben@lab.example.org")).getByRole("button", { name: "Approve…" }));
  beaten = { ...find("moose", "ben-1"), state: "declined", decidedBy: "adm-2" };
  fireEvent.click(dialog().getByRole("button", { name: "Approve" }));

  expect((await screen.findByRole("alert")).textContent).toBe(
    "Another admin decided this request first. The list now shows the latest.",
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() =>
    expect(calls.filter((call) => call.path === "/api/admin/access-requests")).toHaveLength(2),
  );
  await waitFor(() => expect(tab().textContent).toBe("Access requests 1 waiting"));
  expect(waiting().queryByText("ben@lab.example.org")).toBeNull();
});

test("when the list can't be loaded, it says so and Try again reads it again", async () => {
  let fail = true;
  const answer = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
    fail && new URL(url, "https://site").pathname === "/api/admin/access-requests"
      ? new Response("", { status: 503 })
      : answer(url, init),
  );
  renderTab();

  expect((await screen.findByRole("alert")).textContent).toBe("Couldn't load the access requests.");
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await asked("ben@lab.example.org");
});

test("an axe check of the tab and its approve dialog finds no violations", async () => {
  const { container } = renderTab();

  fireEvent.click((await asked("ben@lab.example.org")).getByRole("button", { name: "Approve…" }));
  const results = await axe.run(container);
  expect(results.violations).toEqual([]);
});
