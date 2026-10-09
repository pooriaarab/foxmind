// Tool calls in the text of small models that have no tool call API.
import type { ToolCall } from "../types.js";

/** Qwen3 and Hermes-style models write tool calls as <tool_call>{"name": …, "arguments": …}</tool_call>. */
export function parseToolCalls(text: string): { content: string; toolCalls: ToolCall[] } {
  const toolCalls: ToolCall[] = [];
  const content = text.replace(/<tool_call>([\s\S]*?)(<\/tool_call>|$)/g, (_, body: string) => {
    const raw = body.trim();
    let name = raw.match(/"name"\s*:\s*"([^"]+)"/)?.[1] ?? "unknown";
    let args = raw;
    try {
      const parsed = JSON.parse(raw) as { name?: string; arguments?: unknown };
      name = parsed.name ?? name;
      args = typeof parsed.arguments === "string" ? parsed.arguments : JSON.stringify(parsed.arguments ?? {});
    } catch {
      // checkReply() reports the raw text as a bad tool call.
    }
    toolCalls.push({ id: `call_${toolCalls.length}`, type: "function", function: { name, arguments: args } });
    return "";
  });
  return { content: content.trim(), toolCalls };
}
