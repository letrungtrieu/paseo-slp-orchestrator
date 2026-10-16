import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";

// Only the fields decidePermission reads are modelled; the cast keeps tests free of
// provider-specific protocol fields that are irrelevant to the policy.
export function permissionRequest(overrides: {
  name: string;
  kind?: string;
  input?: Record<string, unknown>;
  detail?: Record<string, unknown>;
}): AgentPermissionRequest {
  // A random id per request because the permission handler de-duplicates by request id.
  return {
    id: `req-${Math.random().toString(36).slice(2, 10)}`,
    provider: "claude",
    kind: "tool",
    ...overrides,
  } as unknown as AgentPermissionRequest;
}

export function fileWriteRequest(filePath: string, toolName = "Edit"): AgentPermissionRequest {
  return permissionRequest({ name: toolName, input: { file_path: filePath } });
}

export function shellRequest(command: string, toolName = "Bash"): AgentPermissionRequest {
  return permissionRequest({ name: toolName, input: { command } });
}
