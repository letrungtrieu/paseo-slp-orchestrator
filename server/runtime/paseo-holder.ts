// The plugin SDK hands `paseo` to hooks and RPC handlers only, never to the entry function.
// Bus tool calls and the sweeper run outside any handler, so they borrow the instance captured here.
import type { PluginHandlerContext } from "@getpaseo/plugin/server";

export type PaseoApi = PluginHandlerContext["paseo"];

export class PaseoHolder {
  private currentPaseo: PaseoApi | null = null;
  private readonly waiters: Array<(paseo: PaseoApi) => void> = [];

  capture(paseo: PaseoApi): void {
    this.currentPaseo = paseo;
    for (const waiter of this.waiters.splice(0)) waiter(paseo);
  }

  // After a plugin restart no hook has fired yet, so a bus call may have to wait for the first one.
  async get(timeoutMs = 30_000): Promise<PaseoApi> {
    if (this.currentPaseo) return this.currentPaseo;
    return new Promise<PaseoApi>((resolvePaseo, rejectPaseo) => {
      const timeoutHandle = setTimeout(
        () => rejectPaseo(new Error("Paseo SDK is not available yet; retry shortly")),
        timeoutMs,
      );
      this.waiters.push((paseo) => {
        clearTimeout(timeoutHandle);
        resolvePaseo(paseo);
      });
    });
  }

  isReady(): boolean {
    return this.currentPaseo !== null;
  }
}
