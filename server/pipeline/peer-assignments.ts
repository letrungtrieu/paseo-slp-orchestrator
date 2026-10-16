// Assignment capabilities belong to the task, allowing the Lead to use one business role in different ways.
import type { Run, TaskDefinition } from "../../shared/state";
import type { VerifierRole } from "../../shared/roles";
import { peerRole } from "../project-prompts/defaults";
import { ToolError } from "./tool-error";

export function reviewerCapability(task: TaskDefinition, projectRoleId: string): VerifierRole {
  // Preserve QA's historical test-writing default; every other role defaults to read-only unless the Lead grants tests.
  const permission = Object.hasOwn(task.reviewerPermissions, projectRoleId)
    ? task.reviewerPermissions[projectRoleId] : projectRoleId === "qa" ? "tests" : "read-only";
  return permission === "tests" ? "qa" : "security";
}

export function reviewerAgentKey(projectRoleId: string): string {
  // Preserve saved QA/Security participant keys while allowing any business role to review without colliding with primary agents.
  return ["qa", "security"].includes(projectRoleId) ? projectRoleId : `reviewer:${projectRoleId}`;
}

export function validatePeerAssignments(run: Run, tasks: TaskDefinition[]): void {
  for (const task of tasks) {
    const assignedRoles = [task.implementerRole, ...task.verifiers,
      ...(task.documentedBy === "implementer" ? [] : [task.documentedBy])];
    for (const roleId of assignedRoles) {
      try { peerRole(run.promptConfig, roleId); }
      catch (roleError) { throw new ToolError(`Task '${task.id}': ${roleError instanceof Error ? roleError.message : String(roleError)}`); }
    }
    // A reviewer owes exactly one verdict per round; duplicate IDs would otherwise make the quorum ambiguous.
    if (new Set(task.verifiers).size !== task.verifiers.length) throw new ToolError(`Task '${task.id}': duplicate reviewer role`);
    for (const roleId of Object.keys(task.reviewerPermissions)) {
      if (!task.verifiers.includes(roleId)) throw new ToolError(`Task '${task.id}': reviewerPermissions references unassigned role '${roleId}'`);
    }
  }
}
