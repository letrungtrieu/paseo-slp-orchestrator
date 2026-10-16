import { describe, expect, it } from "vitest";
import { TASK_PHASES } from "../shared/state";
import { phaseLabel } from "../shared/card";

describe("phaseLabel", () => {
  // the card renders phaseLabel directly, so a blank label would show an empty badge
  it("has a non-empty label for every phase", () => {
    for (const phase of TASK_PHASES) expect(phaseLabel(phase, 0, 3).length).toBeGreaterThan(0);
  });

  it("shows the review round while verifying, starting at 1", () => {
    expect(phaseLabel("verifying", 0, 3)).toBe("Đang kiểm thử (Vòng 1/3)");
    expect(phaseLabel("verifying", 1, 3)).toBe("Đang kiểm thử (Vòng 2/3)");
  });

  it("never shows a round beyond the limit", () => {
    // the 4th review after three fixes would otherwise read "4/3"
    expect(phaseLabel("verifying", 3, 3)).toBe("Đang kiểm thử (Vòng 3/3)");
  });

  // fixing shows loops already used, verifying shows the round about to run
  it("shows the number of completed fix loops while fixing", () => {
    expect(phaseLabel("fixing", 2, 3)).toBe("Đang sửa lỗi (Vòng 2/3)");
  });

  // labels are the Vietnamese strings quoted in specs/MVP.md section 5
  it("uses the wording of the spec for the main phases", () => {
    expect(phaseLabel("handshaking", 0, 3)).toBe("Đang bắt tay");
    expect(phaseLabel("implementing", 0, 3)).toBe("Đang viết code");
    expect(phaseLabel("merged", 0, 3)).toBe("Đã gộp vào dev");
  });
});
