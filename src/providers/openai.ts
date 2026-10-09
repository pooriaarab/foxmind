// Any server that speaks the OpenAI chat completions API: llama.cpp
// llama-server, Ollama, LM Studio, OpenAI, OpenRouter and many more.
import { FoxmindError } from "../errors.js";
import { call, failure, type Fetched, type Origin } from "../http.js";
import { checkReply } from "../reply.js";
import { events } from "../sse.js";
import type { ChatOptions, ChatReply, FinishReason, Message, Probe, Provider, ProviderStatus, Tier, ToolCall } from "../types.js";

export interface OpenAICompatibleOptions {
  /** The API root, with the version: "http://127.0.0.1:8080/v1", "https://api.openai.com/v1". */
  baseURL: string;
  model: string;
  /** Sent as "Authorization: Bearer". foxmind keeps it in memory only and hides it from every error. */
  apiKey?: string;
  /** The model for embed(). Default: `model`. */
  embedModel?: string;
  /** Default "openai-compatible". */
  name?: string;
  /** Default "local" for localhost and 127.0.0.1, else "cloud". */
  tier?: Tier;
  headers?: Record<string, string>;
  /** Extra fields for every chat request, for example llama.cpp's `chat_template_kwargs`. */
  body?: Record<string, unknown>;
  /**
   * How probe() checks the server's model list: true = it must list `model`,
   * a RegExp = one id must match, false = do not check. Default true.
   */
  checkModel?: boolean | RegExp;
  /** Added to the reason of a failed probe, for example the command that starts the server. */
  hint?: string;
  /** Default 120000 for chat and embed. probe() always uses 3000. */
  timeoutMs?: number;
}

type WireMessage = { role?: string; content?: string | null; tool_calls?: ToolCall[]; reasoning_content?: string; reasoning?: string };
type Chunk = {
  choices?: { delta?: WireMessage & { tool_calls?: (Partial<ToolCall> & { index?: number; function?: Partial<ToolCall["function"]> })[] }; finish_reason?: string | null }[];
  usage?: Completion["usage"];
  error?: string | { message?: string };
};
type Completion = { choices?: { message?: WireMessage; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };

export function finishReason(value: string | null | undefined): FinishReason {
  if (value === "tool_calls" || value === "function_call") return "tool_calls";
  if (value === "length" || value === "content_filter") return value;
  return "stop";
}

/** The wire message without the fields only foxmind uses. */
export function toWire(message: Message) {
  const { reasoning: _reasoning, provider_data: _data, ...wire } = message;
  return wire;
}

export function isLocalURL(url: string): boolean {
  return /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?(\/|$)/i.test(url);
}

export function openaiCompatible(options: OpenAICompatibleOptions): Provider {
  const baseURL = options.baseURL.replace(/\/+$/, "");
  const name = options.name ?? "openai-compatible";
  const tier = options.tier ?? (isLocalURL(baseURL) ? "local" : "cloud");
  const origin: Origin = { provider: name, tier, secrets: [options.apiKey] };
  const headers = { ...options.headers, ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}) };
  const timeout = options.timeoutMs ?? 120_000;
  let last: Probe | undefined;

  function request(messages: Message[], chat: ChatOptions, stream: boolean) {
    return {
      ...options.body,
      model: options.model,
      messages: messages.map(toWire),
      ...(chat.tools?.length ? { tools: chat.tools } : {}),
      ...(chat.json ? { response_format: { type: "json_object" } } : {}),
      ...(chat.temperature === undefined ? {} : { temperature: chat.temperature }),
      ...(chat.maxTokens === undefined ? {} : { max_tokens: chat.maxTokens }),
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    };
  }

  function reply(data: Completion): ChatReply {
    const choice = data.choices?.[0];
    if (!choice?.message) throw failure(origin, "bad_response", "The reply has no choices[0].message.");
    const wire = choice.message;
    const reasoning = wire.reasoning_content ?? wire.reasoning;
    const message: ChatReply["message"] = {
      role: "assistant",
      content: wire.content ?? null,
      ...(wire.tool_calls?.length ? { tool_calls: wire.tool_calls } : {}),
      ...(reasoning ? { reasoning } : {}),
    };
    const usage = data.usage ? { inputTokens: data.usage.prompt_tokens ?? 0, outputTokens: data.usage.completion_tokens ?? 0 } : undefined;
    return { message, finishReason: finishReason(choice.finish_reason), ...(usage ? { usage } : {}) };
  }

  /** Join streamed pieces into one completion, calling onDelta with each piece of text. */
  async function collect(fetched: Fetched, onDelta: (text: string) => void): Promise<Completion> {
    const message: WireMessage & { content: string } = { content: "" };
    const calls: ToolCall[] = [];
    let finish: string | undefined;
    let done = false;
    let usage: Completion["usage"];
    try {
      for await (const event of events(fetched.body!)) {
        if (event.data === "[DONE]") {
          done = true;
          break;
        }
        let chunk: Chunk;
        try {
          chunk = JSON.parse(event.data) as Chunk;
        } catch {
          throw failure(origin, "bad_response", `The stream sent data that is not JSON: ${event.data.slice(0, 120)}`, { partial: message.content });
        }
        if (chunk.error) {
          const said = typeof chunk.error === "string" ? chunk.error : chunk.error.message;
          throw failure(origin, "http", `The server sent an error in the stream: ${said ?? event.data}`, { partial: message.content });
        }
        usage = chunk.usage ?? usage;
        const choice = chunk.choices?.[0];
        const delta = choice?.delta ?? {};
        if (delta.content) {
          message.content += delta.content;
          onDelta(delta.content);
        }
        const thought = delta.reasoning_content ?? delta.reasoning;
        if (thought) message.reasoning_content = (message.reasoning_content ?? "") + thought;
        for (const piece of delta.tool_calls ?? []) {
          // With no index, a new id starts a new call; otherwise the piece belongs to the last call.
          const top = calls.length - 1;
          const index = piece.index ?? (top < 0 || (piece.id && piece.id !== calls[top]!.id) ? top + 1 : top);
          const slot = (calls[index] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
          if (piece.id) slot.id = piece.id;
          // Some servers repeat the name in every piece: keep the first one.
          if (piece.function?.name && !slot.function.name) slot.function.name = piece.function.name;
          slot.function.arguments += piece.function?.arguments ?? "";
        }
        finish = choice?.finish_reason ?? finish;
      }
    } catch (error) {
      if (error instanceof FoxmindError) throw error;
      // A connection that drops after the server said it was done lost nothing.
      if (!finish) throw fetched.fail(error, message.content);
    }
    if (!done && !finish) throw failure(origin, "stream_interrupted", "The stream ended before the server said it was done.", { partial: message.content });
    const toolCalls = calls.filter(Boolean);
    return {
      choices: [{ message: { ...message, content: message.content || (toolCalls.length ? null : ""), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    };
  }

  return {
    name,
    tier,
    model: options.model,
    capabilities: ["chat", "embed"],

    async probe(probeOptions = {}) {
      try {
        const fetched = await call(origin, `${baseURL}/models`, { headers, ...probeOptions, timeoutMs: probeOptions.timeoutMs ?? 3000 }, 3000);
        const ids = ((await fetched.json<{ data?: { id: string }[] }>()).data ?? []).map((model) => model.id);
        const check = options.checkModel ?? true;
        const found = check === false || (check instanceof RegExp ? ids.some((id) => check.test(id)) : ids.includes(options.model));
        last = found
          ? { ok: true, where: baseURL }
          : { ok: false, code: "model_not_found", where: baseURL, reason: `The server does not list ${check instanceof RegExp ? String(check) : `"${options.model}"`}. It has: ${ids.join(", ") || "no models"}.` };
      } catch (error) {
        const failed = error as { code?: string; message?: string };
        last = { ok: false, code: failed.code ?? "unreachable", where: baseURL, reason: failed.message ?? String(error) };
      }
      if (!last.ok && options.hint) last.reason = `${last.reason} ${options.hint}`;
      return last;
    },

    status(): ProviderStatus {
      return {
        name,
        tier,
        model: options.model,
        capabilities: ["chat", "embed"],
        state: !last ? "idle" : last.ok ? "ready" : "unavailable",
        where: baseURL,
        ...(last?.reason ? { reason: last.reason } : {}),
      };
    },

    async chat(messages, chat) {
      const url = `${baseURL}/chat/completions`;
      const stream = chat.onDelta !== undefined;
      const fetched = await call(origin, url, { ...chat, headers, body: request(messages, chat, stream) }, timeout);
      const data = chat.onDelta ? await collect(fetched, chat.onDelta) : await fetched.json<Completion>();
      return checkReply(origin, reply(data), chat.json);
    },

    async embed(texts, embed) {
      const url = `${baseURL}/embeddings`;
      const fetched = await call(origin, url, { ...embed, headers, body: { model: options.embedModel ?? options.model, input: texts } }, timeout);
      const data = (await fetched.json<{ data?: { index: number; embedding: number[] }[] }>()).data;
      if (!Array.isArray(data) || data.length !== texts.length) {
        throw failure(origin, "bad_response", `Asked for ${texts.length} embeddings and got ${Array.isArray(data) ? data.length : "none"}.`);
      }
      return data.toSorted((a, b) => a.index - b.index).map((item) => item.embedding);
    },
  };
}
