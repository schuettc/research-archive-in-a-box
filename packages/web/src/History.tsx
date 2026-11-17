import type { SubmissionEvent } from "./api";
import { plural } from "./Findings";
import { decisionLabel, eventLabel } from "./labels";
import { usePeople } from "./People";

const DETAIL_KEYS = ["eventKey", "at", "submissionId"];

/**
 * A retried step can record an event twice (Plan 7's PARK12): show each once. Two events alike
 * in everything but their time and key are one event.
 */
function deduplicated(events: SubmissionEvent[]): SubmissionEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = JSON.stringify(
      Object.entries(event)
        .filter(([field]) => !DETAIL_KEYS.includes(field))
        .toSorted(([a], [b]) => a.localeCompare(b)),
    );
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** An event's details in words, beyond its type. */
function detail(event: SubmissionEvent): string | null {
  switch (event.type) {
    case "checked":
      if (event.blocked) return `blocked: ${plural(event.errors ?? 0, "error")} to fix`;
      return `${plural(event.errors ?? 0, "error")}, ${plural(event.warnings ?? 0, "warning")}, ${plural(event.notes ?? 0, "note")}`;
    case "scanned": {
      const threats = Object.keys(event.threats ?? {}).length;
      return threats
        ? `${plural(threats, "file")} flagged`
        : `${plural(event.files ?? 0, "file")}, none flagged`;
    }
    case "held":
      return plural(event.files ?? 0, "file");
    case "entered-review":
      return event.outcome === "two" ? "needs two curators" : "needs one curator";
    case "reminded":
      return `day ${event.day}`;
    case "stale":
      return `after ${event.days} days`;
    case "decided":
      return (
        decisionLabel(event.decision ?? "") + (event.selfReview ? " (their own submission)" : "")
      );
    case "published":
      return `as ${event.datasetId}, version ${event.version}`;
    case "failed":
      return event.error ?? null;
    case "edited": {
      // The headline already names each field and property; this says what they became.
      const changes = event.changes ?? [];
      return changes
        .map(
          (change) =>
            (changes.length > 1 ? `${change.field}: ` : "") +
            (change.before ? `from “${change.before}” ` : "") +
            `to “${change.after}”`,
        )
        .join("; ");
    }
    default:
      return null;
  }
}

const when = (at: string) =>
  new Date(at).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

/** What a curator's edit changed, as words: "depth_cm's description and battery_v's unit". */
function changed(event: SubmissionEvent): string {
  const parts = (event.changes ?? []).map((change) => `${change.field}'s ${change.property}`);
  return parts.length > 1
    ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`
    : (parts[0] ?? "");
}

/** A submission's audit events, oldest first, with people named. */
export function History({ events }: { events: SubmissionEvent[] }) {
  const shown = deduplicated(events.toSorted((a, b) => a.eventKey.localeCompare(b.eventKey)));
  const name = usePeople(shown.map((event) => event.actor));
  if (shown.length === 0) return <p className="muted">Nothing has happened yet.</p>;
  return (
    <ol aria-label="History" className="history">
      {shown.map((event) => {
        const said = detail(event);
        const note = event.note;
        return (
          <li key={event.eventKey}>
            <time dateTime={event.at}>{when(event.at)}</time>
            <span>
              {event.type === "edited" ? (
                `${name(event.actor)} changed ${changed(event)}`
              ) : (
                <>
                  {eventLabel(event.type)}
                  {event.actor !== "pipeline" && ` by ${name(event.actor)}`}
                </>
              )}
              {said && <span className="muted"> · {said}</span>}
              {event.round > 1 && <span className="muted"> · round {event.round}</span>}
              {note && <q className="history-note">{note}</q>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
