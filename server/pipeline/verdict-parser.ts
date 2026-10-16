// The Forked Lead has no tools, so its handshake verdict is parsed out of its reply text.
import { z } from "zod";

const ForkedLeadVerdictSchema = z.object({
  verdict: z.enum(["approve", "clarify", "escalate"]),
  message: z.string().default(""),
});
export type ForkedLeadVerdict = z.infer<typeof ForkedLeadVerdictSchema>;

function candidateJsonBlocks(replyText: string): string[] {
  const candidates: string[] = [];
  // fenced blocks first: that is what the prompt asks for
  for (const fencedMatch of replyText.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    candidates.push(fencedMatch[1].trim());
  }
  // fall back to any brace pair, scanning from the end so the final answer wins over quoted examples
  const lastOpenBrace = replyText.lastIndexOf("{");
  const lastCloseBrace = replyText.lastIndexOf("}");
  if (lastOpenBrace !== -1 && lastCloseBrace > lastOpenBrace) {
    candidates.push(replyText.slice(lastOpenBrace, lastCloseBrace + 1));
  }
  return candidates.reverse();
}

export function parseForkedLeadVerdict(replyText: string | null): ForkedLeadVerdict | null {
  if (!replyText) return null;
  for (const candidate of candidateJsonBlocks(replyText)) {
    try {
      const parsedVerdict = ForkedLeadVerdictSchema.safeParse(JSON.parse(candidate));
      if (parsedVerdict.success) return parsedVerdict.data;
    } catch {
      // not JSON; try the next candidate
    }
  }
  return null;
}
