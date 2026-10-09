// GLiNER2 as a foxmind provider: extract() finds entities for your labels,
// classify() scores texts against labels. Default model: the 614 MB fp16
// graph foxpilot uses.
import type { Origin } from "../http.js";
import type { Provider, ProviderStatus } from "../types.js";
import { Gliner2 } from "./gliner2-model.js";
import { loadOnce, onProgress, pickDevice, toBrowserError, type Device } from "./runtime.js";

export interface Gliner2Options {
  /** Default "pooria/gliner2-multi-v1-agent-batch-ONNX". */
  model?: string;
  /** Default "auto": WebGPU when the browser has it, else WASM. */
  device?: Device;
  /** Default "fp16". */
  dtype?: "fp32" | "fp16";
  /** Default "gliner2". */
  name?: string;
}

export function gliner2(options: Gliner2Options = {}): Provider {
  const model = options.model ?? "pooria/gliner2-multi-v1-agent-batch-ONNX";
  const name = options.name ?? "gliner2";
  const origin: Origin = { provider: name, tier: "browser", secrets: [] };
  const capabilities = ["extract", "classify"] as const;
  const loader = loadOnce(origin, model, options.device ?? "auto", async (device, progress) => {
    const loaded = await Gliner2.load(model, { device, dtype: options.dtype ?? "fp16", progress_callback: onProgress(progress) });
    // Compile the WebGPU shaders now, not on the first real call.
    await loaded.classify("warm up", "warmup", { a: undefined, b: undefined });
    return loaded;
  });

  async function run<T>(work: (model: Gliner2) => Promise<T>): Promise<T> {
    const loaded = await loader.get();
    try {
      return await work(loaded);
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
    async extract(text, labels, extractOptions) {
      if (!Object.keys(labels).length) return {};
      return run((loaded) => loaded.extractEntities(text, labels, extractOptions.threshold ?? 0.5));
    },
    async classify(texts, prompt, labels) {
      if (!Object.keys(labels).length) return texts.map(() => ({}));
      return run((loaded) => loaded.classifyMany(texts, prompt, labels));
    },
  };
}
