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
    expect(configuration.peers.map((peer) => peer.role).sort()).toEqual(["doc", "implementer", "qa", "security"]);
    expect(await readFile(join(repoPath, ".slp/LEAD.md"), "utf8")).toContain("# Workflow");
    expect(await readFile(join(repoPath, ".slp/SUPERVISOR.md"), "utf8")).toContain("role: Supervisor");
    // Business-role metadata must not prescribe a permanent pipeline kind.
    expect(await readFile(join(repoPath, ".slp/peers/QA.md"), "utf8")).not.toContain("kind:");
  });

  it("preserves a customized workflow across repeated initialization", async () => {
    const repoPath = await createDirectory("project-prompts");
    await loadProjectPrompts(repoPath);
    const qaPath = join(repoPath, ".slp/peers/QA.md");
    const customizedQa = "---\nrole: QA\ndescription: Test invoice rounding.\n---\nCheck fractional currency boundaries.";
    await writeFile(qaPath, customizedQa);
    const configuration = await loadProjectPrompts(repoPath);
    expect(configuration.peers.find((peer) => peer.role === "qa")?.workflow).toBe("Check fractional currency boundaries.");
    expect(await readFile(qaPath, "utf8")).toBe(customizedQa);
  });

  // Older versions left data in .slp; it must not prevent seeding user-editable configuration.
  it("initializes a legacy log directory without replacing its data", async () => {
    const repoPath = await createDirectory("project-prompts");
    await mkdir(join(repoPath, ".slp"));
    await writeFile(join(repoPath, ".slp/comm-log.jsonl"), "historic log");
    await writeFile(join(repoPath, ".slp/MASTER_SPEC.md"), "historic spec without YAML");
    expect((await loadProjectPrompts(repoPath)).peers).toHaveLength(4);
    expect(await readFile(join(repoPath, ".slp/comm-log.jsonl"), "utf8")).toBe("historic log");
  });

  it("does not expose a half-seeded catalog to concurrent callers", async () => {
    const repoPath = await createDirectory("project-prompts");
    const configurations = await Promise.all([loadProjectPrompts(repoPath), loadProjectPrompts(repoPath)]);
    expect(configurations[0]).toEqual(configurations[1]);
    expect(configurations[0].peers).toHaveLength(4);
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

  // Duplicate normalized IDs cannot silently select a workflow based on filesystem ordering.
  it("rejects duplicate roles and identifies both files", async () => {
    const repoPath = await createDirectory("project-prompts");
    await loadProjectPrompts(repoPath);
    await writeFile(join(repoPath, ".slp/peers/OTHER.md"), "---\nrole: qa\ndescription: Duplicate\n---\nReview.");
    await expect(loadProjectPrompts(repoPath)).rejects.toThrow(/duplicate role 'qa'.*\.slp\/peers/);
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
  it("injects peer metadata into the Lead and only the selected workflow into a peer", async () => {
    const repoPath = await createDirectory("project-prompts");
    const configuration = await loadProjectPrompts(repoPath);
    const qa = configuration.peers.find((peer) => peer.role === "qa")!;
    qa.frontMatter += "\nfeatures: [invoice-regression]";
    qa.workflow = "PRIVATE_QA_WORKFLOW: test invoice fractions.";
    configuration.lead.workflow = "CUSTOM_LEAD_WORKFLOW: prioritize acceptance risk.";
    const leadPrompt = systemPromptFor("master_lead", configuration);
    expect(leadPrompt).toContain("features: [invoice-regression]");
    expect(leadPrompt).toContain("CUSTOM_LEAD_WORKFLOW");
    expect(leadPrompt).not.toContain("PRIVATE_QA_WORKFLOW");
    // A selected business role is independent of whether this assignment grants tests or read-only review.
    expect(systemPromptFor("security", configuration, "qa")).toContain("PRIVATE_QA_WORKFLOW");
    expect(systemPromptFor("qa", configuration, "qa")).toContain("PRIVATE_QA_WORKFLOW");
    expect(systemPromptFor("implementer", configuration, "implementer")).not.toContain("PRIVATE_QA_WORKFLOW");
  });
});
