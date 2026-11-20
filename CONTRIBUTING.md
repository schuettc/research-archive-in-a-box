# Contributing

Contributions come as pull requests against `main`. This page says how the repository is laid out, and how to set up a clone, check a change and open the pull request.

## Layout

```
packages/
  contract/   Python: archive-contract, the package and archive.yaml models and their JSON Schema
  tool/       Python: cruise, the command-line tool that checks and edits packages
  backend/    Python: the Lambda functions behind the archive's API and pipeline
  infra/      TypeScript: the CDK construct (ResearchArchive) and the app CI deploys
  web/        TypeScript: the React and Vite web app
  agent/      Python: the Claude Code plugin, its MCP server (archive-mcp) and skills
  client/     Python: browser sign-in to an archive, for the MCP server
examples/     the sample package, an example brand (logo and favicon), and femc, an example converter
              that turns an existing data portal's datasets into packages
docs/         the guide, the architecture page and the module docs
```

The Python packages form a uv workspace (`pyproject.toml`), and the TypeScript packages form an npm workspace (`package.json`). [Architecture](docs/architecture.md) explains the packages and how a submission becomes a published dataset.

## Set up

You need [uv](https://docs.astral.sh/uv/), Node 24 or later and [just](https://just.systems/). In a clone of the repository, install the packages of both workspaces:

```
uv sync --all-packages
npm ci
```

Inside a clone, `uv run cruise` runs the command-line tool from the source.

To try the web app locally against a deployed stage, run `ARCHIVE_DEV_SITE=https://<stage domain> npm run dev -w packages/web`. Vite then proxies `/api/`, `/auth-config.json` and `/data/` to that stage; without the variable, `npm run dev` is unchanged. Uploads, the findings report and file Preview fail locally, because the stage's storage refuses a localhost origin: check those on the stage itself.

## Check a change

`just check` runs the format checks, the linters, the type checks and the tests in Python and TypeScript, and the drift check that fails when a committed generated file differs from the code it comes from. CI also runs a security job, which `just check` does not: pip-audit on the locked Python dependencies, npm audit on the npm dependencies the archive ships (not the build and test tools), and zizmor on the workflows.

```
just check
```

`just fmt` fixes the formatting in place. A change to the contract's models or to the read API's routes changes generated files: `just schema` writes the contract's JSON Schema and the construct's config type again, `just openapi` writes the read API's OpenAPI spec, and `just web-types` writes the web app's types from both. Commit what they write with the change.

## Open a pull request

1. Make a branch from an up-to-date `main`, such as `fix-search-paging`.
2. Commit the change with its tests. A bug fix comes with a test that fails without it.
3. Push the branch and open a pull request against `main` that says what changed and why.

CI runs three checks on every pull request: `python`, `typescript` and `security` (a dependency audit of both lockfiles and a scan of the workflows). All three must pass before the pull request is merged. Once merged, a push to `main` deploys each stage that has a deploy role; a pull request never deploys.

Please report a vulnerability privately, as [SECURITY.md](SECURITY.md) says, not in an issue or a pull request.
