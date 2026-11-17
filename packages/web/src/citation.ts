import type { Contributor, Manifest } from "./generated/manifest";
import { BRAND } from "./site";

/** A contributor's display name: its title, else given and family name, else organization. */
export function personName(contributor: Contributor): string | null {
  if (contributor.title) return contributor.title;
  const parts = [contributor.givenName, contributor.familyName].filter(Boolean);
  if (parts.length) return parts.join(" ");
  return contributor.organization ?? null;
}

export function creatorNames(manifest: Manifest): string[] {
  return (manifest.contributors ?? [])
    .filter((c) => c.roles?.includes("creator"))
    .map(personName)
    .filter((name): name is string => Boolean(name));
}

const squash = (text: string) => text.split(/\s+/).filter(Boolean).join(" ");

const DOI = /^10\.\d{4,9}\/\S+$/;

/**
 * The version's DOI from `archive:identifier`, bare, with its address: the stored address when
 * the identifier is one (doi.org, or DataCite's test handle server), else `https://doi.org/<doi>`.
 * A bare DOI and the `doi:` form count; any other identifier is null.
 */
export function doiOf(manifest: Manifest): { doi: string; address: string } | null {
  const stored: unknown = manifest["archive:identifier"];
  if (typeof stored !== "string") return null;
  const value = stored.trim();
  if (/^https:\/\//.test(value)) {
    let doi: string;
    try {
      doi = decodeURIComponent(new URL(value).pathname.slice(1));
    } catch {
      return null; // not an address, or a broken escape: no DOI
    }
    return DOI.test(doi) ? { doi, address: value } : null;
  }
  const doi = value.replace(/^doi:/i, "");
  return DOI.test(doi) ? { doi, address: `https://doi.org/${doi}` } : null;
}

/** The version's DOI address from `archive:identifier`, or null when it has no DOI. */
export function doiAddress(manifest: Manifest): string | null {
  return doiOf(manifest)?.address ?? null;
}

/** The address a citation gives: the DOI's when the version has one, else the versioned URL. */
export function citedAddress(manifest: Manifest, versionUrl: string): string {
  return doiAddress(manifest) ?? versionUrl;
}

/** The year cited: `created`'s, else the year it was published (`archive:published`). */
function yearOf(manifest: Manifest): string | null {
  const date = manifest.created ?? manifest["archive:published"];
  return date ? date.slice(0, 4) : null;
}

/**
 * The citation as the generated README builds it (`archive:citation`, else creators, year,
 * title, version and id), then the DOI's address when the version has one, else the versioned
 * URL the reader cites.
 */
export function citation(manifest: Manifest, versionUrl: string): string | null {
  const url = citedAddress(manifest, versionUrl);
  if (manifest["archive:citation"]) return `${squash(manifest["archive:citation"])} ${url}`;
  if (!manifest.title) return null;
  const parts: string[] = [];
  const names = creatorNames(manifest);
  if (names.length) {
    const year = yearOf(manifest) ? ` (${yearOf(manifest)})` : "";
    parts.push(`${names.join(", ")}${year}.`);
  }
  parts.push(`${manifest.title.replace(/\.+$/, "")}.`);
  if (manifest.version) parts.push(`Version ${manifest.version}.`);
  if (manifest.id) parts.push(`${manifest.id}.`);
  parts.push(url);
  return parts.join(" ");
}

type ReferenceName = { name: string; whole: boolean };

/** Each creator as a reference manager reads a name: "Family, Given", else the whole name. */
function creatorsForReference(manifest: Manifest): ReferenceName[] {
  return (manifest.contributors ?? [])
    .filter((c) => c.roles?.includes("creator"))
    .flatMap((c): ReferenceName[] => {
      if (c.familyName) {
        return [
          { name: c.givenName ? `${c.familyName}, ${c.givenName}` : c.familyName, whole: false },
        ];
      }
      const name = personName(c);
      return name ? [{ name, whole: true }] : [];
    });
}

/**
 * What BibTeX and RIS both give: the citation's data, with the DOI and the cited address, each
 * value on one line with its whitespace squashed, so no value can split a record.
 */
function referenceOf(manifest: Manifest, versionUrl: string) {
  const one = (text: string | null | undefined) => (text == null ? null : squash(text));
  return {
    creators: creatorsForReference(manifest).map((c) => ({ ...c, name: squash(c.name) })),
    title: one(manifest.title?.replace(/\.+$/, "")),
    year: one(yearOf(manifest)),
    version: one(manifest.version),
    doi: one(doiOf(manifest)?.doi),
    url: squash(citedAddress(manifest, versionUrl)),
  };
}

const TEX: Record<string, string> = {
  "\\": "\\textbackslash{}",
  "{": "\\{",
  "}": "\\}",
  "&": "\\&",
  "%": "\\%",
  $: "\\$",
  "#": "\\#",
  _: "\\_",
  "^": "\\^{}",
  "~": "\\~{}",
};
const tex = (text: string) => text.replace(/[\\{}&%$#_^~]/g, (c) => TEX[c] ?? c);

/** One BibTeX `@misc` entry keyed `<id>_v<version>`, from the same data as the citation. */
export function bibtex(manifest: Manifest, versionUrl: string): string {
  const ref = referenceOf(manifest, versionUrl);
  const id = manifest.id ?? manifest.name ?? "dataset";
  const key = `${id}${ref.version ? `_v${ref.version}` : ""}`.replace(/[^A-Za-z0-9_:-]/g, "_");
  const fields: [string, string][] = [];
  if (ref.creators.length) {
    const names = ref.creators.map((c) => (c.whole ? `{${tex(c.name)}}` : tex(c.name)));
    fields.push(["author", names.join(" and ")]);
  }
  if (ref.title) fields.push(["title", tex(ref.title)]);
  if (ref.year) fields.push(["year", tex(ref.year)]);
  if (ref.version) fields.push(["version", tex(ref.version)]);
  fields.push(["publisher", tex(squash(BRAND.name))]);
  // biblatex reads doi and url verbatim, so they are written as typed, not escaped.
  if (ref.doi) fields.push(["doi", ref.doi]);
  fields.push(["url", ref.url]);
  const body = fields.map(([name, value]) => `  ${name} = {${value}}`).join(",\n");
  return `@misc{${key},\n${body}\n}\n`;
}

/** One RIS `DATA` record, from the same data as the citation, its lines ending CRLF. */
export function ris(manifest: Manifest, versionUrl: string): string {
  const ref = referenceOf(manifest, versionUrl);
  const lines: [string, string | null][] = [
    ["TY", "DATA"],
    ...ref.creators.map((c): [string, string] => ["AU", c.name]),
    ["TI", ref.title],
    ["PY", ref.year],
    ["ET", ref.version],
    ["PB", squash(BRAND.name)],
    ["DO", ref.doi],
    ["UR", ref.url],
    ["ER", ""],
  ];
  return lines
    .filter((line): line is [string, string] => line[1] !== null)
    .map(([tag, value]) => `${tag}  - ${value}\r\n`)
    .join("");
}
