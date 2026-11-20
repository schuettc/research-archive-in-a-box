// The plugin's browser sign-in, driven off camera for the agent scene of the demo video.
// The plugin's sign_in tool opens the archive's own sign-in page with Python's `webbrowser`,
// which runs the program named in BROWSER with the page's address. `just demo-video` points
// BROWSER at a small wrapper demo/setup.py writes, which starts this script and returns. It
// signs in on that page as the contributor with the password from out/run.json and presses
// Sign in the command line; the page then posts the sign-in to the plugin's listener on
// localhost, exactly as it does for a person.
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const run = JSON.parse(await readFile(path.join(here, "out", "run.json"), "utf8"));
const address = new URL(process.argv[2] ?? "");
if (address.origin !== run.site || address.pathname !== "/sign-in")
  throw new Error(`not the demo stage's sign-in page: ${address.origin}${address.pathname}`);
const account = run.accounts.contributor;

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(address.href);
  const form = page.locator("form.sign-in-form");
  await form.getByLabel("Email").fill(account.email);
  await form.getByRole("button", { name: "Continue" }).click();
  await form.getByLabel("Password").fill(account.password);
  await form.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Sign in the command line" }).click();
  await page.getByRole("heading", { name: "The command line is signed in" }).waitFor();
  process.stdout.write(`signed the command line in as ${account.email}\n`);
} finally {
  await browser.close();
}
