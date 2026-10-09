// Firefox's own on-device inference engine, browser.trial.ml. It needs the
// optional "trialML" permission, takes models only from the Mozilla hub and the
// Mozilla and Xenova orgs on Hugging Face, and allows one engine per extension.
import { failure, type Origin } from "../http.js";
import type { Message, Provider, ProviderStatus } from "../types.js";

type TrialMl = {
  createEngine(request: Record<string, unknown>): Promise<unknown>;
  runEngine(request: { args: unknown[]; options?: Record<string, unknown> }): Promise<unknown>;
  onProgress: { addListener(listener: (data: Record<string, unknown>) => void): void };
};
type Browser = {
  trial?: { ml?: TrialMl };
  permissions?: { contains(p: { permissions: string[] }): Promise<boolean>; request(p: { permissions: string[] }): Promise<boolean> };
};

export interface TrialMLOptions {
  task: "embed" | "chat";
  /** Default "Xenova/all-MiniLM-L6-v2" for embed and "Xenova/Qwen1.5-0.5B-Chat" for chat. */
  model?: string;
  /** Default "wasm". "gpu" uses WebGPU where Firefox has it. */
  device?: "wasm" | "gpu";
  /** Default "trialml-embed" or "trialml-chat". */
  name?: string;
  /** "llama.cpp" runs a GGUF file (set `modelFile`). Default: Firefox's ONNX backend. */
  backend?: "llama.cpp";
  /** The GGUF file in the model repo, for the llama.cpp backend. */
  modelFile?: string;
  /** Refuse model files larger than this many bytes before the download. Default 4 GB. */
  maxBytes?: number;
}

const GB = 1e9;

/** The size of one file in a Hugging Face repo, from the hub API. */
async function fileSize(model: string, file: string): Promise<number | undefined> {
  const response = await fetch(`https://huggingface.co/api/models/${model}?blobs=true`).catch(() => undefined);
  if (!response?.ok) return undefined;
  const info = (await response.json()) as { siblings?: { rfilename: string; size?: number }[] };
  return info.siblings?.find((sibling) => sibling.rfilename === file)?.size;
}

const api = () => (globalThis as { browser?: Browser }).browser;

/** Ask the user for the optional trialML permission. Call it from a click handler. */
export function requestTrialML(): Promise<boolean> {
  const permissions = api()?.permissions;
  if (!permissions) return Promise.resolve(false);
  return permissions.request({ permissions: ["trialML"] });
}

/** Firefox allows one engine per extension, so the first provider to start one keeps it. */
let engine: { owner: string; key: string; ready: Promise<unknown> } | undefined;

/** One vector per text from whatever shape the engine returns. */
export function toVectors(result: unknown, count: number): number[][] | undefined {
  let rows: unknown = result;
  const tensor = result as { data?: ArrayLike<number>; dims?: number[]; ort_tensor?: unknown };
  if (tensor && !Array.isArray(result) && tensor.data && tensor.dims) {
    const width = tensor.dims.at(-1)!;
    const flat = Array.from(tensor.data);
    rows = Array.from({ length: flat.length / width }, (_, i) => flat.slice(i * width, (i + 1) * width));
  }
  while (Array.isArray(rows) && rows.length === 1 && Array.isArray(rows[0]) && Array.isArray((rows[0] as unknown[])[0]) && count === (rows[0] as unknown[]).length) rows = rows[0];
  const ok = Array.isArray(rows) && rows.length === count && rows.every((row) => Array.isArray(row) && row.every((x) => typeof x === "number"));
  return ok ? (rows as number[][]) : undefined;
}

/** Why trial.ml cannot run, or undefined when it can. The namespace exists only after the grant. */
async function unavailable(): Promise<{ code: "unsupported" | "permission"; reason: string } | undefined> {
  const permissions = api()?.permissions;
  if (permissions && !(await permissions.contains({ permissions: ["trialML"] }).catch(() => false))) {
    return { code: "permission", reason: 'The optional "trialML" permission is not granted. Call requestTrialML() from a click.' };
  }
  if (!api()?.trial?.ml) return { code: "unsupported", reason: "browser.trial.ml is missing: this is not Firefox, or trial ML is turned off." };
  return undefined;
}

/** The text in a text-generation result, in any of the shapes the backends return. */
function generatedText(output: unknown): string | undefined {
  if (typeof output === "string") return output;
  const record = output as { finalOutput?: unknown; output?: unknown } | undefined;
  if (typeof record?.finalOutput === "string") return record.finalOutput;
  if (typeof record?.output === "string") return record.output;
  const text = (output as { generated_text?: string | { content: string }[] }[] | undefined)?.[0]?.generated_text;
  return Array.isArray(text) ? text.at(-1)?.content : text;
}

export function trialML(options: TrialMLOptions): Provider {
  const chat = options.task === "chat";
  const model = options.model ?? (chat ? "Xenova/Qwen1.5-0.5B-Chat" : "Xenova/all-MiniLM-L6-v2");
  const name = options.name ?? `trialml-${options.task}`;
  const device = options.device ?? "wasm";
  const origin: Origin = { provider: name, tier: "browser", secrets: [] };
  const llama = options.backend === "llama.cpp";
  const key = `${options.task}:${model}:${options.modelFile ?? ""}:${device}`;

  /** Checks that need no engine: the file size, and the orgs trial ML takes models from. */
  async function refused(): Promise<{ code: "out_of_memory" | "unsupported"; reason: string } | undefined> {
    if (llama && options.modelFile) {
      const size = await fileSize(model, options.modelFile);
      const max = options.maxBytes ?? 4 * GB;
      if (size !== undefined && size > max) {
        return { code: "out_of_memory", reason: `${options.modelFile} is ${(size / GB).toFixed(2)} GB, more than the ${(max / GB).toFixed(2)} GB limit (maxBytes) for a model in the browser. Run it on a local server instead.` };
      }
    }
    if (!/^(Mozilla|Xenova)\//.test(model)) return { code: "unsupported", reason: `trial.ml takes models only from the Mozilla and Xenova orgs on Hugging Face (or the Mozilla hub), not ${model}.` };
    return undefined;
  }
  const state: Pick<ProviderStatus, "state" | "progress" | "reason"> = { state: "idle" };

  async function ready(): Promise<TrialMl> {
    const blocked = (await unavailable()) ?? (await refused());
    if (blocked) throw failure(origin, blocked.code, blocked.reason);
    const ml = api()!.trial!.ml!;
    if (engine && engine.key !== key) throw failure(origin, "unsupported", `Firefox allows one trial.ml engine per extension, and ${engine.owner} holds it (${engine.key}).`);
    if (!engine) {
      state.state = "loading";
      ml.onProgress.addListener((data) => {
        const progress = Number(data.progress ?? data.totalProgress);
        if (Number.isFinite(progress)) state.progress = progress > 1 ? progress / 100 : progress;
      });
      const request = { taskName: chat ? "text-generation" : "feature-extraction", modelHub: "huggingface", modelId: model, ...(llama ? { backend: "llama.cpp", modelFile: options.modelFile } : { device }) };
      const started = { owner: name, key, ready: ml.createEngine(request) };
      engine = started;
      started.ready.catch(() => { if (engine === started) engine = undefined; });
    }
    try {
      await engine.ready;
    } catch (error) {
      throw mapped(error);
    }
    Object.assign(state, { state: "ready", progress: 1 });
    return ml;
  }

  function mapped(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    state.state = "error";
    state.reason = message;
    if (/disabled/i.test(message)) return failure(origin, "unsupported", `Trial ML is turned off in this Firefox: ${message}`);
    if (/memory/i.test(message)) return failure(origin, "out_of_memory", `Firefox stopped the engine for lack of memory: ${message}`);
    return failure(origin, "bad_response", `trial.ml failed: ${message}`);
  }

  /** One engine call, stopped after timeoutMs: an engine that never answers must not hang the caller. */
  async function run(args: unknown[], runOptions: Record<string, unknown>, timeoutMs = 120_000): Promise<unknown> {
    const ml = await ready();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(failure(origin, "timeout", `trial.ml gave no answer within ${timeoutMs} ms.`)), timeoutMs);
    });
    try {
      return await Promise.race([ml.runEngine({ args, options: runOptions, ...(llama ? runOptions : {}) }), timeout]);
    } catch (error) {
      if ((error as { code?: string }).code === "timeout") throw error;
      throw mapped(error);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    name,
    tier: "browser",
    model,
    capabilities: chat ? ["chat"] : ["embed"],
    async probe() {
      const blocked = (await unavailable()) ?? (await refused());
      if (blocked) return { ok: false, ...blocked };
      if (engine && engine.key !== key) return { ok: false, code: "unsupported", reason: `${engine.owner} holds the one trial.ml engine.` };
      return { ok: true, where: `trial.ml (${device})` };
    },
    status: () => ({ name, tier: "browser", model, capabilities: chat ? ["chat"] : ["embed"], where: `trial.ml (${device})`, ...state }),
    async load() {
      await ready();
    },
    ...(chat
      ? {
          async chat(messages: Message[], chatOptions) {
            if (chatOptions.tools?.length) throw failure(origin, "unsupported", "trial.ml has no tool calls. Use transformers() or a server for tools.");
            const plain = messages.map(({ role, content }) => ({ role, content }));
            const maxTokens = chatOptions.maxTokens ?? 256;
            // The ONNX backend takes { args, options }; the llama.cpp backend takes { prompt, nPredict }.
            const output = await run([plain], llama ? { prompt: plain, nPredict: maxTokens } : { max_new_tokens: maxTokens }, chatOptions.timeoutMs);
            const content = generatedText(output);
            if (typeof content !== "string") throw failure(origin, "bad_response", "trial.ml returned no generated text.");
            return { message: { role: "assistant" as const, content }, finishReason: "stop" as const };
          },
        }
      : {
          async embed(texts: string[], embedOptions) {
            const vectors = toVectors(await run([texts], { pooling: "mean", normalize: true }, embedOptions.timeoutMs), texts.length);
            if (!vectors) throw failure(origin, "bad_response", "trial.ml returned a shape that is not one vector per text.");
            return vectors;
          },
        }),
  };
}

/**
 * Experimental: a GGUF model on Firefox's llama.cpp backend, through trial ML.
 * Small models only: trial ML takes models from the Mozilla and Xenova orgs,
 * and foxmind refuses files over `maxBytes` (default 4 GB) before the download.
 */
export function wllama(options: { model: string; modelFile: string; name?: string; maxBytes?: number }): Provider {
  return trialML({ task: "chat", backend: "llama.cpp", name: options.name ?? "wllama", ...options });
}
