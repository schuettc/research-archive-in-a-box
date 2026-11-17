import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, test, vi, type Mock } from "vitest";
import type { DatasetAnswer, VersionAnswer } from "../api";
import type { Manifest } from "../generated/manifest";
import { CorrectDetails } from "./CorrectDetails";

vi.mock("../auth", () => ({
  apiToken: vi.fn(() => "TOKEN"),
  signIn: vi.fn(async () => {}),
  subscribe: vi.fn(() => () => {}),
  signedInEmail: vi.fn(() => "curator@example.org"),
  groups: vi.fn(() => ["curator"]),
}));

const SAMPLE = join(import.meta.dirname, "../../../../examples/sample-package");
const SAMPLE_MANIFEST = JSON.parse(
  readFileSync(join(SAMPLE, "datapackage.json"), "utf-8"),
) as Manifest;
const ID = "stream-temperature-sample";
const TITLE = SAMPLE_MANIFEST.title ?? "";

const MANIFEST: Manifest = {
  ...SAMPLE_MANIFEST,
  contributors: [
    {
      title: "Ada Invented",
      organization: "Example Lab",
      organizationId: "https://ror.org/03yrm5c26",
      orcid: "0000-0002-1825-0097",
      roles: ["creator"],
    },
    { title: "Ben Placeholder", roles: ["data-curator"] },
    { givenName: "Bo", familyName: "Example", organization: "Example Lab", roles: ["creator"] },
  ],
  "archive:relatedIdentifiers": [
    { relationType: "IsCitedBy", identifierType: "DOI", identifier: "10.5072/example.paper" },
  ],
  "archive:funding": [
    {
      funder: "Invented Foundation",
      awardNumber: "IF-2024-17",
      awardTitle: null,
      awardUri: "https://example.org/award/17",
    },
  ],
};

const DATASET: DatasetAnswer = {
  id: ID,
  title: TITLE,
  access: "public",
  currentVersion: 2,
  prefix: `open/${ID}/2/`,
  manifest: MANIFEST,
  files: [],
};
const VERSION: VersionAnswer = {
  version: 2,
  prefix: `open/${ID}/2/`,
  manifest: MANIFEST,
  files: [],
};

let fetchMock: Mock;
let dataset: DatasetAnswer;
let answer: Response | null;
/** The manifest version 2 answers with; a test may change it. */
let versionManifest: Manifest;

beforeEach(() => {
  dataset = DATASET;
  answer = null;
  versionManifest = MANIFEST;
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, "https://site").pathname;
    if (init?.method === "PUT" && path === `/api/datasets/${ID}/versions/2/metadata`) {
      return answer ?? Response.json({ datasetId: ID, version: 2, manifest: MANIFEST });
    }
    if (path === `/api/datasets/${ID}`) return Response.json(dataset);
    if (path === `/api/datasets/${ID}/versions/2`)
      return Response.json({ ...VERSION, manifest: versionManifest });
    return Response.json({}, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/datasets/${ID}/v2/correct`]}>
      <Routes>
        <Route
          path="/datasets/:id/:version/correct"
          element={<CorrectDetails id={ID} version={2} />}
        />
        <Route path="/datasets/:id/:version" element={<p>The version's page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function form() {
  renderPage();
  await screen.findByRole("button", { name: "Save correction" });
}

/** The body of each correction sent. */
function sent(): Record<string, unknown>[] {
  return (fetchMock.mock.calls as [string, RequestInit?][])
    .filter(([, init]) => init?.method === "PUT")
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
}

const creator = (n: number) => screen.getByRole("group", { name: `Creator ${n}` });
const type = (field: HTMLElement, value: string) => fireEvent.change(field, { target: { value } });
const note = (value: string) => type(screen.getByLabelText(/^What did you correct\?/), value);
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save correction" }));

test("the trail leads back through the dataset's version, above Correct details", async () => {
  await form();

  const trail = screen.getByRole("navigation", { name: "Breadcrumb" });
  expect(within(trail).getByRole("link", { name: "Browse" }).getAttribute("href")).toBe("/");
  expect(within(trail).getByRole("link", { name: TITLE }).getAttribute("href")).toBe(
    `/datasets/${ID}/v2`,
  );
  expect(within(trail).getByText("Correct details").getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Correct details");
  expect(screen.getByText(/^Version 2 of /).textContent).toBe(
    `Version 2 of ${TITLE}. Each save is listed under Corrections on the dataset page, with your note. Files, the version number and access can't change here: submit a new version for those.`,
  );
});

test("the form holds the stored values, a row per creator and per grant", async () => {
  await form();

  expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe(
    MANIFEST.description,
  );
  expect((screen.getByLabelText(/^Keywords/) as HTMLInputElement).value).toBe(
    "stream temperature, water quality, loggers",
  );
  expect(screen.getAllByRole("group", { name: /^Creator / })).toHaveLength(2);
  expect((within(creator(1)).getByLabelText(/^Affiliation/) as HTMLInputElement).value).toBe(
    "https://ror.org/03yrm5c26",
  );
  expect((within(creator(2)).getByLabelText("Name") as HTMLInputElement).value).toBe("Bo Example");
  expect(
    (screen.getByLabelText(/^Related publications and data/) as HTMLTextAreaElement).value,
  ).toBe("Is cited by doi:10.5072/example.paper");
  const grant = screen.getByRole("group", { name: "Grant 1" });
  expect((within(grant).getByLabelText("Funder") as HTMLInputElement).value).toBe(
    "Invented Foundation",
  );
});

test("a description-only correction sends only the description and the note, then shows the version", async () => {
  await form();

  type(screen.getByLabelText("Description"), "Three sites, not four.");
  note("Fixed the site count.");
  save();

  await screen.findByText("The version's page");
  expect(sent()).toEqual([
    { description: "Three sites, not four.", note: "Fixed the site count." },
  ]);
});

test("an ORCID iD with a wrong last digit says so as it is typed", async () => {
  await form();
  const field = within(creator(2)).getByLabelText("ORCID iD");

  type(field, "0000-0002-1825-009");
  expect(within(creator(2)).queryByText(/last digit/)).toBeNull();
  type(field, "0000-0002-1825-0098");

  const error = within(creator(2)).getByText("This ORCID iD's last digit doesn't check out.");
  expect(field.getAttribute("aria-invalid")).toBe("true");
  expect(field.getAttribute("aria-describedby")).toBe(error.id);
  note("Added Bo's iD.");
  save();
  expect(sent()).toEqual([]);
});

test("something not shaped like an iD says what one looks like on leaving the field", async () => {
  await form();
  const field = within(creator(2)).getByLabelText("ORCID iD");

  type(field, "orcid 1825");
  expect(within(creator(2)).queryByText(/looks like/)).toBeNull();
  fireEvent.blur(field);

  expect(within(creator(2)).getByText("An ORCID iD looks like 0000-0002-1825-0097.")).toBeDefined();
});

test("a creator's iD added sends the whole contributors list, the non-creator kept in place", async () => {
  await form();

  type(within(creator(2)).getByLabelText("ORCID iD"), "https://orcid.org/0000-0002-1694-233X");
  type(within(creator(2)).getByLabelText(/^Affiliation/), "https://ror.org/05dxps055");
  note("Added Bo's iD and ROR.");
  save();

  await screen.findByText("The version's page");
  expect(sent()).toEqual([
    {
      contributors: [
        MANIFEST.contributors![0],
        MANIFEST.contributors![1],
        {
          givenName: "Bo",
          familyName: "Example",
          organization: "Example Lab",
          organizationId: "https://ror.org/05dxps055",
          roles: ["creator"],
          orcid: "0000-0002-1694-233X",
        },
      ],
      note: "Added Bo's iD and ROR.",
    },
  ]);
});

test("a renamed creator loses the given and family names; a plain affiliation drops the ROR id", async () => {
  await form();

  type(within(creator(1)).getByLabelText(/^Affiliation/), "Another Lab");
  type(within(creator(2)).getByLabelText("Name"), "Bo Examplé");
  type(within(creator(1)).getByLabelText("ORCID iD"), "");
  note("Names.");
  save();

  await screen.findByText("The version's page");
  expect(sent()[0]!.contributors).toEqual([
    { title: "Ada Invented", organization: "Another Lab", roles: ["creator"] },
    MANIFEST.contributors![1],
    { organization: "Example Lab", roles: ["creator"], title: "Bo Examplé" },
  ]);
});

test("a ROR-looking affiliation that isn't one says what one looks like", async () => {
  await form();
  const field = within(creator(2)).getByLabelText(/^Affiliation/);

  type(field, "https://ror.org/nope");
  fireEvent.blur(field);

  expect(
    within(creator(2)).getByText("A ROR address looks like https://ror.org/03yrm5c26."),
  ).toBeDefined();
  note("ROR.");
  save();
  expect(sent()).toEqual([]);
});

test("a new creator is appended with the creator role; a removed one is left out", async () => {
  await form();

  fireEvent.click(screen.getByRole("button", { name: "Add a creator" }));
  type(within(creator(3)).getByLabelText("Name"), "Cy New");
  fireEvent.click(within(creator(1)).getByRole("button", { name: /^Remove/ }));
  note("Creators.");
  save();

  await screen.findByText("The version's page");
  expect(sent()[0]!.contributors).toEqual([
    MANIFEST.contributors![1],
    MANIFEST.contributors![2],
    { roles: ["creator"], title: "Cy New" },
  ]);
});

test("a related line is parsed into its relation and identifier, the stored one kept", async () => {
  await form();

  type(
    screen.getByLabelText(/^Related publications and data/),
    "Is cited by doi:10.5072/example.paper\nReferences https://example.org/report\nis supplement to 10.5072/other",
  );
  note("Related.");
  save();

  await screen.findByText("The version's page");
  expect(sent()[0]!["archive:relatedIdentifiers"]).toEqual([
    MANIFEST["archive:relatedIdentifiers"]![0],
    { relationType: "References", identifierType: "URL", identifier: "https://example.org/report" },
    { relationType: "IsSupplementTo", identifierType: "DOI", identifier: "10.5072/other" },
  ]);
});

test("a related line that doesn't parse is refused, and nothing is sent", async () => {
  await form();

  type(screen.getByLabelText(/^Related publications and data/), "Mentions 10.5072/other");
  note("Related.");
  save();

  expect(
    screen.getByText(
      'Start each line with how it\'s related, such as "Is cited by", then a DOI or address.',
    ),
  ).toBeDefined();
  expect(sent()).toEqual([]);
});

test("a grant's award number changed keeps its award address", async () => {
  await form();

  const grant = screen.getByRole("group", { name: "Grant 1" });
  type(within(grant).getByLabelText("Award number"), "IF-2024-18");
  note("Award.");
  save();

  await screen.findByText("The version's page");
  expect(sent()[0]!["archive:funding"]).toEqual([
    {
      funder: "Invented Foundation",
      awardNumber: "IF-2024-18",
      awardTitle: null,
      awardUri: "https://example.org/award/17",
    },
  ]);
});

test("with nothing changed, it says so and sends nothing", async () => {
  await form();

  note("Nothing really.");
  save();

  expect(screen.getByText("Nothing has changed yet.")).toBeDefined();
  expect(sent()).toEqual([]);
});

test("a creator whose name is emptied is refused under the field, and nothing is sent", async () => {
  await form();
  const name = within(creator(1)).getByLabelText("Name");

  type(name, "  ");
  note("Names.");
  save();

  const error = within(creator(1)).getByText("Give the creator a name, or remove them.");
  expect(name.getAttribute("aria-invalid")).toBe("true");
  expect(name.getAttribute("aria-describedby")).toBe(error.id);
  expect(sent()).toEqual([]);
});

test("a stored keyword with a comma stays whole unless the keywords are edited", async () => {
  dataset = { ...DATASET, manifest: { ...MANIFEST, keywords: ["Temperature, water", "rivers"] } };
  versionManifest = { ...MANIFEST, keywords: ["Temperature, water", "rivers"] };
  await form();

  note("Nothing really.");
  save();
  expect(screen.getByText("Nothing has changed yet.")).toBeDefined();
  expect(sent()).toEqual([]);

  type(screen.getByLabelText("Description"), "New words.");
  save();

  await screen.findByText("The version's page");
  expect(sent()).toEqual([{ description: "New words.", note: "Nothing really." }]);
});

test("with no note, it asks for one and sends nothing", async () => {
  await form();

  type(screen.getByLabelText("Methods"), "Loggers.");
  save();

  const field = screen.getByLabelText(/^What did you correct\?/);
  const error = screen.getByText("Say what you corrected; it's shown under Corrections.");
  expect(field.getAttribute("aria-describedby")).toBe(error.id);
  expect(sent()).toEqual([]);
});

test("a 422 shows against the field it names", async () => {
  answer = Response.json(
    {
      statusCode: 422,
      detail: [{ loc: ["body", "contributors", 1, "orcid"], type: "value_error" }],
    },
    { status: 422 },
  );
  await form();

  type(within(creator(2)).getByLabelText("Name"), "Bo E.");
  note("Name.");
  save();

  const creators = screen.getByRole("group", { name: "Creators" });
  expect(await within(creators).findByText(/The archive didn't accept this/)).toBeDefined();
  expect(screen.queryByText("The version's page")).toBeNull();
});

test("a 409 shows the API's words above the buttons", async () => {
  answer = Response.json(
    { error: "dataset stream-temperature-sample is withdrawn; restore it before correcting it" },
    { status: 409 },
  );
  await form();

  type(screen.getByLabelText("Methods"), "Loggers.");
  note("Methods.");
  save();

  expect((await screen.findByRole("alert")).textContent).toBe(
    "Dataset stream-temperature-sample is withdrawn; restore it before correcting it.",
  );
});

test("a withdrawn dataset says to restore it first, and has no form", async () => {
  dataset = { ...DATASET, withdrawn: { at: "2026-12-03T10:00:00Z", by: "x", reason: "consent" } };
  renderPage();

  expect(await screen.findByText(/Restore it before correcting its details/)).toBeDefined();
  expect(screen.queryByRole("button", { name: "Save correction" })).toBeNull();
});

test("Cancel leads back to the version's page", async () => {
  await form();

  expect(screen.getByRole("link", { name: "Cancel" }).getAttribute("href")).toBe(
    `/datasets/${ID}/v2`,
  );
});

test("an axe check of the form with an error showing finds no violations", async () => {
  const { container } = renderPage();
  await screen.findByRole("button", { name: "Save correction" });
  type(within(creator(2)).getByLabelText("ORCID iD"), "0000-0002-1825-0098");
  save();
  await waitFor(() => screen.getByText("Say what you corrected; it's shown under Corrections."));

  const results = await axe.run(container);
  expect(results.violations).toEqual([]);
});
