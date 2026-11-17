import type { ReactNode } from "react";
import type { Finding, FindingsReport } from "./api";

const SEVERITIES = [
  ["error", "Errors"],
  ["warning", "Warnings"],
  ["note", "Notes"],
] as const;

export const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

/** What a finding is about: "logger › site_id", or a file's path. */
function where(finding: Finding): string | null {
  const target = finding.target;
  if (!target) return null;
  const parts = [target.resource, target.field].filter(Boolean);
  if (parts.length) return parts.join(" › ");
  return target.path ?? null;
}

function evidence(finding: Finding): string | null {
  const found = finding.evidence;
  if (!found) return null;
  const parts: string[] = [];
  if (found.rows?.length) parts.push(`rows ${found.rows.join(", ")}`);
  if (found.values?.length) parts.push(`values ${found.values.map(String).join(", ")}`);
  if (typeof found.count === "number") parts.push(`${found.count} in all`);
  return parts.length ? parts.join(" · ") : null;
}

/**
 * What fixes a finding here: the box `editor` gives it, or null for one fixed elsewhere.
 * Left out, findings are listed without boxes and with a plain "fix" label.
 */
export type Editor = (finding: Finding) => ReactNode | null;

/** Findings grouped error, warning, note, each with what it is about and its suggested fix. */
export function FindingGroups({
  findings,
  editor,
  elsewhere = "Fix with cruise:",
}: {
  findings: Finding[];
  editor?: Editor;
  /** With an editor, the label on a finding it can't fix: who fixes it, and how. */
  elsewhere?: string;
}) {
  return (
    <>
      {SEVERITIES.map(([severity, heading]) => {
        const found = findings.filter((finding) => finding.severity === severity);
        if (found.length === 0) return null;
        return (
          <div key={severity} className={`finding-group severity-${severity}`}>
            <h3>
              {heading} ({found.length})
            </h3>
            <ul aria-label={heading} className="finding-list">
              {found.map((finding, index) => {
                const about = where(finding);
                const shown = evidence(finding);
                const box = editor ? editor(finding) : null;
                return (
                  <li
                    key={`${finding.ruleId}-${about}-${index}`}
                    className={box ? "finding editable" : "finding"}
                  >
                    <p className="finding-message">{finding.message}</p>
                    <p className="finding-meta">
                      {about && <code>{about}</code>}
                      {about && shown && " · "}
                      {shown}
                      <span className="rule-id">{finding.ruleId}</span>
                    </p>
                    {box ??
                      (finding.suggestedFix || editor ? (
                        <p className="finding-fix">
                          <span className="label">{editor ? elsewhere : "fix"}</span>{" "}
                          {finding.suggestedFix}
                        </p>
                      ) : null)}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </>
  );
}

/**
 * A round's findings report: the score and counts, then the findings grouped error, warning,
 * note, each with what it is about and its suggested fix. The same Finding model cruise prints.
 * `editor` puts a box beside each finding that can be fixed here.
 */
export function Findings({
  report,
  editor,
  elsewhere,
}: {
  report: FindingsReport;
  editor?: Editor;
  elsewhere?: string;
}) {
  const quality = report.quality;
  const count = (severity: string) =>
    report.findings.filter((finding) => finding.severity === severity).length;
  return (
    <div className="findings">
      <p className="checks-summary">
        {quality ? (
          <>
            <strong>{quality.score}%</strong> of the checks passed ·{" "}
            {plural(count("error"), "error")} · {plural(count("warning"), "warning")} ·{" "}
            {plural(count("note"), "note")}
          </>
        ) : report.validation ? (
          "The checks couldn't read the manifest, so there is no score."
        ) : (
          "The malware scan stopped this round before the checks ran."
        )}
      </p>
      {report.findings.length === 0 && <p className="muted">No findings.</p>}
      <FindingGroups findings={report.findings} editor={editor} elsewhere={elsewhere} />
    </div>
  );
}
