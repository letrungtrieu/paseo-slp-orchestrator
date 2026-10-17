import { describe, expect, it } from "vitest";
import { AcceptanceReportSchema, StoredAcceptanceReportSchema } from "../shared/reports";

const COMPLETE_ACCEPTANCE_REPORT = {
  summary: "The dynamic pipeline result is ready.",
  changedFiles: ["src/ingestion.ts"],
  technicalDecisions: ["Keep the existing parser boundary."],
  verificationSummary: "Focused stage checks pass with no new trust boundary issues.",
  risks: ["Large imports still need monitoring."],
};

describe("acceptance report validation", () => {
  // The required evidence fields replace the old document-heading check.
  it.each(["summary", "verificationSummary"] as const)("rejects blank %s", (requiredField) => {
    expect(AcceptanceReportSchema.safeParse({ ...COMPLETE_ACCEPTANCE_REPORT, [requiredField]: "  " }).success).toBe(false);
  });

  it("allows a task with no new technical decisions or outstanding risks", () => {
    expect(AcceptanceReportSchema.parse({ ...COMPLETE_ACCEPTANCE_REPORT, technicalDecisions: [], risks: [] }))
      .toMatchObject({ technicalDecisions: [], risks: [] });
  });

  // Historic prose remains readable, but a new tool submission must carry structured evidence.
  it("accepts legacy text only in the stored report envelope", () => {
    expect(StoredAcceptanceReportSchema.safeParse({ report: "Old Markdown", submittedBy: "legacy-import", submittedAt: "2026-01-01" }).success).toBe(true);
    expect(AcceptanceReportSchema.safeParse("Old Markdown").success).toBe(false);
  });
});
