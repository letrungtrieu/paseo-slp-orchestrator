// Soft write-lock (spec section 4, rule 4): every permission request of an SLP agent is answered
// by this pure policy. The scope gate (git diff) is the second line of defence for anything
// that slips through, e.g. writes made by a shell command.
import { isAbsolute, relative, resolve } from "node:path";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { BUS_SERVER_NAME, type SlpRole } from "../../shared/roles";
import type { TaskPhase } from "../../shared/state";
import { PROTECTED_TASK_FILES, QA_WRITABLE_SCOPE, matchesAnyScope } from "../git/scope";

export interface PermissionContext {
  role: SlpRole;
  taskPhase: TaskPhase | null;
  agentCwd: string;
  writableScope: readonly string[];
}

export type PermissionDecision =
  | { behavior: "allow" }
  | { behavior: "deny"; message: string };

// Matched by name prefix because each provider spells its edit tools differently (Claude Edit, Codex apply_patch, ...).
const FILE_WRITE_TOOLS = /^(edit|write|multiedit|notebookedit|apply_patch|str_replace|create|delete)/i;
const SHELL_TOOLS = /^(bash|shell|exec|run_command|local_shell)/i;
// Shell snippets that mutate state; only used for roles that must stay read-only.
// Deliberately heuristic: it only gates read-only roles, and the scope gate on the git diff catches whatever a regex misses.
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

function roleMayWritePath(context: PermissionContext, relativePath: string): boolean {
  // Even a Lead uses tools for pipeline documents; these filenames belong to the retired storage layout.
  if ((PROTECTED_TASK_FILES as readonly string[]).includes(relativePath)) return false;
  switch (context.role) {
    case "master_lead":
      // the Master Lead owns its whole checkout (integration branch)
      return true;
    case "implementer": {
      // Only the two coding phases open the task's writable scope; in the handshake the Implementer is read-only on purpose.
      const writablePhase = context.taskPhase === "implementing" || context.taskPhase === "fixing";
      if (writablePhase) return matchesAnyScope(relativePath, context.writableScope);
      // Documentation is now a report submission, so it grants no extra filesystem write access.
      return false;
    }
    case "peer":
      // Extra domain peers follow the same coding gate, with an empty scope for read-only assignments.
      return (context.taskPhase === "implementing" || context.taskPhase === "fixing") && matchesAnyScope(relativePath, context.writableScope);
    // QA may add tests only inside the test scope and only while verifying, so it cannot patch the code it is judging.
    case "qa":
      return context.taskPhase === "verifying" && matchesAnyScope(relativePath, QA_WRITABLE_SCOPE);
    case "doc":
      return false;
    default:
      return false;
  }
}

function decideFileWrite(request: AgentPermissionRequest, context: PermissionContext): PermissionDecision {
  for (const writePath of extractWritePaths(request)) {
    // Paths are resolved against the agent's cwd first so '../' tricks cannot reach another worktree.
    const absolutePath = isAbsolute(writePath) ? writePath : resolve(context.agentCwd, writePath);
    const relativePath = relative(context.agentCwd, absolutePath).replace(/\\/g, "/");
    const escapesWorktree = relativePath.startsWith("..") || isAbsolute(relativePath);
    if (escapesWorktree || !roleMayWritePath(context, relativePath)) {
      return {
        behavior: "deny",
        message: `Writing '${writePath}' is not allowed for ${context.role} in phase ${context.taskPhase ?? "n/a"}. Stay inside your writable scope or use slp_escalate.`,
      };
    }
  }
  return { behavior: "allow" };
}

function decideShell(request: AgentPermissionRequest, context: PermissionContext): PermissionDecision {
  const shellCommand = extractShellCommand(request);
  // A shell request without a readable command is allowed: denying unknown shapes would stall agents on harmless calls.
  if (shellCommand === null) return { behavior: "allow" };
  if (DAEMON_BYPASS.test(shellCommand)) {
    return { behavior: "deny", message: "Do not drive the Paseo daemon or CLI; use the slp_ bus tools." };
  }
  // The pipeline merges locally; a push would publish unreviewed work outside the human gate.
  if (/\bgit\s+push\b/.test(shellCommand)) {
    return { behavior: "deny", message: "Pushing is not part of the pipeline." };
  }
  const mayMutate = context.role === "master_lead" || context.role === "qa" || (
    (context.role === "implementer" || (context.role === "peer" && context.writableScope.length > 0)) && (context.taskPhase === "implementing" || context.taskPhase === "fixing")
  );
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
