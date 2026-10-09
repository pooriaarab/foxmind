// Failure modes F21-F27 in docs/failure-modes.md: routing across providers.
import { afterEach, describe, expect, it } from "vitest";
import { createMind, FoxmindError, openaiCompatible, type ChatReply, type Probe, type Provider, type Tier } from "../src/index.js";
import { fakeServer, sse } from "./fake-server.js";

const hi = [{ role: "user" as const, content: "hi" }];
let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

/** An in-memory provider. `fail` makes chat() throw that code; `down` makes probe() fail. */
function fake(name: string, tier: Tier, behaviour: { down?: boolean; fail?: string; embed?: boolean } = {}) {
  const calls = { probe: 0, chat: 0 };
  const provider: Provider = {
    name,
    tier,
    model: `${name}-model`,
    capabilities: behaviour.embed ? ["chat", "embed"] : ["chat"],
    async probe(): Promise<Probe> {
      calls.probe++;
      return behaviour.down ? { ok: false, code: "unreachable", reason: `${name} is not running` } : { ok: true };
    },
    status: () => ({ name, tier, model: `${name}-model`, capabilities: ["chat"], state: "ready" }),
    async chat(): Promise<ChatReply> {
      calls.chat++;
      if (behaviour.fail) throw new FoxmindError(behaviour.fail as never, `${name} failed`, { provider: name, tier });
      return { message: { role: "assistant", content: `from ${name}` }, finishReason: "stop" };
    },
    ...(behaviour.embed ? { embed: async (texts: string[]) => texts.map(() => [1, 2]) } : {}),
  };
  return { provider, calls };
}

async function failure(promise: Promise<unknown>): Promise<FoxmindError> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(FoxmindError);
  return error as FoxmindError;
}

describe("createMind", () => {
  it("answers with the first provider in prefer order and says which tier answered", async () => {
    const mind = createMind({ providers: [fake("cloudy", "cloud").provider, fake("server", "local").provider], prefer: ["local", "cloud"] });
    const result = await mind.chat(hi);
    expect(result).toMatchObject({ provider: "server", tier: "local", model: "server-model", skipped: [], message: { content: "from server" } });
    expect(mind.status().last).toMatchObject({ capability: "chat", provider: "server", tier: "local" });
  });

  it("routes embed to a provider that can embed", async () => {
    const mind = createMind({ providers: [fake("chatty", "local").provider, fake("vectors", "browser", { embed: true }).provider] });
    expect(await mind.embed(["a"])).toMatchObject({ vectors: [[1, 2]], provider: "vectors", tier: "browser" });
  });

  it("no provider (F21)", async () => {
    const mind = createMind({ providers: [fake("a", "local", { down: true }).provider, fake("b", "cloud", { down: true }).provider] });
    const error = await failure(mind.chat(hi));
    expect(error.code).toBe("no_provider");
    expect(error.message).toContain("a is not running");
    expect(error.skipped?.map((skip) => skip.provider)).toEqual(["a", "b"]);
    expect((await failure(mind.embed(["x"]))).code).toBe("no_provider");
  });

  it("skips a provider that is down (F22)", async () => {
    const mind = createMind({ providers: [fake("a", "local", { down: true }).provider, fake("b", "cloud").provider] });
    const result = await mind.chat(hi);
    expect(result.provider).toBe("b");
    expect(result.skipped).toEqual([{ provider: "a", tier: "local", code: "unreachable", reason: "a is not running" }]);
  });

  it("no silent fallback (F23)", async () => {
    const b = fake("b", "cloud");
    const mind = createMind({ providers: [fake("a", "local", { fail: "http" }).provider, b.provider] });
    const error = await failure(mind.chat(hi));
    expect(error).toMatchObject({ code: "http", provider: "a" });
    expect(b.calls.chat).toBe(0);
  });

  it("fallbackOnError (F23)", async () => {
    const mind = createMind({ providers: [fake("a", "local", { fail: "http" }).provider, fake("b", "cloud").provider], fallbackOnError: true });
    const result = await mind.chat(hi);
    expect(result.provider).toBe("b");
    expect(result.skipped).toMatchObject([{ provider: "a", code: "http", reason: expect.stringContaining("a failed") }]);
  });

  it("no fallback after streamed text (F24)", async () => {
    const server = await fakeServer((_, res) => sse(res, [{ choices: [{ index: 0, delta: { content: "Hal" }, finish_reason: null }] }], true));
    close = server.close;
    const b = fake("b", "cloud");
    const local = openaiCompatible({ baseURL: `${server.url}/v1`, model: "m", checkModel: false, name: "flaky" });
    local.probe = async () => ({ ok: true });
    const mind = createMind({ providers: [local, b.provider], fallbackOnError: true });
    const pieces: string[] = [];
    const error = await failure(mind.chat(hi, { onDelta: (piece) => pieces.push(piece) }));
    expect(error).toMatchObject({ code: "stream_interrupted", provider: "flaky", partial: "Hal" });
    expect(pieces).toEqual(["Hal"]);
    expect(b.calls.chat).toBe(0);
  });

  it("abort (F25)", async () => {
    const b = fake("b", "cloud");
    const mind = createMind({ providers: [fake("a", "local", { fail: "aborted" }).provider, b.provider], fallbackOnError: true });
    expect((await failure(mind.chat(hi))).code).toBe("aborted");
    expect(b.calls.chat).toBe(0);
  });

  it("probe cache (F26)", async () => {
    const a = fake("a", "local");
    const mind = createMind({ providers: [a.provider] });
    await mind.chat(hi);
    await mind.chat(hi);
    expect(a.calls.probe).toBe(1);
    a.provider.chat = async () => { throw new FoxmindError("unreachable", "gone", { provider: "a", tier: "local" }); };
    await failure(mind.chat(hi));
    await failure(mind.chat(hi));
    expect(a.calls.probe).toBe(2);
    expect((await mind.probe()).map((probe) => probe.provider)).toEqual(["a"]);
    expect(a.calls.probe).toBe(3);
  });

  it("bad config (F27)", () => {
    const a = fake("a", "local").provider;
    expect(() => createMind({ providers: [a], prefer: ["nope"] })).toThrow(/nope/);
    expect(() => createMind({ providers: [a, fake("a", "cloud").provider] })).toThrow(/two providers named "a"/);
  });

  it("status lists every provider", async () => {
    const mind = createMind({ providers: [fake("a", "local").provider, fake("b", "cloud").provider] });
    expect(mind.status().providers.map((status) => status.name)).toEqual(["a", "b"]);
  });

  it("abort during a probe (F74)", async () => {
    const local = fake("slow", "local");
    let probes = 0;
    local.provider.probe = (options) => {
      probes++;
      // A probe that honors a signal would end here; the router must not pass the caller's one.
      expect(options?.signal).toBeUndefined();
      return new Promise((done) => setTimeout(() => done({ ok: true }), 200));
    };
    const cloud = fake("cloud", "cloud");
    const mind = createMind({ providers: [local.provider, cloud.provider] });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const error = await failure(mind.chat(hi, { signal: controller.signal }));
    expect(error.code).toBe("aborted");
    expect(cloud.calls.probe + cloud.calls.chat).toBe(0);
    const later = await mind.chat(hi);
    expect(later.provider).toBe("slow");
    expect(probes).toBe(2);
  });

  it("aborted before the call (F74)", async () => {
    const cloud = fake("cloud", "cloud");
    const mind = createMind({ providers: [fake("a", "local", { down: true }).provider, cloud.provider] });
    const controller = new AbortController();
    controller.abort();
    expect((await failure(mind.chat(hi, { signal: controller.signal }))).code).toBe("aborted");
    expect(cloud.calls.chat).toBe(0);
  });

  it("probe cache after any failure (F75)", async () => {
    for (const code of ["timeout", "http", "auth", "rate_limited"]) {
      const a = fake("a", "local");
      const mind = createMind({ providers: [a.provider] });
      a.provider.chat = async () => { throw new FoxmindError(code as never, "no", { provider: "a", tier: "local" }); };
      await failure(mind.chat(hi));
      await failure(mind.chat(hi));
      expect(a.calls.probe, code).toBe(2);
    }
  });
});
