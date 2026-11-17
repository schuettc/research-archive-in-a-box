import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test } from "vitest";
import { BRAND } from "../site";
import { Privacy } from "./Privacy";

afterEach(() => {
  cleanup();
  BRAND.privacy = null;
});

function renderPrivacy() {
  return render(
    <MemoryRouter>
      <Privacy />
    </MemoryRouter>,
  );
}

test("the default says what the archive keeps, with the 90-day log rule and the contact", () => {
  renderPrivacy();

  expect(screen.getByRole("heading", { level: 1, name: "Privacy" })).toBeDefined();
  expect(
    screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent),
  ).toEqual([
    "Reading and downloading",
    "Accounts",
    "Submitting data and asking for access",
    "Questions and deletion",
  ]);
  expect(screen.getByText(`What ${BRAND.name} keeps about the people who use it, and why.`));
  expect(screen.getByText(/Those logs are deleted after 90 days/)).toBeDefined();
  expect(screen.getByRole("link", { name: "archive-admin@example.org" }).getAttribute("href")).toBe(
    "mailto:archive-admin@example.org",
  );
  expect(screen.getByText(/This page is the kit's default/)).toBeDefined();
  expect(screen.getByText("brand.privacy")).toBeDefined();
});

test("with no contact, the default says to ask the archive's admins", () => {
  const contact = BRAND.contact;
  BRAND.contact = null;
  try {
    renderPrivacy();
    expect(screen.queryByRole("link", { name: /@/ })).toBeNull();
    expect(screen.getByText(/ask the archive's admins/)).toBeDefined();
  } finally {
    BRAND.contact = contact;
  }
});

test("the operator's text replaces the default, one paragraph per block, as plain text", () => {
  BRAND.privacy = "We keep your email.\n\nWrite to <b>us</b>\nto delete it.";
  const { container } = renderPrivacy();

  const main = within(container);
  expect(main.getByRole("heading", { level: 1, name: "Privacy" })).toBeDefined();
  const paragraphs = [...container.querySelectorAll("p")].map((p) => p.textContent);
  expect(paragraphs).toEqual(["We keep your email.", "Write to <b>us</b>\nto delete it."]);
  expect(container.querySelector("b")).toBeNull();
  expect(main.queryByText(/This page is the kit's default/)).toBeNull();
  expect(main.queryByRole("heading", { level: 2 })).toBeNull();
});
