# Contributing

Contributions come as pull requests against `main`. This page says how to set up a clone, check a change and open the pull request.

## Set up

You need [uv](https://docs.astral.sh/uv/), Node 24 or later and [just](https://just.systems/). In a clone of the repository, install the Python packages (a uv workspace) and the TypeScript packages (an npm workspace):

```
uv sync --all-packages
npm ci
```

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
