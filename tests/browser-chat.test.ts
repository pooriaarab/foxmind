// Failure mode F87 in docs/failure-modes.md: in-browser chat honors signal and timeoutMs.
import { describe, expect, it, vi } from "vitest";
import { FoxmindError } from "../src/errors.js";

let stopped = 0;
// A fake transformers.js: the pipeline generates until a stopping criterion says stop.
vi.mock("@huggingface/transformers", () => {
  class InterruptableStoppingCriteria {
    interrupted = false;
    interrupt() { this.interrupted = true; }
  }
  const pipe = Object.assign(
    async (_prompt: string, options: { stopping_criteria?: InterruptableStoppingCriteria }) => {
      while (!options.stopping_criteria?.interrupted) await new Promise((done) => setTimeout(done, 5));
      stopped++;
      return [{ generated_text: "cut" }];
    },
    { tokenizer: { apply_chat_template: () => "prompt" } },
  );
  return { env: { backends: { onnx: { wasm: {} } } }, pipeline: async () => pipe, TextStreamer: Object, InterruptableStoppingCriteria };
});
const { transformers } = await import("../src/browser/transformers.js");

async function failure(promise: Promise<unknown>): Promise<FoxmindError> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(FoxmindError);
  return error as FoxmindError;
}

describe("transformers chat", () => {
  const chat = transformers({ task: "chat", device: "wasm" });

  it("chat abort (F87)", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    expect((await failure(chat.chat!([{ role: "user", content: "x" }], { signal: controller.signal }))).code).toBe("aborted");
    await vi.waitFor(() => expect(stopped).toBe(1));
  });

  it("chat timeout (F87)", async () => {
    expect((await failure(chat.chat!([{ role: "user", content: "x" }], { timeoutMs: 50 }))).code).toBe("timeout");
    await vi.waitFor(() => expect(stopped).toBe(2));
  });
});
