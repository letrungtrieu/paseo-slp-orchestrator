// Structured reports replace worktree documents so review requirements can be validated at the tool boundary.
import { z } from "zod";

export const AcceptanceReportSchema = z.object({
  summary: z.string().trim().min(1),
  changedFiles: z.array(z.string().trim().min(1)),
  // A task may introduce no new design decision; an explicit empty list is still a complete report.
  technicalDecisions: z.array(z.string().trim().min(1)),
  verificationSummary: z.string().trim().min(1),
  risks: z.array(z.string().trim().min(1)).default([]),
});
export type AcceptanceReport = z.infer<typeof AcceptanceReportSchema>;

export const StoredAcceptanceReportSchema = z.object({
  // Imported Markdown stays verbatim so migrating an old run cannot manufacture review evidence.
  report: z.union([AcceptanceReportSchema, z.string().min(1)]),
  submittedBy: z.string(),
  submittedAt: z.string(),
});

export const PeerReportSubmissionSchema = z.object({
  summary: z.string().trim().min(1),
  findings: z.array(z.string().trim().min(1)).default([]),
  status: z.enum(["completed", "blocked"]).default("completed"),
});
export type PeerReportSubmission = z.infer<typeof PeerReportSubmissionSchema>;

// Authorship is attached by the bus handler rather than accepted from the model's arguments.
export const StoredPeerReportSchema = PeerReportSubmissionSchema.extend({
  agentId: z.string(), role: z.string(), submittedAt: z.string(),
});
