import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadProjectPrompts } from "../server/project-prompts/load";
import { parseRoleMarkdown } from "../server/project-prompts/markdown";
import { systemPromptFor } from "../server/prompts/system-prompts";
import { peerKindOf } from "../shared/project-prompts";
import { useTemporaryDirectories } from "./helpers/temp-directory";

const createDirectory = useTemporaryDirectories();

describe("project prompt initialization", () => {
  it("seeds the requested layout for an empty project", async () => {
    const repoPath = await createDirectory("project-prompts");
    const configuration = await loadProjectPrompts(repoPath);
    expect(configuration.peers.map((peer) => peer.role).sort()).toEqual([
      "architect",
      "developer",
      "qa-engineer",
      "reviewer",
      "security-reviewer",
    ]);
    expect(await readFile(join(repoPath, ".slp/LEAD.md"), "utf8")).toContain("# Workflow");
    expect(await readFile(join(repoPath, ".slp/SUPERVISOR.md"), "utf8")).toContain("role: supervisor");
    // Merged-build verification belongs to the QA Lead, so no separate UAT peer is seeded.
    await expect(readFile(join(repoPath, ".slp/peers/END_USER_UAT.md"), "utf8")).rejects.toThrow();
    // Peer files declare what the peer may do (kind), which decides its stage and write access.
    expect(await readFile(join(repoPath, ".slp/peers/QA_ENGINEER.md"), "utf8")).toContain("kind: qa");
  });

  it("preserves a customized workflow across repeated initialization", async () => {
    const repoPath = await createDirectory("project-prompts");
    await loadProjectPrompts(repoPath);
    const qaPath = join(repoPath, ".slp/peers/QA_ENGINEER.md");
    // Role IDs normalize literally without a hidden alias table, so 'QA Engineer' maps to 'qa-engineer'.
    const customizedQa = "---\nrole: QA Engineer\ndescription: Test invoice rounding.\n---\nCheck fractional currency boundaries.";
    await writeFile(qaPath, customizedQa);
    const configuration = await loadProjectPrompts(repoPath);
    expect(configuration.peers.find((peer) => peer.role === "qa-engineer")?.workflow).toBe("Check fractional currency boundaries.");
    expect(await readFile(qaPath, "utf8")).toBe(customizedQa);
  });

  // Older versions left data in .slp; it must not prevent seeding user-editable configuration.
  it("initializes a legacy log directory without replacing its data", async () => {
    const repoPath = await createDirectory("project-prompts");
    await mkdir(join(repoPath, ".slp"));
    await writeFile(join(repoPath, ".slp/comm-log.jsonl"), "historic log");
    await writeFile(join(repoPath, ".slp/MASTER_SPEC.md"), "historic spec without YAML");
    expect((await loadProjectPrompts(repoPath)).peers).toHaveLength(5);
    expect(await readFile(join(repoPath, ".slp/comm-log.jsonl"), "utf8")).toBe("historic log");
  });

  it("does not expose a half-seeded catalog to concurrent callers", async () => {
    const repoPath = await createDirectory("project-prompts");
    const configurations = await Promise.all([loadProjectPrompts(repoPath), loadProjectPrompts(repoPath)]);
    expect(configurations[0]).toEqual(configurations[1]);
    expect(configurations[0].peers).toHaveLength(5);
  });
});

describe("QA Lead root role", () => {
  it("adds QA_LEAD.md to a project created before it existed without touching existing roles", async () => {
    const repoPath = await createDirectory("project-prompts");
    await loadProjectPrompts(repoPath);
    const customLeadMarkdown = "---\nrole: master-lead\ndescription: Custom lead.\n---\nCustom lead workflow.";
    await writeFile(join(repoPath, ".slp/LEAD.md"), customLeadMarkdown);
    // Simulate an older project by removing the QA Lead file the first load created.
    await rm(join(repoPath, ".slp/QA_LEAD.md"));

    const configuration = await loadProjectPrompts(repoPath);
    // Every delegation spawns a QA Lead, so its root file must come back while user edits stay intact.
    expect(configuration.qaLead?.role).toBe("qa-lead");
    expect(await readFile(join(repoPath, ".slp/QA_LEAD.md"), "utf8")).toContain("ROLE: QA Lead");
    expect(await readFile(join(repoPath, ".slp/LEAD.md"), "utf8")).toBe(customLeadMarkdown);
    expect(systemPromptFor("qa_lead", configuration)).toContain("AVAILABLE PROJECT PEERS");
  });

  it("reserves the qa-lead ID for the root QA Lead file", async () => {
    const repoPath = await createDirectory("project-prompts");
    await loadProjectPrompts(repoPath);
    await writeFile(join(repoPath, ".slp/peers/QA_COPY.md"), "---\nrole: qa-lead\ndescription: Copied by mistake.\n---\nWorkflow.");
    await expect(loadProjectPrompts(repoPath)).rejects.toThrow("reserved for a root orchestration role");
  });
});

describe("Markdown role discovery", () => {
  it("loads nested Markdown by front matter rather than filename", async () => {
    const repoPath = await createDirectory("project-prompts");
    await loadProjectPrompts(repoPath);
    await mkdir(join(repoPath, ".slp/peers/domain"));
    await writeFile(join(repoPath, ".slp/peers/domain/anything.MD"),
      "---\nrole: Invoice Specialist\ndescription: |\n  Understand billing and tax rules.\nfeatures: [invoices, taxes]\n---\nCheck rounding before changing totals.");
    const role = (await loadProjectPrompts(repoPath)).peers.find((peer) => peer.role === "invoice-specialist");
    expect(role?.workflow).toBe("Check rounding before changing totals.");
    expect(role?.frontMatter).toContain("features: [invoices, taxes]");
  });

  // Ignore non-role subdirectories (such as .slp/architecture/) and non-role root files so project docs never fail YAML parsing.
  it("ignores Markdown files outside .slp/peers and the 3 default root role files", async () => {
    const repoPath = await createDirectory("project-prompts");
    await mkdir(join(repoPath, ".slp/architecture"), { recursive: true });
    await writeFile(join(repoPath, ".slp/architecture/ecs-dod.md"), "# ECS Data-Oriented Design\nNo YAML front matter here.");
    await writeFile(join(repoPath, ".slp/NOTES.md"), "# Project Notes\nAlso no YAML front matter.");

    // First load should still seed the default role files when only non-role docs exist in .slp.
    const configuration = await loadProjectPrompts(repoPath);
    expect(configuration.supervisor.role).toBe("supervisor");
    expect(configuration.lead.role).toBe("master-lead");
    expect(configuration.peers.map((peer) => peer.role).sort()).toEqual([
      "architect",
      "developer",
      "qa-engineer",
      "reviewer",
      "security-reviewer",
    ]);
    expect(await readFile(join(repoPath, ".slp/architecture/ecs-dod.md"), "utf8")).toContain("# ECS Data-Oriented Design");
  });

  // Duplicate normalized IDs cannot silently select a workflow based on filesystem ordering.
  it("rejects duplicate roles and identifies both files", async () => {
    const repoPath = await createDirectory("project-prompts");
    await loadProjectPrompts(repoPath);
    await writeFile(join(repoPath, ".slp/peers/OTHER.md"), "---\nrole: reviewer\ndescription: Duplicate\n---\nReview.");
    await expect(loadProjectPrompts(repoPath)).rejects.toThrow(/duplicate role 'reviewer'.*\.slp\/peers/);
  });

  it("infers a peer kind from the role id when the front matter has none, and rejects unknown kinds", () => {
    const parseKindOf = (frontMatter: string) =>
      peerKindOf(parseRoleMarkdown(`---\n${frontMatter}\ndescription: Example\n---\nWork.`, ".slp/peers/X.md"));
    expect(parseKindOf("role: code-reviewer")).toBe("advisor");
    expect(parseKindOf("role: unity-test-automation")).toBe("qa");
    expect(parseKindOf("role: gameplay-engineer")).toBe("developer");
    // An explicit kind always wins over the name heuristic.
    expect(parseKindOf("role: code-reviewer\nkind: developer")).toBe("developer");
    expect(() => parseRoleMarkdown("---\nrole: x\ndescription: d\nkind: writer\n---\nWork.", ".slp/peers/X.md")).toThrow(".slp/peers/X.md");
  });

  it.each([
    ["No YAML", "front matter"],
    ["---\nrole: QA\n---\nReview.", "description"],
    ["---\nrole: QA\nrole: QA\ndescription: Review\n---\nReview.", "unique"],
    ["---\nrole: QA\ndescription: Review\n---\n", "workflow"],
  ])("rejects invalid configuration with an actionable file path", (markdown, expectedReason) => {
    expect(() => parseRoleMarkdown(markdown, ".slp/peers/BROKEN.md")).toThrow(".slp/peers/BROKEN.md");
    expect(() => parseRoleMarkdown(markdown, ".slp/peers/BROKEN.md")).toThrow(new RegExp(expectedReason, "i"));
  });
});

describe("project system prompt composition", () => {
  it("includes full default workflows in seeded .slp files while letting custom .slp edits completely replace the workflow without hardcoded wrappers", async () => {
    const repoPath = await createDirectory("project-prompts");
    const configuration = await loadProjectPrompts(repoPath);
    const defaultDeveloperPrompt = systemPromptFor("peer", configuration, "developer");
    const defaultQaPrompt = systemPromptFor("peer", configuration, "qa-engineer");
    const defaultLeadPrompt = systemPromptFor("master_lead", configuration);

    // Seeded workflows carry the calm anti-over-engineering rules instead of capitalised mandates.
    expect(defaultDeveloperPrompt).toContain("Keep it simple: build only what the acceptance criteria and the locked brief require.");
    expect(defaultDeveloperPrompt).toContain("Build what the locked brief describes");
    expect(defaultDeveloperPrompt).toContain("Talk only to your Lead");
    expect(defaultQaPrompt).toContain("scorecard entry per criterion");
    expect(defaultQaPrompt).not.toContain("Build what the locked brief describes");
    expect(defaultDeveloperPrompt).not.toContain("scorecard entry per criterion");
    // Mockups are settled before a Run, so the seeded Lead workflow has only planning before implement.
    expect(defaultLeadPrompt).toContain("Pipeline shape (enforced): [planning]? -> implement.");
    // The Lead's catalog shows each peer's kind because it decides which stage the peer may join.
    expect(defaultLeadPrompt).toContain("(Architect, kind: advisor)");
    for (const seededPrompt of [defaultDeveloperPrompt, defaultQaPrompt, defaultLeadPrompt]) {
      expect(seededPrompt).not.toMatch(/MANDATORY|STRICT TECHNICAL METRICS/);
    }

    // Customizing .slp workflows replaces the prompt body cleanly without any hardcoded contract wrappers remaining.
    const qa = configuration.peers.find((peer) => peer.role === "qa-engineer")!;
    const developer = configuration.peers.find((peer) => peer.role === "developer")!;
    qa.frontMatter += "\nfeatures: [invoice-regression]";
    qa.workflow = "PRIVATE_QA_WORKFLOW: test invoice fractions.";
    developer.workflow = "CUSTOM_DEV_WORKFLOW: write minimal code.";
    configuration.lead.workflow = "CUSTOM_LEAD_WORKFLOW: prioritize acceptance risk.";

    const customLeadPrompt = systemPromptFor("master_lead", configuration);
    const customQaPrompt = systemPromptFor("peer", configuration, "qa-engineer");
    const customDeveloperPrompt = systemPromptFor("peer", configuration, "developer");

    expect(customLeadPrompt).toContain("features: [invoice-regression]");
    expect(customLeadPrompt).toContain("CUSTOM_LEAD_WORKFLOW");
    expect(customLeadPrompt).not.toContain("PRIVATE_QA_WORKFLOW");
    expect(customQaPrompt).toContain("PRIVATE_QA_WORKFLOW");
    expect(customQaPrompt).not.toContain("scorecard entry per criterion");
    expect(customDeveloperPrompt).toContain("CUSTOM_DEV_WORKFLOW");
    expect(customDeveloperPrompt).not.toContain("Build what the locked brief describes");
    expect(customDeveloperPrompt).not.toContain("ROLE CONTRACT:");
    expect(customDeveloperPrompt).not.toContain("RUNTIME CONTRACT PRIORITY:");
  });
});

describe("checkout policy in system prompts", () => {
  const worktreeFreeRun = { spawnWorktrees: false, repoPath: "/repo/app", baseBranch: "main" };

  it("states the main checkout before the project workflow when the run has worktrees off", () => {
    const leadPrompt = systemPromptFor("master_lead", null, undefined, undefined, worktreeFreeRun);

    expect(leadPrompt).toContain("CHECKOUT POLICY FOR THIS RUN: git worktrees are off.");
    expect(leadPrompt).toContain("main checkout at /repo/app on branch main");
    // Older .slp workflows can still ask for worktrees, so the override must be read before them.
    expect(leadPrompt.indexOf("CHECKOUT POLICY")).toBeLessThan(leadPrompt.indexOf("PROJECT WORKFLOW"));
  });

  it("leaves the prompt untouched when the run keeps worktrees on", () => {
    const worktreeRun = { ...worktreeFreeRun, spawnWorktrees: true };

    expect(systemPromptFor("master_lead", null, undefined, undefined, worktreeRun)).not.toContain("CHECKOUT POLICY");
  });

  it("adds the shared-checkout delegation rule to the Supervisor only when worktrees are off", () => {
    const supervisorPrompt = systemPromptFor("supervisor", null, undefined, undefined, worktreeFreeRun);

    // Features on one checkout can overlap without any merge step noticing, so the Supervisor's split carries the scope rule.
    expect(supervisorPrompt).toContain("SHARED CHECKOUT DELEGATION RULE");
    expect(supervisorPrompt.indexOf("SHARED CHECKOUT DELEGATION RULE")).toBeLessThan(supervisorPrompt.indexOf("PROJECT WORKFLOW"));
    // Leads and peers receive the checkout policy but not the Supervisor's delegation rule.
    expect(systemPromptFor("master_lead", null, undefined, undefined, worktreeFreeRun)).not.toContain("SHARED CHECKOUT DELEGATION RULE");
    expect(systemPromptFor("supervisor", null, undefined, undefined, { ...worktreeFreeRun, spawnWorktrees: true })).not.toContain("SHARED CHECKOUT DELEGATION RULE");
  });
});
