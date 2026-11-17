import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { getDownloads, type DownloadsAnswer, type DownloadsMonths } from "../api";
import { accessClass, accessLabel } from "../labels";
import { PageHeading, useTitle } from "../page";
import { SettingsTabs } from "./Settings";

const CHOICES: { months: DownloadsMonths; label: string }[] = [
  { months: "3", label: "Last 3 months" },
  { months: "12", label: "Last 12 months" },
  { months: "all", label: "All time" },
];

const monthsOf = (value: string | null): DownloadsMonths =>
  value === "12" || value === "all" ? value : "3";

/** A `YYYY-MM` month as a heading: "Nov 2026". */
function monthLabel(month: string): string {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year ?? 1970, (number ?? 1) - 1, 1)).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** One CSV field, quoted when it holds a comma, a quote or a line end (RFC 4180). */
const csvField = (value: string | number) => {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

/** The counts as CSV: `id,title,access,<YYYY-MM>…,total`, every month oldest first. */
function csvOf(answer: DownloadsAnswer): string {
  const lines = [["id", "title", "access", ...answer.months, "total"]];
  for (const row of answer.rows) {
    lines.push([
      row.id,
      row.title,
      row.access,
      ...answer.months.map((month) => String(row.counts[month] ?? 0)),
      String(row.total),
    ]);
  }
  return lines.map((line) => `${line.map(csvField).join(",")}\r\n`).join("");
}

type Loaded = { months: DownloadsMonths; answer: DownloadsAnswer | "failed" };

/** `/settings/downloads`: downloads per dataset per month, for 3 or 12 months or all time. */
export function Downloads() {
  useTitle("Downloads");
  const [params, setParams] = useSearchParams();
  const months = monthsOf(params.get("months"));
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    getDownloads(months).then(
      (answer) => current && setLoaded({ months, answer }),
      () => current && setLoaded({ months, answer: "failed" }),
    );
    return () => {
      current = false;
    };
  }, [months, attempt]);

  const answer = loaded?.months === months ? loaded.answer : null;
  const newest = answer && answer !== "failed" ? answer.months.toReversed() : [];
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <PageHeading>Settings</PageHeading>
      <SettingsTabs current="/settings/downloads" />
      <p className="lede">
        Downloads per dataset per month. Public files are counted from the site's logs once a day;
        limited and restricted files when a download link is given out. Download as CSV for reports.
      </p>
      <div className="range">
        <fieldset className="choices months">
          <legend>Months</legend>
          {CHOICES.map((choice) => (
            <label key={choice.months} className="facet">
              <input
                type="radio"
                name="months"
                value={choice.months}
                checked={months === choice.months}
                onChange={() => setParams(choice.months === "3" ? {} : { months: choice.months })}
              />
              {choice.label}
            </label>
          ))}
        </fieldset>
        {answer && answer !== "failed" && answer.rows.length > 0 && (
          <a
            className="button"
            download={`downloads-${months}-${today}.csv`}
            href={`data:text/csv;charset=utf-8,${encodeURIComponent(csvOf(answer))}`}
          >
            Download as CSV
          </a>
        )}
      </div>
      {answer === null ? (
        <p role="status" className="loading">
          Loading downloads…
        </p>
      ) : answer === "failed" ? (
        <div className="callout failed">
          <p role="alert" className="lead">
            Couldn't load the downloads.
          </p>
          <p className="actions">
            <button type="button" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </p>
        </div>
      ) : answer.rows.length === 0 ? (
        <div className="empty">
          <p className="lead">No downloads yet.</p>
          <p className="muted">
            Counts appear here the day after the first download of a published dataset.
          </p>
        </div>
      ) : (
        <div
          className="table-scroll cards-on-phone"
          role="region"
          aria-label="Downloads, scrolls sideways"
          tabIndex={0}
        >
          <table
            className="cols listing to-cards downloads"
            aria-label="Downloads per dataset per month"
          >
            <thead>
              <tr>
                <th scope="col">Dataset</th>
                <th scope="col">Access</th>
                {newest.map((month) => (
                  <th key={month} scope="col" className="num">
                    {monthLabel(month)}
                  </th>
                ))}
                <th scope="col" className="num">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {answer.rows.map((row) => (
                <tr key={row.id}>
                  <td className="title-cell">
                    <Link to={`/datasets/${encodeURIComponent(row.id)}`}>{row.title}</Link>
                    <span className="sub">{row.id}</span>
                  </td>
                  <td data-label="Access">
                    <span className={accessClass(row.access)}>{accessLabel(row.access)}</span>
                  </td>
                  {newest.map((month) => (
                    <td key={month} data-label={monthLabel(month)} className="num">
                      {row.counts[month] ?? 0}
                    </td>
                  ))}
                  <td data-label="Total" className="num">
                    <b>{row.total}</b>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
