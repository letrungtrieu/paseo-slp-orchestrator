// Antigravity CLI (agy) ignores per-session HTTP mcpServers passed to Paseo's workspace.agents.create
// and instead spawns stdio MCP servers from ~/.gemini/config/mcp_config.json. This module materializes
// a per-agent stdio-to-HTTP bridge script in SLP_HOME and registers it under "slp-bus" so each agy
// agent authenticates to the loopback bus using its inherited PASEO_AGENT_ID / SLP_AGENT_TOKEN env.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BUS_SERVER_NAME } from "../../shared/roles";
import { BUS_TOOL_DEFINITIONS, type BusToolName } from "./tool-schemas";

export interface AntigravityBridgeSetupOptions {
  mcpConfigPath?: string;
  nodeExecutablePath?: string;
}

const BRIDGE_SCRIPT_FILENAME = "slp-mcp-bridge.mjs";

// Default global MCP configuration path read by Antigravity CLI on startup.
export function defaultAntigravityMcpConfigPath(): string {
  return process.env.SLP_AGY_MCP_CONFIG_PATH ?? join(homedir(), ".gemini", "config", "mcp_config.json");
}

// Build the standalone ESM stdio bridge source so it remains available on disk even when Paseo
// bundles the plugin's TypeScript entrypoint into an in-memory or single-file server build.
export function renderAntigravityBridgeScript(defaultStateDirectory: string): string {
  return `#!/usr/bin/env node
// Standalone stdio-to-HTTP MCP bridge for Antigravity CLI ("${BUS_SERVER_NAME}").
// Each agy process spawns its own child instance of this script and passes its agent environment.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_STATE_DIRECTORY = ${JSON.stringify(defaultStateDirectory)};
// Newest protocol first so clients negotiating an unknown version downgrade from our latest supported spec.
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
// Transient reload windows can briefly close the loopback bus socket while the plugin restarts.
const MAX_FORWARD_ATTEMPTS = 4;
const FORWARD_RETRY_DELAY_MS = 150;

function readSavedBusPort(stateDirectory) {
  try {
    const rawPortText = readFileSync(join(stateDirectory, "bus-port"), "utf8").trim();
    const parsedBusPort = Number.parseInt(rawPortText, 10);
    return Number.isInteger(parsedBusPort) && parsedBusPort > 0 ? parsedBusPort : null;
  } catch {
    return null;
  }
}

function lookupAgentTokenInSqlite(stateDirectory, targetAgentId) {
  const sqliteDatabasePath = join(stateDirectory, "orchestrator.sqlite3");
  if (!existsSync(sqliteDatabasePath)) return null;
  let sqliteConnection = null;
  try {
    // Open read-only so a stray stdio child never competes for SQLite write locks with the daemon.
    sqliteConnection = new DatabaseSync(sqliteDatabasePath, { open: true, readOnly: true });
    sqliteConnection.exec("PRAGMA busy_timeout = 2000;");
    const persistedRunRows = sqliteConnection.prepare("SELECT payload FROM runs").all();
    for (const persistedRunRow of persistedRunRows) {
      const parsedRunPayload = JSON.parse(String(persistedRunRow.payload));
      const matchedAgentRecord = parsedRunPayload?.agents?.[targetAgentId];
      if (typeof matchedAgentRecord?.token === "string" && matchedAgentRecord.token.length > 0) {
        return matchedAgentRecord.token;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    try { sqliteConnection?.close(); } catch {}
  }
}

export function resolveAgentBusEndpoint(environment = process.env, fallbackStateDirectory = DEFAULT_STATE_DIRECTORY) {
  const activeStateDirectory = environment.SLP_HOME || fallbackStateDirectory || join(homedir(), ".slp-orchestrator");
  const explicitBusUrl = typeof environment.SLP_BUS_URL === "string" ? environment.SLP_BUS_URL.trim() : "";
  const tokenFromExplicitUrl = /^https?:\\/\\/[^/]+\\/mcp\\/([A-Za-z0-9_-]+)$/.exec(explicitBusUrl)?.[1] ?? null;
  const targetAgentId = environment.SLP_AGENT_ID || environment.PASEO_AGENT_ID || "";
  // Prefer the token injected by agent.session_open, falling back to SQLite lookup via PASEO_AGENT_ID
  // so sessions opened before a plugin reload still authenticate without needing recreation.
  const resolvedAgentToken =
    (typeof environment.SLP_AGENT_TOKEN === "string" && environment.SLP_AGENT_TOKEN.trim())
    || tokenFromExplicitUrl
    || (targetAgentId ? lookupAgentTokenInSqlite(activeStateDirectory, targetAgentId) : null);

  const liveBusPort = readSavedBusPort(activeStateDirectory);
  if (resolvedAgentToken && liveBusPort) {
    // Prefer the live bus-port file over a static URL port so plugin reloads that move ports stay reachable.
    return \`http://127.0.0.1:\${liveBusPort}/mcp/\${resolvedAgentToken}\`;
  }
  if (explicitBusUrl) return explicitBusUrl;
  return null;
}

function buildLocalInitializeReply(rpcRequestId, requestedProtocolVersion) {
  const negotiatedVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requestedProtocolVersion)
    ? requestedProtocolVersion
    : SUPPORTED_PROTOCOL_VERSIONS[0];
  return {
    jsonrpc: "2.0",
    id: rpcRequestId,
    result: {
      protocolVersion: negotiatedVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "${BUS_SERVER_NAME}", version: "0.1.0" },
    },
  };
}

function delayMs(durationMs) {
  return new Promise((resolveTimer) => setTimeout(resolveTimer, durationMs));
}

async function forwardRpcToHttpBus(rpcMessage, environment = process.env) {
  let lastForwardError = null;
  for (let attemptIndex = 0; attemptIndex < MAX_FORWARD_ATTEMPTS; attemptIndex += 1) {
    const targetBusEndpoint = resolveAgentBusEndpoint(environment);
    if (!targetBusEndpoint) break;
    try {
      const busHttpResponse = await fetch(targetBusEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(rpcMessage),
      });
      if (busHttpResponse.status === 202) return null;
      const responseText = await busHttpResponse.text();
      if (!responseText.trim()) return null;
      return JSON.parse(responseText);
    } catch (forwardError) {
      lastForwardError = forwardError;
      if (attemptIndex + 1 < MAX_FORWARD_ATTEMPTS) await delayMs(FORWARD_RETRY_DELAY_MS);
    }
  }
  const errorMessage = lastForwardError instanceof Error ? lastForwardError.message : "slp-bus HTTP endpoint unreachable";
  return {
    jsonrpc: "2.0",
    id: rpcMessage.id ?? null,
    result: {
      content: [{ type: "text", text: \`Failed to reach ${BUS_SERVER_NAME}: \${errorMessage}\` }],
      isError: true,
    },
  };
}

export async function handleStdioRpcMessage(rpcMessage, environment = process.env) {
  // JSON-RPC notifications have no id and must never produce a stdout response frame.
  if (!rpcMessage || typeof rpcMessage !== "object" || rpcMessage.id === undefined) return null;
  if (rpcMessage.method === "initialize") {
    const requestedProtocolVersion = String(rpcMessage.params?.protocolVersion ?? "");
    return buildLocalInitializeReply(rpcMessage.id, requestedProtocolVersion);
  }
  if (rpcMessage.method === "ping") {
    return { jsonrpc: "2.0", id: rpcMessage.id, result: {} };
  }
  const targetBusEndpoint = resolveAgentBusEndpoint(environment);
  if (!targetBusEndpoint) {
    // Non-SLP agy sessions share ~/.gemini/config/mcp_config.json, so advertise an empty toolset outside SLP runs.
    if (rpcMessage.method === "tools/list") {
      return { jsonrpc: "2.0", id: rpcMessage.id, result: { tools: [] } };
    }
    if (rpcMessage.method === "tools/call") {
      return {
        jsonrpc: "2.0",
        id: rpcMessage.id,
        result: {
          content: [{ type: "text", text: "${BUS_SERVER_NAME} is only active inside a Paseo SLP Orchestrator run." }],
          isError: true,
        },
      };
    }
    return {
      jsonrpc: "2.0",
      id: rpcMessage.id,
      error: { code: -32601, message: \`Method not found: \${String(rpcMessage.method ?? "")}\` },
    };
  }
  return forwardRpcToHttpBus(rpcMessage, environment);
}

// Only start the stdin loop when invoked as the stdio bridge entrypoint.
if (import.meta.url === \`file://\${process.argv[1]}\`) {
  const stdinLines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  stdinLines.on("line", (rawLine) => {
    const trimmedLine = rawLine.trim();
    if (!trimmedLine) return;
    let parsedRpcPayload;
    try {
      parsedRpcPayload = JSON.parse(trimmedLine);
    } catch {
      process.stdout.write(
        \`\${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\\n\`,
      );
      return;
    }
    const rpcBatch = Array.isArray(parsedRpcPayload) ? parsedRpcPayload : [parsedRpcPayload];
    void Promise.all(rpcBatch.map((rpcRequest) => handleStdioRpcMessage(rpcRequest, process.env)))
      .then((rpcReplies) => {
        const nonNullReplies = rpcReplies.filter((replyPayload) => replyPayload !== null);
        if (nonNullReplies.length === 0) return;
        const wirePayload = Array.isArray(parsedRpcPayload) ? nonNullReplies : nonNullReplies[0];
        process.stdout.write(\`\${JSON.stringify(wirePayload)}\\n\`);
      })
      .catch((bridgeError) => {
        const failureText = bridgeError instanceof Error ? bridgeError.message : String(bridgeError);
        process.stderr.write(\`[slp-mcp-bridge] \${failureText}\\n\`);
      });
  });
}
`;
}

// Mark every SLP bus tool as eager in mcp_config.json so Antigravity injects the role's tool
// parameter schemas directly into the model declaration instead of relying on shared lazy schema files.
function buildEagerToolMap(): Record<BusToolName, { eager: boolean }> {
  const eagerToolsByName = {} as Record<BusToolName, { eager: boolean }>;
  for (const toolName of Object.keys(BUS_TOOL_DEFINITIONS) as BusToolName[]) {
    eagerToolsByName[toolName] = { eager: true };
  }
  return eagerToolsByName;
}

function readExistingMcpConfigObject(mcpConfigPath: string): Record<string, unknown> {
  if (!existsSync(mcpConfigPath)) return { mcpServers: {} };
  try {
    const rawConfigText = readFileSync(mcpConfigPath, "utf8");
    const parsedConfig = JSON.parse(rawConfigText);
    if (parsedConfig && typeof parsedConfig === "object" && !Array.isArray(parsedConfig)) {
      return parsedConfig as Record<string, unknown>;
    }
    return { mcpServers: {} };
  } catch {
    return { mcpServers: {} };
  }
}

export function ensureAntigravityMcpBridge(
  stateDirectory: string,
  options: AntigravityBridgeSetupOptions = {},
): string {
  mkdirSync(stateDirectory, { recursive: true });
  const bridgeScriptPath = join(stateDirectory, BRIDGE_SCRIPT_FILENAME);
  const desiredScriptContent = renderAntigravityBridgeScript(stateDirectory);
  const existingScriptContent = existsSync(bridgeScriptPath)
    ? readFileSync(bridgeScriptPath, "utf8")
    : null;
  // Avoid unnecessary disk writes on every session open when the bridge script is already current.
  if (existingScriptContent !== desiredScriptContent) {
    writeFileSync(bridgeScriptPath, desiredScriptContent, "utf8");
    chmodSync(bridgeScriptPath, 0o755);
  }

  const mcpConfigPath = options.mcpConfigPath ?? defaultAntigravityMcpConfigPath();
  // Use the daemon's own Node binary so child bridges always have node:sqlite regardless of GUI PATH.
  const nodeExecutablePath = options.nodeExecutablePath ?? process.execPath;
  const existingConfigRoot = readExistingMcpConfigObject(mcpConfigPath);
  const existingMcpServers =
    existingConfigRoot.mcpServers
    && typeof existingConfigRoot.mcpServers === "object"
    && !Array.isArray(existingConfigRoot.mcpServers)
      ? (existingConfigRoot.mcpServers as Record<string, unknown>)
      : {};

  const desiredBusServerEntry = {
    command: nodeExecutablePath,
    args: [bridgeScriptPath],
    tools: buildEagerToolMap(),
  };

  const currentBusServerEntry = existingMcpServers[BUS_SERVER_NAME];
  if (JSON.stringify(currentBusServerEntry) !== JSON.stringify(desiredBusServerEntry)) {
    mkdirSync(dirname(mcpConfigPath), { recursive: true });
    const updatedConfigRoot = {
      ...existingConfigRoot,
      mcpServers: {
        ...existingMcpServers,
        [BUS_SERVER_NAME]: desiredBusServerEntry,
      },
    };
    writeFileSync(mcpConfigPath, `${JSON.stringify(updatedConfigRoot, null, 2)}\n`, "utf8");
  }
  return bridgeScriptPath;
}
