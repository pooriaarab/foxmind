// Failure modes F78-F80 in docs/failure-modes.md: loadOnce with a fake cache and a fake GPU.
import { beforeEach, describe, expect, it } from "vitest";
import { FoxmindError } from "../src/errors.js";
import { loadOnce } from "../src/browser/runtime.js";

const MODEL = "org/model";
let files: string[] = [];
// A fake Cache Storage that holds the model's files until loadOnce deletes them.
(globalThis as { caches?: unknown }).caches = {
  open: async () => ({
    keys: async () => files.map((url) => ({ url })),
    delete: async (request: { url: string }) => { files = files.filter((url) => url !== request.url); return true; },
  }),
};
Object.defineProperty(globalThis.navigator, "gpu", { value: { requestAdapter: async () => ({}) }, configurable: true });

const origin = { provider: "test", tier: "browser" as const, secrets: [] };
const GPU_ERROR = new Error("WebGPU validation error: shader compile failed for op GroupQueryAttention");
const PARSE_ERROR = new Error("Can't create a session. ERROR_MESSAGE: Failed to load model because protobuf parsing failed.");

beforeEach(() => { files = [`https://huggingface.co/${MODEL}/resolve/main/onnx/model.onnx`, `https://huggingface.co/${MODEL}/resolve/main/config.json`]; });

describe("loadOnce", () => {
  it("webgpu fails, wasm works, cache kept (F78)", async () => {
    const tried: string[] = [];
    const loader = loadOnce(origin, MODEL, "auto", async (device) => {
      tried.push(device);
      if (device === "webgpu") throw GPU_ERROR;
      return "model";
    });
    expect(await loader.get()).toBe("model");
    expect(tried).toEqual(["webgpu", "wasm"]);
    expect(files).toHaveLength(2);
    expect(loader.state).toMatchObject({ state: "ready", where: "wasm", reason: expect.stringContaining("WebGPU failed") });
  });

  it("both fail, then repair (F79)", async () => {
    const tried: string[] = [];
    const loader = loadOnce(origin, MODEL, "auto", async (device) => {
      tried.push(device);
      if (files.length) throw PARSE_ERROR;
      return "fresh";
    });
    expect(await loader.get()).toBe("fresh");
    expect(tried).toEqual(["webgpu", "wasm", "wasm"]);
    expect(loader.state.reason).toMatch(/Repaired/);
  });

  it("explicit webgpu keeps the cache (F80)", async () => {
    const loader = loadOnce(origin, MODEL, "webgpu", async () => { throw GPU_ERROR; });
    const error = await loader.get().then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(FoxmindError);
    expect((error as FoxmindError).code).toBe("bad_response");
    expect(files).toHaveLength(2);
  });

  it("explicit webgpu repairs a parse error (F80)", async () => {
    const loader = loadOnce(origin, MODEL, "webgpu", async () => { if (files.length) throw PARSE_ERROR; return "fresh"; });
    expect(await loader.get()).toBe("fresh");
  });
});
