# @research-in-a-box/web

The web app is the archive's site: a React app built with Vite and served by CloudFront. A reader searches the catalog, opens a dataset's page and downloads its files; a contributor submits a package; a curator works through the review queue; an admin manages people, access requests and downloads under Settings.

Its types come from the contract's JSON Schema and the read API's OpenAPI spec, both committed under `src/schema/`, so `just web-types` writes `src/generated/` again when either changes.

Who uses it: everyone who visits the archive. A developer runs it locally against a deployed stage, which sends `/api/`, `/auth-config.json` and `/data/` to that stage:

```
ARCHIVE_DEV_SITE=https://<stage domain> npm run dev -w packages/web
```
