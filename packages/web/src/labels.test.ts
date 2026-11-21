import { expect, test } from "vitest";
import {
  accessFacetLabel,
  accessLabel,
  formatLabel,
  formatSize,
  kindsOf,
  licenceLabel,
} from "./labels";

test("access levels read as words", () => {
  expect(accessLabel("public")).toBe("Public");
  expect(accessLabel("limited")).toBe("Limited");
  expect(accessLabel("restricted")).toBe("Restricted");
  expect(accessLabel("description-only")).toBe("Description only");
  expect(accessFacetLabel("public")).toBe("Public");
  expect(accessFacetLabel("restricted")).toBe("Restricted");
});

test("licence ids read as their short names, and an unknown one as itself", () => {
  expect(licenceLabel("CC-BY-4.0")).toBe("CC BY 4.0");
  expect(licenceLabel("CC-BY-NC-4.0")).toBe("CC BY-NC 4.0");
  expect(licenceLabel("CC0-1.0")).toBe("CC0 1.0");
  expect(licenceLabel("ODbL-1.0")).toBe("ODbL-1.0");
});

test("formats read with their extension, and an unknown one as the extension", () => {
  expect(formatLabel("shp")).toBe("Shapefile (.shp)");
  expect(formatLabel("asc")).toBe("Esri ASCII grid (.asc)");
  expect(formatLabel("md")).toBe("Markdown (.md)");
  expect(formatLabel("xyz")).toBe(".xyz");
});

test("formats group into kinds of file, in a fixed order", () => {
  expect(kindsOf(["png", "csv", "shp", "asc", "xlsx", "md"])).toEqual([
    "tables",
    "GIS",
    "documents",
    "images",
  ]);
  expect(kindsOf(["csv"])).toEqual(["tables"]);
  expect(kindsOf(["xyz"])).toEqual(["other files"]);
  expect(kindsOf([])).toEqual([]);
});

test("sizes read in decimal units", () => {
  expect(formatSize(697)).toBe("697 B");
  expect(formatSize(50_000)).toBe("50.0 kB");
  expect(formatSize(3_400_000)).toBe("3.4 MB");
});

test("every status and event has a plain label", async () => {
  const { STATUSES, EVENT_TYPES, statusLabel, statusLine, eventLabel, decisionLabel } =
    await import("./labels");
  for (const status of STATUSES) {
    expect(statusLabel(status)).toMatch(/^[A-Z][a-z ]+$/);
    expect(statusLine(status)).not.toBe(status);
  }
  for (const type of EVENT_TYPES) expect(eventLabel(type)).toMatch(/^[A-Z]/);
  expect(statusLabel("needs-changes")).toBe("Changes requested");
  expect(statusLine("in-review")).toBe("Waiting for a curator");
  expect(decisionLabel("request-changes")).toBe("Changes requested");
  expect(eventLabel("entered-review")).toBe("Entered review");
});

test("an expired submission's line gives the 360 days the archive kept it", async () => {
  const { statusLine } = await import("./labels");

  expect(statusLine("expired")).toBe("Expired: the submission was kept for 360 days and closed");
});
