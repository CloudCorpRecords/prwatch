/**
 * Shared types for prwatch. All scoring inputs live in PRSnapshot so the
 * attention engine stays a pure function with no network access.
 */

export type Category =
  | "ACTION"
  | "WAITING"
  | "STALE"
  | "READY"
  | "BLOCKED_EXTERNAL";

export type ReviewState = "CHANGES_REQUESTED" | "APPROVED" | "COMMENTED" | "NONE";

export interface AttentionResult {
  score: number;
  reasons: string[];
  category: Category;
}

export interface ReviewThread {
  id: number;
  path: string;
  line: number | null;
  author: string;
  body: string;
  actionable: boolean;
  resolved: boolean;
}

export interface CheckRun {
  name: string;
  status: "queued" | "in_progress" | "completed" | string;
  conclusion: "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required" | null | string;
  description: string | null;
}

export interface CombinedStatus {
  state: "success" | "pending" | "failure" | "error";
}

export interface PRSnapshot {
  sourceUrl: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  daysOpen: number;
  daysSinceActivity: number;
  mergeableState: string | null;
  merged: boolean;
  draft: boolean;
  headSha: string;
  baseRef: string;
  reviewState: ReviewState;
  reviewAuthors: string[];
  threads: ReviewThread[];
  checkRuns: CheckRun[];
  combinedStatus: CombinedStatus | null;
  issueCommentCount: number;
}

export interface ReportEntry {
  pr: { owner: string; repo: string; number: number; title: string; url: string };
  attention: AttentionResult;
  /**
   * True when the PR could not be examined (e.g. rate limit hit mid-sweep).
   * Incomplete entries carry a placeholder score and are segregated after
   * every scored entry in rankings — never mixed in as a real 0 (PT-6).
   */
  incomplete?: boolean;
}
