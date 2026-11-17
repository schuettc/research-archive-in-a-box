import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AppRoutes } from "./App";
import { groups, signedInEmail, signIn } from "./auth";

vi.mock("./auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth")>()),
  signedInEmail: vi.fn(() => null),
  signedInSub: vi.fn(() => null),
  groups: vi.fn(() => []),
  apiToken: vi.fn(() => null),
  signIn: vi.fn(async () => {}),
}));

beforeEach(() => {
  // The areas' own content waits on the API; these tests are about the frame and the gates.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise(() => {})),
  );
  vi.mocked(signedInEmail).mockReturnValue(null);
  vi.mocked(groups).mockReturnValue([]);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

function signInAs(...roles: string[]) {
  vi.mocked(signedInEmail).mockReturnValue("reader@example.org");
  vi.mocked(groups).mockReturnValue(roles);
}

const navNames = () =>
  within(screen.getByRole("navigation", { name: "Main" }))
    .getAllByRole("link")
    .map((link) => link.textContent);

test.each([
  [[], ["Browse", "About the archive"]],
  [["contributor"], ["Browse", "About the archive", "Submissions"]],
  [["curator"], ["Browse", "About the archive", "Review"]],
  [["admin"], ["Browse", "About the archive", "Settings"]],
  [
    ["contributor", "curator", "admin"],
    ["Browse", "About the archive", "Submissions", "Review", "Settings"],
  ],
])("a reader in %j sees exactly %j", (roles, names) => {
  signInAs(...roles);
  renderAt("/about");

  expect(navNames()).toEqual(names);
});

test.each(["/submissions", "/submissions/s-1", "/submit"])(
  "for a contributor, Submissions leads to the list and is current on %s",
  (path) => {
    signInAs("contributor");
    renderAt(path);

    const link = within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", {
      name: "Submissions",
    });
    expect(link.getAttribute("href")).toBe("/submissions");
    expect(link.getAttribute("aria-current")).toBe("page");
  },
);

test("signed out, the nav lists only Browse and About the archive", () => {
  renderAt("/about");

  expect(navNames()).toEqual(["Browse", "About the archive"]);
});

test("whatever the groups, Browse and About lead the nav and the account slot ends the masthead", () => {
  for (const roles of [[], ["contributor"], ["contributor", "curator", "admin"]]) {
    signInAs(...roles);
    const { unmount } = renderAt("/about");
    const inner = screen.getByRole("banner").querySelector(".inner");
    const children = [...(inner?.children ?? [])];
    expect(children.map((child) => child.className)).toEqual([
      "mark",
      "nav",
      "account",
      "menu-button",
    ]);
    // The public links sit in their own slot ahead of the areas, so the areas never push them.
    const nav = screen.getByRole("navigation", { name: "Main" });
    const slots = [...nav.children].map((child) => child.className);
    expect(slots).toEqual(["nav-public", "nav-areas"]);
    unmount();
  }
});

test.each([
  ["/submit", "Sign in to submit a package"],
  ["/submissions", "Sign in to see your submissions"],
  ["/submissions/s-1", "Sign in to see this submission"],
  ["/review", "Sign in to see the review queue"],
  ["/review/s-1", "Sign in to review this submission"],
  ["/settings", "Sign in to change the settings"],
  ["/settings/people", "Sign in to change the settings"],
  ["/settings/access", "Sign in to change the settings"],
])(
  "signed out, %s says what to do in its heading, with Sign in back to itself",
  (path, heading) => {
    renderAt(path);

    expect(screen.getByRole("heading", { level: 1, name: heading })).toBeDefined();
    const main = within(screen.getByRole("main"));
    fireEvent.click(main.getByRole("button", { name: "Sign in" }));
    expect(signIn).toHaveBeenCalledWith(path);
  },
);

test.each([
  ["/submit", "Submit a package", "contributor"],
  ["/review", "Review queue", "curator"],
  ["/settings", "Settings", "admin"],
  ["/settings/people", "Settings", "admin"],
  ["/settings/access", "Settings", "admin"],
])(
  "signed in without the group, %s says it needs the %s role and whom to ask",
  (path, heading, role) => {
    signInAs();
    renderAt(path);

    expect(screen.getByRole("heading", { level: 1, name: heading })).toBeDefined();
    const main = screen.getByRole("main");
    expect(main.textContent).toContain(`needs the ${role} role`);
    expect(within(main).getByRole("link", { name: "archive-admin@example.org" })).toBeDefined();
    expect(within(main).queryByRole("button", { name: "Sign in" })).toBeNull();
  },
);

test("signed out, a submission's gate keeps its trail", () => {
  renderAt("/submissions/s-1");

  const trail = within(screen.getByRole("navigation", { name: "Breadcrumb" }));
  expect(trail.getByRole("link", { name: "Submissions" }).getAttribute("href")).toBe(
    "/submissions",
  );
});

test("on the wrong role, the gate links to the areas the reader does have", () => {
  signInAs("contributor");
  renderAt("/review");

  const main = within(screen.getByRole("main"));
  expect(main.getByText("What you can use")).toBeDefined();
  expect(main.getByRole("link", { name: "Submissions" }).getAttribute("href")).toBe("/submissions");
  expect(main.getByRole("link", { name: "Browse the archive" }).getAttribute("href")).toBe("/");
});

test.each(["/submit", "/review", "/settings"])(
  "an axe check of the gate at %s finds no violations",
  async (path) => {
    signInAs();
    const { container } = renderAt(path);

    const results = await axe.run(container);
    expect(results.violations).toEqual([]);
  },
);

test("an admin at /settings/access sees the Access requests tab, current in the tab row", () => {
  signInAs("admin");
  renderAt("/settings/access");

  expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeDefined();
  const tabs = within(screen.getByRole("navigation", { name: "Settings" }));
  const tab = tabs.getByRole("link", { name: "Access requests" });
  expect(tab.getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("status").textContent).toBe("Loading access requests…");
});

test.each([["admin"], ["curator"]])("a reader in the %s group reaches Correct details", (role) => {
  signInAs(role);
  renderAt("/datasets/ds-1/v2/correct");

  expect(screen.getByRole("heading", { level: 1, name: "Correct details" })).toBeDefined();
  expect(screen.getByRole("status").textContent).toBe("Loading the dataset…");
});

test("a contributor is kept out of Correct details, told it needs a curator or an admin", () => {
  signInAs("contributor");
  renderAt("/datasets/ds-1/v2/correct");

  const main = screen.getByRole("main");
  expect(main.textContent).toContain("needs the curator or admin role");
  expect(within(main).queryByRole("button", { name: "Save correction" })).toBeNull();
});

test("Correct details on an address that isn't a version is not found", () => {
  signInAs("curator");
  renderAt("/datasets/ds-1/latest/correct");

  expect(screen.getByRole("heading", { level: 1, name: "Page not found" })).toBeDefined();
});

test("an admin at /settings/downloads sees the Downloads tab, current in the tab row", () => {
  signInAs("admin");
  renderAt("/settings/downloads");

  const tabs = within(screen.getByRole("navigation", { name: "Settings" }));
  expect(tabs.getByRole("link", { name: "Downloads" }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("status").textContent).toBe("Loading downloads…");
});

test("a curator who isn't an admin is kept out of the Downloads tab", () => {
  signInAs("curator");
  renderAt("/settings/downloads");

  expect(screen.getByRole("main").textContent).toContain("needs the admin role");
});
