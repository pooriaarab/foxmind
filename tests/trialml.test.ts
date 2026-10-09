// Failure modes F84-F86 in docs/failure-modes.md: trialML against a fake browser.trial.ml.
import { describe, expect, it } from "vitest";
import { FoxmindError } from "../src/errors.js";

let listeners = 0;
let creates = 0;
let reply: () => Promise<unknown> = async () => [];
(globalThis as { browser?: unknown }).browser = {
  permissions: { contains: async () => true, request: async () => true },
  trial: {
    ml: {
      onProgress: { addListener: () => { listeners++; } },
      createEngine: async () => { creates++; if (creates === 1) throw new Error("network blip"); },
      runEngine: () => reply(),
    },
  },
};
const { trialML } = await import("../src/browser/trialml.js");

async function failure(promise: Promise<unknown>): Promise<FoxmindError> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(FoxmindError);
  return error as FoxmindError;
}
const never = () => new Promise<never>(() => {});

describe("trialML", () => {
  const chat = trialML({ task: "chat", model: "Xenova/tiny-chat" });

  it("one progress listener (F86)", async () => {
    expect((await failure(chat.load!())).message).toContain("network blip");
    reply = async () => [{ generated_text: "hi" }];
    await chat.load!();
    expect(creates).toBe(2);
    expect(listeners).toBe(1);
  });

  it("trial.ml abort (F84)", async () => {
    reply = never;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    expect((await failure(chat.chat!([{ role: "user", content: "x" }], { signal: controller.signal }))).code).toBe("aborted");
  });

  it("trial.ml timeout (F84)", async () => {
    reply = never;
    const started = Date.now();
    expect((await failure(chat.chat!([{ role: "user", content: "x" }], { timeoutMs: 50 }))).code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("trial.ml json (F85)", async () => {
    reply = async () => [{ generated_text: "Sure, here you go" }];
    expect((await failure(chat.chat!([{ role: "user", content: "x" }], { json: true }))).code).toBe("bad_json");
  });
});
