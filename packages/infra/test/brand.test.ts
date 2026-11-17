import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { DEFAULT_PRIMARY, loginBrand } from "../src/brand";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const STYLES = fileURLToPath(new URL("../../web/src/styles.css", import.meta.url));

test("the brand block's name and colour reach the invitation and code emails' brand", () => {
  const brand = loginBrand(
    {
      publisher: "Invented Research Cooperative",
      brand: {
        name: "Lake Archive",
        primaryColor: "#0B5CAD",
        logo: "examples/brand/logo.svg",
        favicon: "examples/brand/favicon.svg",
      },
    },
    REPO,
  );

  expect(brand.name).toBe("Lake Archive");
  expect(brand).toEqual({ name: "Lake Archive", primaryColor: "#0b5cad" });
});

test("no brand block gives the publisher's name and the app's default colour", () => {
  const brand = loginBrand({ publisher: "P" }, REPO);

  expect(brand).toEqual({ name: "P", primaryColor: DEFAULT_PRIMARY });
  expect(readFileSync(STYLES, "utf-8")).toContain(`--brand: ${DEFAULT_PRIMARY};`);
});

test("synth stops with a plain message when a brand file is missing or of the wrong kind", () => {
  const dir = mkdtempSync(join(tmpdir(), "brand-"));
  writeFileSync(join(dir, "logo.gif"), "GIF89a");

  expect(() => loginBrand({ publisher: "P", brand: { logo: "missing.svg" } }, dir)).toThrow(
    /no logo file/,
  );
  expect(() => loginBrand({ publisher: "P", brand: { logo: "logo.gif" } }, dir)).toThrow(
    /logo must be svg or png/,
  );
});
