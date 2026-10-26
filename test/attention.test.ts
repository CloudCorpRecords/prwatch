/**
 * Tests for the prwatch attention engine. Fixtures are modeled on real PRs
 * (shadcn-labs/pdfcn #92, #93, #94 on 2026-10-13) and one synthetic case each
 * for approved, changes requested, stale, and conflicted. No network access.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  scorePR,
  rankEntries,
  isExternalBlocker,
  isMaintainerGated,
  isRealFailure,
} from "../src/attention.js";
import type { PRSnapshot } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): PRSnapshot =>
  JSON.parse(readFileSync(join(here, "fixtures", name), "utf8")) as PRSnapshot;

const NOW = new Date("2026-10-13T22:00:00Z");

describe("attention engine categories", () => {
  it("fixture a: CodeRabbit threads plus external Vercel failure is ACTION", () => {
    const r = scorePR(fixture("a-coderabbit-threads.json"), NOW);
    assert.equal(r.category, "ACTION");
  });

  it("fixture a: the four threads drive the score above 70", () => {
    const r = scorePR(fixture("a-coderabbit-threads.json"), NOW);
    assert.ok(r.score > 70, `expected > 70, got ${r.score}`);
    assert.ok(r.reasons.some((x) => x.includes("4 unresolved review threads")));
  });

  it("fixture a: Vercel authorization failure is not counted as a failing check", () => {
    const r = scorePR(fixture("a-coderabbit-threads.json"), NOW);
    assert.ok(!r.reasons.some((x) => x.includes("Failing check: Vercel")));
    assert.ok(isExternalBlocker({ name: "Vercel", status: "completed", conclusion: "failure", description: "Authorization required to deploy" }));
  });

  it("fixture b: approved and green is READY with a low score", () => {
    const r = scorePR(fixture("b-approved-green.json"), NOW);
    assert.equal(r.category, "READY");
    assert.ok(r.score < 50, `expected < 50, got ${r.score}`);
    assert.ok(r.reasons.some((x) => x.includes("ready to merge")));
  });

  it("fixture c: changes requested plus a real failing build is ACTION with a top score", () => {
    const r = scorePR(fixture("c-changes-requested.json"), NOW);
    assert.equal(r.category, "ACTION");
    assert.ok(r.score >= 90, `expected >= 90, got ${r.score}`);
    assert.ok(r.reasons.some((x) => x.includes("Changes requested")));
    assert.ok(r.reasons.some((x) => x.includes("Failing check: build")));
  });

  it("fixture d: 12 days of silence with no approval is STALE", () => {
    const r = scorePR(fixture("d-stale-silent.json"), NOW);
    assert.equal(r.category, "STALE");
    assert.ok(r.reasons.some((x) => x.includes("12 days")));
  });

  it("fixture e: a dirty mergeable state is ACTION", () => {
    const r = scorePR(fixture("e-conflicted.json"), NOW);
    assert.equal(r.category, "ACTION");
    assert.ok(r.reasons.some((x) => x.includes("Merge conflicts")));
  });

  it("merged PRs score zero", () => {
    const s = fixture("b-approved-green.json");
    const r = scorePR({ ...s, merged: true }, NOW);
    assert.equal(r.score, 0);
  });

  it("a PR with only an external blocker is BLOCKED_EXTERNAL, not ACTION", () => {
    const s = fixture("a-coderabbit-threads.json");
    const onlyExternal = {
      ...s,
      threads: [],
      reviewState: "COMMENTED" as const,
      checkRuns: [
        { name: "Vercel", status: "completed", conclusion: "failure", description: "Authorization required to deploy" },
        { name: "typecheck", status: "completed", conclusion: "success", description: null },
      ],
    };
    const r = scorePR(onlyExternal, NOW);
    assert.equal(r.category, "BLOCKED_EXTERNAL");
    assert.ok(r.score <= 25, `expected <= 25, got ${r.score}`);
    assert.ok(r.reasons.some((x) => x.includes("External blocker")));
  });

  it("stale boundary: 6 days of silence is not STALE, 7 days is", () => {
    const s = fixture("d-stale-silent.json");
    const six = scorePR({ ...s, daysSinceActivity: 6, updatedAt: "2026-10-07T22:00:00Z" }, NOW);
    assert.notEqual(six.category, "STALE");
    const seven = scorePR({ ...s, daysSinceActivity: 7, updatedAt: "2026-10-06T22:00:00Z" }, NOW);
    assert.equal(seven.category, "STALE");
  });

  it("scores stay within 0 to 100 even when every signal fires", () => {
    const s = fixture("a-coderabbit-threads.json");
    const everything = {
      ...s,
      reviewState: "CHANGES_REQUESTED" as const,
      reviewAuthors: ["a", "b"],
      mergeableState: "dirty",
      checkRuns: [
        ...s.checkRuns,
        { name: "lint", status: "completed", conclusion: "failure", description: null },
        { name: "dco", status: "completed", conclusion: "failure", description: null },
        { name: "tests", status: "completed", conclusion: "failure", description: null },
        { name: "extra", status: "completed", conclusion: "failure", description: null },
      ],
    };
    const r = scorePR(everything, NOW);
    assert.ok(r.score >= 0 && r.score <= 100);
    assert.equal(r.category, "ACTION");
  });

  it("ranking puts the highest score first", () => {
    const a = { attention: scorePR(fixture("a-coderabbit-threads.json"), NOW), pr: { owner: "o", repo: "r", number: 1, title: "t", url: "u" } };
    const b = { attention: scorePR(fixture("b-approved-green.json"), NOW), pr: { owner: "o", repo: "r", number: 2, title: "t", url: "u" } };
    const ranked = rankEntries([b, a]);
    assert.equal(ranked[0].pr.number, 1);
  });

  it("incomplete entries are segregated after every scored entry (PT-6)", () => {
    const scored = {
      attention: { score: 0, reasons: ["No reviews yet. Waiting on reviewers."], category: "WAITING" as const },
      pr: { owner: "o", repo: "r", number: 1, title: "t", url: "u" },
    };
    const incomplete = {
      attention: { score: 0, reasons: ["GitHub rate limit hit. Set GITHUB_TOKEN for 5000 req/hr."], category: "WAITING" as const },
      pr: { owner: "o", repo: "r", number: 2, title: "t", url: "u" },
      incomplete: true,
    };
    const ranked = rankEntries([incomplete, scored]);
    assert.equal(ranked[0].pr.number, 1, "a genuinely scored 0 must outrank an unexamined PR");
    assert.equal(ranked[1].pr.number, 2);
    assert.equal(ranked[1].incomplete, true);
  });
});

describe("fork PRs with action_required suites", () => {
  it("fixture f: every suite gated is BLOCKED_EXTERNAL, never ACTION", () => {
    const r = scorePR(fixture("f-fork-action-required.json"), NOW);
    assert.equal(r.category, "BLOCKED_EXTERNAL");
    assert.ok(r.score <= 25, `expected <= 25, got ${r.score}`);
    assert.ok(r.reasons.some((x) => x.includes("approve the workflow run")));
    assert.ok(!r.reasons.some((x) => x.includes("Failing check")), "a gated run must not be reported as a failing check");
  });

  it("an action_required run is maintainer gated and never a real failure, whatever its name or description", () => {
    const run = { name: "build", status: "completed", conclusion: "action_required", description: null };
    assert.ok(isMaintainerGated(run));
    assert.ok(!isRealFailure(run));
    const scary = { name: "tests", status: "completed", conclusion: "action_required", description: "TypeScript errors everywhere" };
    assert.ok(!isRealFailure(scary), "a run that never ran carries no failure evidence");
  });

  it("a gated suite next to a real failure stays ACTION, and the gated suite adds no failure score", () => {
    const s = fixture("f-fork-action-required.json");
    const mixed = {
      ...s,
      checkRuns: [
        ...s.checkRuns,
        { name: "lint", status: "completed", conclusion: "failure", description: null },
      ],
    };
    const r = scorePR(mixed, NOW);
    assert.equal(r.category, "ACTION");
    // Base 50 plus exactly one real failure at +12; the two gated runs add nothing.
    assert.equal(r.score, 62, `expected 62, got ${r.score} (${r.reasons.join(" | ")})`);
    assert.ok(r.reasons.some((x) => x.includes("Failing check: lint")));
    assert.ok(!r.reasons.some((x) => x.includes("Failing check: build")));
    assert.ok(r.reasons.some((x) => x.includes("approve the workflow run")));
  });

  it("an approved, mergeable PR whose suites are gated is not READY", () => {
    const s = fixture("f-fork-action-required.json");
    const r = scorePR({ ...s, reviewState: "APPROVED" as const, reviewAuthors: ["maintainer-jane"] }, NOW);
    assert.equal(r.category, "BLOCKED_EXTERNAL");
  });

  it("ranking: a gated fork PR ranks below a PR that needs the author", () => {
    const gated = { attention: scorePR(fixture("f-fork-action-required.json"), NOW), pr: { owner: "o", repo: "r", number: 1, title: "t", url: "u" } };
    const action = { attention: scorePR(fixture("c-changes-requested.json"), NOW), pr: { owner: "o", repo: "r", number: 2, title: "t", url: "u" } };
    const ranked = rankEntries([gated, action]);
    assert.equal(ranked[0].pr.number, 2);
    assert.equal(ranked[1].pr.number, 1);
  });
});

describe("external blocker classification", () => {
  it("matches the Vercel authorization pattern", () => {
    assert.ok(isExternalBlocker({ name: "Vercel", status: "completed", conclusion: "failure", description: "Authorization required to deploy" }));
  });

  it("matches sign in to deploy phrasing", () => {
    assert.ok(isExternalBlocker({ name: "Preview", status: "completed", conclusion: "action_required", description: "Sign in to deploy this preview" }));
  });

  it("does not classify a real build failure as external", () => {
    assert.ok(!isExternalBlocker({ name: "build", status: "completed", conclusion: "failure", description: "TypeScript errors in cover-letter.tsx" }));
    assert.ok(isRealFailure({ name: "build", status: "completed", conclusion: "failure", description: "TypeScript errors" }));
  });

  it("does not classify successful checks", () => {
    assert.ok(!isExternalBlocker({ name: "Vercel", status: "completed", conclusion: "success", description: "Authorization required to deploy" }));
    assert.ok(!isRealFailure({ name: "typecheck", status: "completed", conclusion: "success", description: null }));
  });
});
