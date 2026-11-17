import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, expect, test, vi } from "vitest";
import type { Finding } from "./api";
import { FieldEditor } from "./FieldEditor";

afterEach(cleanup);

const finding = (ruleId: string, field = "battery_v"): Finding => ({
  ruleId,
  severity: "warning",
  message: `Column ${field} has a problem.`,
  target: { resource: "logger", field, path: null },
  evidence: null,
  suggestedFix: null,
});

test("a missing description gets a description box that saves the typed text", async () => {
  const onSave = vi.fn(async () => {});
  const { container } = render(
    <FieldEditor finding={finding("field.description-missing")} current="" onSave={onSave} />,
  );

  const box = screen.getByRole("textbox", { name: "Description of logger › battery_v" });
  expect(box.tagName).toBe("TEXTAREA");
  const save = screen.getByRole("button", { name: "Save" });
  expect(save).toHaveProperty("disabled", false);
  expect(save.className).toBe("primary");
  fireEvent.click(save);
  expect((await screen.findByRole("alert")).textContent).toBe("Type a description first.");
  expect(onSave).not.toHaveBeenCalled();
  fireEvent.change(box, { target: { value: "  Battery voltage at the reading. " } });
  fireEvent.click(save);

  await waitFor(() => expect(onSave).toHaveBeenCalledWith("Battery voltage at the reading."));
  expect((await axe.run(container)).violations).toEqual([]);
});

test("Cancel puts the box back to what the manifest holds", () => {
  render(
    <FieldEditor
      finding={finding("field.description-repeats-name", "depth_cm")}
      current="depth_cm"
      onSave={vi.fn()}
    />,
  );
  const box = screen.getByRole("textbox", { name: "Description of logger › depth_cm" });
  expect((box as HTMLTextAreaElement).value).toBe("depth_cm");
  fireEvent.change(box, { target: { value: "Depth" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

  expect((box as HTMLTextAreaElement).value).toBe("depth_cm");
});

test("a unit finding gets a one-line unit box", () => {
  render(<FieldEditor finding={finding("field.unit-missing")} current="" onSave={vi.fn()} />);

  const box = screen.getByRole("textbox", { name: "Unit of logger › battery_v" });
  expect(box.tagName).toBe("INPUT");
});

test("a save that fails says why and keeps the text", async () => {
  const onSave = vi.fn(async () => {
    throw new Error("The archive refused it: submission is no longer in-review.");
  });
  render(<FieldEditor finding={finding("field.unit-missing")} current="" onSave={onSave} />);
  const box = screen.getByRole("textbox", { name: "Unit of logger › battery_v" });
  fireEvent.change(box, { target: { value: "V" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  expect((await screen.findByRole("alert")).textContent).toContain("no longer in-review");
  expect((box as HTMLInputElement).value).toBe("V");
});
