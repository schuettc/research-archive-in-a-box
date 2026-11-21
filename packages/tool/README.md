# cruise

`cruise` is the command-line tool for dataset packages. A package is a folder with the data files, a `datapackage.json` manifest that describes them, and a `checksums.sha256` file with each file's hash, as in `examples/sample-package`. `cruise` runs the same quality rules on it that the archive runs when the package is submitted. Run it with `--config` pointing at the archive's `archive.yaml`, so it also applies that archive's profiles and required fields: a package that passes that way passes there.

Who uses it: a researcher or data manager preparing a package before submitting it, and the archive itself, whose ingest function runs these rules.

It has three commands. `cruise diagnose <folder>` checks one package and lists each finding with its fix. `cruise audit <folders>` ranks every package under some folders by its findings and score. `cruise set <folder> <field> <value>` writes a field to the manifest and rewrites the package's `README.md` and `checksums.sha256`, for example a column's description:

```
cruise set . description "Logger battery voltage." --resource logger --column battery_v
```

Install it with [uv](https://docs.astral.sh/uv/) and check a package:

```
uv tool install "git+https://github.com/schuettc/research-archive-in-a-box@v0.1.3#subdirectory=packages/tool"
cruise diagnose examples/sample-package
```

Inside a clone, `uv run cruise` runs it with no install.
