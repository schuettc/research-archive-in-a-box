# femc: an example migration

This folder shows how an archive that already publishes data elsewhere moves its datasets into packages. A migration here means a converter: a small program that reads one dataset as the old portal offers it and writes it as a package, a folder with `datapackage.json`, the data files and `checksums.sha256`.

The converter is written for the shape of one existing portal, the Forest Ecosystem Monitoring Cooperative's public data archive, where each dataset has an EML record (an XML description standard in ecology) and a download. It reads the record with the contract's EML importer, makes each real column of the files a field, and lists what it couldn't import, one line each with its reason, in `_build/not-imported.txt`. `archive.yaml` in this folder is that archive's config, with no infrastructure, so it is never deployed.

The repo holds no data from that portal. The test fixtures under `tests/fixtures/` are invented, in the portal's shape, and every name in them is made up.

Its one command converts one dataset folder, reading the folder's row of the `SOURCES.md` beside it for the licence and access the portal shows:

```
uv run femc convert examples/femc/tests/fixtures/datasets/stream-counts out
```
