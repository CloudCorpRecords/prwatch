/**
 * Tests for URL parsing and comment actionability heuristics. No network.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parsePullUrl,
  parseRepoSlug,
  isActionableComment,
  filterOpenPRsByAuthor,
  isAuthorSearchRestricted,
  AuthorSearchRestrictedError,
} from "../src/github.js";

describe("parsePullUrl", () => {
  it("parses a plain PR URL", () => {
    assert.deepEqual(parsePullUrl("https://github.com/shadcn-labs/pdfcn/pull/92"), {
      owner: "shadcn-labs",
      repo: "pdfcn",
      number: 92,
    });
  });

  it("tolerates a trailing slash", () => {
    assert.deepEqual(parsePullUrl("https://github.com/shadcn-labs/pdfcn/pull/93/"), {
      owner: "shadcn-labs",
      repo: "pdfcn",
      number: 93,
    });
  });

  it("rejects non PR URLs", () => {
    assert.throws(() => parsePullUrl("https://github.com/shadcn-labs/pdfcn/issues/60"), /pull request URL/);
    assert.throws(() => parsePullUrl("not a url"), /pull request URL/);
  });
});

describe("parseRepoSlug", () => {
  it("parses owner/repo", () => {
    assert.deepEqual(parseRepoSlug("shadcn-labs/pdfcn"), { owner: "shadcn-labs", repo: "pdfcn" });
  });

  it("rejects malformed slugs", () => {
    assert.throws(() => parseRepoSlug("pdfcn"), /owner\/repo/);
    assert.throws(() => parseRepoSlug("a/b/c"), /owner\/repo/);
  });
});

describe("isActionableComment", () => {
  it("treats code suggestions as actionable", () => {
    assert.ok(isActionableComment("Looks good otherwise.", "```suggestion\nconst x = 1;\n```"));
  });

  it("treats direct asks as actionable", () => {
    assert.ok(isActionableComment("Please update the import path before merging.", ""));
  });

  it("treats praise as non actionable", () => {
    assert.ok(!isActionableComment("Nice work, this is clean.", ""));
  });
});

describe("filterOpenPRsByAuthor", () => {
  const pulls = [
    { number: 92, title: "feat: business letter", html_url: "https://github.com/o/r/pull/92", user: { login: "CloudCorpRecords" } },
    { number: 93, title: "feat: resume", html_url: "https://github.com/o/r/pull/93", user: { login: "cloudcorprecords" } },
    { number: 94, title: "other author's pr", html_url: "https://github.com/o/r/pull/94", user: { login: "someone-else" } },
  ];

  it("keeps only PRs opened by the user, case-insensitively", () => {
    const out = filterOpenPRsByAuthor(pulls, "CloudCorpRecords");
    assert.deepEqual(out.map((p) => p.number), [92, 93]);
  });

  it("returns an empty list when the user has no open PRs", () => {
    assert.deepEqual(filterOpenPRsByAuthor(pulls, "nobody-here"), []);
  });
});

describe("isAuthorSearchRestricted", () => {
  const github422 =
    "The listed users cannot be searched either because the users do not exist or you do not have permission to view the users.";

  it("maps the unauthenticated author search 422", () => {
    assert.ok(isAuthorSearchRestricted(422, github422));
  });

  it("ignores 422s that are not the search restriction", () => {
    assert.ok(!isAuthorSearchRestricted(422, "Validation Failed"));
  });

  it("ignores non 422 statuses", () => {
    assert.ok(!isAuthorSearchRestricted(200, github422));
  });

  it("AuthorSearchRestrictedError carries actionable guidance", () => {
    const err = new AuthorSearchRestrictedError();
    assert.match(err.message, /GITHUB_TOKEN/);
    assert.match(err.message, /--repo/);
  });
});
