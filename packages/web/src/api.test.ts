import { afterEach, beforeEach, expect, test, vi, type Mock } from "vitest";
import {
  ApiRefused,
  correctMetadata,
  createSubmission,
  decide,
  getDownloads,
  getPolicy,
  getSubmission,
  heldFiles,
  listCurators,
  listSubmissions,
  lookupPeople,
  renewUploads,
  restoreDataset,
  savePolicy,
  submitRound,
  withdrawDataset,
} from "./api";
import { apiToken } from "./auth";

vi.mock("./auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth")>()),
  apiToken: vi.fn(() => "id-token"),
}));

let fetchMock: Mock;

beforeEach(() => {
  vi.mocked(apiToken).mockReturnValue("id-token");
  fetchMock = vi.fn(async () => Response.json({}));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

function call(n = 0): { url: string; method: string; body: unknown; auth: string | null } {
  const [url, init = {}] = fetchMock.mock.calls[n] as [string, RequestInit?];
  return {
    url,
    method: init.method ?? "GET",
    body: init.body ? JSON.parse(String(init.body)) : undefined,
    auth: new Headers(init.headers).get("Authorization"),
  };
}

const FILES = [{ path: "datapackage.json", size: 10, sha256: "a".repeat(64) }];

test.each([
  ["list mine", () => listSubmissions({ mine: true }), "GET", "/api/submissions?mine=1", undefined],
  [
    "list a status",
    () => listSubmissions({ status: "needs-changes" }),
    "GET",
    "/api/submissions?status=needs-changes",
    undefined,
  ],
  ["read", () => getSubmission("s 1"), "GET", "/api/submissions/s%201", undefined],
  [
    "create",
    () => createSubmission(FILES, "ds-1"),
    "POST",
    "/api/submissions",
    { files: FILES, datasetId: "ds-1" },
  ],
  [
    "renew",
    () => renewUploads("s1", FILES),
    "POST",
    "/api/submissions/s1/uploads",
    { files: FILES },
  ],
  ["submit", () => submitRound("s1"), "POST", "/api/submissions/s1/submit", undefined],
  [
    "decide",
    () => decide("s1", "request-changes", "fix the units"),
    "POST",
    "/api/submissions/s1/decision",
    { decision: "request-changes", note: "fix the units" },
  ],
  ["held files", () => heldFiles("s1"), "GET", "/api/submissions/s1/files", undefined],
  ["policy", () => getPolicy(), "GET", "/api/submissions/policy", undefined],
  [
    "save policy",
    () => savePolicy({ required: true, staleDays: 14 }),
    "PUT",
    "/api/submissions/policy",
    { required: true, staleDays: 14 },
  ],
  ["people", () => lookupPeople(["a", "b"]), "GET", "/api/people?sub=a&sub=b", undefined],
  ["curators", () => listCurators(), "GET", "/api/curators", undefined],
  [
    "withdraw",
    () => withdrawDataset("ds 1", "consent withdrawn"),
    "POST",
    "/api/admin/datasets/ds%201/withdraw",
    { reason: "consent withdrawn" },
  ],
  ["restore", () => restoreDataset("ds-1"), "POST", "/api/admin/datasets/ds-1/restore", undefined],
  [
    "correct",
    () => correctMetadata("ds-1", 2, { description: "Fixed.", note: "the site count" }),
    "PUT",
    "/api/datasets/ds-1/versions/2/metadata",
    { description: "Fixed.", note: "the site count" },
  ],
  ["downloads", () => getDownloads("all"), "GET", "/api/admin/downloads?months=all", undefined],
])("%s calls its route with the reader's ID token", async (_name, run, method, url, body) => {
  await run();

  const sent = call();
  expect(sent.method).toBe(method);
  expect(sent.url).toBe(url);
  expect(sent.body).toEqual(body);
  expect(sent.auth).toBe("Bearer id-token");
});

test("a refusal carries the API's own words", async () => {
  fetchMock.mockImplementation(async () =>
    Response.json(
      { error: "a second approval must come from a different curator" },
      { status: 409 },
    ),
  );

  const error = await decide("s1", "approve").catch((e: unknown) => e);

  expect(error).toBeInstanceOf(ApiRefused);
  expect((error as ApiRefused).status).toBe(409);
  expect((error as ApiRefused).reason).toBe("a second approval must come from a different curator");
});

test("a 422 carries the API's detail, naming the fields it refused", async () => {
  const detail = [{ loc: ["body", "contributors", 0, "orcid"], type: "value_error" }];
  fetchMock.mockImplementation(async () =>
    Response.json({ statusCode: 422, detail }, { status: 422 }),
  );

  const error = await correctMetadata("ds-1", 1, { note: "x" }).catch((e: unknown) => e);

  expect((error as ApiRefused).status).toBe(422);
  expect((error as ApiRefused).detail).toEqual(detail);
});

test("signed out, a signed-in call is refused as 401 without asking the API", async () => {
  vi.mocked(apiToken).mockReturnValue(null);

  const error = await listSubmissions({ mine: true }).catch((e: unknown) => e);

  expect((error as ApiRefused).status).toBe(401);
  expect(fetchMock).not.toHaveBeenCalled();
});
