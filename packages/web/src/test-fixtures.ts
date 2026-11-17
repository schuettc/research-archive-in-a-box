/** Fixtures the tests share: the sample package as a browser would give it, and a fake XHR. */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Finding, FindingsReport, Submission as Item, SubmissionEvent } from "./api";

export const SAMPLE = join(import.meta.dirname, "../../../examples/sample-package");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** The sample package as a directory input gives it: each file under the folder's own name. */
export function sampleFiles(change?: Record<string, string>, leave: string[] = []): File[] {
  return walk(SAMPLE)
    .map((path) => relative(SAMPLE, path))
    .filter((path) => !leave.includes(path))
    .map((path) => {
      const content = change?.[path] ?? readFileSync(join(SAMPLE, path));
      const file = new File([content], path.split("/").pop() ?? path);
      Object.defineProperty(file, "webkitRelativePath", { value: `sample-package/${path}` });
      return file;
    });
}

type Column = { name: string; type?: string; description?: string; "archive:unit"?: string };
type Resource = { name: string; schema?: { fields: Column[] } };

/**
 * The sample package with its logger fields changed by `change`, and its checksums.sha256
 * rewritten to match, so it still checks.
 */
export function editedSample(change: (fields: Column[]) => void): File[] {
  const raw = JSON.parse(readFileSync(join(SAMPLE, "datapackage.json"), "utf8")) as {
    resources: Resource[];
  };
  change(raw.resources.find((r) => r.name === "logger")!.schema!.fields);
  const manifest = JSON.stringify(raw, null, 2) + "\n";
  const digest = createHash("sha256").update(manifest).digest("hex");
  const sums = readFileSync(join(SAMPLE, "checksums.sha256"), "utf8").replace(
    /^\w+( {2}datapackage\.json)$/m,
    `${digest}$1`,
  );
  return sampleFiles({ "datapackage.json": manifest, "checksums.sha256": sums });
}

/**
 * What `/api/checks` would say of a manifest's three text checks, worked out the way cruise's
 * rules do, so a mocked archive answers each re-check from the manifest it was sent.
 */
export function checksFor(manifest: Record<string, unknown>): Finding[] {
  const findings: Finding[] = [];
  const bare = (text: string) => text.toLowerCase().replace(/[\W_]+/g, "");
  for (const resource of (manifest.resources ?? []) as Resource[]) {
    for (const column of resource.schema?.fields ?? []) {
      const target = { resource: resource.name, field: column.name, path: null };
      const description = (column.description ?? "").trim();
      if (!description) {
        findings.push({
          ruleId: "field.description-missing",
          severity: "warning",
          message: `Column ${column.name} has no description.`,
          target,
          evidence: null,
          suggestedFix: `Describe what ${column.name} holds and how it was measured.`,
        });
      } else if (bare(description) === bare(column.name)) {
        findings.push({
          ruleId: "field.description-repeats-name",
          severity: "warning",
          message: `Column ${column.name}'s description only repeats its name.`,
          target,
          evidence: null,
          suggestedFix: `Say what ${column.name} holds, not just its name.`,
        });
      }
      if (["number", "integer"].includes(column.type ?? "") && !column["archive:unit"]?.trim()) {
        findings.push({
          ruleId: "field.unit-missing",
          severity: "warning",
          message: `Column ${column.name} is a measurement with no unit.`,
          target,
          evidence: null,
          suggestedFix: `Set archive:unit on ${column.name}, or mark it nominal or ordinal.`,
        });
      }
    }
  }
  return findings;
}

/** A stand-in for XMLHttpRequest: records each request and reports progress, then load. */
export class FakeXhr {
  static sent: { method: string; url: string; headers: Record<string, string>; body: unknown }[] =
    [];
  static status = 200;
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  status = 0;
  private request = { method: "", url: "", headers: {} as Record<string, string> };
  open(method: string, url: string) {
    this.request = { method, url, headers: {} };
  }
  setRequestHeader(name: string, value: string) {
    this.request.headers[name.toLowerCase()] = value;
  }
  send(body: Blob) {
    FakeXhr.sent.push({ ...this.request, body });
    queueMicrotask(() => {
      const total = body.size;
      this.upload.onprogress?.({
        lengthComputable: true,
        loaded: total / 2,
        total,
      } as ProgressEvent);
      this.upload.onprogress?.({ lengthComputable: true, loaded: total, total } as ProgressEvent);
      this.status = FakeXhr.status;
      this.onload?.();
    });
  }
}

/** A submission as the API answers it, with the given fields changed. */
export function item(over: Partial<Item> = {}): Item {
  return {
    submissionId: "s-1",
    submitter: "me-1",
    submitterIsCurator: false,
    status: "in-review",
    createdAt: "2026-11-10T14:00:00Z",
    round: 1,
    files: { "1": [] },
    datasetId: "stream-temperature-sample",
    newVersion: false,
    rule: null,
    approvals: [],
    stale: false,
    reportKey: "reports/s-1/1.json",
    waiting: true,
    ...over,
  };
}

export function event(type: SubmissionEvent["type"], over: Partial<SubmissionEvent> = {}) {
  return {
    submissionId: "s-1",
    eventKey: `2026-11-10T15:00:0${Math.floor(Math.random() * 10)}Z#${type}`,
    type,
    actor: "pipeline",
    round: 1,
    at: "2026-11-10T15:00:00Z",
    ...over,
  } as SubmissionEvent;
}

export const REPORT: FindingsReport = {
  round: 1,
  validation: { valid: true, contractVersion: "1.4.0", checkedAt: "2026-11-10T15:00:00Z" },
  quality: {
    errors: 1,
    warnings: 1,
    notes: 1,
    auditedAt: "2026-11-10T15:00:00Z",
    score: 87,
    find: { passed: 3, applicable: 4 },
    understand: { passed: 5, applicable: 6 },
    trust: { passed: 2, applicable: 3 },
  },
  findings: [
    {
      ruleId: "understand.units",
      severity: "warning",
      message: "Column water_temp has no unit.",
      target: { resource: "logger", field: "water_temp", path: null },
      evidence: null,
      suggestedFix: "Set the field's unit to degC.",
    },
    {
      ruleId: "trust.methods",
      severity: "note",
      message: "The methods document doesn't name the logger.",
      target: { resource: null, field: null, path: "docs/methods.md" },
      evidence: null,
      suggestedFix: null,
    },
    {
      ruleId: "contract.schema",
      severity: "error",
      message: "Column site_id has values outside its codelist.",
      target: { resource: "logger", field: "site_id", path: null },
      evidence: { rows: [14, 98], values: ["S9", "S0"], count: 2 },
      suggestedFix: "Add S9 and S0 to the site codes.",
    },
  ],
} as FindingsReport;

const finding = (ruleId: string, field: string, message: string, values?: unknown[]) => ({
  ruleId,
  severity: "warning" as const,
  message,
  target: { resource: "logger", field, path: null },
  evidence: values ? { rows: null, values, count: null } : null,
  suggestedFix: `Fix ${field}.`,
});

/** A report with two findings a field editor fixes (a missing and a name-only description) and one it doesn't. */
export const EDITABLE: FindingsReport = {
  ...REPORT,
  findings: [
    finding("field.description-missing", "battery_v", "Column battery_v has no description."),
    finding(
      "field.description-repeats-name",
      "depth_cm",
      "Column depth_cm's description only repeats its name.",
      ["depth_cm"],
    ),
    finding("values.constant", "logger_model", "Column logger_model holds one value."),
  ],
};
