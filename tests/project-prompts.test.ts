import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadProjectPrompts } from "../server/project-prompts/load";
import { parseRoleMarkdown } from "../server/project-prompts/markdown";
import { systemPromptFor } from "../server/prompts/system-prompts";
import { useTemporaryDirectories } from "./helpers/temp-directory";

const createDirectory = useTemporaryDirectories();

describe("project prompt initialization", () => {
  it("seeds the requested layout for an empty project", async () => {
    const repoPath = await createDirectory("project-prompts");
    const configuration = await loadProjectPrompts(repoPath);
    expect(configuration.peers.map((peer) => peer.role).sort()).toEqual([
      "developer",
      "end-user",
      "qa-engineer",
      "reviewer",
      "security-reviewer",
    ]);
    expect(await readFile(join(repoPath, ".slp/LEAD.md"), "utf8")).toContain("# Workflow");
    expect(await readFile(join(repoPath, ".slp/SUPERVISOR.md"), "utf8")).toContain("role: supervisor");
    expect(await readFile(join(repoPath, ".slp/peers/END_USER_UAT.md"), "utf8")).toContain("role: end-user");
    // Business-role metadata must not prescribe a permanent pipeline kind.
    expect(await readFile(join(repoPath, ".slp/peers/QA_ENGINEER.md"), "utf8")).not.toContain("kind:");
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
      "developer",
      "end-user",
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

    // Seeded .slp files contain the default metrics, methodology, anti-bloat, and QA screenshot rules out of the box.
    expect(defaultDeveloperPrompt).toContain("STRICT TECHNICAL METRICS & INPUT/LOGIC/OUTPUT RULE");
    expect(defaultDeveloperPrompt).toContain("CROSS-STAGE PEER LIFECYCLE");
    expect(defaultDeveloperPrompt).toContain("MANDATORY DEVELOPER METHODOLOGY, STEP-BY-STEP METRICS & TRADE-OFF ARGUMENT CONTRACT");
    expect(defaultDeveloperPrompt).toContain("I used technique A to solve problem B");
    expect(defaultDeveloperPrompt).toContain("I did not use technique F because G");
    expect(defaultQaPrompt).toContain("MANDATORY QA VERIFICATION & VISUAL EVIDENCE CONTRACT");
    expect(defaultQaPrompt).toContain("screenshot evidence");
    expect(defaultQaPrompt).not.toContain("MANDATORY DEVELOPER METHODOLOGY, STEP-BY-STEP METRICS & TRADE-OFF ARGUMENT CONTRACT");
    expect(defaultDeveloperPrompt).not.toContain("MANDATORY QA VERIFICATION & VISUAL EVIDENCE CONTRACT");
    expect(defaultLeadPrompt).toContain("system garbage/bloat");

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
    expect(customQaPrompt).not.toContain("MANDATORY QA VERIFICATION & VISUAL EVIDENCE CONTRACT");
    expect(customDeveloperPrompt).toContain("CUSTOM_DEV_WORKFLOW");
    expect(customDeveloperPrompt).not.toContain("MANDATORY DEVELOPER METHODOLOGY, STEP-BY-STEP METRICS & TRADE-OFF ARGUMENT CONTRACT");
    expect(customDeveloperPrompt).not.toContain("ROLE CONTRACT:");
    expect(customDeveloperPrompt).not.toContain("RUNTIME CONTRACT PRIORITY:");
  });
});

