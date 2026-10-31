// Soft write-lock: every permission request is answered by this pure policy.
// The agent's current pipeline/stage identity is the authorization boundary for writes.
import { isAbsolute, relative, resolve } from "node:path";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { MOCKUP_ROOT } from "../../shared/board";
import type { PeerKind } from "../../shared/project-prompts";
import { BUS_SERVER_NAME, type SlpRole } from "../../shared/roles";
import { PROTECTED_TASK_FILES, matchesAnyScope } from "../git/scope";

export interface PermissionContext {
  role: SlpRole;
  agentCwd: string;
  writableScope: readonly string[];
  pipelineId: string | null;
  stageId: string | null;
  // False means this agent belongs to an archived or no-longer-current stage.
  stageActive: boolean;
  archived: boolean;
  // Null for non-peers and for callers predating peer kinds; only "advisor" and "qa" restrict a live peer.
  peerKind?: PeerKind | null;
  // The Product Agent works outside any stage: it may write only the shared mockup source and commit it when the human asks.
  mockupAuthor?: boolean;
  // True when a Forked Lead is merging its completed pipeline branch and resolving conflicts.
  finalizingPipeline?: boolean;
  // Additional worktree paths (such as the pipeline worktree) writable by a finalizing Forked Lead.
  additionalWritableRoots?: readonly string[];
}

export type PermissionDecision =
  | { behavior: "allow" }
  | { behavior: "deny"; message: string };

// Matched by name prefix because each provider spells its edit tools differently (Claude Edit, Codex apply_patch, ...).
const FILE_WRITE_TOOLS = /^(edit|write|multiedit|notebookedit|apply_patch|str_replace|create|delete)/i;
const SHELL_TOOLS = /^(bash|shell|exec|run_command|local_shell)/i;
// Shell snippets that mutate state; only used for roles that must stay read-only.
// Deliberately heuristic: it gates read-only roles while the path boundary catches common shell omissions.
const MUTATING_SHELL = /(^|[;&|]\s*)(rm|mv|cp|touch|mkdir|tee|chmod|sed\s+-i|npm\s+(i|install)|git\s+(add|commit|checkout|reset|merge|rebase|stash|clean))\b|[^<>=]>{1,2}\s*[^&\s]/;
// Agents must not bypass the bus by driving the daemon directly.
// Zero-CLI-Send: all inter-agent traffic must go through the bus so it is audited and ordered, never via the daemon directly.
const DAEMON_BYPASS = /(^|[;&|`(]\s*|\$\(\s*)(\S*\/)?paseo(\s|$)|curl[^|;]*(127\.0\.0\.1|localhost):6767/;

function stringField(source: Record<string, unknown> | undefined, key: string): string | null {
  const fieldValue = source?.[key];
  return typeof fieldValue === "string" ? fieldValue : null;
}

export function extractWritePaths(request: AgentPermissionRequest): string[] {
  const requestInput = request.input as Record<string, unknown> | undefined;
  const detail = request.detail as { filePath?: string } | undefined;
  const collectedPaths: string[] = [];
  if (detail?.filePath) collectedPaths.push(detail.filePath);
  for (const key of ["file_path", "path", "notebook_path"]) {
    const keyedPath = stringField(requestInput, key);
    if (keyedPath) collectedPaths.push(keyedPath);
  }
  // Codex lists every touched file in one request, so all of them must be checked, not just the first.
  // Codex apply_patch lists every touched file under input.files
  const patchedFiles = requestInput?.files;
  if (Array.isArray(patchedFiles)) {
    for (const patchedFile of patchedFiles) {
      const patchedPath = stringField(patchedFile as Record<string, unknown>, "path");
      if (patchedPath) collectedPaths.push(patchedPath);
    }
  }
  return [...new Set(collectedPaths)];
}

export function extractShellCommand(request: AgentPermissionRequest): string | null {
  const requestInput = request.input as Record<string, unknown> | undefined;
  const commandField = requestInput?.command ?? requestInput?.cmd;
  if (typeof commandField === "string") return commandField;
  return Array.isArray(commandField) ? commandField.join(" ") : null;
}

// Advisors only discuss the plan and QA only grades, so neither may change the worktree they judge.
function isReadOnlyPeer(context: PermissionContext): boolean {
  return context.peerKind === "advisor" || context.peerKind === "qa";
}

function isMockupPath(relativePath: string): boolean {
  return relativePath === MOCKUP_ROOT || relativePath.startsWith(`${MOCKUP_ROOT}/`);
}

function roleMayWritePath(context: PermissionContext, relativePath: string): boolean {
  if (context.mockupAuthor) return !context.archived && isMockupPath(relativePath);
  // Runtime artifacts remain protected even when a peer has a whole-worktree grant.
  if ((PROTECTED_TASK_FILES as readonly string[]).includes(relativePath)) return false;
  if (context.archived || !context.stageActive) return false;
  switch (context.role) {
    case "master_lead":
      // The Lead owns its feature worktree and integration checkout.
      return true;
    case "supervisor":
      // Supervisor stays read-only; production edits stay with stage peers or Leads.
      return false;
    case "qa_lead":
      // The QA Lead verifies through the peers it spawns, so every fix on the QA branch has an accountable peer report.
      return false;
    case "peer": {
      if (!context.pipelineId || !context.stageId) return false;
      if (isReadOnlyPeer(context)) return false;
      // An empty scope is the explicit whole-worktree default for a live pipeline peer.
      return context.writableScope.length === 0 || matchesAnyScope(relativePath, context.writableScope);
    }
  }
}

function decideFileWrite(request: AgentPermissionRequest, context: PermissionContext): PermissionDecision {
  const allowedRoots = [context.agentCwd, ...(context.additionalWritableRoots ?? [])];
  for (const writePath of extractWritePaths(request)) {
    // Paths are resolved against the agent's cwd first so '../' tricks cannot reach an unauthorized directory.
    const absolutePath = isAbsolute(writePath) ? writePath : resolve(context.agentCwd, writePath);
    const matchingRelativePath = allowedRoots
      .map((rootPath) => relative(rootPath, absolutePath).replace(/\\/g, "/"))
      .find((candidateRelative) => !candidateRelative.startsWith("..") && !isAbsolute(candidateRelative));
    if (matchingRelativePath === undefined || !roleMayWritePath(context, matchingRelativePath)) {
      return {
        behavior: "deny",
        message: `Writing '${writePath}' is not allowed for ${context.role} in stage ${context.stageId ?? "n/a"}. Stay inside your writable scope or use slp_escalate.`,
      };
    }
  }
  return { behavior: "allow" };
}

// Allows a mockup author only `git add` of mockup paths plus commit, push and read commands, chained with `&&`.
function isMockupGitCommand(shellCommand: string): boolean {
  if (/[;|>`]|\$\(/.test(shellCommand)) return false;
  return shellCommand.split("&&").every((commandSegment) => {
    const [, gitSubcommand, gitArguments = ""] =
      /^\s*git\s+(add|commit|push|status|diff|log)\b(.*)$/s.exec(commandSegment) ?? [];
    if (gitSubcommand !== "add") return Boolean(gitSubcommand);
    // Staging is limited by path because the human's own unrelated edits must never land in a mockup commit.
    const stagedPaths = gitArguments.trim().split(/\s+/).filter(Boolean);
    return stagedPaths.length > 0
      && stagedPaths.every((stagedPath) => isMockupPath(stagedPath.replace(/^\.\//, "").replace(/\/$/, "")));
  });
}

function decideShell(request: AgentPermissionRequest, context: PermissionContext): PermissionDecision {
  const shellCommand = extractShellCommand(request);
  // A shell request without a readable command is allowed: denying unknown shapes would stall agents on harmless calls.
  if (shellCommand === null) return { behavior: "allow" };
  if (DAEMON_BYPASS.test(shellCommand)) {
    return { behavior: "deny", message: "Do not drive the Paseo daemon or CLI; use the slp_ bus tools." };
  }
  // The human may ask the Product Agent to commit and push the mockup; that exception covers nothing else it could run.
  if (context.mockupAuthor && isMockupGitCommand(shellCommand)) return { behavior: "allow" };
  // The pipeline merges locally and deletes temporary slp/* branches after merge; pushing from an agent is never allowed.
  if (/\bgit\b(?:\s+-\S+(?:\s+\S+)?)*\s+push\b/.test(shellCommand)) {
    return { behavior: "deny", message: "Pushing is not part of the pipeline." };
  }
  const peerMayMutate = context.role === "peer"
    && !isReadOnlyPeer(context)
    && context.stageActive
    && Boolean(context.pipelineId && context.stageId);
  const mayMutate = !context.archived && context.stageActive
    && (context.role === "master_lead" || peerMayMutate);
  if (!mayMutate && MUTATING_SHELL.test(shellCommand)) {
    return { behavior: "deny", message: `Command looks mutating but ${context.role} is read-only right now.` };
  }
  return { behavior: "allow" };
}

export function decidePermission(
  request: AgentPermissionRequest,
  context: PermissionContext,
): PermissionDecision {
  // Bus tools are always allowed: authorization for them happens at dispatch by role, not here.
  if (request.name.includes(BUS_SERVER_NAME)) return { behavior: "allow" };
  // No human is watching the agent's own chat, so interactive questions cannot be answered and would stall the turn.
  if (request.kind === "question") {
    return { behavior: "deny", message: "No human is available. Decide yourself or call slp_escalate." };
  }
  // Plan and mode switches are harmless here because every peer already runs in the policy-controlled default mode.
  if (request.kind === "plan" || request.kind === "mode") return { behavior: "allow" };
  const isFileWrite = FILE_WRITE_TOOLS.test(request.name) || request.detail?.type === "edit" || request.detail?.type === "write";
  if (isFileWrite) return decideFileWrite(request, context);
  if (SHELL_TOOLS.test(request.name) || request.detail?.type === "shell") return decideShell(request, context);
  // reads, searches, web fetches and unknown read-like tools are harmless to the pipeline
  return { behavior: "allow" };
}
