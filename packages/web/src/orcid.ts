/** ORCID iD and ROR address checks, as the contract's `Contributor` makes them. */

const ORCID = /^[0-9]{4}-[0-9]{4}-[0-9]{4}-[0-9]{3}[0-9X]$/;
const ROR = /^https:\/\/ror\.org\/0[0-9a-z]{6}[0-9]{2}$/;
const ORCID_PREFIXES = ["https://orcid.org/", "http://orcid.org/"];

/** The ISO 7064 MOD 11-2 check character of an ORCID iD's first fifteen digits. */
export function orcidCheckDigit(digits: string): string {
  let total = 0;
  for (const digit of digits) total = (total + Number(digit)) * 2;
  const result = (12 - (total % 11)) % 11;
  return result === 10 ? "X" : String(result);
}

/**
 * An ORCID iD, bare or as its orcid.org address, as the bare iD; else what is wrong with it:
 * `check-digit` for a whole iD whose last character doesn't check out, `shape` for the rest.
 */
export function checkOrcid(
  value: string,
): { orcid: string } | { problem: "shape" | "check-digit" } {
  let bare = value.trim();
  for (const prefix of ORCID_PREFIXES) {
    if (bare.startsWith(prefix)) bare = bare.slice(prefix.length);
  }
  if (!ORCID.test(bare)) return { problem: "shape" };
  const digits = bare.replaceAll("-", "");
  if (orcidCheckDigit(digits.slice(0, 15)) !== digits[15]) return { problem: "check-digit" };
  return { orcid: bare };
}

/** Whether a value is a ROR address, `https://ror.org/<id>`. */
export const isRor = (value: string) => ROR.test(value);
