import { describe, expect, it } from "vitest";
import { checkScope, findScopeOverlaps, matchesAnyScope, normalizeRelativePath } from "../server/git/scope";

describe("normalizeRelativePath", () => {
  it("strips a leading ./ and trailing slashes and converts backslashes", () => {
    // users type scopes in several spellings; git always prints forward slashes
    expect(normalizeRelativePath("./src/")).toBe("src");
    expect(normalizeRelativePath("src\\app\\")).toBe("src/app");
  });
});

describe("matchesAnyScope", () => {
  it("treats a bare directory (with or without trailing slash) as everything below it", () => {
    expect(matchesAnyScope("src/a.ts", ["src/"])).toBe(true);
    expect(matchesAnyScope("src/deep/er/a.ts", ["src"])).toBe(true);
    // the directory entry itself is also inside its own scope
    expect(matchesAnyScope("src", ["src/"])).toBe(true);
  });

  it("does not let a directory prefix leak into a sibling with a longer name", () => {
    // "src" must not authorise "srcx/..." or "src-old/..."
    expect(matchesAnyScope("srcx/a.ts", ["src/"])).toBe(false);
    expect(matchesAnyScope("src-old/a.ts", ["src"])).toBe(false);
  });

  // '**' is how Master Leads express whole subtrees such as src/**
  it("supports ** as any depth, including zero directories", () => {
    expect(matchesAnyScope("src/a.ts", ["src/**"])).toBe(true);
    expect(matchesAnyScope("src/x/y/z.ts", ["src/**"])).toBe(true);
    expect(matchesAnyScope("other/a.ts", ["src/**"])).toBe(false);
    // "**/" must collapse so a root level file still matches
    expect(matchesAnyScope("a.test.ts", ["**/*.test.*"])).toBe(true);
  });

  it("matches **/*.test.* at any depth but not non-test files", () => {
    expect(matchesAnyScope("src/deep/a.test.ts", ["**/*.test.*"])).toBe(true);
    expect(matchesAnyScope("src/deep/a.spec.ts", ["**/*.test.*"])).toBe(false);
    expect(matchesAnyScope("src/a.ts", ["**/*.test.*"])).toBe(false);
  });

  // a segment wildcard that crossed '/' would silently widen the writable scope
  it("keeps a single * inside one path segment", () => {
    expect(matchesAnyScope("src/a.ts", ["src/*.ts"])).toBe(true);
    // crossing a slash needs **, otherwise the scope could be widened by accident
    expect(matchesAnyScope("src/sub/a.ts", ["src/*.ts"])).toBe(false);
    expect(matchesAnyScope("src/ab.ts", ["src/a?.ts"])).toBe(true);
    expect(matchesAnyScope("src/a/b.ts", ["src/a?b.ts"])).toBe(false);
  });

  it("escapes regex metacharacters in literal parts of the glob", () => {
    // the dot must be literal: "a.ts" must not authorise "aXts"
    expect(matchesAnyScope("aXts", ["a.ts"])).toBe(false);
    expect(matchesAnyScope("a.ts", ["a.ts"])).toBe(true);
    expect(matchesAnyScope("src/(x)/a.ts", ["src/(x)/"])).toBe(true);
  });

  it("normalises the candidate path as well as the scope", () => {
    expect(matchesAnyScope("./src/a.ts", ["src/"])).toBe(true);
    expect(matchesAnyScope("src\\a.ts", ["src/"])).toBe(true);
  });

  // no scope means nothing is writable, never everything
  it("returns false for an empty scope list", () => {
    expect(matchesAnyScope("src/a.ts", [])).toBe(false);
  });
});

describe("checkScope", () => {
  it("reports files outside the writable scope", () => {
    const scopeOutcome = checkScope({
      changedFiles: ["src/a.ts", "docs/readme.md"],
      writableScope: ["src/"],
    });
    expect(scopeOutcome.outOfScopeFiles).toEqual(["docs/readme.md"]);
    expect(scopeOutcome.protectedFileTouched).toEqual([]);
  });

  // the pipeline restores this file itself, so it must not be reported as a scope violation
  it("reports TASK_SPEC.md separately and never as plain out-of-scope", () => {
    const scopeOutcome = checkScope({ changedFiles: ["TASK_SPEC.md"], writableScope: ["src/"] });
    expect(scopeOutcome.protectedFileTouched).toEqual(["TASK_SPEC.md"]);
    expect(scopeOutcome.outOfScopeFiles).toEqual([]);
  });

  // protection beats a catch-all scope like '**'
  it("protects TASK_SPEC.md even when the writable scope would otherwise allow it", () => {
    const scopeOutcome = checkScope({ changedFiles: ["TASK_SPEC.md"], writableScope: ["**"] });
    expect(scopeOutcome.protectedFileTouched).toEqual(["TASK_SPEC.md"]);
  });

  // SQLite replaced these outputs, so a broad scope must not reintroduce the retired document layout.
  it("rejects obsolete report and log files under .slp/", () => {
    const scopeOutcome = checkScope({
      changedFiles: [".slp/ACCEPTANCE_DOC.md", ".slp/comm-log.jsonl"],
      writableScope: ["src/"],
    });
    expect(scopeOutcome).toEqual({ outOfScopeFiles: [], protectedFileTouched: [".slp/ACCEPTANCE_DOC.md", ".slp/comm-log.jsonl"] });
  });

  // Supplemental path grants let a stage peer modify test directories alongside the primary scope.
  it("allows extra globs such as supplemental test directories", () => {
    const scopeOutcome = checkScope({
      changedFiles: ["src/a.ts", "tests/a.test.ts", "lib/x.ts"],
      writableScope: ["src/"],
      additionalAllowedScope: ["tests/**"],
    });
    expect(scopeOutcome.outOfScopeFiles).toEqual(["lib/x.ts"]);
  });

  it("normalises reported file names", () => {
    const scopeOutcome = checkScope({ changedFiles: ["./docs/a.md"], writableScope: ["src/"] });
    expect(scopeOutcome.outOfScopeFiles).toEqual(["docs/a.md"]);
  });
});

describe("findScopeOverlaps", () => {
  const overlapBetween = (firstScope: string[], secondScope: string[]) =>
    findScopeOverlaps([
      { id: "task-a", writableScope: firstScope },
      { id: "task-b", writableScope: secondScope },
    ]);

  // spec phase 1, step 3: work packages must not overlap in files
  it("accepts disjoint directories", () => {
    expect(overlapBetween(["src/api/"], ["src/ui/"])).toEqual([]);
  });

  it("detects a nested directory", () => {
    expect(overlapBetween(["src/a"], ["src/a/b"])).toEqual(["task-a overlaps task-b"]);
  });

  it("does not confuse directories that merely share a name prefix", () => {
    // "src/a" and "src/ab" are different directories
    expect(overlapBetween(["src/a"], ["src/ab"])).toEqual([]);
  });

  // globs are compared by literal prefix, which is conservative but needs no glob solver
  it("detects a glob that covers the other scope", () => {
    expect(overlapBetween(["src/**"], ["src/x/"])).toHaveLength(1);
    expect(overlapBetween(["src/*.ts"], ["src/a.ts"])).toHaveLength(1);
  });

  it("is conservative for globs without a literal prefix", () => {
    // "**/*.test.*" can match anywhere, so it is flagged against every other scope
    expect(overlapBetween(["**/*.test.*"], ["src/"])).toHaveLength(1);
  });

  // each unordered pair is reported once so the Lead gets a readable list
  it("reports every colliding pair once", () => {
    const overlapDescriptions = findScopeOverlaps([
      { id: "a", writableScope: ["src/"] },
      { id: "b", writableScope: ["src/x/"] },
      { id: "c", writableScope: ["docs/"] },
    ]);
    expect(overlapDescriptions).toEqual(["a overlaps b"]);
  });

  // a lone task has nothing to collide with
  it("returns nothing for a single task", () => {
    expect(findScopeOverlaps([{ id: "only", writableScope: ["src/"] }])).toEqual([]);
  });
});
