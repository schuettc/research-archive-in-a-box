/* global document, fetch */
// The browser scenes, the screenshots and the caption strips of the demo video, with Playwright.
// `just demo-video` runs this after demo/setup.py (which wrote out/run.json) and the terminal
// scene (which gave the plot survey its title). It writes one .webm per scene to out/scenes/,
// the parts of each to keep to out/timeline.json, the screenshots to out/screenshots/ and one
// transparent caption strip per scene to out/captions/. demo/assemble.mjs joins them.
//
// Every page is the stage's own; nothing is drawn over one but the pointer, a dot that follows
// the mouse because a recording shows no cursor. A wait too long for its scene is left out of
// the parts kept, never replaced.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const SIZE = { width: 1280, height: 800 };
const REPOSITORY = "github.com/schuettc/research-archive-in-a-box";
const LONG_WAIT = 15 * 60_000;

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "out");
const run = JSON.parse(await readFile(path.join(out, "run.json"), "utf8"));
const captions = JSON.parse(await readFile(path.join(here, "captions.json"), "utf8"));
const timeline = {};

const say = (text) => process.stdout.write(`${text}\n`);
const pause = (page, ms) => page.waitForTimeout(ms);

/** Runs in each recorded page: a dot that follows the mouse, kept above an open dialog. */
function showPointer() {
  const dot = document.createElement("div");
  dot.popover = "manual";
  dot.style.cssText =
    "position:fixed;inset:auto;left:-60px;top:-60px;width:22px;height:22px;margin:-11px 0 0 -11px;" +
    "padding:0;border:2px solid rgba(36,57,95,.9);border-radius:50%;background:rgba(36,57,95,.3);" +
    "pointer-events:none;overflow:hidden;transition:transform .12s";
  let above = null;
  const raise = () => {
    if (!dot.isConnected) document.documentElement.append(dot);
    const dialog = document.querySelector("dialog[open]");
    if (dot.matches(":popover-open") && dialog === above) return;
    // Shown again, the dot goes to the top of the top layer, over a dialog opened since.
    if (dot.matches(":popover-open")) dot.hidePopover();
    dot.showPopover();
    above = dialog;
  };
  document.addEventListener(
    "mousemove",
    (event) => {
      raise();
      dot.style.left = `${event.clientX}px`;
      dot.style.top = `${event.clientY}px`;
    },
    true,
  );
  document.addEventListener("mousedown", () => (dot.style.transform = "scale(.65)"), true);
  document.addEventListener("mouseup", () => (dot.style.transform = ""), true);
}

const at = new WeakMap();

/** Move the mouse to the middle of an element in small steps, so the pointer is seen to travel. */
async function point(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error(`nothing on screen to point at: ${locator}`);
  const from = at.get(page) ?? { x: SIZE.width / 2, y: SIZE.height / 2 };
  const to = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  for (let step = 1; step <= 24; step++) {
    const eased = 1 - (1 - step / 24) ** 2;
    await page.mouse.move(from.x + (to.x - from.x) * eased, from.y + (to.y - from.y) * eased);
    await pause(page, 16);
  }
  at.set(page, to);
  await pause(page, 250);
}

async function press(page, locator) {
  await point(page, locator);
  await locator.click();
}

/** Scroll an element to the middle of the window, smoothly. */
async function glide(page, locator) {
  await locator.evaluate((element) =>
    element.scrollIntoView({ behavior: "smooth", block: "center" }),
  );
  await pause(page, 1000);
}

/**
 * Record one scene in a window of its own. `play` gets the page and `keep`: only what runs
 * inside `await keep(async () => { ... })` is in the video, so signing in and long waits are
 * done outside it.
 */
async function scene(browser, name, options, play) {
  const raw = path.join(out, "raw", name);
  await rm(raw, { recursive: true, force: true });
  const context = await browser.newContext({
    viewport: SIZE,
    recordVideo: { dir: raw, size: SIZE },
    ...options,
  });
  await context.addInitScript(showPointer);
  const page = await context.newPage();
  const started = Date.now();
  const keeps = [];
  const keep = async (act) => {
    const from = (Date.now() - started) / 1000;
    await act();
    keeps.push({ from, to: (Date.now() - started) / 1000 });
  };
  let result;
  try {
    result = await play(page, keep);
  } finally {
    await context.close();
  }
  const file = path.join(out, "scenes", `${name}.webm`);
  await rename(await page.video().path(), file);
  timeline[name] = { file, keeps };
  say(`recorded ${name}`);
  return result;
}

/** Take one screenshot in a window of its own, at twice the size, with no pointer. */
async function still(browser, name, options, arrange) {
  const context = await browser.newContext({ viewport: SIZE, deviceScaleFactor: 2, ...options });
  const page = await context.newPage();
  try {
    const fullPage = (await arrange(page)) === "full";
    await page.screenshot({ path: path.join(out, "screenshots", `${name}.png`), fullPage });
  } finally {
    await context.close();
  }
  say(`saved ${name}.png`);
}

/** Sign in with the password on the archive's own sign-in page, and land on `next`. */
async function signIn(page, account, next) {
  await page.goto(`${run.site}/sign-in?next=${encodeURIComponent(next)}`);
  const form = page.locator("form.sign-in-form");
  await form.getByLabel("Email").fill(account.email);
  await form.getByRole("button", { name: "Continue" }).click();
  await form.getByLabel("Password").fill(account.password);
  await form.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => url.pathname === next);
}

const resultsHead = (page) => page.locator(".results-head");

/** Browse, signed out, with the six sample datasets listed. */
async function openBrowse(page) {
  await page.goto(run.site);
  await resultsHead(page).filter({ hasText: "6 datasets" }).waitFor();
}

/** Submit, signed in as the contributor, with the plot survey chosen and its checks shown. */
async function chooseFolder(page) {
  // The folder goes to the page's own "Choose folder" input: a script can't drop a real
  // folder from the desktop, and the page treats a chosen folder and a dropped one alike.
  await page.locator(".dropzone input[type=file]").setInputFiles(run.plot);
  const checks = page.locator(".pre-checks");
  await checks.getByRole("heading", { name: "Checks before upload" }).waitFor();
  await checks.locator("p.muted[role=status]").waitFor({ state: "detached" });
}

const queueRow = (page, title) =>
  page.locator("table.queue").getByRole("link", { name: title, exact: true });

async function openQueue(page) {
  await signIn(page, run.accounts.curator, "/review");
  await queueRow(page, run.plotTitle).waitFor();
  await queueRow(page, run.snowTitle).waitFor();
}

const datasetPath = () => `/datasets/${encodeURIComponent(run.plotId)}`;

async function openDataset(page) {
  await page.goto(run.site + datasetPath());
  await page.getByRole("heading", { name: "Cite this dataset" }).waitFor();
}

/** Wait, in the page, until the stage answers for the dataset: it is published. */
async function published(page) {
  const url = `/api/datasets/${encodeURIComponent(run.plotId)}`;
  const deadline = Date.now() + LONG_WAIT;
  while (!(await page.evaluate(async (address) => (await fetch(address)).ok, url))) {
    if (Date.now() > deadline) throw new Error(`${run.plotId} is not published after 15 minutes`);
    await pause(page, 5000);
  }
}

const strip = (caption) => `<!doctype html>
<style>
  html, body { margin: 0; background: transparent; }
  p {
    position: fixed; left: 0; right: 0; bottom: 0; height: 64px; margin: 0;
    display: flex; align-items: center; justify-content: center;
    background: rgba(17, 24, 39, 0.9); color: #fff; white-space: nowrap;
    font: 500 23px/1 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
  }
</style>
<p>${caption.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>`;

/** Each scene's caption as a transparent picture the size of the video, one line at the bottom. */
async function captionStrips(browser) {
  const context = await browser.newContext({ viewport: SIZE });
  const page = await context.newPage();
  for (const { scene: name, caption } of captions) {
    await page.setContent(strip(caption));
    const text = page.locator("p");
    if (await text.evaluate((element) => element.scrollWidth > element.clientWidth))
      throw new Error(`the caption of ${name} doesn't fit on one line`);
    await page.screenshot({
      path: path.join(out, "captions", `${name}.png`),
      omitBackground: true,
    });
  }
  await context.close();
}

const escapeHtml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** The last scene's page: the demo stage's config as a file in an editor, then the repository. */
async function configPage() {
  const file = path.join(here, "..", "examples", "demo-stage", "archive.yaml");
  // The header comment is left out so the settings fill the window.
  const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
  const settings = lines.slice(lines.findIndex((line) => !line.startsWith("#")));
  const rows = settings
    .map((line) => {
      const key = /^(\s*(?:- )?)([\w:]+?):(.*)$/.exec(line);
      const text = key
        ? `${key[1]}<b>${escapeHtml(key[2])}</b>:${escapeHtml(key[3])}`
        : escapeHtml(line);
      return `<li><code>${text || " "}</code></li>`;
    })
    .join("");
  return `<!doctype html>
<style>
  html, body { margin: 0; height: 100%; background: #1f2430; color: #d9d7ce; }
  header { height: 44px; background: #171b24; display: flex; align-items: flex-end; }
  header span {
    padding: 10px 22px; background: #1f2430; border-top: 2px solid #ffcc66;
    font: 15px -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
  }
  ol { margin: 0; padding: 22px 0 0 74px; color: #707a8c; font: 19px/1.55 ui-monospace, Menlo, monospace; }
  code { font: inherit; color: #d9d7ce; white-space: pre; }
  b { font-weight: 500; color: #73d0ff; }
  section {
    position: fixed; inset: 0; background: #fff; color: #111827; opacity: 0;
    transition: opacity 0.5s; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 22px; padding-bottom: 64px;
    font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
  }
  section.on { opacity: 1; }
  h1 { margin: 0; font-size: 46px; color: #24395f; }
  section p { margin: 0; font: 30px ui-monospace, Menlo, monospace; }
</style>
<header><span>archive.yaml</span></header>
<ol>${rows}</ol>
<section><h1>Research archive in a box</h1><p>${REPOSITORY}</p></section>`;
}

const browser = await chromium.launch();
try {
  for (const folder of ["scenes", "screenshots", "captions"])
    await mkdir(path.join(out, folder), { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(run.plot, "datapackage.json"), "utf8"));
  if (manifest.title !== run.plotTitle)
    throw new Error("the plot survey has no title yet: record the terminal scene first");

  await captionStrips(browser);

  // Scene 1. Browse: six datasets, and a search for "stream" narrows them to two. (Scene 2 is
  // the terminal's, recorded by VHS before this script runs.)
  await still(browser, "demo-browse", {}, openBrowse);
  await scene(browser, "browse", {}, async (page, keep) => {
    await openBrowse(page);
    await keep(async () => {
      await pause(page, 1500);
      const box = page.locator("#search-q");
      await press(page, box);
      await box.pressSequentially("stream", { delay: 130 });
      await pause(page, 300);
      await box.press("Enter");
      await resultsHead(page).filter({ hasText: "2 datasets" }).waitFor();
      await pause(page, 3000);
    });
  });

  // Scene 3. Submit, as the contributor: the folder, Checks before upload, Upload and submit, and
  //    the submission's page saying Being checked. Then, off camera, the wait for a curator.
  await still(browser, "demo-submit-checks", {}, async (page) => {
    await signIn(page, run.accounts.contributor, "/submit");
    await chooseFolder(page);
    return "full";
  });
  await scene(browser, "submit", {}, async (page, keep) => {
    await signIn(page, run.accounts.contributor, "/submit");
    await page.getByRole("heading", { name: "Submit a package" }).waitFor();
    const badge = page.locator(".status-row .badge");
    await keep(async () => {
      await pause(page, 1500);
      await point(page, page.locator(".dropzone .choose"));
      await chooseFolder(page);
      await pause(page, 5000);
      await press(page, page.getByRole("button", { name: "Upload and submit" }));
      await page.waitForURL((url) => url.pathname.startsWith("/submissions/"));
      await badge.filter({ hasText: "Being checked" }).waitFor();
      await pause(page, 4500);
    });
    // The page reads the submission again every ten seconds while it moves.
    await badge.filter({ hasNotText: "Being checked" }).waitFor({ timeout: LONG_WAIT });
    const status = (await badge.textContent())?.trim();
    if (status !== "Waiting for a curator")
      throw new Error(`the submission stopped at "${status}", not waiting for a curator`);
  });

  // Scene 4. Review, as the curator: the queue, the submission, a file previewed, Approve. Then, off
  //    camera, the wait for the dataset to be published.
  await still(browser, "demo-review-queue", {}, openQueue);
  await scene(browser, "review", {}, async (page, keep) => {
    await openQueue(page);
    await keep(async () => {
      await pause(page, 2000);
      await press(page, queueRow(page, run.plotTitle));
      const preview = page.getByRole("button", { name: "Preview data/plots.csv" });
      await preview.waitFor();
      await pause(page, 1200);
      await glide(page, preview);
      await press(page, preview);
      const dialog = page.locator("dialog[open]");
      await dialog.locator("table").waitFor();
      await pause(page, 2500);
      await press(page, dialog.getByRole("button", { name: "Close" }));
      const approve = page.getByRole("button", { name: "Approve", exact: true });
      await glide(page, approve);
      await page.locator("button.primary:enabled", { hasText: "Approve" }).waitFor();
      await press(page, approve);
      await dialog.getByRole("heading", { name: "Approve this submission?" }).waitFor();
      await pause(page, 900);
      await press(page, dialog.getByRole("button", { name: "Approve", exact: true }));
      await page.getByText("You approved it").waitFor();
      await pause(page, 2200);
    });
    await published(page);
  });

  // Scene 5. The published page, signed out: the columns with their units, Cite this dataset, Copy,
  //    then Download all.
  await still(browser, "demo-dataset-page", {}, async (page) => {
    await openDataset(page);
    return "full";
  });
  // Copy writes to the clipboard, which a page may do only with leave.
  const clipboard = { permissions: ["clipboard-read", "clipboard-write"], acceptDownloads: true };
  await scene(browser, "dataset", clipboard, async (page, keep) => {
    await openDataset(page);
    await keep(async () => {
      await pause(page, 2000);
      await glide(page, page.getByRole("heading", { name: "Columns" }));
      await pause(page, 3200);
      const cite = page.locator("section", { has: page.locator("#cite-heading") });
      await glide(page, cite);
      await pause(page, 1200);
      await press(page, cite.getByRole("button", { name: "Copy" }));
      await cite.locator(".copied", { hasText: "Copied" }).waitFor();
      await pause(page, 1800);
      const all = page.locator("[data-testid=summary-strip] .download");
      await glide(page, all);
      const download = page.waitForEvent("download", { timeout: 20_000 }).catch(() => null);
      await press(page, all);
      if (!(await download)) say("warning: Download all started no download within 20 seconds");
      // The page then asks how the data will be used; the reader here says no thanks.
      const noThanks = page.locator("dialog[open]").getByRole("button", { name: "No thanks" });
      if (
        await noThanks.waitFor({ timeout: 3000 }).then(
          () => true,
          () => false,
        )
      ) {
        await pause(page, 1500);
        await press(page, noThanks);
      }
      await pause(page, 1500);
    });
  });

  // Scene 6. The config file, then the repository's address.
  await scene(browser, "config", {}, async (page, keep) => {
    await page.setContent(await configPage());
    await keep(async () => {
      await pause(page, 4300);
      await page.locator("section").evaluate((element) => element.classList.add("on"));
      await pause(page, 3700);
    });
  });

  await writeFile(path.join(out, "timeline.json"), `${JSON.stringify(timeline, null, 2)}\n`);
  say("wrote out/timeline.json");
} finally {
  await browser.close();
}
