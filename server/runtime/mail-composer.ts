// Builds the single prompt that carries everything queued for one agent. Paseo cancels an active turn on a
// new prompt, so mail cannot be split into several prompts; instead it is grouped by kind, ordered by how
// urgent it is to the sender, and stripped of reminders that the same prompt already makes redundant.
import type { MailboxMessage } from "../../shared/state";

export type MailClass = "question" | "answer" | "assignment" | "notice" | "reminder";

// Questions first: their askers are blocked inside a tool call and every second of delay is theirs to wait.
const CLASS_ORDER: readonly MailClass[] = ["question", "answer", "assignment", "notice", "reminder"];

const CLASS_HEADINGS: Readonly<Record<MailClass, string>> = {
  question: "## Questions waiting for your answer",
  answer: "## Answers to your questions",
  assignment: "## Assignments and instructions",
  notice: "## Notices (information only)",
  reminder: "## Reminders",
};

const MESSAGE_SEPARATOR = "\n\n---\n\n";

// A reminder only repeats an obligation; when the same prompt already carries that obligation fresh, the reminder is noise.
function dropRedundantMail(messages: MailboxMessage[]): MailboxMessage[] {
  const freshOwedTools = new Set(messages.filter((message) => !message.isReminder && message.awaitTool).map((message) => message.awaitTool));
  const freshQuestionIds = new Set(messages.filter((message) => !message.isReminder && message.questionId).map((message) => message.questionId));
  const seenTexts = new Set<string>();
  return messages.filter((message) => {
    if (message.isReminder && message.awaitTool && freshOwedTools.has(message.awaitTool)) return false;
    if (message.isReminder && message.questionId && freshQuestionIds.has(message.questionId)) return false;
    // Identical text queued twice (for example a retried notice) is shown once.
    if (seenTexts.has(message.text)) return false;
    seenTexts.add(message.text);
    return true;
  });
}

export function composeMailPrompt(messages: MailboxMessage[], classify: (message: MailboxMessage) => MailClass): string {
  const relevantMessages = dropRedundantMail(messages);
  const messagesByClass = new Map<MailClass, MailboxMessage[]>();
  for (const message of relevantMessages) {
    const messageClass = classify(message);
    messagesByClass.set(messageClass, [...(messagesByClass.get(messageClass) ?? []), message]);
  }
  const presentClasses = CLASS_ORDER.filter((messageClass) => messagesByClass.has(messageClass));
  // With a single kind there is nothing to tell apart, so the prompt stays exactly as the sender wrote it.
  if (presentClasses.length <= 1) return relevantMessages.map((message) => message.text).join(MESSAGE_SEPARATOR);
  return presentClasses
    .map((messageClass) => {
      const sectionBody = messagesByClass.get(messageClass)!.map((message) => message.text).join(MESSAGE_SEPARATOR);
      return `${CLASS_HEADINGS[messageClass]}\n\n${sectionBody}`;
    })
    .join("\n\n====\n\n");
}
