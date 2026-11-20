import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { maxPackageGiB } from "../src/config";
import type { ArchiveConfig } from "../src/generated/archive-config";
import { DISK_MARGIN_MIB } from "../src/ingest";

const BASE: ArchiveConfig = { publisher: "P" };
const SCHEMA = JSON.parse(
  readFileSync(
    new URL("../../web/src/schema/archive-contract.schema.json", import.meta.url),
    "utf-8",
  ),
) as { $defs: { Submissions: { properties: { maxPackageGiB: { maximum: number } } } } };

test("the package limit is the config's, or the schema's default when it names none", () => {
  expect(maxPackageGiB({ ...BASE, submissions: { maxPackageGiB: 2 } })).toBe(2);
  expect(maxPackageGiB(BASE)).toBe(9);
});

test("the schema's ceiling plus the margin is a Lambda's largest disk", () => {
  expect(SCHEMA.$defs.Submissions.properties.maxPackageGiB.maximum * 1024 + DISK_MARGIN_MIB).toBe(
    10240,
  );
});
