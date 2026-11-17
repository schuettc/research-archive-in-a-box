import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { Manifest } from "./generated/manifest";
import { bibtex, citation, citedAddress, doiAddress, doiOf, ris } from "./citation";
import { BRAND } from "./site";

const SAMPLE = join(import.meta.dirname, "../../../examples/sample-package");
const URL_ = "https://archive.example.org/datasets/stream-temperature-sample/v1";

test("the sample's citation is the README's, ending with the versioned URL", () => {
  const manifest = JSON.parse(readFileSync(join(SAMPLE, "datapackage.json"), "utf-8")) as Manifest;
  const readme = readFileSync(join(SAMPLE, "README.md"), "utf-8").split("\n");
  const cited = readme[readme.indexOf("## Citation") + 2];

  expect(citation(manifest, URL_)).toBe(`${cited} ${URL_}`);
});

test("with no archive:citation, it is built from the creators, year, title, version and id", () => {
  const manifest: Manifest = {
    id: "ds-1",
    title: "Lake levels.",
    version: "3",
    created: "2021-04-02T00:00:00Z",
    contributors: [
      { title: "Ada Invented", roles: ["creator"] },
      { givenName: "Ben", familyName: "Placeholder", roles: ["creator"] },
      { title: "Cy Curator", roles: ["data-curator"] },
    ],
  };

  expect(citation(manifest, URL_)).toBe(
    `Ada Invented, Ben Placeholder (2021). Lake levels. Version 3. ds-1. ${URL_}`,
  );
});

test("a manifest with no title has no citation", () => {
  expect(citation({ id: "ds-1" }, URL_)).toBeNull();
});

test("a DOI address in archive:identifier is cited instead of the page URL", () => {
  const doi = "https://handle.test.datacite.org/10.5072/example.irc.ds-1.v1";
  const manifest: Manifest = { id: "ds-1", title: "Lake levels", "archive:identifier": doi };

  expect(doiAddress(manifest)).toBe(doi);
  expect(citation(manifest, URL_)).toBe(`Lake levels. ds-1. ${doi}`);
  expect(doiAddress({ "archive:identifier": "https://doi.org/10.5072/x" })).toBe(
    "https://doi.org/10.5072/x",
  );
});

test("a page URL in archive:identifier is not a DOI, so the page URL is cited", () => {
  const manifest: Manifest = { id: "ds-1", title: "Lake levels", "archive:identifier": URL_ };

  expect(doiAddress(manifest)).toBeNull();
  expect(citation(manifest, URL_)).toBe(`Lake levels. ds-1. ${URL_}`);
});

test("doiOf reads a bare DOI, the doi: form and a resolver's address, and nothing else", () => {
  const of = (identifier: string) => doiOf({ "archive:identifier": identifier });

  expect(of("10.5072/irc.stream-temp.v2")).toEqual({
    doi: "10.5072/irc.stream-temp.v2",
    address: "https://doi.org/10.5072/irc.stream-temp.v2",
  });
  expect(of("doi:10.5072/irc.stream-temp.v2")).toEqual({
    doi: "10.5072/irc.stream-temp.v2",
    address: "https://doi.org/10.5072/irc.stream-temp.v2",
  });
  expect(of("https://doi.org/10.5072/x.v1")).toEqual({
    doi: "10.5072/x.v1",
    address: "https://doi.org/10.5072/x.v1",
  });
  expect(of("https://handle.test.datacite.org/10.5072/x.v1")).toEqual({
    doi: "10.5072/x.v1",
    address: "https://handle.test.datacite.org/10.5072/x.v1",
  });
  expect(of(URL_)).toBeNull();
  expect(of("ark:/12345/x")).toBeNull();
  expect(of("10.12/too-short-a-prefix")).toBeNull();
  expect(doiOf({})).toBeNull();
});

test("the cited address is the DOI's when there is one, else the versioned address", () => {
  expect(citedAddress({ "archive:identifier": "doi:10.5072/x.v1" }, URL_)).toBe(
    "https://doi.org/10.5072/x.v1",
  );
  expect(citedAddress({}, URL_)).toBe(URL_);
  expect(
    citation({ id: "ds-1", title: "Lake levels", "archive:identifier": "10.5072/x" }, URL_),
  ).toBe("Lake levels. ds-1. https://doi.org/10.5072/x");
});

const CITED: Manifest = {
  id: "ds-1",
  title: "Lake levels",
  version: "3",
  created: "2021-04-02T00:00:00Z",
  "archive:identifier": "https://doi.org/10.5072/irc.ds-1.v3",
  contributors: [
    { givenName: "Ada", familyName: "Invented", title: "Ada Invented", roles: ["creator"] },
    { title: "Lake Survey Team", roles: ["creator"] },
    { title: "Cy Curator", roles: ["data-curator"] },
  ],
};

test("BibTeX is one @misc entry from the same data as the citation", () => {
  expect(bibtex(CITED, URL_)).toBe(
    [
      "@misc{ds-1_v3,",
      "  author = {Invented, Ada and {Lake Survey Team}},",
      "  title = {Lake levels},",
      "  year = {2021},",
      "  version = {3},",
      `  publisher = {${BRAND.name}},`,
      "  doi = {10.5072/irc.ds-1.v3},",
      "  url = {https://doi.org/10.5072/irc.ds-1.v3}",
      "}",
      "",
    ].join("\n"),
  );
});

test("BibTeX escapes TeX's special characters, keys on a safe id and has no doi without one", () => {
  const entry = bibtex(
    { id: "lake levels/2", title: "Rock & roll: 100% #1 $5 a_b ^ ~ {x} \\", version: "1" },
    URL_,
  );

  expect(entry.split("\n")[0]).toBe("@misc{lake_levels_2_v1,");
  expect(entry).toContain(
    "  title = {Rock \\& roll: 100\\% \\#1 \\$5 a\\_b \\^{} \\~{} \\{x\\} \\textbackslash{}},",
  );
  expect(entry).not.toContain("doi =");
  expect(entry).toContain(`  url = {${URL_}}`);
});

test("RIS is a DATA record with its tags in order and CRLF line ends", () => {
  expect(ris(CITED, URL_)).toBe(
    [
      "TY  - DATA",
      "AU  - Invented, Ada",
      "AU  - Lake Survey Team",
      "TI  - Lake levels",
      "PY  - 2021",
      "ET  - 3",
      `PB  - ${BRAND.name}`,
      "DO  - 10.5072/irc.ds-1.v3",
      "UR  - https://doi.org/10.5072/irc.ds-1.v3",
      "ER  - ",
      "",
    ].join("\r\n"),
  );
});

test("BibTeX writes the doi and url as typed, since biblatex reads them verbatim", () => {
  const entry = bibtex(
    {
      id: "ds_2",
      title: "T",
      version: "1",
      "archive:identifier": "https://doi.org/10.5072/irc.ds_2.v1",
    },
    URL_,
  );

  expect(entry).toContain("  doi = {10.5072/irc.ds_2.v1},");
  expect(entry).toContain("  url = {https://doi.org/10.5072/irc.ds_2.v1}");
});

test("a malformed address in archive:identifier is no DOI, and nothing throws", () => {
  for (const identifier of ["https://", "https://x/%E0"]) {
    const manifest: Manifest = {
      id: "ds-1",
      title: "Lake levels",
      "archive:identifier": identifier,
    };
    expect(doiOf(manifest)).toBeNull();
    expect(citation(manifest, URL_)).toBe(`Lake levels. ds-1. ${URL_}`);
  }
});

test("a line break or run of spaces in a value can't split a RIS or BibTeX record", () => {
  const manifest: Manifest = {
    id: "ds-1",
    title: "Lake\nlevels\r\n  ER  - x",
    version: "3\n",
    contributors: [{ givenName: "Ada\n", familyName: "In  vented", roles: ["creator"] }],
  };

  const record = ris(manifest, URL_);
  expect(record).toContain("TI  - Lake levels ER - x\r\n");
  expect(record).toContain("AU  - In vented, Ada\r\n");
  expect(record).toContain("ET  - 3\r\n");
  expect(record.split("\r\n").filter((line) => line.startsWith("ER  -"))).toHaveLength(1);
  const entry = bibtex(manifest, URL_);
  expect(entry).toContain("  title = {Lake levels ER - x},");
  expect(entry).toContain("  author = {In vented, Ada},");
  expect(entry).toContain("  version = {3},");
});

test("with no created date, the year is archive:published's, in the citation, BibTeX and RIS", () => {
  const manifest: Manifest = {
    id: "ds-1",
    title: "Lake levels",
    version: "3",
    "archive:published": "2024-06-30T12:00:00Z",
    contributors: [{ givenName: "Ada", familyName: "Invented", roles: ["creator"] }],
  };

  expect(citation(manifest, URL_)).toBe(
    `Ada Invented (2024). Lake levels. Version 3. ds-1. ${URL_}`,
  );
  expect(bibtex(manifest, URL_)).toContain("  year = {2024},");
  expect(ris(manifest, URL_)).toContain("PY  - 2024\r\n");
  expect(bibtex({ ...manifest, created: "2021-04-02" }, URL_)).toContain("  year = {2021},");
});
