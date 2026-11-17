import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test } from "vitest";
import { Trail } from "./Trail";

afterEach(cleanup);

test("the trail links each step but the last, which is the page itself", () => {
  render(
    <MemoryRouter>
      <Trail steps={[{ label: "Submissions", to: "/submissions" }, { label: "Lake levels" }]} />
    </MemoryRouter>,
  );

  const trail = within(screen.getByRole("navigation", { name: "Breadcrumb" }));
  expect(trail.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
    "/submissions",
  ]);
  const last = trail.getByText("Lake levels");
  expect(last.tagName).not.toBe("A");
  expect(last.getAttribute("aria-current")).toBe("page");
});
