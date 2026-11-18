# archive-agent

The agent package is the `cruise` plugin for Claude Code: an MCP server and three skills. An MCP server is a program that gives Claude Code tools to call; this one, `archive-mcp`, runs on the user's own machine and has tools to search an archive, fetch a dataset, check and edit a package, submit it, and decide a submission. A skill is a written procedure Claude Code follows: `find-data`, `submit-dataset` and `review-submission`. Nothing is written to a manifest or sent to the archive without the user's yes.

Who uses it: a researcher finding or submitting data, and a curator reviewing submissions, from Claude Code. It needs [uv](https://docs.astral.sh/uv/).

Its one command installs the plugin, in Claude Code:

```
/plugin marketplace add schuettc/research-archive-in-a-box
/plugin install cruise@research-archive-in-a-box
```

Claude Code then starts `archive-mcp` itself, as `.mcp.json` says; there is nothing to run by hand.

Its `sign_in` tool opens the archive's own sign-in page in the browser. Sign in there as on the site, then press **Sign in the command line** to hand the sign-in to the plugin; it lasts about an hour and is kept only while the server runs.
