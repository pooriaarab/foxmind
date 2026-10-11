// Failure modes F92-F104 in docs/failure-modes.md: roles, a mixture of local models.
import { afterEach, describe, expect, it } from "vitest";
import { createMind, FoxmindError, llamaServer, type ChatOptions, type ChatReply, type Message, type Probe, type Provider, type ShadowEvent, type Tier } from "../src/index.js";
import { completion, fakeServer, json } from "./fake-server.js";

const hi: Message[] = [{ role: "user", content: "hi" }];
let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

interface Behaviour {
  tier?: Tier;
  down?: boolean;
  fail?: string;
  /** The reply text. A function gets the call options. */
  says?: string | ((options: ChatOptions) => string);
  /** Wait this long before the reply. An abort ends the wait. */
  delayMs?: number;
  embedOnly?: boolean;
}

/** An in-memory provider that records each call. */
function model(name: string, behaviour: Behaviour = {}) {
  const tier = behaviour.tier ?? "local";
  const calls = { probe: 0, chat: 0, options: [] as ChatOptions[], aborted: 0 };
  const provider: Provider = {
    name,
    tier,
    model: `${name}-model`,
    capabilities: behaviour.embedOnly ? ["embed"] : ["chat"],
    async probe(): Promise<Probe> {
      calls.probe++;
      return behaviour.down ? { ok: false, code: "unreachable", reason: `${name} is not running` } : { ok: true };
    },
    status: () => ({ name, tier, model: `${name}-model`, capabilities: ["chat"], state: "ready" }),
    async chat(_messages, options): Promise<ChatReply> {
      calls.chat++;
      calls.options.push(options);
      if (behaviour.delayMs) {
        await new Promise<void>((done, reject) => {
          const timer = setTimeout(done, behaviour.delayMs);
          options.signal?.addEventListener("abort", () => { clearTimeout(timer); calls.aborted++; reject(new FoxmindError("aborted", "stopped", { provider: name, tier })); }, { once: true });
        });
      }
      if (behaviour.fail) throw new FoxmindError(behaviour.fail as never, `${name} failed`, { provider: name, tier });
      const says = typeof behaviour.says === "function" ? behaviour.says(options) : (behaviour.says ?? `from ${name}`);
      options.onDelta?.(says);
      return { message: { role: "assistant", content: says }, finishReason: "stop" };
    },
  };
  return { provider, calls };
}

async function failure<T extends Error>(promise: Promise<unknown>, type: new (...args: never[]) => T): Promise<T> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(type);
  return error as T;
}

describe("roles", () => {
  it("role crosses only (F92)", () => {
    const cloud = model("claude", { tier: "cloud" });
    expect(() => createMind({ providers: [model("saluki").provider, cloud.provider], only: ["browser", "local"], roles: { read: { use: ["claude", "saluki"] } } })).toThrow(/read.*claude.*cloud.*only/);
    expect(cloud.calls.probe).toBe(0);
    // Without `only`, a cloud provider in a role is the caller's own choice.
    expect(() => createMind({ providers: [model("saluki").provider, cloud.provider], roles: { read: { use: ["claude"] } } })).not.toThrow();
  });

  it("role config (F93)", () => {
    const providers = [model("saluki").provider, model("scout").provider, model("vectors", { embedOnly: true }).provider];
    expect(() => createMind({ providers, roles: { read: { use: [] } } })).toThrow(/read.*empty/);
    expect(() => createMind({ providers, roles: { read: { use: ["nope"] } } })).toThrow(/nope/);
    expect(() => createMind({ providers, roles: { read: { use: ["scout", "scout"] } } })).toThrow(/twice/);
    expect(() => createMind({ providers, roles: { read: { use: ["vectors"] } } })).toThrow(/vectors.*chat/);
    expect(() => createMind({ providers, roles: { check: { use: ["scout"], escalate: "maybe" as never } } })).toThrow(/escalate/);
    expect(() => createMind({ providers, roles: { plan: { use: ["saluki"], shadow: true } } })).toThrow(/plan.*shadow/);
  });

  it("unknown role (F94)", async () => {
    const saluki = model("saluki");
    const mind = createMind({ providers: [saluki.provider], roles: { read: { use: ["saluki"] } } });
    const error = await failure(mind.chat(hi, { role: "reed" }), TypeError);
    expect(error.message).toMatch(/reed.*read/);
    expect(saluki.calls.probe + saluki.calls.chat).toBe(0);
  });

  it("role fallback (F95)", async () => {
    const roles = { read: { use: ["scout", "saluki"] } };
    const down = createMind({ providers: [model("saluki").provider, model("scout", { down: true }).provider], roles });
    const result = await down.chat(hi, { role: "read" });
    expect(result).toMatchObject({ provider: "saluki", role: "read", skipped: [{ provider: "scout", code: "unreachable", reason: "scout is not running" }] });

    // No fallbackOnError: the role's own list is the fallback.
    const failing = createMind({ providers: [model("saluki").provider, model("scout", { fail: "http" }).provider], roles });
    expect(await failing.chat(hi, { role: "read" })).toMatchObject({ provider: "saluki", skipped: [{ provider: "scout", code: "http" }] });

    // A role picks only from its own list, never from the other providers.
    const other = model("other");
    const only = createMind({ providers: [other.provider, model("scout", { fail: "http" }).provider], roles: { read: { use: ["scout"] } } });
    expect((await failure(only.chat(hi, { role: "read" }), FoxmindError)).code).toBe("http");
    expect(other.calls.probe + other.calls.chat).toBe(0);
  });

  it("role abort (F95)", async () => {
    const saluki = model("saluki");
    const mind = createMind({ providers: [saluki.provider, model("scout", { delayMs: 500 }).provider], roles: { read: { use: ["scout", "saluki"] } } });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    expect((await failure(mind.chat(hi, { role: "read", signal: controller.signal }), FoxmindError)).code).toBe("aborted");
    expect(saluki.calls.chat).toBe(0);
  });

  it("scout timeout (F96)", async () => {
    const scout = model("scout", { delayMs: 5000 });
    const mind = createMind({ providers: [model("saluki").provider, scout.provider], roles: { read: { use: ["scout", "saluki"], timeoutMs: 50 } } });
    const started = Date.now();
    const result = await mind.chat(hi, { role: "read" });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result).toMatchObject({ provider: "saluki", skipped: [{ provider: "scout", code: "timeout" }] });
    expect(scout.calls.aborted).toBe(1);
  });

  it("escalation (F97)", async () => {
    const unsure = model("scout", { says: '{"done": true, "sure": false}' });
    const alsoUnsure = model("mid", { says: "not json at all" });
    const saluki = model("saluki", { says: '{"done": false, "sure": false}' });
    const mind = createMind({ providers: [saluki.provider, unsure.provider, alsoUnsure.provider], roles: { check: { use: ["scout", "mid", "saluki"], escalate: "unsure" } } });
    const result = await mind.chat(hi, { role: "check" });
    expect(result.provider).toBe("saluki");
    expect(result.message.content).toBe('{"done": false, "sure": false}');
    expect(result.skipped.map((skip) => [skip.provider, skip.code])).toEqual([["scout", "unsure"], ["mid", "unsure"]]);
    expect([unsure.calls.chat, alsoUnsure.calls.chat, saluki.calls.chat]).toEqual([1, 1, 1]);
    // escalate asks every provider for JSON.
    expect(unsure.calls.options[0]?.json).toBe(true);

    const sure = model("scout", { says: '{"done": true, "sure": true}' });
    const planner = model("saluki");
    const direct = createMind({ providers: [planner.provider, sure.provider], roles: { check: { use: ["scout", "saluki"], escalate: "unsure" } } });
    expect(await direct.chat(hi, { role: "check" })).toMatchObject({ provider: "scout", skipped: [] });
    expect(planner.calls.chat).toBe(0);
  });

  it("escalate refuses a stream (F98)", async () => {
    const scout = model("scout");
    const mind = createMind({ providers: [scout.provider, model("saluki").provider], roles: { check: { use: ["scout", "saluki"], escalate: "unsure" } } });
    await failure(mind.chat(hi, { role: "check", onDelta: () => {} }), TypeError);
    expect(scout.calls.probe + scout.calls.chat).toBe(0);
  });

  it("json mode a provider ignores (F99)", async () => {
    const scoutServer = await fakeServer((_, res) => json(res, 200, completion({ content: "Sure! The fields are name and email." })));
    const plannerServer = await fakeServer((_, res) => json(res, 200, completion({ content: '{"name": "#n", "email": "#e"}' })));
    close = async () => { await scoutServer.close(); await plannerServer.close(); };
    const scout = llamaServer({ name: "scout", baseURL: `${scoutServer.url}/v1` });
    const saluki = llamaServer({ name: "saluki", baseURL: `${plannerServer.url}/v1` });
    for (const provider of [scout, saluki]) provider.probe = async () => ({ ok: true });
    const mind = createMind({ providers: [saluki, scout], roles: { fields: { use: ["scout", "saluki"], json: true } } });
    const result = await mind.chat(hi, { role: "fields" });
    expect(result).toMatchObject({ provider: "saluki", skipped: [{ provider: "scout", code: "bad_json" }] });
    expect(JSON.parse(result.message.content!)).toEqual({ name: "#n", email: "#e" });
    expect(scoutServer.seen[0]?.body.response_format).toEqual({ type: "json_object" });

    const alone = createMind({ providers: [scout], roles: { fields: { use: ["scout"], json: true } } });
    expect((await failure(alone.chat(hi, { role: "fields" }), FoxmindError)).code).toBe("bad_json");
  });

  it("shadow returns the planner (F100)", async () => {
    const events: ShadowEvent[] = [];
    const providers = [model("saluki", { says: "planner says" }).provider, model("scout", { says: "scout says" }).provider];
    const mind = createMind({ providers, roles: { plan: { use: ["saluki"] }, read: { use: ["scout", "saluki"], shadow: true } }, onShadow: (event) => events.push(event) });
    const result = await mind.chat(hi, { role: "read" });
    expect(result).toMatchObject({ provider: "saluki", message: { content: "planner says" } });
    expect(JSON.stringify(result)).not.toContain("scout says");
    await expect.poll(() => events.length).toBe(1);
    expect(events[0]).toMatchObject({ role: "read", scout: { provider: "scout", message: { content: "scout says" } }, planner: { provider: "saluki", message: { content: "planner says" } } });

    // A failed scout never fails the call.
    const quiet: ShadowEvent[] = [];
    const broken = createMind({ providers: [model("saluki").provider, model("scout", { fail: "http" }).provider], roles: { read: { use: ["scout"], shadow: true } }, onShadow: (event) => quiet.push(event) });
    expect((await broken.chat(hi, { role: "read" })).provider).toBe("saluki");
    await expect.poll(() => quiet.length).toBe(1);
    expect((quiet[0]!.scout as { error: FoxmindError }).error.code).toBe("http");

    // A failed planner throws the planner's error, not the scout's answer.
    const noPlanner = createMind({ providers: [model("saluki", { fail: "timeout" }).provider, model("scout").provider], roles: { plan: { use: ["saluki"] }, read: { use: ["scout"], shadow: true } } });
    expect(await failure(noPlanner.chat(hi, { role: "read" }), FoxmindError)).toMatchObject({ code: "timeout", provider: "saluki" });
  });

  it("shadow does not wait for the scout (F101)", async () => {
    const events: ShadowEvent[] = [];
    const scout = model("scout", { delayMs: 300 });
    const roles = { plan: { use: ["saluki"] }, read: { use: ["scout"], shadow: true, timeoutMs: 100 } };
    const mind = createMind({ providers: [model("saluki").provider, scout.provider], roles, onShadow: (event) => events.push(event) });
    const started = Date.now();
    expect((await mind.chat(hi, { role: "read" })).provider).toBe("saluki");
    expect(Date.now() - started).toBeLessThan(80);
    expect(events).toHaveLength(0);
    await expect.poll(() => events.length).toBe(1);
    expect((events[0]!.scout as { error: FoxmindError }).error.code).toBe("timeout");
    expect(scout.calls.aborted).toBe(1);
  });

  it("maxInput (F102)", async () => {
    const scout = model("scout");
    const mind = createMind({ providers: [model("saluki").provider, scout.provider], roles: { read: { use: ["scout", "saluki"], maxInput: 10 } } });
    expect((await mind.chat(hi, { role: "read" })).provider).toBe("scout");
    const result = await mind.chat([{ role: "user", content: "a long page of text" }], { role: "read" });
    expect(result).toMatchObject({ provider: "saluki", skipped: [{ provider: "scout", code: "too_long" }] });
    expect(scout.calls.chat).toBe(1);
  });

  it("shadow hook throws (F103)", async () => {
    let fired = 0;
    const roles = { read: { use: ["scout"], shadow: true } };
    const mind = createMind({ providers: [model("saluki").provider, model("scout").provider], roles, onShadow: () => { fired++; throw new Error("hook broke"); } });
    expect((await mind.chat(hi, { role: "read" })).provider).toBe("saluki");
    await expect.poll(() => fired).toBe(1);
  });

  it("no role (F104)", async () => {
    const scout = model("scout");
    const withPlan = createMind({ providers: [scout.provider, model("saluki").provider], roles: { plan: { use: ["saluki"] }, read: { use: ["scout"] } } });
    expect(await withPlan.chat(hi)).toMatchObject({ provider: "saluki", role: "plan" });
    expect(scout.calls.chat).toBe(0);

    const noPlan = createMind({ providers: [model("saluki").provider, scout.provider], roles: { read: { use: ["scout"] } } });
    const result = await noPlan.chat(hi);
    expect(result.provider).toBe("saluki");
    expect(result.role).toBeUndefined();
  });
});
