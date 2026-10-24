import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureAntigravityMcpBridge } from "../server/bus/antigravity-mcp-bridge";
import { startBus, type BusCaller, type BusTransportDeps, type RunningBus } from "../server/bus/http-mcp";
import { toolNamesForRole } from "../server/bus/tool-schemas";
import { RunStore } from "../server/store/run-store";
import { BUS_SERVER_NAME, SLP_ROLES } from "../shared/roles";
import { buildAgentRecord, buildRun } from "./helpers/run-factory";

const SUPERVISOR_CALLER: BusCaller = { runId: "run-1", agentId: "agent-sup", role: "supervisor", taskId: null };
const PEER_CALLER: BusCaller = { runId: "run-1", agentId: "agent-peer", role: "peer", projectRole: "developer", taskId: null };
const CALLERS_BY_TOKEN: Record<string, BusCaller> = { "tok-sup": SUPERVISOR_CALLER, "tok-peer": PEER_CALLER };

let runningBus: RunningBus;
let dispatchSpy: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  dispatchSpy = vi.fn(async () => ({ text: "dispatched ok", isError: false }));
  const fakeDeps: BusTransportDeps = {
    resolveCaller: (token) => CALLERS_BY_TOKEN[token] ?? null,
    dispatch: dispatchSpy as BusTransportDeps["dispatch"],
  };
  // port 0 asks the OS for a free port so parallel test files never collide
  runningBus = await startBus(fakeDeps, null);
});

afterEach(async () => {
  await runningBus.close();
});

function post(token: string, body: unknown, extraPath = "") {
  return fetch(`http://127.0.0.1:${runningBus.port}/mcp/${token}${extraPath}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// the URL token is the agent's only credential, so unknown tokens must get nothing
describe("authentication and HTTP verbs", () => {
  it("answers 401 for an unknown token without leaking details", async () => {
    const unauthorizedResponse = await post("bad-token", { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(unauthorizedResponse.status).toBe(401);
    expect(await unauthorizedResponse.json()).toEqual({ error: "unauthorized" });
  });

  it("answers 401 for paths outside /mcp/<token>", async () => {
    const strayResponse = await fetch(`http://127.0.0.1:${runningBus.port}/other`, { method: "POST", body: "{}" });
    expect(strayResponse.status).toBe(401);
  });

  // the spec allows 405 when the server offers no SSE stream
  it("answers 405 to GET because no server stream is offered", async () => {
    const getResponse = await fetch(`http://127.0.0.1:${runningBus.port}/mcp/tok-sup`);
    expect(getResponse.status).toBe(405);
    expect(getResponse.headers.get("allow")).toContain("POST");
  });

  it("still authenticates GET before answering 405", async () => {
    const getResponse = await fetch(`http://127.0.0.1:${runningBus.port}/mcp/nope`);
    expect(getResponse.status).toBe(401);
  });

  // clients close sessions with DELETE; refusing would log noisy errors
  it("accepts DELETE (session close) with 200", async () => {
    const deleteResponse = await fetch(`http://127.0.0.1:${runningBus.port}/mcp/tok-sup`, { method: "DELETE" });
    expect(deleteResponse.status).toBe(200);
  });

  // some MCP clients append a session query parameter
  it("ignores a query string when matching the token", async () => {
    const queryResponse = await post("tok-sup", { jsonrpc: "2.0", id: 1, method: "ping" }, "?session=1");
    expect(queryResponse.status).toBe(200);
  });

  // a malformed body must not crash or hang the request
  it("answers 400 with a JSON-RPC parse error for a malformed body", async () => {
    const malformedResponse = await post("tok-sup", "{ not json");
    expect(malformedResponse.status).toBe(400);
    expect(await malformedResponse.json()).toMatchObject({ error: { code: -32700 } });
  });
});

describe("request size limit", () => {
  it("drops an oversized body and keeps serving other callers", async () => {
    const oversizedBody = "x".repeat(1_500_000);
    // the server destroys the socket instead of buffering without bound
    await expect(post("tok-sup", oversizedBody)).rejects.toThrow();
    const pingResponse = await post("tok-sup", { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(pingResponse.status).toBe(200);
  });
});

describe("JSON-RPC methods", () => {
  // clients reject servers that answer with an unexpected protocol version
  it("initialize echoes a supported protocol version", async () => {
    const initializeResponse = await post("tok-sup", {
      jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" },
    });
    const initializeReply = await initializeResponse.json();
    expect(initializeReply.id).toBe(1);
    expect(initializeReply.result.protocolVersion).toBe("2024-11-05");
    expect(initializeReply.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(initializeReply.result.serverInfo.name).toBe("slp-bus");
  });

  it("initialize falls back to the newest supported version for an unknown one", async () => {
    const initializeResponse = await post("tok-sup", {
      jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" },
    });
    expect((await initializeResponse.json()).result.protocolVersion).toBe("2025-06-18");
  });

  // ping keeps long-lived sessions alive
  it("ping returns an empty result", async () => {
    const pingResponse = await post("tok-sup", { jsonrpc: "2.0", id: "p", method: "ping" });
    expect(await pingResponse.json()).toEqual({ jsonrpc: "2.0", id: "p", result: {} });
  });

  // unsupported methods such as resources/list must fail cleanly
  it("unknown methods yield a -32601 error", async () => {
    const unknownResponse = await post("tok-sup", { jsonrpc: "2.0", id: 9, method: "resources/list" });
    expect((await unknownResponse.json()).error).toMatchObject({ code: -32601 });
  });

  // JSON-RPC notifications never get a response body
  it("notifications (no id) return 202 with an empty body", async () => {
    const notificationResponse = await post("tok-sup", { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(notificationResponse.status).toBe(202);
    expect(await notificationResponse.text()).toBe("");
    expect(dispatchSpy).not.toHaveBeenCalled();
  });
});

describe("tools/list", () => {
  // every role sees exactly its catalogue, never another role's tools
  it.each(SLP_ROLES)("returns exactly the tools of role %s", async (role) => {
    const callerForRole: BusCaller = { runId: "run-1", agentId: `agent-${role}`, role, taskId: null };
    // Use a role-list-specific token so the shared 'tok-peer' fixture retains its projectRole for tools/call tests.
    CALLERS_BY_TOKEN[`tok-list-${role}`] = callerForRole;
    const listResponse = await post(`tok-list-${role}`, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const exposedToolNames = (await listResponse.json()).result.tools.map((tool: { name: string }) => tool.name);
    expect(exposedToolNames).toEqual(toolNamesForRole(role));
  });

  it("shows the Supervisor shared read tools and its own workflow tools", async () => {
    const listResponse = await post("tok-sup", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const exposedToolNames = (await listResponse.json()).result.tools.map((tool: { name: string }) => tool.name);
    // Read access does not grant the Supervisor the Lead's pipeline creation tools.
    expect(exposedToolNames).toEqual(toolNamesForRole("supervisor"));
  });

  // agents build their calls from these schemas
  it("describes each tool with a JSON schema object and no $schema key", async () => {
    const listResponse = await post("tok-peer", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const exposedTools = (await listResponse.json()).result.tools as Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
    expect(exposedTools.length).toBeGreaterThan(0);
    for (const exposedTool of exposedTools) {
      expect(exposedTool.description.length).toBeGreaterThan(0);
      expect(exposedTool.inputSchema.type).toBe("object");
      expect(exposedTool.inputSchema).not.toHaveProperty("$schema");
    }
    const stageReportTool = exposedTools.find((tool) => tool.name === "slp_stage_report");
    expect(stageReportTool?.inputSchema.required).toEqual(["summary"]);
  });

  it("keeps defaulted fields optional in the advertised schema", async () => {
    const peerCaller: BusCaller = { runId: "run-1", agentId: "agent-peer-schema", role: "peer", projectRole: "qa-engineer", taskId: null };
    CALLERS_BY_TOKEN["tok-peer-schema"] = peerCaller;
    const listResponse = await post("tok-peer-schema", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const stageReportTool = (await listResponse.json()).result.tools.find((tool: { name: string }) => tool.name === "slp_stage_report");
    // `findings` and `status` default so a concise report only requires its summary.
    expect(stageReportTool.inputSchema.required).toEqual(["summary"]);
  });
});

describe("tools/call", () => {
  // dispatch receives the identity derived from the token
  it("routes to dispatch with the authenticated caller, tool name and arguments", async () => {
    const callResponse = await post("tok-peer", {
      jsonrpc: "2.0", id: 5, method: "tools/call",
      params: { name: "slp_stage_report", arguments: { summary: "done" } },
    });
    expect(dispatchSpy).toHaveBeenCalledWith(PEER_CALLER, "slp_stage_report", { summary: "done" }, expect.any(AbortSignal));
    expect(await callResponse.json()).toEqual({
      jsonrpc: "2.0", id: 5,
      result: { content: [{ type: "text", text: "dispatched ok" }], isError: false },
    });
  });

  // a blocked call must look like a failed tool call so the agent self-corrects
  it("passes isError through so the agent sees a failed tool call", async () => {
    dispatchSpy.mockResolvedValueOnce({ text: "blocked: scope", isError: true });
    const callResponse = await post("tok-peer", {
      jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "slp_stage_done", arguments: {} },
    });
    expect((await callResponse.json()).result).toMatchObject({ isError: true, content: [{ text: "blocked: scope" }] });
  });

  // dispatch validates arguments itself and expects an object
  it("defaults missing arguments to an empty object", async () => {
    await post("tok-sup", { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "slp_present_to_manager" } });
    expect(dispatchSpy).toHaveBeenCalledWith(SUPERVISOR_CALLER, "slp_present_to_manager", {}, expect.any(AbortSignal));
  });

  // an agent must not be able to impersonate another role through arguments
  it("identifies the caller by token, not by anything in the body", async () => {
    await post("tok-sup", {
      jsonrpc: "2.0", id: 8, method: "tools/call",
      params: { name: "slp_delegate", arguments: { agentId: "agent-peer", role: "developer" } },
    });
    expect(dispatchSpy.mock.calls[0][0]).toBe(SUPERVISOR_CALLER);
  });
});

// JSON-RPC allows several requests in one POST
describe("batch requests", () => {
  it("answers an array with an array, dropping notifications", async () => {
    const batchResponse = await post("tok-sup", [
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "slp_delegate", arguments: {} } },
    ]);
    const responses = await batchResponse.json();
    expect(Array.isArray(responses)).toBe(true);
    expect(responses.map((rpcResponse: { id: number }) => rpcResponse.id)).toEqual([1, 2]);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });

  // an all-notification batch has no responses to send
  it("answers a batch of only notifications with 202", async () => {
    const batchResponse = await post("tok-sup", [{ jsonrpc: "2.0", method: "a" }, { jsonrpc: "2.0", method: "b" }]);
    expect(batchResponse.status).toBe(202);
  });

  it("keeps a single-element batch an array", async () => {
    const batchResponse = await post("tok-sup", [{ jsonrpc: "2.0", id: 1, method: "ping" }]);
    expect(await batchResponse.json()).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
  });
});

describe("startBus", () => {
  it("binds to loopback on an ephemeral port when none is preferred", () => {
    expect(runningBus.port).toBeGreaterThan(0);
  });

  // agents reuse their URL, but a taken port must not stop the plugin
  it("falls back to another port when the preferred one is taken", async () => {
    const noopDeps: BusTransportDeps = { resolveCaller: () => null, dispatch: async () => ({ text: "", isError: false }) };
    const secondBus = await startBus(noopDeps, runningBus.port);
    try {
      // the first bus still owns its port, so the second must have moved
      expect(secondBus.port).not.toBe(runningBus.port);
    } finally {
      await secondBus.close();
    }
  });
});

describe("Antigravity stdio MCP bridge", () => {
  it("registers slp-bus with eager tools in mcp_config.json without dropping existing servers", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "slp-agy-bridge-"));
    try {
      const mcpConfigPath = join(tempDir, "mcp_config.json");
      writeFileSync(
        mcpConfigPath,
        JSON.stringify({ mcpServers: { codegraph: { command: "codegraph", args: ["serve", "--mcp"] } } }),
        "utf8",
      );
      const bridgeScriptPath = ensureAntigravityMcpBridge(tempDir, {
        mcpConfigPath,
        nodeExecutablePath: "/usr/local/bin/node",
        platform: "linux",
      });
      const updatedConfig = JSON.parse(readFileSync(mcpConfigPath, "utf8"));
      expect(updatedConfig.mcpServers.codegraph).toEqual({ command: "codegraph", args: ["serve", "--mcp"] });
      // Wrapping with /usr/bin/env on POSIX guarantees ELECTRON_RUN_AS_NODE=1 when Paseo's execPath is an Electron binary.
      expect(updatedConfig.mcpServers[BUS_SERVER_NAME]).toMatchObject({
        command: "/usr/bin/env",
        args: ["ELECTRON_RUN_AS_NODE=1", "/usr/local/bin/node", bridgeScriptPath],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      });
      expect(updatedConfig.mcpServers[BUS_SERVER_NAME].tools.slp_delegate).toEqual({ eager: true });
      expect(updatedConfig.mcpServers[BUS_SERVER_NAME].tools.slp_stage_report).toEqual({ eager: true });

      // On Windows (/usr/bin/env absent), command points directly to nodeExecutablePath with ELECTRON_RUN_AS_NODE=1 in env.
      ensureAntigravityMcpBridge(tempDir, {
        mcpConfigPath,
        nodeExecutablePath: "C:\\Program Files\\Paseo\\Paseo.exe",
        platform: "win32",
      });
      const winUpdatedConfig = JSON.parse(readFileSync(mcpConfigPath, "utf8"));
      expect(winUpdatedConfig.mcpServers[BUS_SERVER_NAME]).toMatchObject({
        command: "C:\\Program Files\\Paseo\\Paseo.exe",
        args: [bridgeScriptPath],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("exposes an empty toolset outside SLP runs and forwards authenticated calls inside SLP runs", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "slp-agy-rpc-"));
    const sqliteStore = new RunStore(join(tempDir, "orchestrator.sqlite3"));
    try {
      sqliteStore.load();
      sqliteStore.insert(
        buildRun({
          id: "run-1",
          agents: {
            "agent-sup": buildAgentRecord({ agentId: "agent-sup", role: "supervisor", token: "tok-sup" }),
          },
        }),
      );
      writeFileSync(join(tempDir, "bus-port"), String(runningBus.port), "utf8");
      const bridgeScriptPath = ensureAntigravityMcpBridge(tempDir, {
        mcpConfigPath: join(tempDir, "mcp_config.json"),
      });
      const bridgeModule = await import(pathToFileURL(bridgeScriptPath).href);

      // Non-SLP Antigravity sessions must see 0 tools so normal terminal usage stays clean.
      const nonSlpToolsReply = await bridgeModule.handleStdioRpcMessage(
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { SLP_HOME: tempDir },
      );
      expect(nonSlpToolsReply).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [] } });

      // Sessions with PASEO_AGENT_ID resolve their token from SQLite + bus-port and forward to http-mcp.
      const slpToolsReply = await bridgeModule.handleStdioRpcMessage(
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        { SLP_HOME: tempDir, PASEO_AGENT_ID: "agent-sup" },
      );
      const advertisedNames = slpToolsReply.result.tools.map((toolEntry: { name: string }) => toolEntry.name);
      expect(advertisedNames).toEqual(toolNamesForRole("supervisor"));

      const delegateCallReply = await bridgeModule.handleStdioRpcMessage(
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "slp_delegate", arguments: { acceptanceCriteria: "Ship feature" } },
        },
        { SLP_HOME: tempDir, PASEO_AGENT_ID: "agent-sup" },
      );
      expect(dispatchSpy).toHaveBeenCalledWith(SUPERVISOR_CALLER, "slp_delegate", {
        acceptanceCriteria: "Ship feature",
      }, expect.any(AbortSignal));
      expect(delegateCallReply).toEqual({
        jsonrpc: "2.0",
        id: 3,
        result: { content: [{ type: "text", text: "dispatched ok" }], isError: false },
      });
    } finally {
      sqliteStore.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
