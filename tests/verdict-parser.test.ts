import { describe, expect, it } from "vitest";
import { PipelineRoleIdSchema, StageReportSubmissionSchema, StageResultSchema, normalizePipelineRoleId } from "../shared/pipeline";

describe("dynamic pipeline role and approval normalization", () => {
  it.each([
    ["QA Engineer", "qa-engineer"],
    ["qa_engineer", "qa-engineer"],
    ["  Frontend  ", "frontend"],
  ])("normalizes the Lead's role spelling %j", (roleText, expectedRole) => {
    expect(normalizePipelineRoleId(roleText)).toBe(expectedRole);
    expect(PipelineRoleIdSchema.parse(roleText)).toBe(expectedRole);
  });

  it("rejects punctuation and empty role identifiers", () => {
    expect(() => PipelineRoleIdSchema.parse("qa/reviewer")).toThrow();
    expect(() => PipelineRoleIdSchema.parse(" ")).toThrow();
  });

  it("defaults a peer report to completed with no findings", () => {
    expect(StageReportSubmissionSchema.parse({ summary: "accepted" })).toEqual({ summary: "accepted", findings: [], status: "completed" });
  });

  it("preserves blocked evidence for the Forked Lead decision", () => {
    const report = StageReportSubmissionSchema.parse({ summary: "blocked", findings: ["missing fixture"], status: "blocked" });
    expect(report.status).toBe("blocked");
    expect(StageResultSchema.parse({ summary: "reworked and accepted", approvedBy: "stage-lead", approvedAt: "2026-01-01" }).approvedBy).toBe("stage-lead");
  });
});
