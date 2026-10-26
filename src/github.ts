/**
 * GitHub REST client. Native fetch only, no extra dependencies.
 * Token comes from GITHUB_TOKEN or GH_TOKEN (optional; 60 req/hr without it).
 * Responses are cached under ~/.cache/prwatch (10 min for PR data, 1h for
 * search) so attention reports do not burn quota on every run.
 *
 * Repo-scoped listing (`--repo owner/name`) avoids /search/issues entirely by
 * paging /repos/:owner/:repo/pulls and filtering to the author's PRs, so it
 * works without a token. Account-wide author search does use the search API,
 * which GitHub restricts for unauthenticated callers on some accounts (422).
 *
 * Note: REST cannot tell us whether a review comment thread is resolved, so
 * top level review comments from non authors are treated as open threads.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import type { CombinedStatus, PRSnapshot, ReviewThread, CheckRun, ReviewState } from "./types.js";

const DEFAULT_API = "https://api.github.com";

/**
 * The GitHub API base in use. PRWATCH_GITHUB_BASE_URL wins, then the generic
 * GITHUB_BASE_URL, then the public API — the same pattern as Greenlight's
 * GREENLIGHT_GITHUB_BASE_URL, so prwatch can run through a vault-backed
 * localhost proxy (gh-proxy) at the authenticated rate limit. Trailing
 * slashes are stripped.
 */
export function githubApiBase(): string {
  for (const raw of [process.env.PRWATCH_GITHUB_BASE_URL, process.env.GITHUB_BASE_URL]) {
    if (raw && raw.trim().length > 0) return raw.trim().replace(/\/+$/, "");
  }
  return DEFAULT_API;
}

const CACHE_DIR = join(homedir(), ".cache", "prwatch");

function ensureCache(): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
}

const TTL_MS: Record<string, number> = {
  pr: 10 * 60 * 1000,
  search: 60 * 60 * 1000,
};

function cacheKey(kind: string, parts: string[]): string {
  return `${kind}-${parts.join("-").replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`;
}

function cacheGet(kind: string, parts: string[]): unknown | undefined {
  ensureCache();
  const file = join(CACHE_DIR, cacheKey(kind, parts));
  if (!existsSync(file)) return undefined;
  try {
    const entry = JSON.parse(readFileSync(file, "utf8"));
    if (Date.now() - entry.savedAt > TTL_MS[kind]) return undefined;
    return entry.data;
  } catch {
    return undefined;
  }
}

function cacheSet(kind: string, parts: string[], data: unknown): void {
  ensureCache();
  const file = join(CACHE_DIR, cacheKey(kind, parts));
  try {
    writeFileSync(file, JSON.stringify({ savedAt: Date.now(), data }), "utf8");
  } catch {
    /* cache is best effort */
  }
}

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

export const AUTHOR_SEARCH_GUIDANCE =
  "Account-wide author search needs a GitHub token for this account. " +
  "Set GITHUB_TOKEN (create one at github.com/settings/tokens, no scopes needed for public data) " +
  "or use --repo mode, e.g. prwatch attention --user CloudCorpRecords --repo shadcn-labs/pdfcn.";

export class AuthorSearchRestrictedError extends Error {
  constructor() {
    super(AUTHOR_SEARCH_GUIDANCE);
    this.name = "AuthorSearchRestrictedError";
  }
}

/**
 * GitHub returns 422 "The listed users cannot be searched either because the
 * users do not exist or you do not have permission to view the users" for
 * unauthenticated /search/issues queries with author:<user> on some accounts.
 * That is a search restriction, not a missing user, so it maps to guidance.
 */
export function isAuthorSearchRestricted(status: number, body: string): boolean {
  return status === 422 && /cannot be searched/i.test(body);
}

function mapApiError(path: string, status: number, body: string): Error {
  if (path === "/search/issues" && isAuthorSearchRestricted(status, body)) {
    return new AuthorSearchRestrictedError();
  }
  return new Error(`GitHub API ${status} for ${path}: ${body.slice(0, 200)}`);
}

export function githubToken(): string | undefined {
  return process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
}

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "prwatch/0.1.4",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = githubToken();
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function api<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(githubApiBase() + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { headers: headers() });
  if (res.status === 403 || res.status === 429) {
    throw new RateLimitError("GitHub rate limit hit. Set GITHUB_TOKEN for 5000 req/hr.");
  }
  if (!res.ok) {
    throw mapApiError(path, res.status, (await res.text()).slice(0, 200));
  }
  return (await res.json()) as T;
}

/** GET an array endpoint across all pages by following the Link rel="next". */
async function fetchAllPages<T>(path: string, params: Record<string, string> = {}): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = null;
  let first = true;
  const h = headers();
  while (first || next) {
    let res: Response;
    if (first) {
      const url = new URL(githubApiBase() + path);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      res = await fetch(url.toString(), { headers: h });
      first = false;
    } else {
      // Link headers carry absolute api.github.com URLs; retarget them at
      // the configured base so pagination also goes through a proxy.
      const target = (next as string).startsWith(DEFAULT_API)
        ? githubApiBase() + (next as string).slice(DEFAULT_API.length)
        : (next as string);
      res = await fetch(target, { headers: h });
    }
    if (res.status === 403 || res.status === 429) {
      throw new RateLimitError("GitHub rate limit hit. Set GITHUB_TOKEN for 5000 req/hr.");
    }
    if (!res.ok) {
      throw mapApiError(path, res.status, (await res.text()).slice(0, 200));
    }
    out.push(...((await res.json()) as T[]));
    next = null;
    const link = res.headers.get("link");
    if (link) {
      const m = /<([^>]+)>;\s*rel="next"/.exec(link);
      if (m) next = m[1];
    }
  }
  return out;
}

interface RawUser {
  login: string;
}
interface RawPR {
  number: number;
  title: string;
  user: { login: string };
  created_at: string;
  updated_at: string;
  merged: boolean;
  draft: boolean;
  mergeable_state: string | null;
  head: { sha: string };
  base: { ref: string };
  html_url: string;
}
interface RawReview {
  id: number;
  user: { login: string };
  state: string;
  submitted_at: string;
}
interface RawReviewComment {
  id: number;
  user: { login: string };
  body: string;
  path: string;
  original_line: number | null;
  in_reply_to_id: number | null;
  diff_hunk: string;
}
interface RawCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  output?: { summary: string | null; title: string | null };
}
interface RawStatus {
  state: "success" | "pending" | "failure" | "error";
}

export function parsePullUrl(url: string): { owner: string; repo: string; number: number } {
  const m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(url.trim());
  if (!m) throw new Error(`Expected a GitHub pull request URL, got: ${url}`);
  return { owner: m[1], repo: m[2], number: parseInt(m[3], 10) };
}

export function parseRepoSlug(slug: string): { owner: string; repo: string } {
  const m = /^([^/]+)\/([^/]+)$/.exec(slug.trim());
  if (!m) throw new Error(`Expected owner/repo, got: ${slug}`);
  return { owner: m[1], repo: m[2] };
}

export async function currentUser(): Promise<string> {
  const u = await api<RawUser>("/user");
  return u.login;
}

interface RawPullListItem {
  number: number;
  title: string;
  html_url: string;
  user: { login: string };
}

/** Keep only PRs opened by `user` (case-insensitive). Pure, no network. */
export function filterOpenPRsByAuthor(items: RawPullListItem[], user: string): RawPullListItem[] {
  const want = user.toLowerCase();
  return items.filter((it) => it.user?.login?.toLowerCase() === want);
}

export interface OpenPREntry {
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
}

export async function listOpenPRs(user: string, repo?: string): Promise<OpenPREntry[]> {
  if (repo) {
    // Repo-scoped mode avoids /search/issues entirely: list all open PRs in
    // the repo and filter to the author's. Works without a token.
    const cached = cacheGet("search", [user, repo]);
    if (cached) return cached as OpenPREntry[];
    const { owner, repo: r } = parseRepoSlug(repo);
    const items = await fetchAllPages<RawPullListItem>(`/repos/${owner}/${r}/pulls`, {
      state: "open",
      per_page: "100",
    });
    const out = filterOpenPRsByAuthor(items, user).map((it) => ({
      owner,
      repo: r,
      number: it.number,
      title: it.title,
      url: it.html_url,
    }));
    cacheSet("search", [user, repo], out);
    return out;
  }
  const q = `is:pr is:open author:${user}`;
  const cached = cacheGet("search", [user, "all"]);
  if (cached) return cached as OpenPREntry[];
  const res = await api<{ items: Array<{ html_url: string; title: string; number: number }> }>(
    "/search/issues",
    { q, per_page: "100" }
  );
  const out = res.items.map((it) => {
    const { owner, repo: r, number } = parsePullUrl(it.html_url);
    return { owner, repo: r, number, title: it.title, url: it.html_url };
  });
  cacheSet("search", [user, "all"], out);
  return out;
}

/** Heuristic: a review comment is actionable if it asks for a change. */
export function isActionableComment(body: string, diffHunk: string): boolean {
  const text = `${body}\n${diffHunk}`;
  if (/```suggestion/i.test(text)) return true;
  return /\b(should|consider|recommend|suggest|please|fix|change|update|nit|minor|major)\b/i.test(body);
}

/**
 * Derive the effective review state and who is responsible for it.
 * Attribution (PT-5): `authors` lists only reviewers whose effective state
 * IS the derived state — a bot's COMMENTED review must not be reported as
 * "Changes requested by coderabbitai[bot]" when a human requested changes.
 */
export function deriveReviewState(reviews: RawReview[]): { state: ReviewState; authors: string[] } {
  const latest = new Map<string, string>();
  for (const r of reviews) {
    if (r.user.login.endsWith("[bot]")) {
      if (!latest.has(r.user.login)) latest.set(r.user.login, r.state);
      continue;
    }
    latest.set(r.user.login, r.state);
  }
  const states = [...latest.values()];
  const withState = (s: string) => [...latest.entries()].filter(([, v]) => v === s).map(([k]) => k);
  if (states.includes("CHANGES_REQUESTED")) return { state: "CHANGES_REQUESTED", authors: withState("CHANGES_REQUESTED") };
  if (states.includes("APPROVED")) return { state: "APPROVED", authors: withState("APPROVED") };
  if (states.includes("COMMENTED")) return { state: "COMMENTED", authors: withState("COMMENTED") };
  return { state: "NONE", authors: [...latest.keys()] };
}

export async function buildPRSnapshot(owner: string, repo: string, number: number): Promise<PRSnapshot> {
  const cached = cacheGet("pr", [owner, repo, String(number)]);
  if (cached) return cached as PRSnapshot;

  const pr = await api<RawPR>(`/repos/${owner}/${repo}/pulls/${number}`);
  const [reviews, reviewComments, issueComments] = await Promise.all([
    api<RawReview[]>(`/repos/${owner}/${repo}/pulls/${number}/reviews`),
    api<RawReviewComment[]>(`/repos/${owner}/${repo}/pulls/${number}/comments`, { per_page: "100" }),
    api<Array<{ created_at: string }>>(`/repos/${owner}/${repo}/issues/${number}/comments`, { per_page: "100" }),
  ]);

  const { state: reviewState, authors: reviewAuthors } = deriveReviewState(reviews);

  const topLevel = reviewComments.filter((c) => c.in_reply_to_id == null);
  const threads: ReviewThread[] = topLevel
    .filter((c) => c.user.login !== pr.user.login)
    .map((c) => ({
      id: c.id,
      path: c.path,
      line: c.original_line,
      author: c.user.login,
      body: c.body.slice(0, 400),
      actionable: isActionableComment(c.body, c.diff_hunk ?? ""),
      resolved: false,
    }));

  let checkRuns: CheckRun[] = [];
  let combinedStatus: { state: "success" | "pending" | "failure" | "error" } | null = null;
  try {
    const runs = await api<{ check_runs: RawCheckRun[] }>(`/repos/${owner}/${repo}/commits/${pr.head.sha}/check-runs`, { per_page: "100" });
    checkRuns = runs.check_runs.map((r) => ({
      name: r.name,
      status: r.status,
      conclusion: r.conclusion,
      description: r.output?.summary ?? r.output?.title ?? null,
    }));
  } catch {
    /* check runs may be unavailable */
  }
  try {
    const s = await api<RawStatus>(`/repos/${owner}/${repo}/commits/${pr.head.sha}/status`);
    combinedStatus = { state: s.state };
  } catch {
    /* combined status may be unavailable */
  }

  const now = Date.now();
  const updatedAt = new Date(pr.updated_at).getTime();
  const createdAt = new Date(pr.created_at).getTime();

  const snapshot: PRSnapshot = {
    sourceUrl: pr.html_url,
    owner,
    repo,
    number,
    title: pr.title,
    author: pr.user.login,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    daysOpen: Math.max(0, Math.floor((now - createdAt) / 86400000)),
    daysSinceActivity: Math.max(0, Math.floor((now - updatedAt) / 86400000)),
    mergeableState: pr.mergeable_state,
    merged: pr.merged,
    draft: pr.draft,
    headSha: pr.head.sha,
    baseRef: pr.base.ref,
    reviewState,
    reviewAuthors,
    threads,
    checkRuns,
    combinedStatus,
    issueCommentCount: issueComments.length,
  };
  cacheSet("pr", [owner, repo, String(number)], snapshot);
  return snapshot;
}

export function toReportEntry(snapshot: PRSnapshot, attention: import("./types.js").AttentionResult) {
  return {
    pr: { owner: snapshot.owner, repo: snapshot.repo, number: snapshot.number, title: snapshot.title, url: snapshot.sourceUrl },
    attention,
  };
}
