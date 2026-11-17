# archive-contract

The contract is the set of rules every part of the kit agrees on about a dataset package and about `archive.yaml`. A package is a folder holding the data files, a `datapackage.json` manifest that describes them (title, licence, each column and its unit), and a `checksums.sha256` file with each file's hash, as in `examples/sample-package`. `archive.yaml` is the one file a deployer edits to configure an archive, such as its publisher's name and its stages.

This package holds both as Pydantic models (Python classes that check a file's fields and types when it is read), the quality rules' shared vocabulary (findings, profiles, required fields), the writer of `checksums.sha256`, and the importers and exporters (EML in; a README, DataCite, EML and schema.org records out).

Who uses it: `cruise`, the backend's Lambda functions and the Claude Code plugin import it, so a package is judged the same way on a laptop and in the archive. Its JSON Schema, `packages/web/src/schema/archive-contract.schema.json`, gives the web app and the CDK construct the same shapes in TypeScript.

Its one command writes that JSON Schema again from the models, with the construct's config type; `just check` fails when the committed copy differs:

```
just schema
```
