// Any server that speaks the OpenAI chat completions API: llama.cpp
// llama-server, Ollama, LM Studio, OpenAI, OpenRouter and many more.
import { call, failure, type Origin } from "../http.js";
import { checkReply } from "../reply.js";
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
  /** Default 120000 for chat and embed. probe() always uses 3000. */
  timeoutMs?: number;
}

type WireMessage = { role?: string; content?: string | null; tool_calls?: ToolCall[]; reasoning_content?: string; reasoning?: string };
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
      const fetched = await call(origin, url, { ...chat, headers, body: request(messages, chat, false) }, timeout);
      return checkReply(origin, reply(await fetched.json<Completion>()), chat.json);
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
