# Changelog


## 0.1.2 (2026-10-23)

Real 0.1.2 release (the MCP Registry previously carried a phantom 0.1.2 entry pointing at the 0.1.1 packages). Fixes from production validation: review attribution no longer labels bot `COMMENTED` reviews as "Changes requested" — `reviewAuthors` now names only reviewers whose effective state is the derived state (PT-5); PRs that could not be examined (e.g. rate limit hit mid-sweep) are marked `incomplete` and segregated after every scored entry instead of ranking as score-0 (PT-6); GitHub API base URL can be overridden with `PRWATCH_GITHUB_BASE_URL` (fallback `GITHUB_BASE_URL`) so the tool can run through a local proxy at the authenticated rate limit (PT-1). 36 tests passing.


## 0.1.1 (2026-10-15)

Ships on npm as @reneturcios/prwatch and in the official MCP Registry. Adds the `prwatch mcp` subcommand so the MCP server starts from the single published bin, the form the npm package and the MCP Registry entry invoke. 30 tests passing.


## 0.1.0 (2026-10-13)

First release: an attention report for your open GitHub PRs (changes requested, unresolved review threads, failing checks, merge conflicts, reviewer silence), with Vercel-style external blockers classified separately from failures that are yours to fix. Repo-scoped mode needs no token. CLI and MCP server.
