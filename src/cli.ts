#!/usr/bin/env node
/**
 * prwatch CLI: what needs your attention right now?
 *
 *   prwatch attention [--user X] [--repo owner/name] [--json]
 *   prwatch list [--user X] [--repo owner/name] [--json]
 *   prwatch show <pr-url> [--json]
 *
 * Set GITHUB_TOKEN (or GH_TOKEN) for the 5000 req/hr authenticated rate limit.
 */
import {
  parsePullUrl,
  parseRepoSlug,
  currentUser,
  listOpenPRs,
  buildPRSnapshot,
  RateLimitError,
  AuthorSearchRestrictedError,
} from "./github.js";
import { scorePR, rankEntries } from "./attention.js";
import type { PRSnapshot, ReportEntry } from "./types.js";

const SYMBOL: Record<string, string> = {
  ACTION: "[ACTION]",
  BLOCKED_EXTERNAL: "[BLOCKED]",
  READY: "[READY]",
  WAITING: "[WAITING]",
  STALE: "[STALE]",
};

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function resolveUser(flagUser?: string): Promise<string> {
  if (flagUser) return flagUser;
  try {
    return await currentUser();
  } catch {
    throw new Error("--user is required when no GITHUB_TOKEN is set (cannot discover your username).");
  }
}

async function buildReport(user: string, repo?: string): Promise<ReportEntry[]> {
  const prs = await listOpenPRs(user, repo);
  const entries: ReportEntry[] = [];
  for (const pr of prs) {
    try {
      const snapshot = await buildPRSnapshot(pr.owner, pr.repo, pr.number);
      if (snapshot.merged) continue;
      entries.push({
        pr: { owner: pr.owner, repo: pr.repo, number: pr.number, title: pr.title, url: pr.url },
        attention: scorePR(snapshot),
      });
    } catch (err) {
      entries.push({
        pr: { owner: pr.owner, repo: pr.repo, number: pr.number, title: pr.title, url: pr.url },
        attention: { score: 0, reasons: [err instanceof Error ? err.message : String(err)], category: "WAITING" },
      });
    }
  }
  return rankEntries(entries);
}

function printAttention(entries: ReportEntry[], asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }
  if (entries.length === 0) {
    console.log("No open PRs. Nothing needs your attention.");
    return;
  }
  for (const e of entries) {
    console.log(`${SYMBOL[e.attention.category]} ${String(e.attention.score).padStart(3)}  ${e.pr.owner}/${e.pr.repo}#${e.pr.number}`);
    console.log(`         ${e.pr.title}`);
    for (const r of e.attention.reasons.slice(0, 3)) console.log(`         - ${r}`);
    console.log(`         ${e.pr.url}`);
  }
}

function printShow(snapshot: PRSnapshot, asJson: boolean): void {
  const attention = scorePR(snapshot);
  if (asJson) {
    console.log(JSON.stringify({ snapshot, attention }, null, 2));
    return;
  }
  console.log(`${SYMBOL[attention.category]} [${attention.score}] ${snapshot.owner}/${snapshot.repo}#${snapshot.number}: ${snapshot.title}`);
  console.log(`  ${snapshot.sourceUrl}`);
  console.log(`  review state: ${snapshot.reviewState} (by ${snapshot.reviewAuthors.join(", ") || "nobody yet"})`);
  console.log(`  mergeable: ${snapshot.mergeableState ?? "unknown"}  |  base: ${snapshot.baseRef}  |  head: ${snapshot.headSha.slice(0, 7)}`);
  console.log(`  open ${snapshot.daysOpen}d, last activity ${snapshot.daysSinceActivity}d ago, ${snapshot.issueCommentCount} issue comments`);
  if (snapshot.checkRuns.length > 0) {
    console.log("  checks:");
    for (const r of snapshot.checkRuns) {
      console.log(`    - ${r.name}: ${r.status}${r.conclusion ? ` (${r.conclusion})` : ""}${r.description ? ` : ${r.description}` : ""}`);
    }
  } else {
    console.log("  checks: none reported");
  }
  if (snapshot.threads.length > 0) {
    console.log(`  review threads (${snapshot.threads.length}):`);
    for (const t of snapshot.threads) {
      console.log(`    - ${t.path}${t.line != null ? `:${t.line}` : ""} by ${t.author}${t.actionable ? " [actionable]" : ""}`);
      console.log(`      ${t.body.split("\n")[0].slice(0, 140)}`);
    }
  }
  console.log("  attention:");
  for (const r of attention.reasons) console.log(`    - ${r}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [command, ...rest] = args;
  const asJson = rest.includes("--json");
  const userFlag = flag(rest, "user");
  const repoFlag = flag(rest, "repo");

  try {
    if (command === "mcp") {
      // Start the MCP server (stdio); the module runs on import.
      await import("./mcp.js");
      return;
    }
    if (command === "attention") {
      const user = await resolveUser(userFlag);
      const entries = await buildReport(user, repoFlag);
      printAttention(entries, asJson);
    } else if (command === "list") {
      const user = await resolveUser(userFlag);
      const prs = await listOpenPRs(user, repoFlag);
      if (asJson) {
        console.log(JSON.stringify(prs, null, 2));
      } else if (prs.length === 0) {
        console.log("No open PRs.");
      } else {
        for (const p of prs) console.log(`${p.owner}/${p.repo}#${p.number}  ${p.title}`);
      }
    } else if (command === "show") {
      const url = rest.find((a) => !a.startsWith("--"));
      if (!url) throw new Error("Usage: prwatch show <pr-url> [--json]");
      const { owner, repo, number } = parsePullUrl(url);
      const snapshot = await buildPRSnapshot(owner, repo, number);
      printShow(snapshot, asJson);
    } else {
      console.log("prwatch: what needs your attention right now?");
      console.log("");
      console.log("  prwatch attention [--user X] [--repo owner/name] [--json]");
      console.log("  prwatch list [--user X] [--repo owner/name] [--json]");
      console.log("  prwatch show <pr-url> [--json]");
      process.exitCode = command ? 1 : 0;
    }
  } catch (err) {
    if (err instanceof RateLimitError) {
      console.error(`Rate limited: ${err.message}`);
    } else if (err instanceof AuthorSearchRestrictedError) {
      console.error(err.message);
    } else {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exitCode = 1;
  }
}

void main();
