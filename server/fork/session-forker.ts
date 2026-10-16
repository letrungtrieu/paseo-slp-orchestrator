// Session forking (spec section 2.2): a Forked Lead starts from a copy of the Master Lead's
// provider session, so it knows everything from the survey without touching the Lead's history.
// Each provider family gets an adapter; a failure degrades to a stored-spec briefing, never to a crash.

export interface ForkSource {
  provider: string;
  providerSessionId: string;
}

// How a new agent must be created so it continues from the source session.
export interface NativeForkBinding {
  mode: "native";
  // provider-native options merged into agents.create `config.options`
  providerOptions: Record<string, unknown>;
}

export interface SessionForker {
  readonly family: string;
  // returns null when this adapter cannot fork the given provider
  bind(source: ForkSource): Promise<NativeForkBinding | null>;
}

export interface DegradedForkBinding {
  mode: "stored-spec";
  reason: string;
}

export type ForkBinding = NativeForkBinding | DegradedForkBinding;

export function providerFamily(provider: string): string {
  // "claude/claude-sonnet-5-5" -> "claude"
  return provider.split("/")[0].toLowerCase();
}

export class ForkRegistry {
  constructor(private readonly forkers: readonly SessionForker[]) {}

  async resolve(source: ForkSource | null, provider: string): Promise<ForkBinding> {
    // Without a session id there is nothing to resume, so the Forked Lead falls back to reading the stored spec through tools.
    if (!source) {
      return { mode: "stored-spec", reason: "master lead has no provider session id yet" };
    }
    const family = providerFamily(provider);
    // Matched on the provider family, so any Claude model reuses the same adapter without being listed.
    const matchingForker = this.forkers.find((forker) => forker.family === family);
    if (!matchingForker) {
      return { mode: "stored-spec", reason: `no session forker for provider '${family}'` };
    }
    try {
      const nativeBinding = await matchingForker.bind(source);
      if (nativeBinding) return nativeBinding;
      return { mode: "stored-spec", reason: `${family} native fork is not wired into this plugin` };
    } catch (forkError) {
      // a broken adapter must degrade the handshake context, not abort the whole run
      return {
        mode: "stored-spec",
        reason: `${family} fork failed: ${forkError instanceof Error ? forkError.message : String(forkError)}`,
      };
    }
  }
}
