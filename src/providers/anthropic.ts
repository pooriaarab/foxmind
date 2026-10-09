// The Anthropic Messages API, mapped to the OpenAI shape both ways. The caller
// passes the key; foxmind keeps it in memory only and never stores it.
import { FoxmindError } from "../errors.js";
import { call, failure, type Fetched, type Origin } from "../http.js";
import { checkReply } from "../reply.js";
import { events } from "../sse.js";
import type { ChatOptions, ChatReply, FinishReason, Message, Probe, Provider, ProviderStatus } from "../types.js";

export interface AnthropicOptions {
  apiKey: string;
  /** Default "claude-opus-5-5". */
  model?: string;
  /** Default "https://api.anthropic.com". */
  baseURL?: string;
  /** Default 16000. The Messages API needs a value. */
  maxTokens?: number;
  /** Default "anthropic". */
  name?: string;
  /** Default 300000. */
  timeoutMs?: number;
  headers?: Record<string, string>;
}

type Block = { type: string; text?: string; id?: string; name?: string; input?: unknown; thinking?: string; signature?: string; [key: string]: unknown };
type Wire = { role: string; content: string | Block[] };
type Reply = { content?: Block[]; stop_reason?: string; usage?: { input_tokens?: number; output_tokens?: number } };

const JSON_RULE = "Reply with one JSON object and nothing else: no prose and no code fence.";

function finishReason(stop: string | undefined): FinishReason {
  if (stop === "tool_use") return "tool_calls";
  if (stop === "max_tokens") return "length";
  if (stop === "refusal") return "content_filter";
  return "stop";
}

export function anthropic(options: AnthropicOptions): Provider {
  const baseURL = (options.baseURL ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const model = options.model ?? "claude-opus-5-5";
  const name = options.name ?? "anthropic";
  const origin: Origin = { provider: name, tier: "cloud", secrets: [options.apiKey] };
  const timeout = options.timeoutMs ?? 300_000;
  let last: Probe | undefined;
  const headers = () => ({
    ...options.headers,
    "x-api-key": options.apiKey,
    "anthropic-version": "2023-06-01",
    // Lets a browser extension page call the API with the user's own key.
    "anthropic-dangerous-direct-browser-access": "true",
  });

  /** OpenAI messages to Anthropic: leading system messages, grouped tool results, tool_use blocks. */
  function toWire(messages: Message[]): { system: string[]; messages: Wire[] } {
    const system: string[] = [];
    const out: Wire[] = [];
    for (const message of messages) {
      if (message.role === "system") {
        if (out.length) out.push({ role: "system", content: message.content ?? "" });
        else system.push(message.content ?? "");
      } else if (message.role === "user") {
        out.push({ role: "user", content: message.content ?? "" });
      } else if (message.role === "tool") {
        const result: Block = { type: "tool_result", tool_use_id: message.tool_call_id, content: message.content ?? "" };
        const previous = out.at(-1);
        if (previous?.role === "user" && Array.isArray(previous.content) && previous.content.every((block) => block.type === "tool_result")) previous.content.push(result);
        else out.push({ role: "user", content: [result] });
      } else {
        const saved = (message.provider_data?.anthropic as { content?: Block[] } | undefined)?.content;
        if (saved) {
          out.push({ role: "assistant", content: saved });
          continue;
        }
        if (!message.tool_calls?.length) {
          out.push({ role: "assistant", content: message.content ?? "" });
          continue;
        }
        const blocks: Block[] = message.content ? [{ type: "text", text: message.content }] : [];
        for (const toolCall of message.tool_calls) {
          let input: unknown;
          try {
            input = JSON.parse(toolCall.function.arguments || "{}");
          } catch {
            throw failure(origin, "bad_tool_call", `Past tool call "${toolCall.function.name}" in the messages has arguments that are not JSON.`, { raw: toolCall.function.arguments });
          }
          blocks.push({ type: "tool_use", id: toolCall.id, name: toolCall.function.name, input });
        }
        out.push({ role: "assistant", content: blocks });
      }
    }
    return { system, messages: out };
  }

  function toReply(data: Reply): ChatReply {
    if (!Array.isArray(data.content)) throw failure(origin, "bad_response", "The reply has no content array.");
    const text = data.content.filter((block) => block.type === "text").map((block) => block.text ?? "");
    const toolCalls = data.content
      .filter((block) => block.type === "tool_use")
      .map((block) => ({ id: block.id ?? "", type: "function" as const, function: { name: block.name ?? "", arguments: JSON.stringify(block.input ?? {}) } }));
    // Thinking blocks must go back unchanged with the next turn.
    const keep = data.content.some((block) => block.type === "thinking" || block.type === "redacted_thinking");
    return {
      message: {
        role: "assistant",
        content: text.length ? text.join("") : null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        ...(keep ? { provider_data: { anthropic: { content: data.content } } } : {}),
      },
      finishReason: finishReason(data.stop_reason),
      usage: { inputTokens: data.usage?.input_tokens ?? 0, outputTokens: data.usage?.output_tokens ?? 0 },
    };
  }

  /** Join a stream of Messages API events into one reply. */
  async function collect(fetched: Fetched, onDelta: (text: string) => void): Promise<Reply> {
    const blocks: Block[] = [];
    const json: string[] = [];
    const reply: Reply = { usage: {} };
    let text = "";
    let done = false;
    try {
      for await (const event of events(fetched.response.body!)) {
        const data = JSON.parse(event.data) as { type: string; index?: number; content_block?: Block; delta?: Record<string, string>; message?: Reply; usage?: Reply["usage"]; error?: { type?: string; message?: string } };
        const index = data.index ?? 0;
        if (data.type === "message_start") reply.usage = { ...data.message?.usage };
        else if (data.type === "content_block_start") blocks[index] = { ...data.content_block! };
        else if (data.type === "content_block_delta" && data.delta) {
          const block = blocks[index]!;
          const delta = data.delta;
          if (delta.type === "text_delta") {
            block.text = (block.text ?? "") + delta.text;
            text += delta.text;
            onDelta(delta.text!);
          } else if (delta.type === "input_json_delta") json[index] = (json[index] ?? "") + delta.partial_json;
          else if (delta.type === "thinking_delta") block.thinking = (block.thinking ?? "") + delta.thinking;
          else if (delta.type === "signature_delta") block.signature = delta.signature;
        } else if (data.type === "content_block_stop" && blocks[index]?.type === "tool_use") {
          const raw = json[index] ?? "";
          try {
            blocks[index]!.input = raw.trim() ? JSON.parse(raw) : {};
          } catch {
            throw failure(origin, "bad_tool_call", `The arguments of tool call "${blocks[index]!.name}" are not valid JSON.`, { raw, partial: text });
          }
        } else if (data.type === "message_delta") {
          reply.stop_reason = data.delta?.stop_reason ?? reply.stop_reason;
          reply.usage = { ...reply.usage, ...data.usage };
        } else if (data.type === "message_stop") done = true;
        else if (data.type === "error") {
          const kind = data.error?.type;
          const said = `The API sent an error in the stream: ${data.error?.message ?? kind}`;
          if (kind === "rate_limit_error") throw failure(origin, "rate_limited", said, { partial: text });
          if (kind === "authentication_error") throw failure(origin, "auth", said, { partial: text });
          throw failure(origin, "http", said, { partial: text, ...(kind === "overloaded_error" ? { status: 529 } : {}) });
        }
      }
    } catch (error) {
      if (error instanceof FoxmindError) throw error;
      if (error instanceof SyntaxError) throw failure(origin, "bad_response", "The stream sent data that is not JSON.", { partial: text });
      throw fetched.fail(error, text);
    }
    if (!done) throw failure(origin, "stream_interrupted", "The stream ended before message_stop.", { partial: text });
    return { ...reply, content: blocks.filter(Boolean) };
  }

  return {
    name,
    tier: "cloud",
    model,
    capabilities: ["chat"],

    async probe(probeOptions = {}) {
      try {
        await call(origin, `${baseURL}/v1/models/${encodeURIComponent(model)}`, { headers: headers(), ...probeOptions, timeoutMs: probeOptions.timeoutMs ?? 5000 }, 5000);
        last = { ok: true, where: baseURL };
      } catch (error) {
        const failed = error as FoxmindError;
        last = { ok: false, code: failed.code ?? "unreachable", reason: failed.message, where: baseURL };
      }
      return last;
    },

    status(): ProviderStatus {
      return { name, tier: "cloud", model, capabilities: ["chat"], state: !last ? "idle" : last.ok ? "ready" : "unavailable", where: baseURL, ...(last?.reason ? { reason: last.reason } : {}) };
    },

    async chat(messages, chat: ChatOptions) {
      const wire = toWire(messages);
      const system = [...wire.system, ...(chat.json ? [JSON_RULE] : [])].join("\n\n");
      const body = {
        model,
        max_tokens: chat.maxTokens ?? options.maxTokens ?? 16_000,
        ...(system ? { system } : {}),
        ...(chat.tools?.length ? { tools: chat.tools.map((tool) => ({ name: tool.function.name, ...(tool.function.description ? { description: tool.function.description } : {}), input_schema: tool.function.parameters ?? { type: "object", properties: {} } })) } : {}),
        ...(chat.temperature === undefined ? {} : { temperature: chat.temperature }),
        messages: wire.messages,
        ...(chat.onDelta ? { stream: true } : {}),
      };
      const fetched = await call(origin, `${baseURL}/v1/messages`, { ...chat, headers: headers(), body }, timeout);
      const data = chat.onDelta ? await collect(fetched, chat.onDelta) : await fetched.json<Reply>();
      return checkReply(origin, toReply(data), chat.json);
    },
  };
}
