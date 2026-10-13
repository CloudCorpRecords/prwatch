# prwatch

**What needs your attention right now?** prwatch answers that question for contributors with open PRs.

It was born from a real day: three PRs open in one repo, CodeRabbit reviews on all three, a Vercel deploy failure that was not the author's fault, and no way to see at a glance which PR actually needed work. Manually reading every review thread on every PR is the old way. prwatch ranks your open PRs by urgency with human readable reasons, so you open the right one first.

## Install

Requirements: Node 20+.

```bash
git clone https://github.com/CloudCorpRecords/prwatch
cd prwatch
npm install
npm run build
npm link   # or run with npx tsx src/cli.ts
```

Set `GITHUB_TOKEN` (or `GH_TOKEN`) for the 5000 req/hr authenticated rate limit. Without a token it works at the 60 req/hr unauthenticated rate.

## Authentication

A token is optional. `--repo` mode and `prwatch show` work without one, since they never touch the search API. Account-wide reports (`attention` / `list` without `--repo`) use `author:` search, which GitHub restricts for unauthenticated callers on some accounts, so a token is recommended there. A classic token with no scopes is enough for public data; without one you get clear guidance instead of a raw 422.

## CLI usage

```bash
prwatch attention                     # rank my open PRs by urgency
prwatch attention --user octocat --repo shadcn-labs/pdfcn
prwatch attention --json              # machine readable output
prwatch list                          # simple one line per PR
prwatch show https://github.com/shadcn-labs/pdfcn/pull/92
```

Example output:

```
[ACTION]  74  shadcn-labs/pdfcn#92
         feat: add Business Letter block
         - 4 unresolved review threads need a reply or code change (business-letter.tsx, business-letter.mdx)
         https://github.com/shadcn-labs/pdfcn/pull/92
[READY]   45  shadcn-labs/pdfcn#93
         feat: add Resume block
         - Approved and green, ready to merge.
         https://github.com/shadcn-labs/pdfcn/pull/93
```

`prwatch show` gives the deep dive: review state, every check with its conclusion, unresolved review threads with file and line, and the full attention breakdown.

## MCP server

Same engine as the CLI, exposed over stdio for Claude, Cursor, and Cline:

| Tool | What it does |
| ---- | ------------ |
| `attention_report({user?, repo?})` | Ranked attention report with scores, categories, and reasons |
| `list_my_prs({user?, repo?})` | Simple list of open PRs |
| `pr_status({url})` | Deep dive on one PR: reviews, checks, threads, attention score |

Claude Code / Cursor config (`~/.claude.json` or MCP settings):

```json
{
  "mcpServers": {
    "prwatch": {
      "command": "node",
      "args": ["/absolute/path/to/prwatch/dist/mcp.js"],
      "env": { "GITHUB_TOKEN": "ghp_your_token_here" }
    }
  }
}
```

Start it directly with `npm run start:mcp`.

## How scoring works

Every open PR starts at 50 points and gains or loses urgency from signals:

| Signal | Effect |
| ------ | ------ |
| Changes requested by a reviewer | +30, category ACTION |
| Merge conflict (unmergeable branch) | +25, category ACTION |
| Failing check on your code (build, test, lint, DCO) | +12 each, category ACTION |
| Unresolved review thread that asks for a change | +8 each, category ACTION |
| Approved, checks green, mergeable | READY, score capped at 45 |
| Failing check that is not your fault (for example Vercel "Authorization required to deploy") | classified BLOCKED_EXTERNAL, low urgency |
| Checks still running | WAITING |
| 7+ days of silence with no approval | STALE |

Score is clamped to 0-100. Categories rank in this order: ACTION, BLOCKED_EXTERNAL, READY, WAITING, STALE. The report sorts by score, then category.

Two judgment calls worth knowing:

1. **External blockers are not failures.** A preview deploy that fails because a maintainer has to authorize it is GitHub-marked "failure", but no code change fixes it. prwatch detects known patterns (authorization required, sign in to deploy, waiting on team approval) and files them as external, so they never inflate your urgency.
2. **Thread resolution is approximated.** The GitHub REST API cannot say whether a review thread is resolved, so top level review comments from non authors count as open threads. Comments that suggest a change (code suggestions, "please", "consider", "fix") count as actionable.

## Development

```bash
npm install
npm test        # tsx --test test/*.test.ts
npm run build   # tsc, emits to dist/
npm run dev     # run the CLI from source
```

Fixtures in `test/fixtures/` are modeled on the real shapes of shadcn-labs/pdfcn PRs #92, #93, and #94 from 2026-10-13. Tests never touch the network.

## License

MIT. Copyright (c) 2026 Rene Turcios. See LICENSE.
