import { describe, expect, it } from "vitest";
import type { SlpRole } from "../shared/roles";
import type { TaskPhase } from "../shared/state";
import { decidePermission, extractShellCommand, extractWritePaths, type PermissionContext } from "../server/hooks/permissions";
import { fileWriteRequest, permissionRequest, shellRequest } from "./helpers/permission-request";

const WORKTREE = "/work/task-a";
const IMPLEMENTER_SCOPE = ["src/"];

function contextFor(role: SlpRole, taskPhase: TaskPhase | null): PermissionContext {
  return { role, taskPhase, agentCwd: WORKTREE, writableScope: IMPLEMENTER_SCOPE };
}

const isAllowed = (decision: ReturnType<typeof decidePermission>) => decision.behavior === "allow";

// spec section 4, rule 4: only one role group may write at a time
describe("implementer file writes", () => {
  it.each(["queued", "handshaking", "verifying", "paused", "ready_for_merge", "merged"] as TaskPhase[])(
    "is read-only in phase %s",
    (phase) => {
      // during the handshake the implementer must not touch code even inside its own scope
      expect(isAllowed(decidePermission(fileWriteRequest("src/a.ts"), contextFor("implementer", phase)))).toBe(false);
    },
  );

  // the two phases in which the implementer owns the scope
  it.each(["implementing", "fixing"] as TaskPhase[])("may write inside scope while %s", (phase) => {
    expect(isAllowed(decidePermission(fileWriteRequest("src/a.ts"), contextFor("implementer", phase)))).toBe(true);
    expect(isAllowed(decidePermission(fileWriteRequest(`${WORKTREE}/src/deep/b.ts`), contextFor("implementer", phase)))).toBe(true);
  });

  // the deny message must tell the agent how to recover, or it will loop
  it("is denied outside scope even while implementing", () => {
    const decision = decidePermission(fileWriteRequest("docs/a.md"), contextFor("implementer", "implementing"));
    expect(decision.behavior).toBe("deny");
    // the message tells the agent how to recover
    expect(decision).toMatchObject({ message: expect.stringContaining("slp_escalate") });
  });

  // Documentation now submits structured data, so the phase never unlocks file writes.
  it("stays read-only while documenting", () => {
    const documenting = contextFor("implementer", "documenting");
    expect(isAllowed(decidePermission(fileWriteRequest(".slp/ACCEPTANCE_DOC.md"), documenting))).toBe(false);
    expect(isAllowed(decidePermission(fileWriteRequest("src/a.ts"), documenting))).toBe(false);
  });
});

// qa, doc, security, supervisor and master_lead each have a different write contract
describe("other roles' file writes", () => {
  // QA may only add tests; production code stays with the implementer
  it("lets qa write only test files while verifying", () => {
    const verifying = contextFor("qa", "verifying");
    for (const testPath of ["tests/a.test.ts", "test/x.ts", "src/deep/a.spec.ts", "__tests__/z.ts"]) {
      expect(isAllowed(decidePermission(fileWriteRequest(testPath), verifying))).toBe(true);
    }
    expect(isAllowed(decidePermission(fileWriteRequest("src/a.ts"), verifying))).toBe(false);
    // qa writes are tied to the verification stage
    expect(isAllowed(decidePermission(fileWriteRequest("tests/a.test.ts"), contextFor("qa", "fixing")))).toBe(false);
  });

  // these roles are read-only in every phase, including documenting
  it.each(["security", "supervisor", "forked_lead"] as SlpRole[])("never lets %s write", (role) => {
    for (const phase of ["implementing", "verifying", null] as Array<TaskPhase | null>) {
      expect(isAllowed(decidePermission(fileWriteRequest("src/a.ts"), contextFor(role, phase)))).toBe(false);
      expect(isAllowed(decidePermission(fileWriteRequest(".slp/ACCEPTANCE_DOC.md"), contextFor(role, phase)))).toBe(false);
    }
  });

  // The Doc Peer collects evidence and submits it through the authenticated report tool.
  it("keeps the doc peer read-only", () => {
    const docContext = contextFor("doc", "documenting");
    expect(isAllowed(decidePermission(fileWriteRequest(".slp/ACCEPTANCE_DOC.md"), docContext))).toBe(false);
    expect(isAllowed(decidePermission(fileWriteRequest("src/a.ts"), docContext))).toBe(false);
  });

  it("lets the master lead write anywhere inside its checkout", () => {
    const masterLead = contextFor("master_lead", null);
    expect(isAllowed(decidePermission(fileWriteRequest("anything/at/all.md"), masterLead))).toBe(true);
    // Reserved names stay blocked even for the owner of the integration checkout.
    expect(isAllowed(decidePermission(fileWriteRequest(`${WORKTREE}/.slp/MASTER_SPEC.md`), masterLead))).toBe(false);
  });
});

// the soft write-lock must not be bypassed by path tricks
describe("path escapes", () => {
  it.each(["implementer", "master_lead"] as SlpRole[])("denies ../ traversal for %s", (role) => {
    const writableContext = contextFor(role, "implementing");
    expect(isAllowed(decidePermission(fileWriteRequest("../other/a.ts"), writableContext))).toBe(false);
    // a path that starts inside scope but climbs out must be resolved before matching
    expect(isAllowed(decidePermission(fileWriteRequest("src/../../escape.ts"), writableContext))).toBe(false);
  });

  // '/work/task-a-evil' shares a string prefix with the worktree but is another directory
  it("denies absolute paths outside the working directory", () => {
    expect(isAllowed(decidePermission(fileWriteRequest("/etc/passwd"), contextFor("master_lead", null)))).toBe(false);
    expect(isAllowed(decidePermission(fileWriteRequest("/work/task-a-evil/src/a.ts"), contextFor("implementer", "implementing")))).toBe(false);
  });

  it("allows ../ that stays inside the worktree", () => {
    expect(isAllowed(decidePermission(fileWriteRequest("src/x/../a.ts"), contextFor("implementer", "implementing")))).toBe(true);
  });

  // codex announces all patch targets in input.files, not in a single path
  it("checks every file of a codex apply_patch request", () => {
    const patchRequest = permissionRequest({
      name: "apply_patch",
      input: { files: [{ path: "src/a.ts" }, { path: "docs/leak.md" }] },
    });
    // one bad file is enough to deny the whole patch
    expect(isAllowed(decidePermission(patchRequest, contextFor("implementer", "implementing")))).toBe(false);
    const goodPatch = permissionRequest({ name: "apply_patch", input: { files: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
    expect(isAllowed(decidePermission(goodPatch, contextFor("implementer", "implementing")))).toBe(true);
  });

  // some providers only describe the write in the permission detail
  it("recognises writes announced through detail.type or detail.filePath", () => {
    const detailedRequest = permissionRequest({ name: "tool", detail: { type: "edit", filePath: "docs/a.md" } });
    expect(isAllowed(decidePermission(detailedRequest, contextFor("implementer", "implementing")))).toBe(false);
  });
});

// requests that are not file or shell operations
describe("bus, questions and plans", () => {
  it.each(["supervisor", "forked_lead", "security", "implementer"] as SlpRole[])("always allows slp-bus tools for %s", (role) => {
    const busRequest = permissionRequest({ name: "mcp__slp-bus__slp_submit_plan" });
    expect(isAllowed(decidePermission(busRequest, contextFor(role, "handshaking")))).toBe(true);
  });

  // an unanswered question would stall the agent forever
  it("denies questions because no human is available", () => {
    const decision = decidePermission(permissionRequest({ name: "AskUserQuestion", kind: "question" }), contextFor("implementer", "implementing"));
    expect(decision).toMatchObject({ behavior: "deny", message: expect.stringContaining("slp_escalate") });
  });

  it("allows plan and mode approvals", () => {
    expect(isAllowed(decidePermission(permissionRequest({ name: "ExitPlanMode", kind: "plan" }), contextFor("implementer", "handshaking")))).toBe(true);
    expect(isAllowed(decidePermission(permissionRequest({ name: "mode", kind: "mode" }), contextFor("security", "verifying")))).toBe(true);
  });

  // reads are harmless to the pipeline, even outside the worktree
  it("allows read-only tools", () => {
    expect(isAllowed(decidePermission(permissionRequest({ name: "Read", input: { file_path: "/etc/hosts" } }), contextFor("security", "verifying")))).toBe(true);
  });
});

// shell is the loophole the scope gate backs up; the policy only catches obvious cases
describe("shell commands", () => {
  const writableContext = contextFor("implementer", "implementing");

  it.each(["paseo send agent hello", "cd x && paseo ls", "curl http://127.0.0.1:6767/api", "curl -s localhost:6767"])(
    "denies daemon bypass %s for every role",
    (command) => {
      for (const role of ["implementer", "master_lead", "qa"] as SlpRole[]) {
        expect(isAllowed(decidePermission(shellRequest(command), contextFor(role, "implementing")))).toBe(false);
      }
    },
  );

  // "paseo" as a mere argument (search term, path) is harmless; only the command word is a bypass
  it.each(["grep -rn paseo src", "cat docs/paseo-notes.md", "echo paseo"])("allows %s", (command) => {
    expect(isAllowed(decidePermission(shellRequest(command), writableContext))).toBe(true);
  });

  it.each(["/usr/bin/paseo ls", "(paseo send a b)", "echo hi; paseo ls", "x=$(paseo ls)"])("denies %s", (command) => {
    expect(isAllowed(decidePermission(shellRequest(command), writableContext))).toBe(false);
  });

  // pushing is outside the pipeline's remit for every role, even the master lead
  it("denies git push for everyone", () => {
    expect(isAllowed(decidePermission(shellRequest("git push origin main"), contextFor("master_lead", null)))).toBe(false);
  });

  it.each(["rm -rf src", "touch a.txt", "echo hi > out.txt", "sed -i s/a/b/ f", "git commit -am x", "npm install left-pad", "ls | tee log.txt"])(
    "denies mutating command %s for read-only roles",
    (command) => {
      for (const role of ["security", "supervisor", "forked_lead"] as SlpRole[]) {
        expect(isAllowed(decidePermission(shellRequest(command), contextFor(role, "verifying")))).toBe(false);
      }
      // implementer is read-only too until the plan is approved
      expect(isAllowed(decidePermission(shellRequest(command), contextFor("implementer", "handshaking")))).toBe(false);
    },
  );

  // read-only inspection must keep working for security and supervisor
  it.each(["git status", "ls -la", "cat src/a.ts", "grep -rn foo src", "git diff main...HEAD", "ls 2>&1"])(
    "allows read-only command %s for read-only roles",
    (command) => {
      expect(isAllowed(decidePermission(shellRequest(command), contextFor("security", "verifying")))).toBe(true);
    },
  );

  it("allows mutating commands for roles that own a writable stage", () => {
    expect(isAllowed(decidePermission(shellRequest("git add -A && git commit -m x"), writableContext))).toBe(true);
    expect(isAllowed(decidePermission(shellRequest("mkdir out"), contextFor("qa", "verifying")))).toBe(true);
    expect(isAllowed(decidePermission(shellRequest("npm install"), contextFor("master_lead", null)))).toBe(true);
  });

  // codex sends argv arrays instead of a command string
  it("understands codex-style array commands", () => {
    const arrayCommand = permissionRequest({ name: "local_shell", input: { command: ["rm", "-rf", "src"] } });
    expect(isAllowed(decidePermission(arrayCommand, contextFor("security", "verifying")))).toBe(false);
  });
});

// small parsing helpers the policy depends on
describe("extraction helpers", () => {
  it("collects de-duplicated write paths from every known field", () => {
    const writeRequest = permissionRequest({
      name: "Edit",
      input: { file_path: "a.ts", path: "a.ts", notebook_path: "n.ipynb" },
      detail: { filePath: "a.ts" },
    });
    expect(extractWritePaths(writeRequest).sort()).toEqual(["a.ts", "n.ipynb"]);
  });

  it("returns null when a request has no command", () => {
    expect(extractShellCommand(permissionRequest({ name: "Bash", input: {} }))).toBeNull();
    expect(extractShellCommand(shellRequest("ls"))).toBe("ls");
  });
});

describe("Lead-assigned additional peer access", () => {
  it("keeps the default additional assignment read-only even during coding", () => {
    const context = { ...contextFor("peer", "implementing"), writableScope: [] };
    expect(isAllowed(decidePermission(fileWriteRequest("src/a.ts"), context))).toBe(false);
    expect(isAllowed(decidePermission(shellRequest("git add -A"), context))).toBe(false);
  });

  // The Lead's explicit grant is scoped and still subject to the task's coding phase.
  it("allows granted task files only during implementing or fixing", () => {
    expect(isAllowed(decidePermission(fileWriteRequest("src/a.ts"), contextFor("peer", "implementing")))).toBe(true);
    expect(isAllowed(decidePermission(fileWriteRequest("docs/a.md"), contextFor("peer", "implementing")))).toBe(false);
    expect(isAllowed(decidePermission(fileWriteRequest("src/a.ts"), contextFor("peer", "verifying")))).toBe(false);
    expect(isAllowed(decidePermission(fileWriteRequest("src/a.ts"), contextFor("peer", null)))).toBe(false);
  });
});
