import { expect, test } from "vitest";
import { checkOrcid, isRor } from "./orcid";

test("a valid ORCID iD, bare or as its orcid.org address, checks out as the bare iD", () => {
  expect(checkOrcid("0000-0002-1825-0097")).toEqual({ orcid: "0000-0002-1825-0097" });
  expect(checkOrcid(" https://orcid.org/0000-0002-1825-0097 ")).toEqual({
    orcid: "0000-0002-1825-0097",
  });
  expect(checkOrcid("http://orcid.org/0000-0002-1825-0097")).toEqual({
    orcid: "0000-0002-1825-0097",
  });
});

test("an X check digit is the MOD 11-2's ten", () => {
  expect(checkOrcid("0000-0002-1694-233X")).toEqual({ orcid: "0000-0002-1694-233X" });
});

test("a wrong check digit is a check-digit problem, anything else a shape problem", () => {
  expect(checkOrcid("0000-0002-1825-0098")).toEqual({ problem: "check-digit" });
  expect(checkOrcid("0000-0002-1694-2330")).toEqual({ problem: "check-digit" });
  expect(checkOrcid("0000-0002-1825")).toEqual({ problem: "shape" });
  expect(checkOrcid("0000000218250097")).toEqual({ problem: "shape" });
  expect(checkOrcid("Ada")).toEqual({ problem: "shape" });
});

test("a ROR address is https://ror.org/0, six letters or digits, then two digits", () => {
  expect(isRor("https://ror.org/03yrm5c26")).toBe(true);
  expect(isRor("https://ror.org/05dxps055")).toBe(true);
  expect(isRor("https://ror.org/13yrm5c26")).toBe(false);
  expect(isRor("https://ror.org/03yrm5c2x")).toBe(false);
  expect(isRor("https://ror.org/03YRM5C26")).toBe(false);
  expect(isRor("https://ror.org/03yrm5c26/")).toBe(false);
  expect(isRor("ror.org/03yrm5c26")).toBe(false);
});
