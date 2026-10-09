// Small models in the browser through transformers.js: embeddings, and small
// chat models such as Qwen3-0.6B. WebGPU when the browser has it, else WASM.
import type { Origin } from "../http.js";
import { checkReply } from "../reply.js";
import type { ChatReply, Message, Provider, ProviderStatus } from "../types.js";
import { loadOnce, onProgress, pickDevice, toBrowserError, transformersJs, type Device } from "./runtime.js";
import { parseToolCalls } from "./toolcalls.js";

export interface TransformersOptions {
  task: "embed" | "chat";
  /** Default "Xenova/all-MiniLM-L6-v2" for embed and "onnx-community/Qwen3-0.6B-ONNX" for chat. */
  model?: string;
  /** Default "auto": WebGPU when the browser has it, else WASM. */
  device?: Device;
  /** Default on WebGPU: "fp16" for embed, "q4f16" for chat. On WASM: "q8" for embed, "q4" for chat. */
  dtype?: string;
  /** Default "transformers-embed" or "transformers-chat". */
  name?: string;
  /** Chat: the most tokens to write. Default 256. */
  maxNewTokens?: number;
  /** Chat: let Qwen3 think before it answers. Default false. */
  thinking?: boolean;
}

type Pipe = ((input: unknown, options?: Record<string, unknown>) => Promise<unknown>) & {
  tokenizer: { apply_chat_template(messages: unknown[], options: Record<string, unknown>): string };
};

export function transformers(options: TransformersOptions): Provider {
  const chat = options.task === "chat";
  const model = options.model ?? (chat ? "onnx-community/Qwen3-0.6B-ONNX" : "Xenova/all-MiniLM-L6-v2");
  const name = options.name ?? `transformers-${options.task}`;
  const origin: Origin = { provider: name, tier: "browser", secrets: [] };
  const capabilities = chat ? (["chat"] as const) : (["embed"] as const);
  const loader = loadOnce(origin, model, options.device ?? "auto", async (device, progress) => {
    const { pipeline } = await transformersJs();
    const dtype = options.dtype ?? (device === "webgpu" ? (chat ? "q4f16" : "fp16") : chat ? "q4" : "q8");
    const task = chat ? "text-generation" : "feature-extraction";
    return (await pipeline(task, model, { device, dtype, progress_callback: onProgress(progress) } as never)) as unknown as Pipe;
  });

  async function run<T>(work: (pipe: Pipe) => Promise<T>): Promise<T> {
    const pipe = await loader.get();
    try {
      return await work(pipe);
    } catch (error) {
      throw toBrowserError(origin, error, model);
    }
  }

  return {
    name,
    tier: "browser",
    model,
    capabilities,
    async probe() {
      const picked = await pickDevice(options.device ?? "auto");
      return "code" in picked ? { ok: false, code: picked.code, reason: picked.reason } : { ok: true, where: picked.device, ...(picked.note ? { reason: picked.note } : {}) };
    },
    status(): ProviderStatus {
      const { state, where, progress, reason } = loader.state;
      return { name, tier: "browser", model, capabilities, state, ...(where ? { where } : {}), ...(progress === undefined ? {} : { progress }), ...(reason ? { reason } : {}) };
    },
    async load() {
      await loader.get();
    },
    ...(chat
      ? {
          async chat(messages: Message[], chatOptions): Promise<ChatReply> {
            const rule = chatOptions.json ? [{ role: "system", content: "Reply with one JSON object and nothing else." }] : [];
            return run(async (pipe) => {
              const { TextStreamer } = await transformersJs();
              const prompt = pipe.tokenizer.apply_chat_template([...rule, ...messages.map(({ reasoning: _r, provider_data: _p, ...m }) => m)], {
                tokenize: false,
                add_generation_prompt: true,
                enable_thinking: options.thinking ?? false,
                ...(chatOptions.tools?.length ? { tools: chatOptions.tools } : {}),
              });
              const onDelta = chatOptions.onDelta;
              const streamer = onDelta ? new TextStreamer(pipe.tokenizer as never, { skip_prompt: true, skip_special_tokens: true, callback_function: onDelta }) : undefined;
              const [output] = (await pipe(prompt, {
                max_new_tokens: chatOptions.maxTokens ?? options.maxNewTokens ?? 256,
                do_sample: (chatOptions.temperature ?? 0) > 0,
                ...(chatOptions.temperature ? { temperature: chatOptions.temperature } : {}),
                return_full_text: false,
                ...(streamer ? { streamer } : {}),
              })) as { generated_text: string }[];
              const { content, toolCalls } = parseToolCalls(output?.generated_text ?? "");
              const message: ChatReply["message"] = { role: "assistant", content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
              return checkReply(origin, { message, finishReason: toolCalls.length ? "tool_calls" : "stop" }, chatOptions.json);
            });
          },
        }
      : {
          async embed(texts: string[]) {
            return run(async (pipe) => {
              const tensor = (await pipe(texts, { pooling: "mean", normalize: true })) as { tolist(): number[][] };
              return tensor.tolist();
            });
          },
        }),
  };
}
