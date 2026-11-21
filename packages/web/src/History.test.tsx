import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { History } from "./History";
import { forgetPeople } from "./People";
import { event } from "./test-fixtures";

vi.mock("./auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth")>()),
  apiToken: vi.fn(() => "token"),
  signedInSub: vi.fn(() => "cur-9"),
  groups: vi.fn(() => CURATOR),
}));
const CURATOR = ["curator"];

beforeEach(() => {
  forgetPeople();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ people: { "cur-1": { email: "ada@example.org" } } })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("a curator's edit reads in plain words: who changed which field's description or unit, from what to what", async () => {
  render(
    <History
      events={[
        event("edited", {
          actor: "cur-1",
          changes: [
            {
              resource: "logger",
              field: "depth_cm",
              property: "description",
              before: "depth_cm",
              after: "Depth of the logger below the surface.",
            },
            { resource: "logger", field: "battery_v", property: "unit", before: null, after: "V" },
          ],
        }),
      ]}
    />,
  );

  const history = screen.getByRole("list", { name: "History" });
  await waitFor(() =>
    expect(history.textContent).toContain(
      "ada@example.org changed depth_cm's description and battery_v's unit",
    ),
  );
  expect(history.textContent).toContain(
    "depth_cm: from “depth_cm” to “Depth of the logger below the surface.”; battery_v: to “V”",
  );
});

test("a single edit names the field once, then says what it became", async () => {
  render(
    <History
      events={[
        event("edited", {
          actor: "cur-1",
          changes: [
            {
              resource: "sites",
              field: "name",
              property: "description",
              before: null,
              after: "Site name.",
            },
          ],
        }),
      ]}
    />,
  );

  const history = screen.getByRole("list", { name: "History" });
  await waitFor(() =>
    expect(history.textContent).toContain(
      "ada@example.org changed name's description · to “Site name.”",
    ),
  );
  expect(history.textContent?.match(/name's description/g)).toHaveLength(1);
});

test("other events keep their label and the person who acted", async () => {
  render(<History events={[event("decided", { actor: "cur-1", decision: "approve" })]} />);

  await waitFor(() =>
    expect(screen.getByRole("list", { name: "History" }).textContent).toContain(
      "Decided by ada@example.org · Approved",
    ),
  );
});

const REASON =
  "The archive couldn't finish publishing (the catalog step failed). The admins have been told.";
const RAW =
  "An error occurred (AccessDeniedException) when calling the PutItem operation: User: arn:aws:sts::123456789012:assumed-role/Ingest";

test("a failed event shows its plain reason", () => {
  render(<History events={[event("failed", { step: "publish-1-catalog", reason: REASON })]} />);

  expect(screen.getByRole("list", { name: "History" }).textContent).toContain(`Failed · ${REASON}`);
});

test("an older failed event with only the raw error says it plainly and never shows the error", () => {
  render(<History events={[event("failed", { error: RAW })]} />);

  const history = screen.getByRole("list", { name: "History" }).textContent;
  expect(history).toContain(
    "Failed · The archive couldn't finish publishing. The admins have been told.",
  );
  expect(history).not.toContain("AccessDenied");
  expect(history).not.toContain("123456789012");
});
