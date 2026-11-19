// Generated from the archive contract's JSON Schema by
// packages/infra/scripts/generate-config-type.ts (`just schema`). Do not edit.

export type Access = ("public" | "limited" | "restricted" | "description-only")[];
export type Contact = string | null;
export type Favicon = string | null;
export type Font = string | null;
export type Intro = string | null;
export type Logo = string | null;
export type Name = string | null;
export type Primarycolor = string | null;
/**
 * The privacy page's text, in place of the kit's default: plain text, paragraphs separated by blank lines. No HTML or Markdown is read.
 */
export type Privacy = string | null;
/**
 * The repository's DOI prefix from DataCite Fabrica, such as 10.5072.
 */
export type Prefix = string;
/**
 * The DataCite repository id (Account ID), such as EXAMPLE.IRC.
 */
export type Repository = string;
/**
 * Use DataCite's test system. Keep it true here, and go live on the production stage alone with that stage's own doi block (test: false and the live repository and prefix), so no other stage registers DOIs that can never be deleted.
 */
export type Test = boolean;
export type Alertemail = string;
export type Model = "amazon.titan-embed-text-v2:0";
export type Retentiondays = number;
export type Waf = boolean;
export type Monthlybudgetusd = number;
/**
 * @minItems 1
 */
export type Stages = [Stage, ...Stage[]];
export type Account = string | null;
/**
 * This stage's DOI prefix, over the archive-wide one: the live repository's for a stage with test: false.
 */
export type Prefix1 = string | null;
/**
 * This stage's DataCite repository id, over the archive-wide one: the live account's for a stage with test: false.
 */
export type Repository1 = string | null;
/**
 * This stage's doi.test, over the archive-wide one: false registers live DOIs from this stage only, such as prod, while the other stages stay on the test system.
 */
export type Test1 = boolean;
/**
 * The id of the Route 53 public hosted zone that holds the name, in the stage's account: the bare Z... id, not /hostedzone/Z....
 */
export type Hostedzoneid = string;
/**
 * The site's own address, such as data.example.org, in the hosted zone below.
 */
export type Name1 = string;
/**
 * ses: send the account emails (sign-up codes, invitations, password resets) through Amazon SES from no-reply@<domain>, with DKIM records in the domain's hosted zone. Needs a domain. Left out: Cognito's own email, which is capped per day.
 */
export type Email = "ses" | null;
export type Name2 = string;
export type Region = string | null;
export type Licenses = string[];
export type Profiles = string[];
export type Publisher = string;
export type Required = string[];
/**
 * The largest package the archive takes: the total size of its files, in GiB. The checking function's disk is sized from it at deploy.
 */
export type Maxpackagegib = number;
export type Themes = string[];
export type Field = string;
export type Name3 = string;
export type Terms = string[];
export type Url = string | null;
export type Vocabularies = Vocabulary[];

/**
 * Which profiles apply, extra required fields, vocabularies, themes, the licenses and
 * access levels offered, and the publisher the archive fills in at publish.
 */
export interface ArchiveConfig {
  access?: Access;
  brand?: Brand | null;
  doi?: Doi | null;
  infrastructure?: Infrastructure | null;
  licenses?: Licenses;
  profiles?: Profiles;
  publisher: Publisher;
  required?: Required;
  submissions?: Submissions;
  themes?: Themes;
  vocabularies?: Vocabularies;
  [k: string]: unknown;
}
/**
 * How the archive presents itself: the app, the sign-in page and the invitation email.
 *
 * `logo` and `favicon` are paths relative to the config file; they are checked only when
 * the config is loaded from its file, since a deployed copy travels without them.
 */
export interface Brand {
  contact?: Contact;
  favicon?: Favicon;
  font?: Font;
  intro?: Intro;
  logo?: Logo;
  name?: Name;
  primaryColor?: Primarycolor;
  privacy?: Privacy;
}
/**
 * The optional DOI module: a findable DataCite DOI for each published version. The
 * repository's password is an SSM SecureString, never in this file.
 */
export interface Doi {
  prefix: Prefix;
  repository: Repository;
  test?: Test;
}
/**
 * Where and how the archive is deployed.
 */
export interface Infrastructure {
  alertEmail: Alertemail;
  modules?: Modules;
  monthlyBudgetUsd?: Monthlybudgetusd;
  stages?: Stages;
}
/**
 * The optional parts, each built only when switched on.
 */
export interface Modules {
  embeddings?: Embeddings | null;
  objectLock?: ObjectLock | null;
  waf?: Waf;
}
/**
 * Semantic search: an embedding on each dataset item and a vector index to search them.
 */
export interface Embeddings {
  model?: Model;
}
/**
 * Write-once locking of the archive bucket, in governance mode.
 */
export interface ObjectLock {
  retentionDays: Retentiondays;
}
/**
 * One deployment of the archive, its own stack, optionally in its own account and region.
 */
export interface Stage {
  account?: Account;
  doi?: StageDoi | null;
  domain?: Domain | null;
  email?: Email;
  name: Name2;
  region?: Region;
}
/**
 * A stage's own DOI settings, each over the archive-wide `doi` block, which it needs. Test
 * and live DataCite are separate accounts, so a stage going live names its live repository and
 * prefix with `test: false`; its password is already its own, at
 * /research-archive/<stage>/datacite-password.
 */
export interface StageDoi {
  prefix?: Prefix1;
  repository?: Repository1;
  test: Test1;
}
/**
 * A stage's own address, in a Route 53 public hosted zone: a certificate for it in
 * us-east-1, the name on the distribution and its alias records. Email through SES (`email`)
 * is on `Stage`, not in here, and needs this block.
 */
export interface Domain {
  hostedZoneId: Hostedzoneid;
  name: Name1;
}
/**
 * What the archive takes as a submission.
 */
export interface Submissions {
  maxPackageGiB?: Maxpackagegib;
}
/**
 * A vocabulary for a manifest field, named by URL or given as terms.
 */
export interface Vocabulary {
  field: Field;
  name: Name3;
  terms?: Terms;
  url?: Url;
  [k: string]: unknown;
}
