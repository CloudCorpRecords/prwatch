# Changelog


## 0.1.4 (2026-10-25)

Fork PR triage fix. A check run that concluded `action_required` never ran: GitHub is holding the workflow until a maintainer approves it, which is the normal state of a fork PR. The attention engine counted such runs as real failures whenever their name or description did not match an external blocker pattern, so a healthy fork PR scored as ACTION with phantom failing checks, and an approved fork PR could even read READY while its CI had never run. Gated runs are now classified on their own (`isMaintainerGated`), never count as failures, and a PR whose only blockers are gated suites is BLOCKED_EXTERNAL with a reason that names the maintainer approval it is waiting on. A gated suite next to a real failure stays ACTION, with the gated note attached and no failure score for the gated runs. Also corrects the GitHub API User-Agent, which still said 0.1.2. 41 tests passing.

## 0.1.3 (2026-10-23)

Registry metadata correction release (repo health sweep). The MCP Registry's 0.1.2 listing was a phantom entry published 2026-10-18 whose package fields still pointed at the 0.1.1 npm package and the 0.1.1 GHCR image, and Registry versions are immutable, so the corrected listing ships as 0.1.3. No code changes from 0.1.2; server.json, package files, and the MCP server version string all move to 0.1.3 together. 36 tests passing.


## 0.1.2 (2026-10-23)

Real 0.1.2 release (the MCP Registry previously carried a phantom 0.1.2 entry pointing at the 0.1.1 packages). Fixes from production validation: review attribution no longer labels bot `COMMENTED` reviews as "Changes requested" — `reviewAuthors` now names only reviewers whose effective state is the derived state (PT-5); PRs that could not be examined (e.g. rate limit hit mid-sweep) are marked `incomplete` and segregated after every scored entry instead of ranking as score-0 (PT-6); GitHub API base URL can be overridden with `PRWATCH_GITHUB_BASE_URL` (fallback `GITHUB_BASE_URL`) so the tool can run through a local proxy at the authenticated rate limit (PT-1). 36 tests passing.


## 0.1.1 (2026-10-15)

Ships on npm as @reneturcios/prwatch and in the official MCP Registry. Adds the `prwatch mcp` subcommand so the MCP server starts from the single published bin, the form the npm package and the MCP Registry entry invoke. 30 tests passing.


## 0.1.0 (2026-10-13)

First release: an attention report for your open GitHub PRs (changes requested, unresolved review threads, failing checks, merge conflicts, reviewer silence), with Vercel-style external blockers classified separately from failures that are yours to fix. Repo-scoped mode needs no token. CLI and MCP server.
