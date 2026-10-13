/**
 * Attention engine: pure function from PRSnapshot to a scored, categorized
 * attention report. No network, no side effects, fully deterministic given
 * a fixed "now".
 *
 * Scoring starts at 50 and adds urgency signals, clamped to 0-100.
 *
 * Categories (priority order):
 *   ACTION: something only the author can fix (changes requested, failing
 *     checks on their code, merge conflicts, actionable review threads).
 *   BLOCKED_EXTERNAL: the only failures are outside the author's control
 *     (preview deploys gated on maintainer authorization, etc). Low urgency.
 *   READY: approved, green, mergeable. The remaining action is merging.
 *   WAITING: pending checks or a review requested recently (under 3 days).
 *   STALE: 7+ days of silence with no approval. Reviewer silence, not yours.
 */
import type { AttentionResult, Category, CheckRun, PRSnapshot } from "./types.js";

/**
 * Failing checks whose failure is not the author's fault. The classic case
 * is a Vercel preview deploy that fails with "Authorization required to
 * deploy": GitHub marks it failed, but no code change can fix it. Those are
 * classified as external blockers so they do not inflate urgency.
 */
const EXTERNAL_BLOCKER_PATTERNS: RegExp[] = [
  /authorization required/i,
  /sign in to (view|deploy)/i,
  /waiting for (team|maintainer)/i,
  /team owner.*(approve|authorize)/i,
  /preview.*(authorization|approval)/i,
  /deployment authorization/i,
];

export function isExternalBlocker(run: CheckRun): boolean {
  const failed = ["failure", "error", "timed_out", "action_required"].includes(run.conclusion ?? "");
  if (!failed) return false;
  const text = `${run.name} ${run.description ?? ""}`;
  return EXTERNAL_BLOCKER_PATTERNS.some((p) => p.test(text));
}

export function isRealFailure(run: CheckRun): boolean {
  const failed = ["failure", "error", "timed_out", "action_required"].includes(run.conclusion ?? "");
  return failed && !isExternalBlocker(run);
}

export function scorePR(snapshot: PRSnapshot, now: Date = new Date()): AttentionResult {
  const reasons: string[] = [];
  let score = 50;
  let category: Category = "WAITING";

  if (snapshot.merged) {
    return { score: 0, reasons: ["Already merged."], category: "READY" };
  }

  const realFailures = snapshot.checkRuns.filter(isRealFailure);
  const externalFailures = snapshot.checkRuns.filter(isExternalBlocker);
  const pendingChecks = snapshot.checkRuns.filter(
    (r) => r.status === "in_progress" || r.status === "queued"
  );
  const actionableThreads = snapshot.threads.filter((t) => !t.resolved && t.actionable);
  const conflicted = snapshot.mergeableState === "dirty";
  const hasApproval = snapshot.reviewState === "APPROVED";
  const changesRequested = snapshot.reviewState === "CHANGES_REQUESTED";
  const daysSinceActivity = Math.max(
    snapshot.daysSinceActivity,
    Math.floor((now.getTime() - new Date(snapshot.updatedAt).getTime()) / 86400000)
  );

  if (changesRequested) {
    const who = snapshot.reviewAuthors.slice(0, 3).join(", ") || "a reviewer";
    score += 30;
    reasons.push(`Changes requested by ${who}.`);
  }

  if (conflicted) {
    score += 25;
    reasons.push("Merge conflicts: the branch cannot be merged cleanly.");
  }

  for (const run of realFailures.slice(0, 3)) {
    score += 12;
    reasons.push(`Failing check: ${run.name} (${run.conclusion}).`);
  }
  if (realFailures.length > 3) {
    reasons.push(`${realFailures.length - 3} more failing checks not shown.`);
  }

  if (actionableThreads.length > 0) {
    const shown = Math.min(actionableThreads.length, 3);
    score += Math.min(actionableThreads.length * 8, 24);
    const files = [...new Set(actionableThreads.slice(0, shown).map((t) => t.path.split("/").pop()))].join(", ");
    reasons.push(
      `${actionableThreads.length} unresolved review thread${actionableThreads.length === 1 ? "" : "s"} need${actionableThreads.length === 1 ? "s" : ""} a reply or code change (${files}).`
    );
  } else if (snapshot.threads.length > 0) {
    reasons.push(`${snapshot.threads.length} review thread${snapshot.threads.length === 1 ? "" : "s"} open, none look actionable.`);
  }

  const allGreen =
    snapshot.checkRuns.length > 0 &&
    realFailures.length === 0 &&
    pendingChecks.length === 0 &&
    snapshot.checkRuns.every((r) => ["success", "skipped", "neutral"].includes(r.conclusion ?? ""));
  const mergeable = snapshot.mergeableState === "clean";

  if (hasApproval && allGreen && mergeable) {
    category = "READY";
    score = Math.min(score, 45);
    reasons.push("Approved and green, ready to merge.");
  }

  const actionSignals = changesRequested || conflicted || realFailures.length > 0 || actionableThreads.length > 0;
  const onlyExternal = !actionSignals && externalFailures.length > 0;

  if (actionSignals) {
    category = "ACTION";
  } else if (onlyExternal) {
    category = "BLOCKED_EXTERNAL";
    score = Math.min(score, 25);
    reasons.push(
      `External blocker, not your code: ${externalFailures.map((r) => r.name).join(", ")}.`
    );
  } else if (hasApproval && mergeable && snapshot.checkRuns.length > 0) {
    category = "READY";
    score = Math.min(score, 40);
  } else if (pendingChecks.length > 0) {
    category = "WAITING";
    score = Math.min(score, 35);
    reasons.push(`Checks still running: ${pendingChecks.map((r) => r.name).join(", ")}.`);
  } else if (daysSinceActivity >= 7 && !hasApproval) {
    category = "STALE";
    score = Math.min(score, 35);
    reasons.push(`${daysSinceActivity} days with no activity and no approval. Ping the reviewers or close it.`);
  } else {
    category = "WAITING";
    score = Math.min(score, 30);
    if (snapshot.reviewState === "NONE") {
      reasons.push("No reviews yet. Waiting on reviewers.");
    } else {
      reasons.push("Nothing failing yet. Waiting on checks or reviewers.");
    }
  }

  if (snapshot.draft) {
    reasons.push("Note: this PR is still a draft.");
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, reasons, category };
}

/** Sort order for the attention report: highest attention first. */
export const CATEGORY_RANK: Record<Category, number> = {
  ACTION: 0,
  BLOCKED_EXTERNAL: 1,
  READY: 2,
  WAITING: 3,
  STALE: 4,
};

export function rankEntries<T extends { attention: AttentionResult }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => {
    if (b.attention.score !== a.attention.score) return b.attention.score - a.attention.score;
    return CATEGORY_RANK[a.attention.category] - CATEGORY_RANK[b.attention.category];
  });
}
