// Checks every provider runs on a reply before foxmind returns it.
import { failure, type Origin } from "./http.js";
import type { ChatReply, Message } from "./types.js";

/** Move a leading <think>…</think> block out of the answer, as Qwen3 servers often send it. */
export function splitThinking(message: Message): Message {
  const match = message.content?.match(/^\s*<think>([\s\S]*?)<\/think>\s*/);
  if (!match || message.content == null) return message;
  const reasoning = [message.reasoning, match[1]!.trim()].filter(Boolean).join("\n");
  return { ...message, content: message.content.slice(match[0].length), ...(reasoning ? { reasoning } : {}) };
}

/** The JSON text in a reply: the whole reply, or the one ```json block in it. */
function jsonText(content: string): string | undefined {
  for (const candidate of [content.trim(), content.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1]?.trim()]) {
    if (!candidate) continue;
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

/**
 * Throws `bad_tool_call` when a tool call's arguments are not a JSON object,
 * and `bad_json` when the caller asked for JSON and got something else.
 * Empty arguments become "{}", which is what servers send for a tool with no parameters.
 */
export function checkReply(origin: Origin, reply: ChatReply, json: boolean | undefined): ChatReply {
  const message = splitThinking(reply.message);
  const calls = message.tool_calls?.map((toolCall) => {
    const text = toolCall.function.arguments.trim() || "{}";
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw failure(origin, "bad_tool_call", `The arguments of tool call "${toolCall.function.name}" are not valid JSON.`, { raw: toolCall.function.arguments });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw failure(origin, "bad_tool_call", `The arguments of tool call "${toolCall.function.name}" are not a JSON object.`, { raw: text });
    }
    return { ...toolCall, function: { ...toolCall.function, arguments: text } };
  });
  if (calls?.length) message.tool_calls = calls;
  else delete message.tool_calls;
  if (json && !calls?.length) {
    const text = jsonText(message.content ?? "");
    if (text === undefined) throw failure(origin, "bad_json", "The reply is not JSON, but the call asked for JSON.", { raw: message.content ?? "" });
    message.content = text;
  }
  const finishReason = calls?.length && reply.finishReason === "stop" ? "tool_calls" : reply.finishReason;
  return { ...reply, message: message as ChatReply["message"], finishReason };
}
