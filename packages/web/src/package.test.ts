import { statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  applyEdit,
  checkPackage,
  editableKind,
  fieldValue,
  fromEntries,
  fromFileList,
  sha256Hex,
  uploadFile,
  withEdits,
  type PackageFile,
} from "./package";
import { FakeXhr, SAMPLE, sampleFiles } from "./test-fixtures";

afterEach(() => vi.unstubAllGlobals());

test("paths are relative to the package folder's root, and hidden files are skipped", () => {
  const extra = new File(["x"], ".DS_Store");
  Object.defineProperty(extra, "webkitRelativePath", { value: "sample-package/.DS_Store" });

  const files = fromFileList([...sampleFiles(), extra]);

  const paths = files.map((file) => file.path);
  expect(paths).toContain("datapackage.json");
  expect(paths).toContain("data/codes/condition-codes.csv");
  expect(paths).not.toContain(".DS_Store");
  expect(paths.every((path) => !path.startsWith("sample-package/"))).toBe(true);
});

test("the sample package checks: every listed file matches, and its id and title are read", async () => {
  const checked = await checkPackage(fromFileList(sampleFiles()));

  if (!checked.ok) throw new Error(checked.problem);
  expect(checked.manifest).toEqual({
    id: "stream-temperature-sample",
    title: "Stream temperature at three invented sites",
  });
  const paths = checked.files.map((file) => file.path);
  expect(paths).toContain("checksums.sha256");
  expect(paths).toContain("data/logger.csv");
  // _build/ isn't listed in checksums.sha256, so it isn't part of the package.
  expect(checked.left).toEqual(["_build/GAPS.md", "_build/make.py"]);
  const logger = checked.files.find((file) => file.path === "data/logger.csv");
  expect(logger?.sha256).toBe("1b8a6b3736dfbb165673581395b27d1a4e29ec3d90de3acb9a3cc98a72eeb341");
  expect(logger?.size).toBe(statSync(join(SAMPLE, "data/logger.csv")).size);
});

test("a folder without checksums.sha256 is refused", async () => {
  const checked = await checkPackage(fromFileList(sampleFiles({}, ["checksums.sha256"])));

  expect(checked.ok).toBe(false);
  if (!checked.ok) expect(checked.problem).toMatch(/no checksums\.sha256/);
});

test("a folder without datapackage.json is refused", async () => {
  const checked = await checkPackage(fromFileList(sampleFiles({}, ["datapackage.json"])));

  expect(checked.ok).toBe(false);
  if (!checked.ok) expect(checked.problem).toMatch(/no datapackage\.json/);
});

test("a changed file is named as not matching its checksum", async () => {
  const checked = await checkPackage(
    fromFileList(sampleFiles({ "data/logger.csv": "site,temp\nS1,99\n" })),
  );

  expect(checked.ok).toBe(false);
  if (!checked.ok) {
    expect(checked.problem).toBe("data/logger.csv doesn't match its checksum in checksums.sha256.");
  }
});

test("a file listed in checksums.sha256 but missing from the folder is named", async () => {
  const checked = await checkPackage(fromFileList(sampleFiles({}, ["docs/methods.md"])));

  expect(checked.ok).toBe(false);
  if (!checked.ok) expect(checked.problem).toMatch(/docs\/methods\.md is listed/);
});

test("a dropped folder is read through its entries, with paths from the folder's root", async () => {
  const file = (name: string, text: string) => ({
    isFile: true,
    isDirectory: false,
    name,
    file: (done: (file: File) => void) => done(new File([text], name)),
  });
  const dir = (name: string, children: object[]) => ({
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let given = false;
      return {
        readEntries: (done: (entries: object[]) => void) => {
          const batch = given ? [] : children;
          given = true;
          done(batch);
        },
      };
    },
  });
  const root = dir("pkg", [file("datapackage.json", "{}"), dir("data", [file("a.csv", "x")])]);

  const files: PackageFile[] = await fromEntries([root as unknown as FileSystemEntry]);

  expect(files.map((f) => f.path).toSorted()).toEqual(["data/a.csv", "datapackage.json"]);
});

test("an upload PUTs the file to its link with the checksum header, reporting progress", async () => {
  FakeXhr.sent = [];
  FakeXhr.status = 200;
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  const seen: number[] = [];
  const file = new File(["hello"], "a.csv");

  await uploadFile(
    {
      path: "a.csv",
      url: "https://staging.example/a.csv?sig",
      headers: { "x-amz-checksum-sha256": "c2lnbg==" },
    },
    file,
    (loaded) => seen.push(loaded),
  );

  expect(FakeXhr.sent).toEqual([
    {
      method: "PUT",
      url: "https://staging.example/a.csv?sig",
      headers: { "x-amz-checksum-sha256": "c2lnbg==" },
      body: file,
    },
  ]);
  expect(seen.at(-1)).toBe(5);
});

test("an upload S3 refuses is an error", async () => {
  FakeXhr.status = 403;
  vi.stubGlobal("XMLHttpRequest", FakeXhr);

  await expect(
    uploadFile(
      { path: "a", url: "https://x", headers: { "x-amz-checksum-sha256": "c" } },
      new File(["a"], "a"),
      () => {},
    ),
  ).rejects.toThrow(/403/);
});

test("only the three text findings are editable, each with its kind of box", () => {
  const finding = (ruleId: string) => ({
    ruleId,
    severity: "warning" as const,
    message: "m",
    target: { resource: "logger", field: "battery_v", path: null },
    evidence: null,
    suggestedFix: null,
  });
  expect(editableKind(finding("field.description-missing"))).toBe("description");
  expect(editableKind(finding("field.description-repeats-name"))).toBe("description");
  expect(editableKind(finding("field.unit-missing"))).toBe("unit");
  expect(editableKind(finding("values.constant"))).toBeNull();
  expect(editableKind({ ...finding("field.unit-missing"), target: null })).toBeNull();
});

test("an edit changes only that field's description or unit, in a copy", () => {
  const raw = {
    resources: [{ name: "logger", schema: { fields: [{ name: "battery_v", type: "number" }] } }],
  };
  const described = applyEdit(raw, {
    resource: "logger",
    field: "battery_v",
    description: "Battery voltage",
  });
  const united = applyEdit(described!, { resource: "logger", field: "battery_v", unit: "V" });

  expect(united).toEqual({
    resources: [
      {
        name: "logger",
        schema: {
          fields: [
            {
              name: "battery_v",
              type: "number",
              description: "Battery voltage",
              "archive:unit": "V",
            },
          ],
        },
      },
    ],
  });
  expect(raw.resources[0]!.schema.fields[0]).toEqual({ name: "battery_v", type: "number" });
});

test("the edited manifest replaces datapackage.json and only its checksums line changes", async () => {
  const checked = await checkPackage(fromFileList(sampleFiles()));
  if (!checked.ok) throw new Error(checked.problem);
  const raw = applyEdit(checked.raw, {
    resource: "logger",
    field: "battery_v",
    description: "Battery voltage at the reading.",
  })!;

  const files = await withEdits(checked.files, raw, checked.checksums);

  const manifest = files.find((file) => file.path === "datapackage.json")!;
  const sums = files.find((file) => file.path === "checksums.sha256")!;
  expect(JSON.parse(await manifest.file.text())).toEqual(raw);
  expect(manifest.sha256).toBe(await sha256Hex(manifest.file));
  expect(manifest.size).toBe(manifest.file.size);
  expect(sums.sha256).toBe(await sha256Hex(sums.file));
  const before = checked.checksums.split("\n");
  const after = (await sums.file.text()).split("\n");
  expect(after).toHaveLength(before.length);
  for (const [index, line] of after.entries()) {
    if (line.endsWith("  datapackage.json"))
      expect(line).toBe(`${manifest.sha256}  datapackage.json`);
    else expect(line).toBe(before[index]);
  }
  const others = files.filter((f) => !["datapackage.json", "checksums.sha256"].includes(f.path));
  expect(others).toEqual(
    checked.files.filter((f) => !["datapackage.json", "checksums.sha256"].includes(f.path)),
  );
});

test("a vector resource's attribute is read and edited under archive:attributes", async () => {
  const checked = await checkPackage(fromFileList(sampleFiles()));
  if (!checked.ok) throw new Error(checked.problem);
  expect(fieldValue(checked.raw, "sites", "site", "description")).toBe(
    "Site code, as in the logger table's site column.",
  );

  const raw = applyEdit(checked.raw, { resource: "sites", field: "site", description: "Code." });

  expect(raw).not.toBeNull();
  expect(fieldValue(raw!, "sites", "site", "description")).toBe("Code.");
  expect(fieldValue(checked.raw, "sites", "site", "description")).not.toBe("Code.");
});

test("an edit of a field the manifest doesn't have applies nothing", () => {
  const raw = { resources: [{ name: "logger", schema: { fields: [{ name: "battery_v" }] } }] };
  expect(applyEdit(raw, { resource: "logger", field: "ghost", description: "x" })).toBeNull();
});
