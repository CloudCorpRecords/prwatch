/**
 * prwatch MCP server (stdio). Same attention engine as the CLI, exposed as
 * tools so coding agents (Claude, Cursor, Cline) can check what needs the
 * contributor's attention before or after opening PRs.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  parsePullUrl,
  parseRepoSlug,
  currentUser,
  listOpenPRs,
  buildPRSnapshot,
} from "./github.js";
import { scorePR, rankEntries } from "./attention.js";

const server = new McpServer({ name: "prwatch", version: "0.1.2" });

const text = (obj: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }],
});

async function resolveUser(user?: string): Promise<string> {
  if (user) return user;
  try {
    return await currentUser();
  } catch {
    throw new Error("Pass user explicitly when no GITHUB_TOKEN is set.");
  }
}

server.tool(
  "attention_report",
  "Ranked attention report for a contributor's open PRs: which ones need action right now, with scores 0-100, categories (ACTION, BLOCKED_EXTERNAL, READY, WAITING, STALE) and human readable reasons. Call this to triage a stack of open PRs.",
  {
    user: z.string().optional().describe("GitHub username. Defaults to the token owner."),
    repo: z.string().optional().describe("Optional owner/repo filter, e.g. shadcn-labs/pdfcn."),
  },
  async ({ user, repo }) => {
    try {
      const who = await resolveUser(user);
      if (repo) parseRepoSlug(repo);
      const prs = await listOpenPRs(who, repo);
      const entries = [];
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
            attention: { score: 0, reasons: [err instanceof Error ? err.message : String(err)], category: "WAITING" as const },
            incomplete: true,
          });
        }
      }
      return text({ user: who, repo: repo ?? null, results: rankEntries(entries) });
    } catch (err) {
      return text({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

server.tool(
  "list_my_prs",
  "Simple list of a contributor's open PRs (owner, repo, number, title, URL).",
  {
    user: z.string().optional().describe("GitHub username. Defaults to the token owner."),
    repo: z.string().optional().describe("Optional owner/repo filter."),
  },
  async ({ user, repo }) => {
    try {
      const who = await resolveUser(user);
      if (repo) parseRepoSlug(repo);
      return text({ user: who, prs: await listOpenPRs(who, repo) });
    } catch (err) {
      return text({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

server.tool(
  "pr_status",
  "Deep dive on one PR: review state, checks, unresolved review threads, and its attention score with reasons.",
  {
    url: z.string().describe("Full GitHub PR URL, e.g. https://github.com/owner/repo/pull/92"),
  },
  async ({ url }) => {
    try {
      const { owner, repo, number } = parsePullUrl(url);
      const snapshot = await buildPRSnapshot(owner, repo, number);
      return text({ snapshot, attention: scorePR(snapshot) });
    } catch (err) {
      return text({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void main();
