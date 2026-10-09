// Failure modes F1-F8 in docs/failure-modes.md: the HTTP layer against a fake server.
import { afterEach, describe, expect, it } from "vitest";
import { FoxmindError } from "../src/errors.js";
import { call, type Origin } from "../src/http.js";
import { closedPort, fakeServer, json, type Handler } from "./fake-server.js";

const KEY = "my-own-key-0123456789";
const origin: Origin = { provider: "fake", tier: "local", secrets: [KEY] };
let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

async function serve(handler: Handler) {
  const server = await fakeServer(handler);
  close = server.close;
  return server;
}

async function failure(promise: Promise<unknown>): Promise<FoxmindError> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(FoxmindError);
  return error as FoxmindError;
}

const get = (url: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}) =>
  call(origin, url, { headers: { authorization: `Bearer ${KEY}` }, ...options }, 2000).then((fetched) => fetched.json());

describe("http", () => {
  it("sends the body as JSON and returns the parsed reply", async () => {
    const { url, seen } = await serve((_, res) => json(res, 200, { ok: 1 }));
    const fetched = await call(origin, `${url}/x`, { body: { a: 1 } }, 2000);
    expect(await fetched.json()).toEqual({ ok: 1 });
    expect(seen[0]).toMatchObject({ method: "POST", path: "/x", body: { a: 1 }, headers: { "content-type": "application/json" } });
  });

  it("server down (F1)", async () => {
    const url = await closedPort();
    const error = await failure(get(url));
    expect(error).toMatchObject({ code: "unreachable", provider: "fake", tier: "local" });
    expect(error.message).toContain(url);
  });

  it("429 (F2)", async () => {
    const { url, seen } = await serve((_, res) => json(res, 429, { error: { message: "slow down" } }, { "retry-after": "7" }));
    expect(await failure(get(url))).toMatchObject({ code: "rate_limited", status: 429, retryAfterMs: 7000 });
    expect(seen).toHaveLength(1);
  });

  it("429 with a date (F2)", async () => {
    const { url } = await serve((_, res) => json(res, 429, {}, { "retry-after": new Date(Date.now() + 60_000).toUTCString() }));
    const error = await failure(get(url));
    expect(error.retryAfterMs).toBeGreaterThan(55_000);
  });

  it("timeout (F3)", async () => {
    const { url } = await serve(() => {});
    const started = Date.now();
    expect((await failure(get(url, { timeoutMs: 200 }))).code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("slow body (F3)", async () => {
    const { url } = await serve((_, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write('{"a":'); });
    expect((await failure(get(url, { timeoutMs: 300 }))).code).toBe("timeout");
  });

  it("abort (F3)", async () => {
    const { url } = await serve(() => {});
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    expect((await failure(get(url, { signal: controller.signal }))).code).toBe("aborted");
  });

  it("401 (F4)", async () => {
    const { url } = await serve((_, res) => json(res, 401, { error: { message: "bad key" } }));
    expect(await failure(get(url))).toMatchObject({ code: "auth", status: 401 });
  });

  it("key leak (F5)", async () => {
    const { url } = await serve((_, res) => json(res, 403, { error: { message: `Bad key ${KEY}, and also sk-proj-abcdefghijklmnop` } }));
    const error = await failure(get(url));
    for (const text of [error.message, String(error.stack), JSON.stringify(error)]) {
      expect(text).not.toContain(KEY);
      expect(text).not.toContain("sk-proj-abcdefghijklmnop");
    }
    expect(error.message).toContain("[redacted]");
  });

  it("500 (F6)", async () => {
    const { url } = await serve((_, res) => json(res, 500, { error: "model crashed" }));
    const error = await failure(get(url));
    expect(error).toMatchObject({ code: "http", status: 500 });
    expect(error.message).toContain("model crashed");
  });

  it("501 (F6)", async () => {
    const { url } = await serve((_, res) => json(res, 501, { error: { message: "This server does not support embeddings." } }));
    expect(await failure(get(url))).toMatchObject({ code: "unsupported", status: 501 });
  });

  it("model 404 (F7)", async () => {
    const { url } = await serve((_, res) => json(res, 404, { error: { message: 'model "m1" not found, try pulling it first' } }));
    expect((await failure(get(url))).code).toBe("model_not_found");
  });

  it("not json (F8)", async () => {
    const { url } = await serve((_, res) => { res.writeHead(200).end("<html>hello</html>"); });
    expect((await failure(get(url))).code).toBe("bad_response");
  });

  it("redirect (F73)", async () => {
    const other = await fakeServer((_, res) => json(res, 200, { stolen: true }));
    const { url } = await serve((_, res) => { res.writeHead(307, { location: `${other.url}/v1/x` }).end(); });
    const error = await failure(call(origin, `${url}/v1/x`, { headers: { "x-api-key": KEY, "api-key": KEY }, body: { a: 1 } }, 2000));
    await other.close();
    expect(error).toMatchObject({ code: "http", status: 307 });
    expect(error.message).toContain(other.url);
    expect(other.seen).toHaveLength(0);
  });

  it("slow body that keeps sending (F82)", async () => {
    const { url } = await serve(async (_, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      for (const piece of ['{"a"', ":", " 1", "}"]) {
        res.write(piece);
        await new Promise((done) => setTimeout(done, 150));
      }
      res.end();
    });
    expect(await get(url, { timeoutMs: 300 })).toEqual({ a: 1 });
  });
});
