import { describe, expect, it } from "vitest";
import { TaskDefinitionSchema } from "../shared/state";
import {
  ACCEPTANCE_DOC_SECTIONS,
  hashTaskSpec,
  missingAcceptanceSections,
  renderTaskSpec,
} from "../server/prompts/task-spec";

const taskDefinition = TaskDefinitionSchema.parse({
  id: "api-layer",
  title: "API layer",
  purpose: "Expose the billing endpoints",
  assumptions: ["The router lives in src/router.ts"],
  writableScope: ["src/api/", "src/types/"],
  forbidden: ["Do not rename exports"],
});

describe("renderTaskSpec", () => {
  const renderedSpec = renderTaskSpec(taskDefinition, "slp/abc/dev");

  // the Implementer reads these headings to find its boundaries
  it("contains every section the Implementer needs", () => {
    for (const heading of ["## Purpose", "## Lead assumptions about the current code", "## Writable scope", "## Forbidden", "## Git"]) {
      expect(renderedSpec).toContain(heading);
    }
    expect(renderedSpec).toContain("# TASK_SPEC: API layer (`api-layer`)");
  });

  // bullets are the format the Implementer parses when planning
  it("lists scope, assumptions and extra forbidden rules as bullets", () => {
    expect(renderedSpec).toContain("- src/api/");
    expect(renderedSpec).toContain("- src/types/");
    expect(renderedSpec).toContain("- The router lives in src/router.ts");
    expect(renderedSpec).toContain("- Do not rename exports");
  });

  it("always forbids editing TASK_SPEC.md and bypassing the bus", () => {
    expect(renderedSpec).toContain("- Editing TASK_SPEC.md");
    expect(renderedSpec).toContain("slp-bus");
  });

  it("names the integration branch the worktree was cut from", () => {
    expect(renderedSpec).toContain("`slp/abc/dev`");
  });

  it("prints (none) for an empty assumptions list", () => {
    const specWithoutAssumptions = renderTaskSpec({ ...taskDefinition, assumptions: [] }, "dev");
    expect(specWithoutAssumptions).toContain("- (none)");
  });

  // tamper detection compares hashes of re-rendered text, so rendering must be pure
  it("is deterministic so the stored hash can detect tampering", () => {
    expect(renderTaskSpec(taskDefinition, "slp/abc/dev")).toBe(renderedSpec);
  });
});

describe("hashTaskSpec", () => {
  // pins the algorithm; a different digest would invalidate stored hashes
  it("returns a stable sha256 hex digest", () => {
    // well known digest of the empty string
    expect(hashTaskSpec("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(hashTaskSpec("a")).toHaveLength(64);
  });

  it("changes when a single character changes", () => {
    const originalSpec = renderTaskSpec(taskDefinition, "dev");
    expect(hashTaskSpec(originalSpec)).not.toBe(hashTaskSpec(`${originalSpec} `));
  });
});

describe("missingAcceptanceSections", () => {
  const completeDoc = ACCEPTANCE_DOC_SECTIONS.map((section) => `## ${section}\ntext`).join("\n\n");

  it("returns nothing for a complete document", () => {
    expect(missingAcceptanceSections(completeDoc)).toEqual([]);
  });

  it("lists every required section for an empty document", () => {
    expect(missingAcceptanceSections("")).toEqual([...ACCEPTANCE_DOC_SECTIONS]);
  });

  it("reports only the absent sections", () => {
    const partialDoc = "## Summary\nx\n## Changed files\ny";
    expect(missingAcceptanceSections(partialDoc)).toEqual(["Technical decisions", "QA results", "Security review"]);
  });

  // agents vary heading capitalisation; the contract is the section name
  it("matches headings case-insensitively and at any level up to 4", () => {
    const looseDoc = ["# summary", "### CHANGED FILES", "#### technical decisions", "## Qa Results", "## Security Review (clean)"].join("\n");
    expect(missingAcceptanceSections(looseDoc)).toEqual([]);
  });

  // stops a doc that merely lists the names from passing validation
  it("does not count section names that appear only in body text", () => {
    // the pipeline requires real headings, not a mention of them
    expect(missingAcceptanceSections("Summary of changed files, QA results, technical decisions, security review")).toHaveLength(5);
  });

  // keeps the accepted heading levels explicit
  it("does not count a deeper heading than level 4", () => {
    expect(missingAcceptanceSections("##### Summary")).toContain("Summary");
  });
});
