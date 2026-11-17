# archive-backend

The backend is the Python code of the archive's AWS Lambda functions, the small programs AWS runs on each request or event. For example, when a contributor submits a package, the ingest function scans its files, runs the `cruise` rules on it, holds it for a curator's review and publishes it once approved.

It also serves the read API (search, a dataset's page and its downloads), the submissions, people and access-request APIs, the reindex that rebuilds the catalog and search index, DOI registration, the daily run that releases the files of ended embargoes, and the weekly check of every stored file against its checksum.

Who uses it: nobody runs it directly. The CDK construct in `packages/infra` packages it into the functions it deploys, and CI deploys them.

Its one command writes the read API's OpenAPI spec again from its routes, which the web app's types come from; `just check` fails when the committed copy differs:

```
just openapi
```
