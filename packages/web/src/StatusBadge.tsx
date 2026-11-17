import { statusLabel, type Status } from "./labels";

/** The badge's words: the same on every page, so a status reads one way wherever it shows. */
const WORDS: Partial<Record<Status, string>> = {
  draft: "Draft",
  checking: "Being checked",
  "in-review": "Waiting for a curator",
  "needs-changes": "Changes requested",
  publishing: "Publishing",
  published: "Published",
  rejected: "Rejected",
};

/** Its colour by kind: waiting amber, changes and rejected red, published green, the rest neutral. */
const KINDS: Partial<Record<Status, string>> = {
  "in-review": "wait",
  "needs-changes": "no",
  rejected: "no",
  published: "ok",
};

/** A submission's status as a badge: words, a colour by kind and a dot, never colour alone. */
export function StatusBadge({ status }: { status: Status }) {
  return (
    <span className={`badge ${KINDS[status] ?? "neutral"}`}>
      {WORDS[status] ?? statusLabel(status)}
    </span>
  );
}
