// Small models in the browser through transformers.js: embeddings for now.
// WebGPU when the browser has it, else WASM.
import type { Origin } from "../http.js";
import type { Provider, ProviderStatus } from "../types.js";
import { loadOnce, onProgress, pickDevice, toBrowserError, transformersJs, type Device } from "./runtime.js";

export interface TransformersOptions {
  task: "embed";
  /** Default "Xenova/all-MiniLM-L6-v2". */
  model?: string;
  /** Default "auto": WebGPU when the browser has it, else WASM. */
  device?: Device;
  /** Default "fp16" on WebGPU and "q8" on WASM. */
  dtype?: string;
  /** Default "transformers-embed". */
  name?: string;
}

type Pipe = (input: unknown, options?: Record<string, unknown>) => Promise<unknown>;

export function transformers(options: TransformersOptions): Provider {
  const model = options.model ?? "Xenova/all-MiniLM-L6-v2";
  const name = options.name ?? `transformers-${options.task}`;
  const origin: Origin = { provider: name, tier: "browser", secrets: [] };
  const capabilities = ["embed"] as const;
  const loader = loadOnce(origin, model, options.device ?? "auto", async (device, progress) => {
    const { pipeline } = await transformersJs();
    const dtype = options.dtype ?? (device === "webgpu" ? "fp16" : "q8");
    return (await pipeline("feature-extraction", model, { device, dtype, progress_callback: onProgress(progress) } as never)) as unknown as Pipe;
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
    async embed(texts: string[]) {
      return run(async (pipe) => {
        const tensor = (await pipe(texts, { pooling: "mean", normalize: true })) as { tolist(): number[][] };
        return tensor.tolist();
      });
    },
  };
}
