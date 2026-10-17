import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ensureAntigravityMcpBridge } from "./server/bus/antigravity-mcp-bridge";
import { startBus, type RunningBus } from "./server/bus/http-mcp";
import { claudeForker } from "./server/fork/claude-forker";
import { ForkRegistry } from "./server/fork/session-forker";
import { antigravityForker, codexForker } from "./server/fork/unwired-forkers";
import { registerLifecycleHooks } from "./server/hooks/lifecycle-hooks";
import { createPipeline } from "./server/pipeline/pipeline";
import { createBusDispatcher } from "./server/pipeline/tool-handlers";
import { registerRpcHandlers } from "./server/rpc-handlers";
import { AgentGateway } from "./server/runtime/agent-gateway";
import { PaseoHolder } from "./server/runtime/paseo-holder";
import { RunStore } from "./server/store/run-store";
import { startSweeper } from "./server/sweeper";
import { slpSettings } from "./shared/settings";

// A plain directory under the home folder (not the workspace) so run state survives reinstalling the plugin and is shared by every repo.
const DEFAULT_STATE_DIRECTORY = join(homedir(), ".slp-orchestrator");

// Agents keep the bus URL they were created with, so the previous port is reused when free.
function readSavedBusPort(portFilePath: string): number | null {
  try {
    const savedPort = Number.parseInt(readFileSync(portFilePath, "utf8"), 10);
    return Number.isInteger(savedPort) && savedPort > 0 ? savedPort : null;
  } catch {
    return null;
  }
}

// The entry must return its cleanup function synchronously; slow startup (the bus socket) runs
// in the background and is awaited only by the code that needs it.
export default function contribute(server: PluginServerContext) {
  // Paseo stores this outside project worktrees and publishes settings changes to connected clients.
  const globalSettings = server.registerSettings(slpSettings);
  const stateDirectory = process.env.SLP_HOME ?? DEFAULT_STATE_DIRECTORY;
  // Created eagerly and synchronously: the store must be loaded before any hook or RPC can arrive.
  mkdirSync(stateDirectory, { recursive: true });
  try {
    // Provision the stdio MCP bridge before any Antigravity session opens so agy discovers slp-bus on startup.
    ensureAntigravityMcpBridge(stateDirectory);
  } catch (bridgeInitError) {
    console.error("[slp] failed to provision Antigravity MCP bridge", bridgeInitError);
  }
  // Import the previous JSON layout once; all subsequent writes stay outside project worktrees.
  const store = new RunStore(join(stateDirectory, "orchestrator.sqlite3"), join(stateDirectory, "state.json"));
  // Reloading from disk lets a plugin reload resume the runs that were in flight; the sweeper then re-delivers pending mail.
  store.load();

  const holder = new PaseoHolder();
  const portFilePath = join(stateDirectory, "bus-port");
  let runningBus: RunningBus | null = null;
  let busStopRequested = false;

  const forks = new ForkRegistry([claudeForker, codexForker, antigravityForker]);
  // Resolved lazily through a promise: the gateway is built before the bus is listening, yet agents need its real port in their URL.
  // the dispatcher only needs the pipeline; the pipeline needs the gateway; the gateway needs the bus port
  let resolveBusPort: (port: number) => void = () => undefined;
  const busPortReady = new Promise<number>((resolvePort) => {
    resolveBusPort = resolvePort;
  });
  const gateway = new AgentGateway(holder, store, () => busPortReady);
  const pipeline = createPipeline({ store, gateway, forks, holder, stateDirectory });

  // Not awaited: the entry must return its cleanup function synchronously, so the socket opens in the background.
  startBus(createBusDispatcher(pipeline), readSavedBusPort(portFilePath))
    .then(async (startedBus) => {
      // the plugin may have been stopped while the socket was opening
      if (busStopRequested) return startedBus.close();
      // The port is persisted so agents created before a reload keep working against the same URL.
      runningBus = startedBus;
      writeFileSync(portFilePath, String(startedBus.port), "utf8");
      resolveBusPort(startedBus.port);
      console.log(`[slp] bus listening on 127.0.0.1:${startedBus.port}, state in ${stateDirectory}`);
    })
    .catch((busError) => console.error("[slp] bus failed to start", busError));

  // Hooks and handlers are registered before the bus is ready; anything that needs the bus waits on busPortReady instead.
  registerRpcHandlers(server, pipeline, globalSettings);
  const removeHooks = registerLifecycleHooks(server, pipeline);
  const stopSweeper = startSweeper(pipeline);

  return async () => {
    busStopRequested = true;
    stopSweeper();
    removeHooks();
    await runningBus?.close();
    // flush last so mutations made while shutting down still reach the disk
    await store.flush();
    store.close();
  };
}
