import { describe, expect, it } from "vitest";
import type { SlpRole } from "../shared/roles";
import { decidePermission, extractShellCommand, extractWritePaths, type PermissionContext } from "../server/hooks/permissions";
import { fileWriteRequest, permissionRequest, shellRequest } from "./helpers/permission-request";

const WORKTREE = "/work/pipeline-a";
const SOURCE_SCOPE = ["src/"];

function contextFor(role: SlpRole, overrides: Partial<PermissionContext> = {}): PermissionContext {
  // Capability is now an orchestration role. Project business names are carried separately and
  // cannot turn a read-only stage into a writer without an explicit stage scope.
  return {
    role,
    agentCwd: WORKTREE,
    writableScope: SOURCE_SCOPE,
    pipelineId: role === "peer" ? "pipeline-a" : null,
    stageId: role === "peer" ? "stage-coding" : null,
    stageActive: true,
    archived: false,
    ...overrides,
  };
}

const isAllowed = (decision: ReturnType<typeof decidePermission>) => decision.behavior === "allow";

describe("dynamic stage write permissions", () => {
  // Only the developer writes; advisors and QA graders judge the worktree, so they must not change it.
  it.each(["advisor", "qa"] as const)("keeps an active %s peer read-only for files and mutating shell", (peerKind) => {
    const readOnlyPeer = contextFor("peer", { peerKind });
    expect(isAllowed(decidePermission(fileWriteRequest("src/a.ts"), readOnlyPeer))).toBe(false);
    expect(isAllowed(decidePermission(shellRequest("git commit -am wip"), readOnlyPeer))).toBe(false);
    // Reading and running tests stays possible so they can still investigate and grade.
    expect(isAllowed(decidePermission(shellRequest("npm test"), readOnlyPeer))).toBe(true);
    const developerPeer = contextFor("peer", { peerKind: "developer" });
    expect(isAllowed(decidePermission(fileWriteRequest("src/a.ts"), developerPeer))).toBe(true);
    expect(isAllowed(decidePermission(shellRequest("git commit -am wip"), developerPeer))).toBe(true);
  });

  it("keeps a peer read-only before its stage becomes active", () => {
    expect(isAllowed(decidePermission(fileWriteRequest("src/a.ts"), contextFor("peer", { stageActive: false })))).toBe(false);
  });

  it("allows an active peer to write only inside the stage scope", () => {
    const activePeer = contextFor("peer");
    expect(isAllowed(decidePermission(fileWriteRequest("src/a.ts"), activePeer))).toBe(true);
    expect(isAllowed(decidePermission(fileWriteRequest(`${WORKTREE}/src/deep/b.ts`), activePeer))).toBe(true);
    expect(isAllowed(decidePermission(fileWriteRequest("docs/a.md"), activePeer))).toBe(false);
  });

  it("denies peers with no valid pipeline identity", () => {
    const unassignedPeer = contextFor("peer", { pipelineId: null, stageId: null });
    expect(isAllowed(decidePermission(fileWriteRequest("src/a.ts"), unassignedPeer))).toBe(false);
    expect(isAllowed(decidePermission(shellRequest("mkdir out"), unassignedPeer))).toBe(false);
  });

  it("never lets an archived peer write", () => {
    expect(isAllowed(decidePermission(fileWriteRequest("src/a.ts"), contextFor("peer", { archived: true })))).toBe(false);
  });

  it("keeps the Supervisor read-only", () => {
    expect(isAllowed(decidePermission(fileWriteRequest("src/a.ts"), contextFor("supervisor")))).toBe(false);
    expect(isAllowed(decidePermission(fileWriteRequest("docs/a.md"), contextFor("supervisor")))).toBe(false);
  });

  it("lets the Master Lead write inside its integration checkout", () => {
    const masterLead = contextFor("master_lead", { pipelineId: null, stageId: null });
    expect(isAllowed(decidePermission(fileWriteRequest("anything/at/all.md"), masterLead))).toBe(true);
    // SQLite owns orchestration state; broad integration access cannot recreate retired files.
    expect(isAllowed(decidePermission(fileWriteRequest(`${WORKTREE}/.slp/MASTER_SPEC.md`), masterLead))).toBe(false);
  });
});

describe("path boundaries", () => {
  it.each(["peer", "master_lead"] as const)("denies ../ traversal for %s", (role) => {
    const context = contextFor(role, role === "peer" ? {} : { pipelineId: null, stageId: null });
    expect(isAllowed(decidePermission(fileWriteRequest("../other/a.ts"), context))).toBe(false);
    expect(isAllowed(decidePermission(fileWriteRequest("src/../../escape.ts"), context))).toBe(false);
  });

  it("denies absolute paths outside the working directory", () => {
    expect(isAllowed(decidePermission(fileWriteRequest("/etc/passwd"), contextFor("master_lead")))).toBe(false);
    expect(isAllowed(decidePermission(fileWriteRequest("/work/pipeline-a-evil/src/a.ts"), contextFor("peer")))).toBe(false);
  });

  it("allows a normalized path that remains inside the scope", () => {
    expect(isAllowed(decidePermission(fileWriteRequest("src/x/../a.ts"), contextFor("peer")))).toBe(true);
  });

  it("checks every file in a patch request", () => {
    const peer = contextFor("peer");
    const patchRequest = permissionRequest({ name: "apply_patch", input: { files: [{ path: "src/a.ts" }, { path: "docs/leak.md" }] } });
    expect(isAllowed(decidePermission(patchRequest, peer))).toBe(false);
    const goodPatch = permissionRequest({ name: "apply_patch", input: { files: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
    expect(isAllowed(decidePermission(goodPatch, peer))).toBe(true);
  });

  it("recognises writes announced through permission details", () => {
    const detailedRequest = permissionRequest({ name: "tool", detail: { type: "edit", filePath: "docs/a.md" } });
    expect(isAllowed(decidePermission(detailedRequest, contextFor("peer")))).toBe(false);
  });
});

describe("bus, questions and plans", () => {
  it.each(["supervisor", "master_lead", "peer"] as const)("allows bus tools for %s", (role) => {
    const busRequest = permissionRequest({ name: "mcp__slp-bus__slp_stage_report" });
    expect(isAllowed(decidePermission(busRequest, contextFor(role)))).toBe(true);
  });

  it("denies questions because no human is available to the workers", () => {
    const decision = decidePermission(permissionRequest({ name: "AskUserQuestion", kind: "question" }), contextFor("peer"));
    expect(decision).toMatchObject({ behavior: "deny", message: expect.stringContaining("slp_escalate") });
  });

  it("allows plan and mode approvals", () => {
    expect(isAllowed(decidePermission(permissionRequest({ name: "ExitPlanMode", kind: "plan" }), contextFor("peer")))).toBe(true);
    expect(isAllowed(decidePermission(permissionRequest({ name: "mode", kind: "mode" }), contextFor("peer")))).toBe(true);
  });

  it("allows read-only tools outside the worktree", () => {
    expect(isAllowed(decidePermission(permissionRequest({ name: "Read", input: { file_path: "/etc/hosts" } }), contextFor("peer")))).toBe(true);
  });
});

describe("shell boundaries", () => {
  it.each(["paseo send agent hello", "cd x && paseo ls", "curl http://127.0.0.1:6767/api", "curl -s localhost:6767"])(
    "denies daemon bypass %s",
    (command) => {
      for (const role of ["peer", "master_lead", "supervisor"] as const) {
        expect(isAllowed(decidePermission(shellRequest(command), contextFor(role)))).toBe(false);
      }
    },
  );

  it.each(["grep -rn paseo src", "cat docs/paseo-notes.md", "echo paseo"])("allows harmless command %s", (command) => {
    expect(isAllowed(decidePermission(shellRequest(command), contextFor("peer")))).toBe(true);
  });

  it.each(["/usr/bin/paseo ls", "(paseo send a b)", "echo hi; paseo ls", "x=$(paseo ls)"])("denies %s", (command) => {
    expect(isAllowed(decidePermission(shellRequest(command), contextFor("peer")))).toBe(false);
  });

  it("denies git push even to the integration owner or with global git flags", () => {
    expect(isAllowed(decidePermission(shellRequest("git push origin main"), contextFor("master_lead")))).toBe(false);
    expect(isAllowed(decidePermission(shellRequest("git -C /tmp/worktree push origin slp/12345678/task"), contextFor("peer")))).toBe(false);
  });

  it.each(["rm -rf src", "touch a.txt", "echo hi > out.txt", "sed -i s/a/b/ f", "git commit -am x", "npm install left-pad", "ls | tee log.txt"])(
    "denies mutating command %s to read-only roles",
    (command) => {
      expect(isAllowed(decidePermission(shellRequest(command), contextFor("supervisor")))).toBe(false);
      expect(isAllowed(decidePermission(shellRequest(command), contextFor("peer", { stageActive: false })))).toBe(false);
    },
  );

  it.each(["git status", "ls -la", "cat src/a.ts", "grep -rn foo src", "git diff main...HEAD", "ls 2>&1"])(
    "allows read-only command %s",
    (command) => {
      expect(isAllowed(decidePermission(shellRequest(command), contextFor("peer")))).toBe(true);
    },
  );

  it("allows mutating commands for a live peer and Master Lead", () => {
    expect(isAllowed(decidePermission(shellRequest("git add -A && git commit -m x"), contextFor("peer")))).toBe(true);
    expect(isAllowed(decidePermission(shellRequest("mkdir out"), contextFor("peer")))).toBe(true);
    expect(isAllowed(decidePermission(shellRequest("npm install"), contextFor("master_lead")))).toBe(true);
  });

  it("understands Codex-style array commands", () => {
    const arrayCommand = permissionRequest({ name: "local_shell", input: { command: ["rm", "-rf", "src"] } });
    // Read-only roles and inactive stage peers must still be blocked when a mutating command arrives as an argv array.
    expect(isAllowed(decidePermission(arrayCommand, contextFor("supervisor")))).toBe(false);
    expect(isAllowed(decidePermission(arrayCommand, contextFor("peer", { stageActive: false })))).toBe(false);
    expect(isAllowed(decidePermission(arrayCommand, contextFor("peer")))).toBe(true);
  });
});

describe("extraction helpers", () => {
  it("collects de-duplicated write paths from every known field", () => {
    const writeRequest = permissionRequest({ name: "Edit", input: { file_path: "a.ts", path: "a.ts", notebook_path: "n.ipynb" }, detail: { filePath: "a.ts" } });
    expect(extractWritePaths(writeRequest).sort()).toEqual(["a.ts", "n.ipynb"]);
  });

  it("returns null when a shell request has no command", () => {
    expect(extractShellCommand(permissionRequest({ name: "Bash", input: {} }))).toBeNull();
    expect(extractShellCommand(shellRequest("ls"))).toBe("ls");
  });
});

describe("Lead-assigned stage access", () => {
  it("uses an explicit scope for a live project peer", () => {
    const peer = contextFor("peer", { writableScope: ["src/**"] });
    expect(isAllowed(decidePermission(fileWriteRequest("src/a.ts"), peer))).toBe(true);
    expect(isAllowed(decidePermission(fileWriteRequest("docs/a.md"), peer))).toBe(false);
  });

  it("does not grant a scope after the stage closes", () => {
    const peer = contextFor("peer", { writableScope: ["src/**"], stageActive: false });
    expect(isAllowed(decidePermission(fileWriteRequest("src/a.ts"), peer))).toBe(false);
    expect(isAllowed(decidePermission(fileWriteRequest("src/a.ts"), { ...peer, archived: true }))).toBe(false);
  });
});
