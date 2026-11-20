import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test, vi, type Mock } from "vitest";
import type { Account, AccountEvent } from "../api";
import { selfSignUp } from "../auth";
import { forgetPeople } from "../People";
import { People } from "./People";

vi.mock("../auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth")>()),
  apiToken: vi.fn(() => "token"),
  signedInSub: vi.fn(() => "adm-1"),
  groups: vi.fn(() => ["admin"]),
  selfSignUp: vi.fn(),
}));

// Noon UTC, so the day shown is the same in every time zone the tests run in.
const ACCOUNTS: Account[] = [
  {
    sub: "adm-1",
    email: "court@example.org",
    roles: ["admin", "contributor", "curator"],
    status: "active",
    created: "2026-10-01T12:00:00Z",
  },
  {
    sub: "ana-1",
    email: "ana@lab.example.org",
    roles: ["curator"],
    status: "active",
    created: "2026-10-02T12:00:00Z",
  },
  {
    sub: "ben-1",
    email: "ben@lab.example.org",
    roles: ["contributor"],
    status: "invited",
    created: "2026-11-01T12:00:00Z",
  },
  {
    sub: "lee-1",
    email: "lee.r@example.org",
    roles: [],
    status: "signed-up",
    created: "2026-11-14T12:00:00Z",
  },
  {
    sub: "old-1",
    email: "old.student@lab.example.org",
    roles: [],
    status: "disabled",
    created: "2026-09-01T12:00:00Z",
  },
];

const EVENTS: AccountEvent[] = [
  {
    actor: "adm-1",
    action: "roles-set",
    userId: "ana-1",
    details: { email: "ana@lab.example.org", before: [], after: ["curator"] },
    at: "2026-11-14T12:02:00Z",
  },
  {
    actor: "adm-1",
    action: "access-approved",
    userId: "lee-1",
    details: { datasetId: "soil" },
    at: "2026-11-10T12:00:00Z",
  },
  {
    actor: "adm-1",
    action: "disabled",
    userId: "old-1",
    details: { email: "old.student@lab.example.org" },
    at: "2026-11-02T12:40:00Z",
  },
  {
    actor: "adm-1",
    action: "invited",
    userId: "ben-1",
    details: { email: "ben@lab.example.org", roles: ["contributor"] },
    at: "2026-11-01T12:15:00Z",
  },
];

let fetchMock: Mock;
let calls: { method: string; path: string; body: unknown }[];
let refuse: Record<string, string>;
let failList: boolean;

const account = (sub: string) => ACCOUNTS.find((a) => a.sub === sub)!;

beforeEach(() => {
  vi.mocked(selfSignUp).mockResolvedValue(true);
  forgetPeople();
  calls = [];
  refuse = {};
  failList = false;
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const { pathname } = new URL(url, "https://site");
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    calls.push({ method, path: pathname, body });
    const refusal = refuse[`${method} ${pathname}`];
    if (refusal) return Response.json({ error: refusal }, { status: 409 });
    if (pathname === "/api/admin/people" && method === "GET") {
      if (failList) return new Response("", { status: 503 });
      return Response.json({ people: ACCOUNTS });
    }
    if (pathname === "/api/admin/people" && method === "POST") {
      const { email, roles } = body as { email: string; roles: Account["roles"] };
      return Response.json(
        { sub: "new-1", email, roles, status: "invited", created: "2026-11-16T12:00:00Z" },
        { status: 201 },
      );
    }
    if (pathname === "/api/admin/account-events") return Response.json({ events: EVENTS });
    if (pathname === "/api/people") return Response.json({ people: {} });
    const match = /^\/api\/admin\/people\/([^/]+)\/(roles|resend|disable|enable)$/.exec(pathname);
    if (match) {
      const [, sub, action] = match;
      const before = account(sub!);
      if (action === "roles") {
        return Response.json({ ...before, roles: (body as { roles: string[] }).roles });
      }
      if (action === "disable") return Response.json({ ...before, status: "disabled" });
      if (action === "enable") return Response.json({ ...before, status: "active" });
      return Response.json(before);
    }
    return Response.json({}, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPeople() {
  return render(
    <MemoryRouter initialEntries={["/settings/people"]}>
      <People />
    </MemoryRouter>,
  );
}

/** The table row naming `email`. */
async function row(email: string) {
  const cell = await screen.findByRole("cell", {
    name: new RegExp(`^${email.replace(".", "\\.")}`),
  });
  return within(cell.closest("tr")!);
}

const dialog = () => within(screen.getByRole("dialog"));

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

test("on a stage with sign-up off, the note says only invited people get an account", async () => {
  vi.mocked(selfSignUp).mockResolvedValue(false);
  renderPeople();

  expect(
    await screen.findByText(
      "Only people you invite get an account; one has no role until you give it one. Disabling signs the person out everywhere and stops their downloads. You can't remove your own admin role or disable yourself.",
    ),
  ).toBeDefined();
  expect(screen.queryByText("Anyone can create an account", { exact: false })).toBeNull();
});

test("on a stage with sign-up on, the note says anyone can create an account", async () => {
  renderPeople();

  expect(
    await screen.findByText(
      "Anyone can create an account; it has no role until you give one. Disabling signs the person out everywhere and stops their downloads. You can't remove your own admin role or disable yourself.",
    ),
  ).toBeDefined();
  expect(screen.queryByText("Only people you invite", { exact: false })).toBeNull();
});

test("People is the tab shown in the Settings tab row", async () => {
  renderPeople();

  const tabs = within(screen.getByRole("navigation", { name: "Settings" }));
  expect(tabs.getByRole("link", { name: "People" }).getAttribute("aria-current")).toBe("page");
  await row("ana@lab.example.org");
});

test("while the list loads, it says so", () => {
  renderPeople();

  expect(screen.getByRole("status").textContent).toBe("Loading people…");
});

test("each account shows its status in words", async () => {
  renderPeople();

  expect((await row("ana@lab.example.org")).getByText("Active")).toBeDefined();
  expect((await row("ben@lab.example.org")).getByText("Invited, hasn't signed in")).toBeDefined();
  expect((await row("lee.r@example.org")).getByText("Signed up 14 Nov")).toBeDefined();
  const disabled = await row("old.student@lab.example.org");
  expect(disabled.getByText("Disabled 2 Nov")).toBeDefined();
  expect(disabled.getByText("by court@example.org")).toBeDefined();
});

test("each row offers the actions its status allows, and your own row only Change roles", async () => {
  renderPeople();

  const names = async (email: string) =>
    (await row(email)).getAllByRole("button").map((button) => button.textContent);
  expect(await names("court@example.org")).toEqual(["Change roles"]);
  expect((await row("court@example.org")).getByText("(you)")).toBeDefined();
  expect(await names("ana@lab.example.org")).toEqual(["Change roles", "Disable"]);
  expect(await names("ben@lab.example.org")).toEqual(["Change roles", "Resend invite", "Disable"]);
  expect(await names("lee.r@example.org")).toEqual(["Change roles", "Disable"]);
  expect(await names("old.student@lab.example.org")).toEqual(["Re-enable"]);
  expect((await row("lee.r@example.org")).getByText("No role")).toBeDefined();
});

test("the search finds people by email", async () => {
  renderPeople();
  await row("ana@lab.example.org");

  fireEvent.change(screen.getByRole("searchbox", { name: "Find by email" }), {
    target: { value: "LAB.EXAMPLE" },
  });

  const emails = screen.getAllByRole("row").slice(1);
  expect(emails).toHaveLength(3);
  expect(screen.queryByRole("cell", { name: /^lee\.r@example\.org/ })).toBeNull();
});

test("Invite someone sends the email and roles, and the person joins the list", async () => {
  renderPeople();
  await row("ana@lab.example.org");

  fireEvent.click(screen.getByRole("button", { name: "Invite someone" }));
  fireEvent.change(dialog().getByRole("textbox", { name: "Email" }), {
    target: { value: "maria@example.edu" },
  });
  fireEvent.click(dialog().getByRole("checkbox", { name: /Curator/ }));
  fireEvent.click(dialog().getByRole("button", { name: "Send invite" }));

  expect((await row("maria@example.edu")).getByText("Invited, hasn't signed in")).toBeDefined();
  expect(calls).toContainEqual({
    method: "POST",
    path: "/api/admin/people",
    body: { email: "maria@example.edu", roles: ["contributor", "curator"] },
  });
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("a 409 from the invite shows its message in the dialog", async () => {
  refuse["POST /api/admin/people"] = "an account with that email already exists";
  renderPeople();
  await row("ana@lab.example.org");

  fireEvent.click(screen.getByRole("button", { name: "Invite someone" }));
  fireEvent.change(dialog().getByRole("textbox", { name: "Email" }), {
    target: { value: "ana@lab.example.org" },
  });
  fireEvent.click(dialog().getByRole("button", { name: "Send invite" }));

  expect((await dialog().findByRole("alert")).textContent).toBe(
    "An account with that email already exists.",
  );
});

test("Change roles saves exactly the roles ticked, and says what adding admin allows", async () => {
  renderPeople();

  fireEvent.click((await row("ana@lab.example.org")).getByRole("button", { name: "Change roles" }));
  expect(dialog().getByRole("heading", { name: "Roles for ana@lab.example.org" })).toBeDefined();
  expect(dialog().queryByText(/Adding admin/)).toBeNull();
  fireEvent.click(dialog().getByRole("checkbox", { name: "Admin" }));
  expect(
    dialog().getByText(
      "Adding admin lets ana@lab.example.org change settings, manage people and approve access.",
    ),
  ).toBeDefined();
  fireEvent.click(dialog().getByRole("button", { name: "Save roles" }));

  expect(await (await row("ana@lab.example.org")).findByText("admin")).toBeDefined();
  expect(calls).toContainEqual({
    method: "PUT",
    path: "/api/admin/people/ana-1/roles",
    body: { roles: ["curator", "admin"] },
  });
});

test("your own admin box is locked", async () => {
  renderPeople();

  fireEvent.click((await row("court@example.org")).getByRole("button", { name: "Change roles" }));

  expect(dialog().getByRole("heading", { name: "Your roles" })).toBeDefined();
  const admin = dialog().getByRole("checkbox", { name: /Admin/ }) as HTMLInputElement;
  expect(admin.checked).toBe(true);
  expect(admin.disabled).toBe(true);
  expect(dialog().getByText("another admin has to remove this")).toBeDefined();
  fireEvent.click(dialog().getByRole("checkbox", { name: "Contributor" }));
  fireEvent.click(dialog().getByRole("button", { name: "Save roles" }));
  await waitFor(() =>
    expect(calls).toContainEqual({
      method: "PUT",
      path: "/api/admin/people/adm-1/roles",
      body: { roles: ["curator", "admin"] },
    }),
  );
});

test("Resend invite asks first, then sends it again", async () => {
  renderPeople();

  fireEvent.click(
    (await row("ben@lab.example.org")).getByRole("button", { name: "Resend invite" }),
  );
  expect(
    dialog().getByRole("heading", { name: "Resend the invite to ben@lab.example.org?" }),
  ).toBeDefined();
  fireEvent.click(dialog().getByRole("button", { name: "Resend invite" }));

  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(calls).toContainEqual({
    method: "POST",
    path: "/api/admin/people/ben-1/resend",
    body: undefined,
  });
  expect(screen.getByRole("status").textContent).toBe("Invite sent again to ben@lab.example.org.");
});

test("Disable confirms, then the person shows as disabled", async () => {
  renderPeople();

  fireEvent.click((await row("ana@lab.example.org")).getByRole("button", { name: "Disable" }));
  expect(dialog().getByRole("heading", { name: "Disable ana@lab.example.org?" })).toBeDefined();
  expect(dialog().getByText(/signed out everywhere/)).toBeDefined();
  fireEvent.click(dialog().getByRole("button", { name: "Disable" }));

  expect(await (await row("ana@lab.example.org")).findByText(/^Disabled/)).toBeDefined();
  expect(calls).toContainEqual({
    method: "POST",
    path: "/api/admin/people/ana-1/disable",
    body: undefined,
  });
  // The list of recent changes is read again after each change.
  expect(calls.filter((call) => call.path === "/api/admin/account-events")).toHaveLength(2);
});

test("a 409 from Disable shows its message in the dialog, which stays open", async () => {
  refuse["POST /api/admin/people/ana-1/disable"] = "you can't disable yourself";
  renderPeople();

  fireEvent.click((await row("ana@lab.example.org")).getByRole("button", { name: "Disable" }));
  fireEvent.click(dialog().getByRole("button", { name: "Disable" }));

  expect((await dialog().findByRole("alert")).textContent).toBe("You can't disable yourself.");
  expect((await row("ana@lab.example.org")).getByText("Active")).toBeDefined();
});

test("Re-enable confirms, then the person is active again", async () => {
  renderPeople();

  fireEvent.click(
    (await row("old.student@lab.example.org")).getByRole("button", { name: "Re-enable" }),
  );
  expect(
    dialog().getByRole("heading", { name: "Re-enable old.student@lab.example.org?" }),
  ).toBeDefined();
  fireEvent.click(dialog().getByRole("button", { name: "Re-enable" }));

  expect(await (await row("old.student@lab.example.org")).findByText("Active")).toBeDefined();
  expect(calls).toContainEqual({
    method: "POST",
    path: "/api/admin/people/old-1/enable",
    body: undefined,
  });
});

test("Recent changes says who changed what, for people only", async () => {
  renderPeople();

  const history = within(await screen.findByRole("list", { name: "Recent changes" }));
  const lines = history
    .getAllByRole("listitem")
    .map((item) => item.querySelector("span")!.textContent);
  expect(lines).toEqual([
    "court@example.org gave ana@lab.example.org the curator role",
    "court@example.org disabled old.student@lab.example.org",
    "court@example.org invited ben@lab.example.org as contributor",
  ]);
});

test("when the list can't be loaded, it says so and Try again reads it again", async () => {
  failList = true;
  renderPeople();

  expect((await screen.findByRole("alert")).textContent).toBe("Couldn't load the people list.");
  failList = false;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));

  await row("ana@lab.example.org");
});

test("an axe check of the People tab and its dialog finds no violations", async () => {
  const { container } = renderPeople();
  await row("ana@lab.example.org");
  expect((await axe.run(container)).violations).toEqual([]);

  fireEvent.click(screen.getByRole("button", { name: "Invite someone" }));
  expect((await axe.run(container)).violations).toEqual([]);
});
