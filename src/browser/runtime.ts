// What every in-browser model needs: transformers.js set up for an extension
// page, WebGPU detection, the model cache, and load errors mapped to codes.
import { failure, type Origin } from "../http.js";
import type { FoxmindError } from "../errors.js";

type Transformers = typeof import("@huggingface/transformers");
export type Device = "auto" | "webgpu" | "wasm";

export interface RuntimeOptions {
  /** Where ONNX Runtime's asyncify .mjs and .wasm files are. Default: ort/ in the extension. */
  wasmPaths?: { mjs: string; wasm: string };
  /** The model hub, for a mirror. It applies to every model on the page. Default "https://huggingface.co/". */
  remoteHost?: string;
}

let options: RuntimeOptions = {};
let loaded: Promise<Transformers> | undefined;
let adapter: Promise<boolean> | undefined;

/** Change the runtime settings. Call it before the first model loads. */
export function configureRuntime(next: RuntimeOptions): void {
  options = { ...options, ...next };
}

function extensionURL(path: string): string | undefined {
  const runtime = (globalThis as { browser?: { runtime?: { getURL?: (p: string) => string } } }).browser?.runtime;
  return runtime?.getURL?.(path);
}

/** transformers.js, loaded once, set for extension pages: no remote code, one WASM thread when there is no SharedArrayBuffer. */
export async function transformersJs(): Promise<Transformers> {
  const module = await (loaded ??= import("@huggingface/transformers").then((fresh) => {
    const { env } = fresh;
    env.allowLocalModels = false;
    // MV3 forbids blob: and remote scripts, so ONNX Runtime loads its own files.
    env.useWasmCache = false;
    const wasm = env.backends.onnx.wasm!;
    const mjs = extensionURL("ort/ort-wasm-simd-threaded.asyncify.mjs");
    const paths = options.wasmPaths ?? (mjs ? { mjs, wasm: extensionURL("ort/ort-wasm-simd-threaded.asyncify.wasm")! } : undefined);
    if (paths) wasm.wasmPaths = paths;
    if (!globalThis.crossOriginIsolated) wasm.numThreads = 1;
    return fresh;
  }));
  module.env.remoteHost = options.remoteHost ?? "https://huggingface.co/";
  return module;
}

/** True when the browser gives a WebGPU adapter. */
export function hasWebGPU(): Promise<boolean> {
  adapter ??= (async () => {
    const gpu = (globalThis.navigator as { gpu?: { requestAdapter(): Promise<unknown> } } | undefined)?.gpu;
    if (!gpu) return false;
    try {
      return Boolean(await gpu.requestAdapter());
    } catch {
      return false;
    }
  })();
  return adapter;
}

/** The device to load on, or why the asked device cannot run. */
export async function pickDevice(device: Device): Promise<{ device: "webgpu" | "wasm"; note?: string } | { code: "webgpu_missing"; reason: string }> {
  if (device === "wasm") return { device: "wasm" };
  if (await hasWebGPU()) return { device: "webgpu" };
  if (device === "webgpu") return { code: "webgpu_missing", reason: "This browser gives no WebGPU adapter (Firefox has none on Linux, Intel Macs and Android). Use device \"auto\" or \"wasm\"." };
  return { device: "wasm", note: "WebGPU is missing, so it runs on WASM." };
}

const CACHE = "transformers-cache";

/** The cached requests that belong to one model. */
async function cachedFiles(model: string): Promise<{ cache: Cache; keys: readonly Request[] } | undefined> {
  if (typeof caches === "undefined") return undefined;
  const cache = await caches.open(CACHE);
  const keys = (await cache.keys()).filter((request) => request.url.includes(`/${model}/`));
  return { cache, keys };
}

/** Delete one model's files from Cache Storage. Returns how many it deleted. */
export async function purgeModel(model: string): Promise<number> {
  const files = await cachedFiles(model);
  if (!files) return 0;
  await Promise.all(files.keys.map((key) => files.cache.delete(key)));
  return files.keys.length;
}

export async function isCached(model: string): Promise<boolean> {
  return Boolean((await cachedFiles(model))?.keys.length);
}

/** Map an error from a model load or run to a FoxmindError code. */
export function toBrowserError(origin: Origin, error: unknown, model: string): FoxmindError {
  const message = error instanceof Error ? error.message : String(error);
  if (/out of memory|allocation failed|could not allocate|memory access out of bounds|device (was )?lost|maximum buffer size|exceeds the max/i.test(message)) {
    return failure(origin, "out_of_memory", `${model} needs more memory than this device has (${message}). Try a smaller model or a smaller dtype such as "q4".`, { cause: error });
  }
  if (/Could not locate file|Unauthorized access to file|Forbidden access to file/i.test(message)) {
    return failure(origin, "model_not_found", `The hub has no ${model}, or it is private: ${message}`, { cause: error });
  }
  if (/NetworkError|Failed to fetch|network|body stream|input stream|terminated|load failed|Gateway|Service unavailable/i.test(message)) {
    return failure(origin, "download_failed", `The download of ${model} stopped: ${message}. Call again to download it again.`, { cause: error });
  }
  return failure(origin, "bad_response", `${model} did not load: ${message}`, { cause: error });
}

export interface LoadState {
  state: "idle" | "loading" | "ready" | "error";
  where?: "webgpu" | "wasm";
  progress?: number;
  reason?: string;
}

/**
 * Loads a model once. Calls that come during a load wait for it. A failed
 * load is not kept, so the next call tries again. Cached files that do not
 * load are deleted and downloaded once more. With device "auto", a model that
 * fails on WebGPU loads on WASM, and the state says so.
 */
export function loadOnce<T>(origin: Origin, model: string, device: Device, open: (device: "webgpu" | "wasm", progress: (p: number) => void) => Promise<T>) {
  const state: LoadState = { state: "idle" };
  let pending: Promise<T> | undefined;
  const progress = (p: number) => { state.progress = p; };

  async function repairing(where: "webgpu" | "wasm"): Promise<T> {
    const hadCache = await isCached(model);
    try {
      return await open(where, progress);
    } catch (error) {
      const mapped = toBrowserError(origin, error, model);
      if (mapped.code !== "bad_response" || !hadCache) throw mapped;
      const removed = await purgeModel(model);
      try {
        const value = await open(where, progress);
        state.reason = `Repaired: deleted ${removed} cached files of ${model} that did not load, and downloaded them again.`;
        return value;
      } catch (second) {
        const again = toBrowserError(origin, second, model);
        if (again.code !== "bad_response") throw again;
        throw failure(origin, "cache_corrupt", `${model} did not load from a fresh download either: ${again.message}`, { cause: second });
      }
    }
  }

  async function attempt(): Promise<T> {
    const picked = await pickDevice(device);
    if ("code" in picked) throw failure(origin, picked.code, picked.reason);
    Object.assign(state, { state: "loading", where: picked.device, progress: 0, reason: picked.note });
    try {
      return await repairing(picked.device);
    } catch (error) {
      if (device !== "auto" || picked.device !== "webgpu" || (error as FoxmindError).code !== "bad_response") throw error;
      Object.assign(state, { where: "wasm", reason: `WebGPU failed (${(error as Error).message}), so it runs on WASM.` });
      return repairing("wasm");
    }
  }

  return {
    state,
    get(): Promise<T> {
      pending ??= attempt().then(
        (value) => {
          Object.assign(state, { state: "ready", progress: 1 });
          return value;
        },
        (error: unknown) => {
          pending = undefined;
          Object.assign(state, { state: "error", reason: (error as Error).message });
          throw error;
        },
      );
      return pending;
    },
  };
}

/** The progress callback transformers.js takes, as one number from 0 to 1. */
export function onProgress(progress: (p: number) => void) {
  return (info: { status?: string; progress?: number }) => {
    if (info.status === "progress_total" && typeof info.progress === "number") progress(info.progress / 100);
  };
}
