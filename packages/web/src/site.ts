/** The archive's name, intro, contact, logo and privacy text, from `brand:` at build time. */
declare const __BRAND__: {
  name: string;
  intro: string | null;
  contact: string | null;
  logo: string | null;
  privacy: string | null;
};
declare const __PUBLISHER__: string;

export const BRAND = __BRAND__;
export const PUBLISHER = __PUBLISHER__;
