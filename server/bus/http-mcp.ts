// Minimal MCP "streamable HTTP" server, hand written so the plugin has no runtime dependency
// beyond Node. Each agent gets its own URL /mcp/<token>; the token is the agent's identity.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import type { SlpRole } from "../../shared/roles";
import { BUS_TOOL_DEFINITIONS, toolNamesForRole, type BusToolName } from "./tool-schemas";

export interface BusCaller {
  runId: string;
  agentId: string;
  role: SlpRole;
  projectRole?: string | null;
  taskId: string | null;
  // Populated for standalone Spec Agents that operate on a repository's Kanban board outside any SLP Run.
  repoPath?: string | null;
  allowedTools?: readonly BusToolName[] | null;
}

export interface BusToolOutcome {
  text: string;
  isError: boolean;
}

export interface BusTransportDeps {
  resolveCaller(token: string): BusCaller | null;
  // The signal aborts when the agent's connection closes, so a blocking tool (slp_ask) can stop waiting for a caller that is gone.
  dispatch(caller: BusCaller, toolName: string, rawArguments: unknown, abortSignal?: AbortSignal): Promise<BusToolOutcome>;
}

export interface RunningBus {
  port: number;
  close(): Promise<void>;
}

// Newest first: an unknown client version is answered with our latest, which every supported client downgrades from.
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
// Tool payloads are small JSON; 1 MB leaves headroom for a long plan or doc summary without allowing runaway bodies.
const MAX_REQUEST_BYTES = 1_000_000;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function describeTools(caller: BusCaller) {
  const authorizedToolNames = caller.allowedTools ?? toolNamesForRole(caller.role);
  return authorizedToolNames.map((toolName: BusToolName) => {
    const toolDefinition = BUS_TOOL_DEFINITIONS[toolName];
    // io:"input" keeps defaulted fields optional, matching what a caller is allowed to omit
    const { $schema: _ignoredSchemaUri, ...inputSchema } = z.toJSONSchema(toolDefinition.input, {
      io: "input",
    }) as Record<string, unknown>;
    return { name: toolName, description: toolDefinition.description, inputSchema };
  });
}

async function handleRpc(
  rpcRequest: JsonRpcRequest,
  caller: BusCaller,
  deps: BusTransportDeps,
  abortSignal: AbortSignal,
): Promise<unknown | null> {
  // Notifications (no id) must never get a response body, otherwise the client's JSON-RPC state machine desyncs.
  const isNotification = rpcRequest.id === undefined;
  if (isNotification) return null;
  const respondWith = (result: unknown) => ({ jsonrpc: "2.0", id: rpcRequest.id, result });
  switch (rpcRequest.method) {
    case "initialize": {
      const requestedVersion = String(rpcRequest.params?.protocolVersion ?? "");
      // echo a version we know; clients reject servers that answer with something unexpected
      const negotiatedVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)
        ? requestedVersion
        : SUPPORTED_PROTOCOL_VERSIONS[0];
      return respondWith({
        protocolVersion: negotiatedVersion,
        // listChanged is false because each token's tool list is fixed by its role for the agent's whole life.
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "slp-bus", version: "0.1.0" },
      });
    }
    case "ping":
      return respondWith({});
    case "tools/list":
      // The list is built from the caller's role (or explicit tool subset) so an agent only discovers tools it may call.
      return respondWith({ tools: describeTools(caller) });
    case "tools/call": {
      const toolName = String(rpcRequest.params?.name ?? "");
      // Dispatch errors come back as isError content, not JSON-RPC errors, so the model sees the message and can correct its call.
      const toolOutcome = await deps.dispatch(caller, toolName, rpcRequest.params?.arguments ?? {}, abortSignal);
      return respondWith({
        content: [{ type: "text", text: toolOutcome.text }],
        isError: toolOutcome.isError,
      });
    }
    default:
      return {
        jsonrpc: "2.0",
        id: rpcRequest.id,
        error: { code: -32601, message: `Method not found: ${rpcRequest.method}` },
      };
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const bodyChunks: Buffer[] = [];
    let receivedBytes = 0;
    request.on("data", (chunk: Buffer) => {
      receivedBytes += chunk.length;
      // the bus is loopback only, but an unbounded body would still let a bug exhaust memory
      if (receivedBytes > MAX_REQUEST_BYTES) {
        rejectBody(new Error("request body too large"));
        request.destroy();
        return;
      }
      bodyChunks.push(chunk);
    });
    request.on("end", () => resolveBody(Buffer.concat(bodyChunks).toString("utf8")));
    request.on("error", rejectBody);
  });
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  deps: BusTransportDeps,
): Promise<void> {
  const requestPathMatch = /^\/mcp\/([A-Za-z0-9_-]+)$/.exec((request.url ?? "").split("?")[0]);
  const caller = requestPathMatch ? deps.resolveCaller(requestPathMatch[1]) : null;
  // unknown tokens get a bare 401 so nothing about the run leaks to a stray local process
  if (!caller) return sendJson(response, 401, { error: "unauthorized" });
  // Session termination is acknowledged but stateless: the token, not a transport session, carries identity.
  if (request.method === "DELETE") {
    response.writeHead(200).end();
    return;
  }
  // no server-initiated stream is offered, which the spec allows by answering GET with 405
  if (request.method !== "POST") {
    response.writeHead(405, { allow: "POST, DELETE" }).end();
    return;
  }
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(await readBody(request));
  } catch {
    return sendJson(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  // JSON-RPC allows batches; handling both shapes keeps different MCP clients working.
  const rpcRequests = (Array.isArray(parsedBody) ? parsedBody : [parsedBody]) as JsonRpcRequest[];
  // Blocking tools hold this request open; the controller aborts them when the client disconnects before the reply is written.
  const connectionClosed = new AbortController();
  response.once("close", () => connectionClosed.abort());
  const rpcResponses = (
    await Promise.all(rpcRequests.map((rpcRequest) => handleRpc(rpcRequest, caller, deps, connectionClosed.signal)))
  ).filter((rpcResponse) => rpcResponse !== null);
  // A batch of only notifications must answer 202 with no body, as the streamable HTTP transport requires.
  if (rpcResponses.length === 0) {
    response.writeHead(202).end();
    return;
  }
  sendJson(response, 200, Array.isArray(parsedBody) ? rpcResponses : rpcResponses[0]);
}

function listen(port: number, deps: BusTransportDeps): Promise<RunningBus> {
  return new Promise((resolveBus, rejectBus) => {
    const httpServer = createServer((request, response) => {
      // A bug in one request must not crash the daemon plugin; it is logged and answered with a 500 if nothing was sent yet.
      handleHttpRequest(request, response, deps).catch((handlerError) => {
        console.error("[slp-bus] request failed", handlerError);
        if (!response.headersSent) sendJson(response, 500, { error: "internal error" });
      });
    });
    httpServer.once("error", rejectBus);
    // 127.0.0.1 only: the bus carries agent identity tokens and must never be network reachable
    httpServer.listen(port, "127.0.0.1", () => {
      // Port 0 yields an ephemeral port, so the real bound port is read back for the URLs given to agents.
      const boundPort = (httpServer.address() as AddressInfo).port;
      resolveBus({
        port: boundPort,
        close: () => new Promise((resolveClose) => httpServer.close(() => resolveClose())),
      });
    });
  });
}

// Agents keep the URL they were created with, so reuse the previous port when it is still free.
export async function startBus(deps: BusTransportDeps, preferredPort: number | null): Promise<RunningBus> {
  if (preferredPort) {
    try {
      return await listen(preferredPort, deps);
    } catch {
      // port taken by another process: fall through to an ephemeral port
    }
  }
  return listen(0, deps);
}
