import { existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { ArchiveConfig } from "./generated/archive-config";

/** The app's default primary colour (`--brand` in the web app's styles.css). */
export const DEFAULT_PRIMARY = "#24395f";
/** What the invitation and code emails and the static pages take from the config's `brand:` block. */
export interface LoginBrand {
  readonly name: string;
  readonly primaryColor: string;
}

/** Stop the synth when a brand file is missing or of a kind the app doesn't serve. */
function checkBrandFile(kind: "logo" | "favicon", path: string, configDir: string): void {
  const file = resolve(configDir, path);
  if (!existsSync(file)) throw new Error(`brand: no ${kind} file at ${file}`);
  const extension = extname(file).slice(1).toUpperCase();
  const allowed = kind === "logo" ? ["SVG", "PNG"] : ["SVG", "ICO"];
  if (!allowed.includes(extension)) {
    throw new Error(`brand: the ${kind} must be ${allowed.join(" or ").toLowerCase()}: ${file}`);
  }
}

/** The config's brand, once its files, at paths relative to `configDir`, are there. */
export function loginBrand(config: ArchiveConfig, configDir: string): LoginBrand {
  const brand = config.brand ?? {};
  if (brand.logo) checkBrandFile("logo", brand.logo, configDir);
  if (brand.favicon) checkBrandFile("favicon", brand.favicon, configDir);
  return {
    name: brand.name ?? config.publisher,
    primaryColor: (brand.primaryColor ?? DEFAULT_PRIMARY).toLowerCase(),
  };
}
