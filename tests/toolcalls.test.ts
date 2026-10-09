// Failure modes F53-F54 in docs/failure-modes.md: tool calls and thinking in small-model text.
import { describe, expect, it } from "vitest";
import { parseToolCalls } from "../src/browser/toolcalls.js";
import { FoxmindError } from "../src/errors.js";
import { checkReply } from "../src/reply.js";

const origin = { provider: "transformers-chat", tier: "browser" as const, secrets: [] };
const finish = (text: string) => {
  const { content, toolCalls } = parseToolCalls(text);
  return checkReply(origin, { message: { role: "assistant", content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finishReason: "stop" }, false);
};

describe("small-model tool calls", () => {
  it("reads Qwen3 tool calls", () => {
    const reply = finish('I will check.\n<tool_call>\n{"name": "get_weather", "arguments": {"city": "Paris"}}\n</tool_call>');
    expect(reply.finishReason).toBe("tool_calls");
    expect(reply.message.content).toBe("I will check.");
    expect(reply.message.tool_calls).toEqual([{ id: "call_0", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }]);
  });

  it("broken tool call JSON (F53)", () => {
    const error = (() => { try { finish('<tool_call>\n{"name": "get_weather", "arguments": {"city": "Par'); } catch (e) { return e; } })() as FoxmindError;
    expect(error).toBeInstanceOf(FoxmindError);
    expect(error.code).toBe("bad_tool_call");
    expect(error.message).toContain("get_weather");
  });

  it("thinking out loud (F54)", () => {
    const reply = finish("<think>\nThe user wants a greeting.\n</think>\n\nHello!");
    expect(reply.message).toMatchObject({ content: "Hello!", reasoning: "The user wants a greeting." });
  });
});
