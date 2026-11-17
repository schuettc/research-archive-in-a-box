import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { StatusBadge } from "./StatusBadge";

afterEach(cleanup);

test.each([
  ["draft", "Draft", "badge neutral"],
  ["checking", "Being checked", "badge neutral"],
  ["in-review", "Waiting for a curator", "badge wait"],
  ["needs-changes", "Changes requested", "badge no"],
  ["publishing", "Publishing", "badge neutral"],
  ["published", "Published", "badge ok"],
  ["rejected", "Rejected", "badge no"],
] as const)("the badge for %s reads %j, coloured %j", (status, words, className) => {
  render(<StatusBadge status={status} />);

  const badge = screen.getByText(words);
  expect(badge.className).toBe(className);
});
