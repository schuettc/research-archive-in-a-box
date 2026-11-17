import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import {
  ApiRefused,
  correctMetadata,
  getDataset,
  getVersion,
  type CorrectionRequest,
  type RefusedField,
} from "../api";
import { personName } from "../citation";
import type { Contributor, Funding, Manifest, RelatedIdentifier } from "../generated/manifest";
import { checkOrcid, isRor } from "../orcid";
import { PageHeading, useTitle } from "../page";
import { Trail } from "../Trail";

/** DataCite's relation types; a related line starts with one written as words. */
const RELATIONS = [
  "IsCitedBy",
  "Cites",
  "IsSupplementTo",
  "IsSupplementedBy",
  "IsContinuedBy",
  "Continues",
  "IsDescribedBy",
  "Describes",
  "HasMetadata",
  "IsMetadataFor",
  "HasVersion",
  "IsVersionOf",
  "IsNewVersionOf",
  "IsPreviousVersionOf",
  "IsPartOf",
  "HasPart",
  "IsPublishedIn",
  "IsReferencedBy",
  "References",
  "IsDocumentedBy",
  "Documents",
  "IsCompiledBy",
  "Compiles",
  "IsVariantFormOf",
  "IsOriginalFormOf",
  "IsIdenticalTo",
  "IsReviewedBy",
  "Reviews",
  "IsDerivedFrom",
  "IsSourceOf",
  "IsRequiredBy",
  "Requires",
  "IsObsoletedBy",
  "Obsoletes",
  "IsCollectedBy",
  "Collects",
  "HasTranslation",
  "IsTranslationOf",
];

/** A relation type as words: `IsCitedBy` is "Is cited by". */
const relationWords = (type: string) =>
  type.replace(/(?<=[a-z])(?=[A-Z])/g, " ").replace(/ \S/g, (word) => word.toLowerCase());

/** Longest first, so "Is supplemented by" is never read as "Is supplement to". */
const BY_WORDS = RELATIONS.map((type) => ({ type, words: relationWords(type).toLowerCase() })).sort(
  (a, b) => b.words.length - a.words.length,
);

/** A related identifier as its line: the relation in words, then the identifier. */
function relatedLine(related: RelatedIdentifier): string {
  const shown =
    related.identifierType.toUpperCase() === "DOI"
      ? `doi:${related.identifier}`
      : related.identifier;
  return `${relationWords(related.relationType)} ${shown}`;
}

/** The related lines read back: an unchanged line keeps its stored object; null if one won't parse. */
function parseRelated(text: string, stored: RelatedIdentifier[]): RelatedIdentifier[] | null {
  const unused = [...stored];
  const parsed: RelatedIdentifier[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const kept = unused.findIndex((related) => relatedLine(related) === line);
    if (kept >= 0) {
      parsed.push(...unused.splice(kept, 1));
      continue;
    }
    const lower = line.toLowerCase();
    const relation = BY_WORDS.find(({ words }) => lower.startsWith(`${words} `));
    if (!relation) return null;
    const rest = line.slice(relation.words.length).trim();
    if (/^https?:\/\/\S+$/.test(rest)) {
      parsed.push({ relationType: relation.type, identifierType: "URL", identifier: rest });
    } else if (/^(doi:)?10\.\S+$/i.test(rest)) {
      const identifier = rest.replace(/^doi:/i, "");
      parsed.push({ relationType: relation.type, identifierType: "DOI", identifier });
    } else {
      return null;
    }
  }
  return parsed;
}

/** One creator's row: the stored contributor it edits (null for a new one) and its fields. */
interface CreatorRow {
  key: number;
  stored: Contributor | null;
  name: string;
  orcid: string;
  affiliation: string;
  orcidError: "check-digit" | "shape" | null;
  rorError: boolean;
  /** A stored creator whose name was emptied: refused, since a creator needs a name. */
  nameError: boolean;
}

interface GrantRow {
  key: number;
  stored: Funding | null;
  funder: string;
  awardNumber: string;
  awardTitle: string;
}

const isCreator = (c: Contributor) => Boolean(c.roles?.includes("creator"));
const affiliationOf = (c: Contributor) => c.organizationId ?? c.organization ?? "";

let nextKey = 0;
const creatorRow = (stored: Contributor | null): CreatorRow => ({
  key: nextKey++,
  stored,
  name: stored ? (personName(stored) ?? "") : "",
  orcid: stored?.orcid ?? "",
  affiliation: stored ? affiliationOf(stored) : "",
  orcidError: null,
  rorError: false,
  nameError: false,
});
const grantRow = (stored: Funding | null): GrantRow => ({
  key: nextKey++,
  stored,
  funder: stored?.funder ?? "",
  awardNumber: stored?.awardNumber ?? "",
  awardTitle: stored?.awardTitle ?? "",
});

/** A ROR-looking affiliation that isn't a ROR address. */
const badRor = (value: string) =>
  value.trim().startsWith("https://ror.org/") && !isRor(value.trim());

/** A creator as the row leaves it, starting from its stored object. */
function creatorOf(row: CreatorRow): Contributor {
  const next: Contributor = row.stored ? { ...row.stored } : { roles: ["creator"] };
  const name = row.name.trim();
  if (!row.stored || name !== (personName(row.stored) ?? "")) {
    next.title = name;
    delete next.givenName;
    delete next.familyName;
  }
  const orcid = row.orcid.trim();
  if (orcid !== (row.stored?.orcid ?? "")) {
    const checked = checkOrcid(orcid);
    if (!orcid) delete next.orcid;
    else if ("orcid" in checked) next.orcid = checked.orcid;
  }
  const affiliation = row.affiliation.trim();
  if (affiliation !== (row.stored ? affiliationOf(row.stored) : "")) {
    if (!affiliation) {
      delete next.organization;
      delete next.organizationId;
    } else if (isRor(affiliation)) {
      next.organizationId = affiliation;
    } else {
      next.organization = affiliation;
      delete next.organizationId;
    }
  }
  return next;
}

/** A grant as the row leaves it, keeping any stored `awardUri`. */
function grantOf(row: GrantRow): Funding {
  const next: Funding = row.stored ? { ...row.stored } : { funder: "" };
  next.funder = row.funder.trim();
  for (const key of ["awardNumber", "awardTitle"] as const) {
    const value = row[key].trim();
    if (value !== (row.stored?.[key] ?? "")) {
      if (value) next[key] = value;
      else if (row.stored) next[key] = null;
      else delete next[key];
    }
  }
  return next;
}

/** The contributors as the form leaves them: non-creators in place, new creators at the end. */
function contributorsOf(stored: Contributor[], rows: CreatorRow[]): Contributor[] {
  const out: Contributor[] = [];
  for (const contributor of stored) {
    if (!isCreator(contributor)) {
      out.push(contributor);
      continue;
    }
    const row = rows.find((r) => r.stored === contributor);
    if (row) out.push(creatorOf(row));
  }
  for (const row of rows) {
    if (!row.stored && row.name.trim()) out.push(creatorOf(row));
  }
  return out;
}

const keywordsOf = (text: string) =>
  text
    .split(",")
    .map((word) => word.trim())
    .filter(Boolean);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Where a 422's field shows: the form's field it names, else above the buttons. */
type Slot = "description" | "keywords" | "creators" | "related" | "funding" | "methods" | "note";
const SLOTS: Record<string, Slot> = {
  description: "description",
  keywords: "keywords",
  contributors: "creators",
  "archive:relatedIdentifiers": "related",
  "archive:funding": "funding",
  "archive:methods": "methods",
  note: "note",
};

/** The API's refusal as a sentence: capitalised, with a full stop. */
function problemOf(error: unknown): string {
  if (error instanceof ApiRefused && error.reason) {
    const text = error.reason.charAt(0).toUpperCase() + error.reason.slice(1);
    return /[.!?]$/.test(text) ? text : `${text}.`;
  }
  if (error instanceof ApiRefused) return "The archive refused the correction.";
  return "The archive can't be reached right now. Try again.";
}

/** What a 422's refused field says. */
const refusedWords = (field: RefusedField) =>
  `The archive didn't accept this${field.msg ? `: ${field.msg}` : field.type ? ` (${field.type.replaceAll("_", " ")})` : ""}.`;

function FieldError({ id, text }: { id: string; text: string | null | undefined }) {
  return text ? (
    <p id={id} className="field-error">
      {text}
    </p>
  ) : null;
}

/** Props that tie a field to its error. */
const described = (id: string, error: unknown) =>
  error ? { "aria-invalid": true as const, "aria-describedby": id } : {};

function CorrectionForm({
  id,
  version,
  manifest,
}: {
  id: string;
  version: number;
  manifest: Manifest;
}) {
  const navigate = useNavigate();
  const ids = useId();
  const storedContributors = manifest.contributors ?? [];
  const storedRelated = manifest["archive:relatedIdentifiers"] ?? [];
  const storedFunding = manifest["archive:funding"] ?? [];
  const versionPage = `/datasets/${encodeURIComponent(id)}/v${version}`;

  const [description, setDescription] = useState(manifest.description ?? "");
  const [keywords, setKeywords] = useState((manifest.keywords ?? []).join(", "));
  const [creators, setCreators] = useState(() =>
    storedContributors.filter(isCreator).map(creatorRow),
  );
  const [related, setRelated] = useState(storedRelated.map(relatedLine).join("\n"));
  const [grants, setGrants] = useState(() => storedFunding.map(grantRow));
  const [methods, setMethods] = useState(manifest["archive:methods"] ?? "");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<
    Partial<Record<Slot | "related-parse" | "unchanged", string>>
  >({});
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const setCreator = (key: number, change: Partial<CreatorRow>) =>
    setCreators((rows) => rows.map((row) => (row.key === key ? { ...row, ...change } : row)));
  const setGrant = (key: number, change: Partial<GrantRow>) =>
    setGrants((rows) => rows.map((row) => (row.key === key ? { ...row, ...change } : row)));

  /** The fields that differ from the stored ones; null when a field won't parse. */
  function changes(): Omit<CorrectionRequest, "note"> | null {
    const body: Omit<CorrectionRequest, "note"> = {};
    if (description.trim() !== (manifest.description ?? "").trim()) {
      body.description = description.trim() || null;
    }
    // Split only an edited field: a stored keyword may hold a comma, and must stay whole.
    if (keywords.trim() !== (manifest.keywords ?? []).join(", ")) {
      const words = keywordsOf(keywords);
      if (!same(words, manifest.keywords ?? [])) body.keywords = words.length ? words : null;
    }
    const contributors = contributorsOf(storedContributors, creators);
    if (!same(contributors, storedContributors)) body.contributors = contributors;
    const parsed = parseRelated(related, storedRelated);
    if (parsed === null) return null;
    if (!same(parsed, storedRelated))
      body["archive:relatedIdentifiers"] = parsed.length ? parsed : null;
    const funding = grants
      .filter((row) => row.funder.trim() || row.awardNumber.trim() || row.awardTitle.trim())
      .map(grantOf);
    if (!same(funding, storedFunding)) body["archive:funding"] = funding.length ? funding : null;
    if (methods.trim() !== (manifest["archive:methods"] ?? "").trim()) {
      body["archive:methods"] = methods.trim() || null;
    }
    return body;
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    // Check every creator's iD and affiliation as if each field had been left.
    const checked = creators.map((row) => {
      const orcid = row.orcid.trim();
      const result = orcid ? checkOrcid(orcid) : null;
      const orcidError = result && "problem" in result ? result.problem : null;
      const nameError = row.stored !== null && !row.name.trim();
      return { ...row, orcidError, rorError: badRor(row.affiliation), nameError };
    });
    setCreators(checked);
    const next: typeof errors = {};
    const body = changes();
    if (body === null) {
      next["related-parse"] =
        'Start each line with how it\'s related, such as "Is cited by", then a DOI or address.';
    } else if (!Object.keys(body).length) {
      next.unchanged = "Nothing has changed yet.";
    }
    if (!note.trim()) next.note = "Say what you corrected; it's shown under Corrections.";
    setErrors(next);
    const invalid = checked.some((row) => row.orcidError || row.rorError || row.nameError);
    if (body === null || invalid || Object.keys(next).length) return;
    setSending(true);
    try {
      await correctMetadata(id, version, { ...body, note: note.trim() });
      void navigate(versionPage);
    } catch (error) {
      setSending(false);
      if (error instanceof ApiRefused && error.status === 422 && error.detail?.length) {
        const placed: typeof errors = {};
        const elsewhere: string[] = [];
        for (const field of error.detail) {
          const slot = SLOTS[String(field.loc[1] ?? "")];
          if (slot) placed[slot] ??= refusedWords(field);
          else elsewhere.push(refusedWords(field));
        }
        setErrors(placed);
        if (elsewhere.length) setProblem(elsewhere[0] ?? null);
      } else {
        setProblem(problemOf(error));
      }
    }
  }

  const err = (slot: string) => `${ids}-${slot}-error`;
  const field = (
    slot: Slot,
    label: ReactNode,
    control: (props: { id: string } & ReturnType<typeof described>) => ReactNode,
  ) => {
    const errorText = errors[slot];
    return (
      <div className="field-block">
        <label className="field" htmlFor={`${ids}-${slot}`}>
          {label}
        </label>
        {control({ id: `${ids}-${slot}`, ...described(err(slot), errorText) })}
        <FieldError id={err(slot)} text={errorText} />
      </div>
    );
  };

  return (
    <form className="edit-form" noValidate onSubmit={(event) => void save(event)}>
      {field("description", "Description", (props) => (
        <textarea
          rows={4}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          {...props}
        />
      ))}
      {field(
        "keywords",
        <>
          Keywords <span className="muted">comma-separated</span>
        </>,
        (props) => (
          <input
            type="text"
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            {...props}
          />
        ),
      )}
      <fieldset className="rows" {...described(err("creators"), errors.creators)}>
        <legend>Creators</legend>
        {creators.map((row, index) => {
          const n = index + 1;
          const base = `${ids}-creator-${row.key}`;
          const orcidText =
            row.orcidError === "check-digit"
              ? "This ORCID iD's last digit doesn't check out."
              : row.orcidError === "shape"
                ? "An ORCID iD looks like 0000-0002-1825-0097."
                : null;
          return (
            <div key={row.key} className="creator-row" role="group" aria-label={`Creator ${n}`}>
              <div className="field-block">
                <label className="field" htmlFor={`${base}-name`}>
                  Name
                </label>
                <input
                  id={`${base}-name`}
                  type="text"
                  value={row.name}
                  {...described(`${base}-name-error`, row.nameError)}
                  onChange={(e) =>
                    setCreator(row.key, {
                      name: e.target.value,
                      nameError: row.nameError && !e.target.value.trim(),
                    })
                  }
                />
                <FieldError
                  id={`${base}-name-error`}
                  text={row.nameError ? "Give the creator a name, or remove them." : null}
                />
              </div>
              <div className="field-block">
                <label className="field" htmlFor={`${base}-orcid`}>
                  ORCID iD
                </label>
                <input
                  id={`${base}-orcid`}
                  type="text"
                  value={row.orcid}
                  {...described(`${base}-orcid-error`, orcidText)}
                  onChange={(e) => {
                    const value = e.target.value;
                    const result = value.trim() ? checkOrcid(value) : null;
                    const problem = result && "problem" in result ? result.problem : null;
                    setCreator(row.key, {
                      orcid: value,
                      orcidError:
                        problem === "check-digit"
                          ? "check-digit"
                          : problem === "shape" && row.orcidError === "shape"
                            ? "shape"
                            : null,
                    });
                  }}
                  onBlur={(e) => {
                    const value = e.target.value;
                    const result = value.trim() ? checkOrcid(value) : null;
                    if (result && "problem" in result)
                      setCreator(row.key, { orcidError: result.problem });
                  }}
                />
                <FieldError id={`${base}-orcid-error`} text={orcidText} />
              </div>
              <div className="field-block">
                <label className="field" htmlFor={`${base}-affiliation`}>
                  <span>
                    Affiliation <span className="muted">name or ROR address</span>
                  </span>
                </label>
                <input
                  id={`${base}-affiliation`}
                  type="text"
                  value={row.affiliation}
                  {...described(`${base}-affiliation-error`, row.rorError)}
                  onChange={(e) =>
                    setCreator(row.key, {
                      affiliation: e.target.value,
                      rorError: row.rorError && badRor(e.target.value),
                    })
                  }
                  onBlur={(e) => setCreator(row.key, { rorError: badRor(e.target.value) })}
                />
                <FieldError
                  id={`${base}-affiliation-error`}
                  text={row.rorError ? "A ROR address looks like https://ror.org/03yrm5c26." : null}
                />
              </div>
              <p className="row-remove">
                <button
                  type="button"
                  className="link-button"
                  onClick={() => setCreators((rows) => rows.filter((r) => r.key !== row.key))}
                >
                  Remove <span className="visually-hidden">creator {n}</span>
                </button>
              </p>
            </div>
          );
        })}
        <p className="row-add">
          <button
            type="button"
            className="link-button"
            onClick={() => setCreators((rows) => [...rows, creatorRow(null)])}
          >
            Add a creator
          </button>
        </p>
        <FieldError id={err("creators")} text={errors.creators} />
      </fieldset>
      <div className="field-block">
        <label className="field" htmlFor={`${ids}-related`}>
          <span>
            Related publications and data <span className="muted">one per line</span>
          </span>
        </label>
        <textarea
          id={`${ids}-related`}
          rows={3}
          value={related}
          onChange={(e) => setRelated(e.target.value)}
          {...described(err("related"), errors["related-parse"] ?? errors.related)}
        />
        <FieldError id={err("related")} text={errors["related-parse"] ?? errors.related} />
      </div>
      <fieldset className="rows" {...described(err("funding"), errors.funding)}>
        <legend>Funding</legend>
        {grants.map((row, index) => {
          const n = index + 1;
          const base = `${ids}-grant-${row.key}`;
          const input = (key: "funder" | "awardNumber" | "awardTitle", label: string) => (
            <div className="field-block">
              <label className="field" htmlFor={`${base}-${key}`}>
                {label}
              </label>
              <input
                id={`${base}-${key}`}
                type="text"
                value={row[key]}
                onChange={(e) => setGrant(row.key, { [key]: e.target.value })}
              />
            </div>
          );
          return (
            <div key={row.key} className="creator-row" role="group" aria-label={`Grant ${n}`}>
              {input("funder", "Funder")}
              {input("awardNumber", "Award number")}
              {input("awardTitle", "Award title")}
              <p className="row-remove">
                <button
                  type="button"
                  className="link-button"
                  onClick={() => setGrants((rows) => rows.filter((r) => r.key !== row.key))}
                >
                  Remove <span className="visually-hidden">grant {n}</span>
                </button>
              </p>
            </div>
          );
        })}
        <p className="row-add">
          <button
            type="button"
            className="link-button"
            onClick={() => setGrants((rows) => [...rows, grantRow(null)])}
          >
            Add a grant
          </button>
        </p>
        <FieldError id={err("funding")} text={errors.funding} />
      </fieldset>
      {field("methods", "Methods", (props) => (
        <textarea
          rows={3}
          value={methods}
          onChange={(e) => setMethods(e.target.value)}
          {...props}
        />
      ))}
      {field(
        "note",
        <>
          What did you correct? <span className="muted">shown under Corrections</span>
        </>,
        (props) => (
          <input
            type="text"
            required
            value={note}
            onChange={(e) => setNote(e.target.value)}
            {...props}
          />
        ),
      )}
      {(errors.unchanged ?? problem) && (
        <p role="alert" className="problem">
          {errors.unchanged ?? problem}
        </p>
      )}
      <p className="actions">
        <button type="submit" className="primary" disabled={sending}>
          Save correction
        </button>
        <Link className="button" to={versionPage}>
          Cancel
        </Link>
      </p>
    </form>
  );
}

type Loaded = { manifest: Manifest; withdrawn: boolean } | "failed" | null;

/** `/datasets/<id>/v<n>/correct`: one form for a published version's correctable details. */
export function CorrectDetails({ id, version }: { id: string; version: number }) {
  useTitle("Correct details");
  const [loaded, setLoaded] = useState<Loaded>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    Promise.all([getVersion(id, version), getDataset(id)]).then(
      ([answer, dataset]) =>
        current &&
        setLoaded({ manifest: answer.manifest as Manifest, withdrawn: Boolean(dataset.withdrawn) }),
      () => current && setLoaded("failed"),
    );
    return () => {
      current = false;
    };
  }, [id, version, attempt]);

  const versionPage = `/datasets/${encodeURIComponent(id)}/v${version}`;
  const title =
    loaded && loaded !== "failed" ? (loaded.manifest.title ?? loaded.manifest.name ?? id) : id;
  return (
    <>
      <Trail
        steps={[
          { label: "Browse", to: "/" },
          { label: title, to: versionPage },
          { label: "Correct details" },
        ]}
      />
      <PageHeading>Correct details</PageHeading>
      {loaded === null ? (
        <p role="status" className="loading">
          Loading the dataset…
        </p>
      ) : loaded === "failed" ? (
        <div className="callout failed">
          <p role="alert" className="lead">
            The dataset can't be loaded right now.
          </p>
          <p className="actions">
            <button type="button" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </p>
        </div>
      ) : (
        <>
          <p className="muted">
            Version {version} of {title}. Each save is listed under Corrections on the dataset page,
            with your note. Files, the version number and access can't change here: submit a new
            version for those.
          </p>
          {loaded.withdrawn ? (
            <div className="callout failed">
              <p className="lead">This dataset is withdrawn.</p>
              <p>
                Restore it before correcting its details: an admin can restore it from{" "}
                <Link to={versionPage}>its page</Link>.
              </p>
            </div>
          ) : (
            <CorrectionForm id={id} version={version} manifest={loaded.manifest} />
          )}
        </>
      )}
    </>
  );
}
