import { describe, expect, it } from "vitest";
import { composeMailPrompt, type MailClass } from "../server/runtime/mail-composer";
import type { MailboxMessage } from "../shared/state";

let nextMessageNumber = 0;
function mail(text: string, overrides: Partial<MailboxMessage> = {}): MailboxMessage {
  nextMessageNumber += 1;
  return {
    id: `mail-${nextMessageNumber}`, toAgentId: "agent-1", text, taskId: null, awaitTool: null, isReminder: false,
    questionId: null, supersedeKey: null, createdAt: "2026-01-01T00:00:00.000Z", ...overrides,
  };
}

// Classification normally consults the ledger; the unit test fixes it by marker words in the message id.
const classifyByMarker = (message: MailboxMessage): MailClass => {
  if (message.questionId) return message.text.startsWith("Answer") ? "answer" : "question";
  if (message.isReminder) return "reminder";
  return message.awaitTool ? "assignment" : "notice";
};

describe("composeMailPrompt", () => {
  it("leaves a single kind of mail exactly as written, without headings", () => {
    const prompt = composeMailPrompt([mail("first notice"), mail("second notice")], classifyByMarker);
    expect(prompt).toBe("first notice\n\n---\n\nsecond notice");
    expect(prompt).not.toContain("##");
  });

  it("groups mixed mail under headings with questions before assignments before notices", () => {
    const prompt = composeMailPrompt([
      mail("a plain notice"),
      mail("review the stage", { awaitTool: "slp_approve_stage" }),
      mail("What is the cap?", { questionId: "q-1" }),
    ], classifyByMarker);
    const questionAt = prompt.indexOf("## Questions waiting for your answer");
    const assignmentAt = prompt.indexOf("## Assignments and instructions");
    const noticeAt = prompt.indexOf("## Notices");
    expect(questionAt).toBeGreaterThanOrEqual(0);
    expect(questionAt).toBeLessThan(assignmentAt);
    expect(assignmentAt).toBeLessThan(noticeAt);
    expect(prompt.slice(questionAt, assignmentAt)).toContain("What is the cap?");
  });

  it("drops a reminder when the same prompt already carries that obligation or question fresh", () => {
    const prompt = composeMailPrompt([
      mail("You ended your turn without slp_stage_report", { awaitTool: "slp_stage_report", isReminder: true }),
      mail("Fresh stage assignment", { awaitTool: "slp_stage_report" }),
      mail("Reminder: still blocked on q-1", { questionId: "q-1", isReminder: true }),
      mail("What is the cap?", { questionId: "q-1" }),
    ], classifyByMarker);
    expect(prompt).not.toContain("You ended your turn");
    expect(prompt).not.toContain("Reminder: still blocked");
    expect(prompt).toContain("Fresh stage assignment");
    expect(prompt).toContain("What is the cap?");
  });

  it("keeps a reminder that has no fresher mail to replace it, and collapses identical texts", () => {
    const prompt = composeMailPrompt([
      mail("nudge", { awaitTool: "slp_stage_report", isReminder: true }),
      mail("same text"),
      mail("same text"),
    ], classifyByMarker);
    expect(prompt).toContain("nudge");
    expect(prompt.match(/same text/g)).toHaveLength(1);
  });
});
