# Security

A vulnerability is a flaw that lets someone do what the archive should refuse them, for example download a restricted dataset's files without an approved request, act as a curator without the role, or read another person's account details.

## Reporting one

Report it privately through GitHub's private vulnerability reporting: on the repository's **Security** tab, choose **Report a vulnerability**, or open [the form](https://github.com/schuettc/research-in-a-box/security/advisories/new) directly. Only the maintainers see the report, and the fix is discussed there until it is released.

Please don't open a public issue, pull request or discussion for a vulnerability, since that tells everyone how to use it before archives running the kit can update.

A useful report says which part it is in (such as the read API, the sign-in, the ingest function or `cruise`), the version or commit, the steps that show it, and what it lets someone do.

## What is covered

The code in this repository: the contract, `cruise`, the backend's Lambda functions, the CDK construct, the web app, the Claude Code plugin and the deploy skill. A weakness in an archive someone runs from a fork, such as its AWS account settings or who it gave roles to, belongs to that archive's operator.

## Supported versions

Fixes land on `main` and go out in the next release. Archives update from upstream as the deploy skill's Update section describes.
