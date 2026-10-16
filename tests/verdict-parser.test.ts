import { describe, expect, it } from "vitest";
import { parseForkedLeadVerdict } from "../server/pipeline/verdict-parser";

describe("parseForkedLeadVerdict", () => {
  // the prompt asks for a fenced block, so this is the main happy path
  it("parses a fenced json block", () => {
    const reply = 'Looks good.\n```json\n{"verdict":"approve","message":"ok"}\n```';
    expect(parseForkedLeadVerdict(reply)).toEqual({ verdict: "approve", message: "ok" });
  });

  it("parses a fence without the json language tag", () => {
    expect(parseForkedLeadVerdict('```\n{"verdict":"clarify","message":"why?"}\n```')).toEqual({ verdict: "clarify", message: "why?" });
  });

  // models sometimes drop the fence; the brace scan rescues those replies
  it("falls back to a bare JSON object inside prose", () => {
    expect(parseForkedLeadVerdict('My answer: {"verdict":"escalate","message":"spec wrong"} thanks')).toEqual({
      verdict: "escalate",
      message: "spec wrong",
    });
  });

  // the schema defaults message so a terse {"verdict":"approve"} is still usable
  it("defaults a missing message to an empty string", () => {
    expect(parseForkedLeadVerdict('{"verdict":"approve"}')).toEqual({ verdict: "approve", message: "" });
  });

  it("prefers the last fenced block so the final answer wins over quoted examples", () => {
    const reply = [
      "For reference the format is:",
      '```json\n{"verdict":"clarify","message":"example"}\n```',
      "Final:",
      '```json\n{"verdict":"approve","message":"final"}\n```',
    ].join("\n");
    expect(parseForkedLeadVerdict(reply)?.message).toBe("final");
  });

  it("skips an invalid last block and uses an earlier valid one", () => {
    const reply = '```json\n{"verdict":"approve","message":"valid"}\n```\n```json\nnot json\n```';
    expect(parseForkedLeadVerdict(reply)?.message).toBe("valid");
  });

  // an unknown verdict must never be guessed into an approval
  it("rejects unknown verdict values", () => {
    expect(parseForkedLeadVerdict('{"verdict":"maybe","message":"?"}')).toBeNull();
  });

  // empty or unparseable replies trigger the caller's repair attempt
  it.each([null, "", "no json here at all", "{broken"])("returns null for %j", (reply) => {
    expect(parseForkedLeadVerdict(reply)).toBeNull();
  });

  it("handles a message containing braces inside a fenced block", () => {
    const reply = '```json\n{"verdict":"clarify","message":"use {id} not {name}"}\n```';
    expect(parseForkedLeadVerdict(reply)).toEqual({ verdict: "clarify", message: "use {id} not {name}" });
  });
});
