/**
 * Reading a package folder the contributor chose or dropped, checking it against its
 * `checksums.sha256`, editing the text the three text checks ask for, and uploading its files
 * to their presigned links.
 */
import type { Finding, SubmittedFile, Upload } from "./api";
import { formatSize } from "./labels";

/** A file of the package, by its path from the package folder's root. */
export interface PackageFile {
  path: string;
  file: File;
}

/** A file to send: what the API is told about it, and the file itself. */
export type ReadyFile = SubmittedFile & { file: File };

export type Checked =
  | {
      ok: true;
      files: ReadyFile[];
      /** Files in the folder that `checksums.sha256` doesn't list, so aren't sent. */
      left: string[];
      manifest: { id: string; title: string | null };
      /** The parsed datapackage.json, and checksums.sha256 as read, for edits before upload. */
      raw: Manifest;
      checksums: string;
    }
  | { ok: false; problem: string };

const MAX_PUT = 5 * 1024 ** 3;

/** A parsed datapackage.json, as plain JSON: only the fields an edit touches are typed. */
export type Manifest = Record<string, unknown>;

/**
 * Dot-files and dot-folders (`.DS_Store`, `.git/`) are the computer's, not the package's. The
 * same rule as the contract's `is_hidden`; `package.test.ts` holds the two to one file of cases.
 */
export const hidden = (path: string) => path.split("/").some((part) => part.startsWith("."));

/**
 * A directory input's files, each by its path from the chosen folder's root: the input names
 * them `<folder>/<path>`, and the folder's own name is dropped.
 */
export function fromFileList(list: FileList | File[]): PackageFile[] {
  return [...list]
    .map((file) => {
      const relative = file.webkitRelativePath || file.name;
      const slash = relative.indexOf("/");
      return { path: slash === -1 ? relative : relative.slice(slash + 1), file };
    })
    .filter(({ path }) => path && !hidden(path));
}

function readAll(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const entries: FileSystemEntry[] = [];
    const next = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) resolve(entries);
        else {
          entries.push(...batch);
          next();
        }
      }, reject);
    next();
  });
}

async function walk(entry: FileSystemEntry, prefix: string): Promise<PackageFile[]> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    );
    return [{ path: prefix + entry.name, file }];
  }
  const children = await readAll((entry as FileSystemDirectoryEntry).createReader());
  const nested = await Promise.all(children.map((child) => walk(child, `${prefix}${entry.name}/`)));
  return nested.flat();
}

/**
 * Dropped entries: one dropped folder is the package, with paths from inside it; dropped files
 * (or several folders) keep their own names as paths.
 */
export async function fromEntries(entries: FileSystemEntry[]): Promise<PackageFile[]> {
  let files: PackageFile[];
  const only = entries[0];
  if (entries.length === 1 && only?.isDirectory) {
    const children = await readAll((only as FileSystemDirectoryEntry).createReader());
    files = (await Promise.all(children.map((child) => walk(child, "")))).flat();
  } else {
    files = (await Promise.all(entries.map((entry) => walk(entry, "")))).flat();
  }
  return files.filter(({ path }) => !hidden(path));
}

/** A drop's items as entries, read before the drop event ends (the list empties after). */
export function droppedEntries(items: DataTransferItemList): FileSystemEntry[] {
  return [...items]
    .map((item) => item.webkitGetAsEntry())
    .filter((entry): entry is FileSystemEntry => entry !== null);
}

/** `checksums.sha256` as `sha256sum` writes it: each line a hex digest, spaces, a path. */
function parseChecksums(text: string): Map<string, string> | null {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line);
    if (!match) return null;
    sums.set(match[2]!.replace(/^\.\//, ""), match[1]!.toLowerCase());
  }
  return sums;
}

/** A file's SHA-256 in hex, with the browser's own hasher. */
export async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Check a package before anything is sent: it holds `datapackage.json` and `checksums.sha256`,
 * every file the checksums list is there and matches, and the manifest names its dataset.
 * The files sent are the listed ones and `checksums.sha256` itself. `onHashed` hears how many
 * files have been hashed, of how many. With `maxBytes`, the archive's limit, a package whose
 * files total more is refused before any is hashed.
 */
export async function checkPackage(
  files: PackageFile[],
  onHashed: (done: number, total: number) => void = () => {},
  maxBytes: number | null = null,
): Promise<Checked> {
  const byPath = new Map(files.map((entry) => [entry.path, entry.file]));
  const manifestFile = byPath.get("datapackage.json");
  const checksumsFile = byPath.get("checksums.sha256");
  if (!manifestFile) {
    return { ok: false, problem: "The folder has no datapackage.json at its top level." };
  }
  if (!checksumsFile) {
    return { ok: false, problem: "The folder has no checksums.sha256 at its top level." };
  }
  const sums = parseChecksums(await checksumsFile.text());
  if (!sums) {
    return { ok: false, problem: "checksums.sha256 isn't in the form sha256sum writes." };
  }
  let manifest: Manifest;
  try {
    manifest = JSON.parse(await manifestFile.text()) as Manifest;
  } catch {
    return { ok: false, problem: "datapackage.json isn't valid JSON." };
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    return { ok: false, problem: "datapackage.json isn't a JSON object." };
  }
  if (typeof manifest.id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(manifest.id)) {
    return { ok: false, problem: "datapackage.json has no id the archive can use." };
  }
  for (const path of sums.keys()) {
    if (hidden(path)) {
      return {
        ok: false,
        problem: `checksums.sha256 lists ${path}, a hidden file, which a package never holds. Remove its line (any cruise set rewrites the file without it), then choose the folder again.`,
      };
    }
    if (!byPath.has(path)) {
      return {
        ok: false,
        problem: `${path} is listed in checksums.sha256 but isn't in the folder.`,
      };
    }
  }
  const ready: ReadyFile[] = [];
  const listed = [...sums.keys(), "checksums.sha256"];
  const total = listed.reduce((sum, path) => sum + byPath.get(path)!.size, 0);
  if (maxBytes !== null && total > maxBytes) {
    return {
      ok: false,
      problem: `This package's files total ${formatSize(total)}, more than the ${maxBytes / 1024 ** 3} GiB this archive takes.`,
    };
  }
  let done = 0;
  onHashed(done, listed.length);
  for (const path of listed) {
    const file = byPath.get(path)!;
    if (file.size > MAX_PUT) {
      return { ok: false, problem: `${path} is over 5 GB, more than the archive takes.` };
    }
    // One file at a time, so only one is held in memory.
    const sha256 = await sha256Hex(file);
    const expected = sums.get(path);
    if (expected !== undefined && expected !== sha256) {
      return { ok: false, problem: `${path} doesn't match its checksum in checksums.sha256.` };
    }
    ready.push({ path, size: file.size, sha256, file });
    onHashed((done += 1), listed.length);
  }
  const left = files
    .map((entry) => entry.path)
    .filter((path) => !listed.includes(path))
    .toSorted();
  const title = typeof manifest.title === "string" ? manifest.title : null;
  return {
    ok: true,
    files: ready,
    left,
    manifest: { id: manifest.id, title },
    raw: manifest,
    checksums: await checksumsFile.text(),
  };
}

/** The checks fixed by typing text, and which box each needs. */
const EDITABLE: Record<string, "description" | "unit"> = {
  "field.description-missing": "description",
  "field.description-repeats-name": "description",
  "field.unit-missing": "unit",
};

/** The box a finding can be fixed with here, or null when it needs cruise. */
export function editableKind(finding: Finding): "description" | "unit" | null {
  const kind = EDITABLE[finding.ruleId];
  return kind && finding.target?.resource && finding.target.field ? kind : null;
}

/** One field's new description or unit, as the edits route takes it too. */
export interface FieldEdit {
  resource: string;
  field: string;
  description?: string;
  unit?: string;
}

type Column = Record<string, unknown> & { name?: unknown };
type Resource = Record<string, unknown> & {
  name?: unknown;
  schema?: { fields?: Column[] };
  "archive:attributes"?: { fields?: Column[] };
};

function column(raw: Manifest, resource: string, field: string): Column | undefined {
  const resources = (Array.isArray(raw.resources) ? raw.resources : []) as Resource[];
  const found = resources.find((r) => r.name === resource);
  for (const schema of [found?.schema, found?.["archive:attributes"]]) {
    const hit = schema?.fields?.find((f) => f.name === field);
    if (hit) return hit;
  }
  return undefined;
}

/** A field's description or unit as the manifest holds it now. */
export function fieldValue(
  raw: Manifest,
  resource: string,
  field: string,
  kind: "description" | "unit",
): string {
  const value = column(raw, resource, field)?.[kind === "unit" ? "archive:unit" : "description"];
  return typeof value === "string" ? value : "";
}

/**
 * The manifest with one field's description or unit set, as a copy; null when the manifest
 * has no such field, so nothing was edited.
 */
export function applyEdit(raw: Manifest, edit: FieldEdit): Manifest | null {
  const copy = structuredClone(raw);
  const target = column(copy, edit.resource, edit.field);
  if (!target) return null;
  if (edit.description !== undefined) target.description = edit.description;
  if (edit.unit !== undefined) target["archive:unit"] = edit.unit;
  return copy;
}

/**
 * The files to send with an edited manifest: datapackage.json written from `raw`, and
 * checksums.sha256 with only its datapackage.json line rewritten to the new bytes' SHA-256.
 */
export async function withEdits(
  files: ReadyFile[],
  raw: Manifest,
  checksums: string,
): Promise<ReadyFile[]> {
  const manifest = new File([JSON.stringify(raw, null, 2) + "\n"], "datapackage.json", {
    type: "application/json",
  });
  const digest = await sha256Hex(manifest);
  const lines = checksums
    .split("\n")
    .map((line) => {
      const match = /^[0-9a-fA-F]{64}( [ *](?:\.\/)?datapackage\.json\r?)$/.exec(line);
      return match ? digest + match[1] : line;
    })
    .join("\n");
  const sums = new File([lines], "checksums.sha256", { type: "text/plain" });
  const replaced: Record<string, File> = { "datapackage.json": manifest, "checksums.sha256": sums };
  return Promise.all(
    files.map(async (entry) => {
      const file = replaced[entry.path];
      if (!file) return entry;
      return { path: entry.path, size: file.size, sha256: await sha256Hex(file), file };
    }),
  );
}

/**
 * PUT a file to its presigned link with the headers the link was signed with (the checksum),
 * through XMLHttpRequest so its progress can be shown. `onProgress` hears the bytes sent.
 */
export function uploadFile(
  upload: Upload,
  file: Blob,
  onProgress: (loaded: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", upload.url);
    for (const [name, value] of Object.entries(upload.headers)) {
      request.setRequestHeader(name, value);
    }
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded);
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        onProgress(file.size);
        resolve();
      } else reject(new Error(`the upload of ${upload.path} was refused (${request.status})`));
    };
    request.onerror = () => reject(new Error(`the upload of ${upload.path} didn't reach storage`));
    request.send(file);
  });
}
