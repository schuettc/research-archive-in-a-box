import { apiToken } from "./auth";
import type { components } from "./generated/api";
import type { FieldEdit } from "./package";

type Schemas = components["schemas"];
export type CatalogRow = Schemas["CatalogRow"];
export type SearchAnswer = Schemas["SearchAnswer"];
export type DatasetAnswer = Schemas["DatasetAnswer"];
export type VersionAnswer = Schemas["VersionAnswer"];
export type VersionsAnswer = Schemas["VersionsAnswer"];
export type Withdrawal = Schemas["Withdrawal"];

/** The API couldn't be reached, or failed on its side: the reader can only try again. */
export class ApiUnreachable extends Error {
  constructor(cause?: unknown) {
    super("the archive's API can't be reached", { cause });
    this.name = "ApiUnreachable";
  }
}

/** One field a 422 refused: where in the body (`["body", "contributors", 0, "orcid"]`) and why. */
export type RefusedField = { loc: (string | number)[]; type?: string; msg?: string };

/**
 * The API answered with a refusal, such as 404 for a dataset that isn't there; `reason` is the
 * API's own words (its `{"error": ...}`) when it gave them, and `detail` the fields a signed-in
 * route's 422 refused.
 */
export class ApiRefused extends Error {
  constructor(
    readonly status: number,
    readonly reason: string | null = null,
    readonly detail: RefusedField[] | null = null,
  ) {
    super(reason ?? `the archive's API answered ${status}`);
    this.name = "ApiRefused";
  }
}

/** The `error` of a refusal's JSON body, if it has one. */
async function reasonOf(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    throw new ApiUnreachable(error);
  }
  if (response.status >= 500) throw new ApiUnreachable(response.status);
  if (!response.ok) throw new ApiRefused(response.status, await reasonOf(response));
  return (await response.json()) as T;
}

const segment = encodeURIComponent;

/** The most a package's files may total, in bytes, as the archive publishes it. */
export async function getPackageLimit(): Promise<number> {
  const checks = await getJson<{ maxPackageGiB: number }>("/archive-checks.json");
  return checks.maxPackageGiB * 1024 ** 3;
}

/** `GET /api/search` with the query string as the search page holds it. */
export function search(query: URLSearchParams): Promise<SearchAnswer> {
  return getJson(`/api/search?${query}`);
}

export function getDataset(id: string): Promise<DatasetAnswer> {
  return getJson(`/api/datasets/${segment(id)}`);
}

export function getVersion(id: string, version: number): Promise<VersionAnswer> {
  return getJson(`/api/datasets/${segment(id)}/versions/${version}`);
}

export function getVersions(id: string): Promise<VersionsAnswer> {
  return getJson(`/api/datasets/${segment(id)}/versions`);
}

export type UsageAnswers = Schemas["UsageAnswers"];

/** `POST /api/datasets/{id}/usage`: the reader's optional answers, anonymously. */
export async function sendUsage(id: string, answers: UsageAnswers): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`/api/datasets/${segment(id)}/usage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(answers),
    });
  } catch (error) {
    throw new ApiUnreachable(error);
  }
  if (response.status >= 500) throw new ApiUnreachable(response.status);
  if (!response.ok) throw new ApiRefused(response.status);
}

/**
 * `GET /api/datasets/{id}/versions/{version}/download` with the reader's access token: the
 * short-lived link to one file. 401 means sign in again, 403 the account can't have it, with
 * the API's reason ("ask for access", "your request is waiting", ...) as the refusal's `reason`.
 */
export async function downloadLink(
  id: string,
  version: number,
  path: string,
  token: string,
): Promise<string> {
  const query = new URLSearchParams({ path });
  const answer = await getJson<Schemas["DownloadAnswer"]>(
    `/api/datasets/${segment(id)}/versions/${version}/download?${query}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return answer.url;
}

export type Submission = Schemas["Submission"];
export type SubmissionRead = Schemas["SubmissionRead"];
export type SubmissionEvent = Schemas["Event"];
export type SubmittedFile = Schemas["SubmittedFile"];
export type UploadsAnswer = Schemas["UploadsAnswer"];
export type Upload = Schemas["Upload"];
export type HeldFiles = Schemas["HeldFiles"];
export type HeldFile = Schemas["HeldFile"];
export type FindingsReport = Schemas["FindingsReport"];
export type Finding = Schemas["Finding"];
export type ReviewPolicy = Schemas["ReviewPolicy"];
export type Rule = Schemas["Rule"];
export type Curator = Schemas["Curator"];
export type Decision = Schemas["DecisionRequest"]["decision"];

/**
 * A call to a signed-in route with the reader's ID token: 401 without asking when no one is
 * signed in, and the API's own words on any other refusal.
 */
async function signedIn<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const token = apiToken();
  if (!token) throw new ApiRefused(401);
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new ApiUnreachable(error);
  }
  if (response.status >= 500) throw new ApiUnreachable(response.status);
  if (!response.ok) throw await refusalOf(response);
  return (await response.json()) as T;
}

/** A refusal with the API's words (`error`) and, on a 422, the fields it refused (`detail`). */
async function refusalOf(response: Response): Promise<ApiRefused> {
  let body: { error?: unknown; detail?: unknown } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // No JSON body: the status says it all.
  }
  return new ApiRefused(
    response.status,
    typeof body.error === "string" ? body.error : null,
    Array.isArray(body.detail) ? (body.detail as RefusedField[]) : null,
  );
}

/** `GET /api/submissions`: the reader's own (`mine`), or a curator's list for one status. */
export function listSubmissions(
  query: { mine: true } | { status: Submission["status"] },
): Promise<Schemas["SubmissionList"]> {
  const params = "mine" in query ? "mine=1" : `status=${segment(query.status)}`;
  return signedIn(`/api/submissions?${params}`);
}

export function getSubmission(id: string): Promise<SubmissionRead> {
  return signedIn(`/api/submissions/${segment(id)}`);
}

/** `POST /api/submissions`: round 1's files, answered with their upload links. */
export function createSubmission(
  files: SubmittedFile[],
  datasetId: string,
): Promise<UploadsAnswer> {
  return signedIn("/api/submissions", "POST", { files, datasetId });
}

/** `POST /api/submissions/{id}/uploads`: the next round's links, or new links for a draft. */
export function renewUploads(id: string, files: SubmittedFile[]): Promise<UploadsAnswer> {
  return signedIn(`/api/submissions/${segment(id)}/uploads`, "POST", { files });
}

export function submitRound(id: string): Promise<Schemas["SubmitAnswer"]> {
  return signedIn(`/api/submissions/${segment(id)}/submit`, "POST");
}

export function decide(
  id: string,
  decision: Decision,
  note?: string,
): Promise<Schemas["DecisionAnswer"]> {
  const body = note ? { decision, note } : { decision };
  return signedIn(`/api/submissions/${segment(id)}/decision`, "POST", body);
}

export function heldFiles(id: string): Promise<HeldFiles> {
  return signedIn(`/api/submissions/${segment(id)}/files`);
}

export function getPolicy(): Promise<ReviewPolicy> {
  return signedIn("/api/submissions/policy");
}

export function savePolicy(policy: ReviewPolicy): Promise<ReviewPolicy> {
  return signedIn("/api/submissions/policy", "PUT", policy);
}

/** `GET /api/people`: the emails of up to 50 ids; unknown ids are left out. */
export function lookupPeople(subs: string[]): Promise<Schemas["People"]> {
  const query = new URLSearchParams(subs.map((sub) => ["sub", sub]));
  return signedIn(`/api/people?${query}`);
}

export function listCurators(): Promise<Curator[]> {
  return signedIn("/api/curators");
}

export type ChecksAnswer = Schemas["ChecksAnswer"];

/** `POST /api/checks`: the manifest-only checks' findings on a datapackage.json. */
export function checkManifest(manifest: Record<string, unknown>): Promise<ChecksAnswer> {
  return signedIn("/api/checks", "POST", manifest);
}

export type EditAnswer = Schemas["EditAnswer"];

/** `POST /api/submissions/{id}/edits`: a curator's or the submitter's edits to the held round's text. */
export function editSubmission(id: string, edits: FieldEdit[]): Promise<EditAnswer> {
  return signedIn(`/api/submissions/${segment(id)}/edits`, "POST", { edits });
}

export type Account = Schemas["Account"];
export type AccountEvent = Schemas["AccountEvent"];
export type Role = Account["roles"][number];

/** `GET /api/admin/people`: every account, for admins. */
export async function listAccounts(): Promise<Account[]> {
  return (await signedIn<Schemas["AccountList"]>("/api/admin/people")).people;
}

/** `POST /api/admin/people`: invite an email with roles; Cognito emails a temporary password. */
export function invitePerson(email: string, roles: Role[]): Promise<Account> {
  const body: Schemas["InviteRequest"] = { email, roles };
  return signedIn("/api/admin/people", "POST", body);
}

/** `PUT /api/admin/people/{sub}/roles`: the roles to hold, exactly. */
export function setRoles(sub: string, roles: Role[]): Promise<Account> {
  const body: Schemas["RolesRequest"] = { roles };
  return signedIn(`/api/admin/people/${segment(sub)}/roles`, "PUT", body);
}

/** `POST /api/admin/people/{sub}/resend`, `/disable` or `/enable`. */
export function changeAccount(
  sub: string,
  action: "resend" | "disable" | "enable",
): Promise<Account> {
  return signedIn(`/api/admin/people/${segment(sub)}/${action}`, "POST");
}

/** `GET /api/admin/account-events`: the most recent changes to anyone, newest first. */
export async function accountEvents(limit?: number): Promise<AccountEvent[]> {
  const query = limit ? `?limit=${limit}` : "";
  return (await signedIn<Schemas["AccountEventList"]>(`/api/admin/account-events${query}`)).events;
}

export type AccessRequest = Schemas["AccessRequest"];

/** `GET /api/admin/access-requests`: the waiting requests and the approvals, for admins. */
export async function listAccessRequests(): Promise<AccessRequest[]> {
  return (await signedIn<Schemas["AccessRequestList"]>("/api/admin/access-requests")).requests;
}

/**
 * `POST /api/admin/access-requests/{dataset}/{sub}/decision`: approve, optionally until a date
 * (`YYYY-MM-DD`), or decline; either with an optional note the person sees.
 */
export function decideAccess(
  request: AccessRequest,
  decision: Schemas["DecisionBody"]["decision"],
  note: string | null,
  until: string | null = null,
): Promise<AccessRequest> {
  const body: Schemas["DecisionBody"] = { decision, note, until };
  return signedIn(
    `/api/admin/access-requests/${segment(request.datasetId)}/${segment(request.userId)}/decision`,
    "POST",
    body,
  );
}

/** `POST /api/admin/access-requests/{dataset}/{sub}/take-back`: end an approval now. */
export function takeBackAccess(request: AccessRequest): Promise<AccessRequest> {
  return signedIn(
    `/api/admin/access-requests/${segment(request.datasetId)}/${segment(request.userId)}/take-back`,
    "POST",
  );
}

export type DatasetAccess = Schemas["DatasetAccess"];

/** `GET /api/datasets/{id}/access`: the signed-in reader's own standing for one dataset. */
export function myAccess(id: string): Promise<DatasetAccess> {
  return signedIn(`/api/datasets/${segment(id)}/access`);
}

/** `POST /api/datasets/{id}/access-requests`: ask the admins for a restricted dataset. */
export function requestAccess(id: string, reason: string): Promise<DatasetAccess> {
  const body: Schemas["AccessRequestBody"] = { reason };
  return signedIn(`/api/datasets/${segment(id)}/access-requests`, "POST", body);
}

export type CurationAnswer = Schemas["CurationAnswer"];

/** `POST /api/admin/datasets/{id}/withdraw`: withdraw every version, with the reason shown. */
export function withdrawDataset(id: string, reason: string): Promise<CurationAnswer> {
  const body: Schemas["WithdrawRequest"] = { reason };
  return signedIn(`/api/admin/datasets/${segment(id)}/withdraw`, "POST", body);
}

/** `POST /api/admin/datasets/{id}/restore`: undo a withdrawal. */
export function restoreDataset(id: string): Promise<CurationAnswer> {
  return signedIn(`/api/admin/datasets/${segment(id)}/restore`, "POST");
}

export type CorrectionRequest = Schemas["CorrectionRequest"];

/** `PUT /api/datasets/{id}/versions/{version}/metadata`: the changed fields and the note. */
export function correctMetadata(
  id: string,
  version: number,
  body: CorrectionRequest,
): Promise<Schemas["CorrectionAnswer"]> {
  return signedIn(`/api/datasets/${segment(id)}/versions/${version}/metadata`, "PUT", body);
}

export type DownloadsAnswer = Schemas["DownloadsAnswer"];
export type DownloadsMonths = "3" | "12" | "all";

/** `GET /api/admin/downloads`: downloads per dataset per month, for admins. */
export function getDownloads(months: DownloadsMonths): Promise<DownloadsAnswer> {
  return signedIn(`/api/admin/downloads?months=${months}`);
}
