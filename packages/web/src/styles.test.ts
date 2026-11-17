import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { contrast } from "./brand";

const CSS = readFileSync(join(import.meta.dirname, "styles.css"), "utf-8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

type Rule = { selectors: string[]; body: string };

/** The plain rules of a stretch of CSS, outside any @media block. */
function rulesOf(css: string): Rule[] {
  const rules: Rule[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    if (css[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (css[i] === "}") {
      depth--;
      if (depth === 0) {
        const head = css.slice(css.lastIndexOf("}", start) + 1, start).trim();
        if (!head.startsWith("@")) {
          const selectors = head.split(",").map((s) => s.trim());
          rules.push({ selectors, body: css.slice(start + 1, i) });
        }
      }
    }
  }
  return rules;
}

/** The rules inside every `@media (max-width: 40rem)` block: phone width. */
function phoneRules(): Rule[] {
  const rules: Rule[] = [];
  for (const match of CSS.matchAll(/@media \(max-width: 40rem\) \{/g)) {
    let depth = 1;
    let i = match.index + match[0].length;
    const from = i;
    for (; depth > 0; i++) {
      if (CSS[i] === "{") depth++;
      if (CSS[i] === "}") depth--;
    }
    rules.push(...rulesOf(CSS.slice(from, i - 1)));
  }
  return rules;
}

const bodiesFor = (rules: Rule[], selector: string) =>
  rules.filter((r) => r.selectors.includes(selector)).map((r) => r.body);

test("the ORCID iD mark's text meets AA contrast on its green", () => {
  const rule = bodiesFor(rulesOf(CSS), ".orcid i").join("");
  const background = /background: (#[0-9a-f]{6});/i.exec(rule)?.[1] ?? "";
  const ink = /\bcolor: (#[0-9a-f]{6});/i.exec(rule)?.[1] ?? "";

  expect(background).toBe("#a6ce39");
  expect(ink).toMatch(/^#[0-9a-f]{6}$/i);
  expect(contrast(ink, background)).toBeGreaterThanOrEqual(4.5);
});

test("a dialog form's paragraphs have no margins of their own: the grid's gap spaces them", () => {
  // A grid's items' margins don't collapse, so a paragraph's 1em margins would add to the gap.
  expect(bodiesFor(rulesOf(CSS), ".password-form > p").join("")).toMatch(/\bmargin: 0;/);
});

test("at phone width a link in About's facts is a 44 px tap target", () => {
  const body = bodiesFor(phoneRules(), ".facts dd a").join("");

  expect(body).toMatch(/\bmin-height: var\(--tap\);/);
  expect(body).toMatch(/\bdisplay: inline-flex;/);
  expect(bodiesFor(rulesOf(CSS), ".facts dd a").join("")).not.toMatch(/min-height/);
});
