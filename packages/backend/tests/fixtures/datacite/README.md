# DataCite Metadata Schema 4.5, as JSON Schema

`datacite-v4.5.json` is Invenio's community JSON Schema for DataCite Metadata Schema 4.5, not
DataCite's official schema: DataCite publishes only an XML Schema (XSD), and its schema
repository's `source/json/README.md` points to Invenio's maintained JSON Schemas.

- Source: https://github.com/inveniosoftware/datacite/blob/9616f852a820801d73b9a5c3c978eb77949f51d0/datacite/schemas/datacite-v4.5.json
- Commit: `9616f852a820801d73b9a5c3c978eb77949f51d0` (inveniosoftware/datacite `master`, fetched
  2026-11-16), copied unchanged.
- It refers to no other file (the older Invenio schemas' `ietf-bcp-47.json` and `iso-8601.json`
  aren't used by 4.5), so it is the only file vendored.

`test_doi.py` validates `doi.attributes(...)` against it with `jsonschema`, after removing the
REST API's own keys (`REST_ONLY`), which aren't metadata properties.
