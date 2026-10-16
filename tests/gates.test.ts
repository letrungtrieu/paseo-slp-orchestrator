import { describe, expect, it } from "vitest";
import { GATE_KINDS, type GateKind } from "../shared/state";
import { RUN_MODES, type RunMode } from "../shared/roles";
import { gateRequired } from "../server/pipeline/gates";

// Spec section 5: which hand-overs stop for the Supreme Manager in each operating mode.
const EXPECTED_OPEN_GATES: Record<RunMode, GateKind[]> = {
  STEP_BY_STEP_DEBUG: ["after_handshake", "after_implementation", "after_verification", "before_merge", "circuit_breaker", "final_approval"],
  SEMI_AUTO: ["before_merge", "circuit_breaker", "final_approval"],
  FULL_AUTO: ["final_approval"],
};

describe("gateRequired", () => {
  for (const runMode of RUN_MODES) {
    it(`matches the spec matrix for ${runMode}`, () => {
      for (const gateKind of GATE_KINDS) {
        expect(gateRequired(runMode, gateKind), `${runMode}/${gateKind}`).toBe(EXPECTED_OPEN_GATES[runMode].includes(gateKind));
      }
    });
  }

  // only the Supreme Manager may merge into the base branch, in every mode
  it("always requires the final approval regardless of mode", () => {
    // only the Supreme Manager may merge into the base branch
    for (const runMode of RUN_MODES) expect(gateRequired(runMode, "final_approval")).toBe(true);
  });
});
