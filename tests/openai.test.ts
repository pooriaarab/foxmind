// Failure modes F9-F15 in docs/failure-modes.md, against a fake server over real HTTP.
import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { FoxmindError, openaiCompatible } from "../src/index.js";
import { closedPort, completion, fakeServer, json, type Handler } from "./fake-server.js";

const KEY = "sk-test-0123456789abcdefSECRET";
const hi = [{ role: "user" as const, content: "hi" }];
const tool = { type: "function" as const, function: { name: "click", parameters: { type: "object", properties: { id: { type: "string" } } } } };
let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

async function serve(handler: Handler) {
  const server = await fakeServer(handler);
  close = server.close;
  return { ...server, provider: openaiCompatible({ baseURL: `${server.url}/v1`, model: "m1", apiKey: KEY, timeoutMs: 2000 }) };
}

async function failure(promise: Promise<unknown>): Promise<FoxmindError> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(FoxmindError);
  return error as FoxmindError;
}

describe("openaiCompatible", () => {
  it("sends the OpenAI request shape and maps the reply and tool calls", async () => {
    const { provider, seen } = await serve((_, res) =>
      json(res, 200, completion({ content: null, tool_calls: [{ id: "c1", index: 0, type: "function", function: { name: "click", arguments: '{"id":"b2"}' } }] }, "tool_calls")),
    );
    const reply = await provider.chat!(hi, { tools: [tool], temperature: 0 });
    expect(seen[0]!.path).toBe("/v1/chat/completions");
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(seen[0]!.body).toMatchObject({ model: "m1", messages: hi, tools: [tool], temperature: 0 });
    expect(reply.finishReason).toBe("tool_calls");
    expect(reply.message.tool_calls).toEqual([{ id: "c1", type: "function", function: { name: "click", arguments: '{"id":"b2"}' } }]);
    expect(reply.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
    expect(provider.tier).toBe("local");
  });

  it("server down (F9)", async () => {
    const provider = openaiCompatible({ baseURL: `${await closedPort()}/v1`, model: "m1" });
    expect((await failure(provider.chat!(hi, {}))).code).toBe("unreachable");
    expect(await provider.probe()).toMatchObject({ ok: false, code: "unreachable" });
  });

  it("key leak (F15)", async () => {
    const { provider } = await serve((_, res) => json(res, 401, { error: { message: `Incorrect API key provided: ${KEY}` } }));
    const error = await failure(provider.chat!(hi, {}));
    for (const text of [error.message, String(error.stack), JSON.stringify(error), JSON.stringify(provider), inspect(provider, { depth: 5 }), JSON.stringify(provider.status())]) {
      expect(text).not.toContain(KEY);
      expect(text).not.toContain("0123456789abcdef");
    }
    expect(error.message).toContain("[redacted]");
  });

  it("wrong model (F10)", async () => {
    const { provider } = await serve((seen, res) =>
      seen.path === "/v1/models"
        ? json(res, 200, { object: "list", data: [{ id: "qwen3:0.6b" }, { id: "llama3" }] })
        : json(res, 404, { error: { message: 'model "m1" not found, try pulling it first' } }),
    );
    expect(await provider.probe()).toMatchObject({ ok: false, code: "model_not_found", reason: expect.stringContaining("qwen3:0.6b") });
    expect((await failure(provider.chat!(hi, {}))).code).toBe("model_not_found");
  });

  it("probe passes when the server has the model", async () => {
    const { provider } = await serve((_, res) => json(res, 200, { data: [{ id: "m1" }] }));
    expect(await provider.probe()).toMatchObject({ ok: true });
  });

  it("malformed tool call (F11)", async () => {
    const { provider } = await serve((_, res) =>
      json(res, 200, completion({ content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "click", arguments: '{"id": "b2"' } }] }, "tool_calls")),
    );
    const error = await failure(provider.chat!(hi, { tools: [tool] }));
    expect(error.code).toBe("bad_tool_call");
    expect(error.message).toContain("click");
    expect(error.raw).toBe('{"id": "b2"');
  });

  it("bad json (F12)", async () => {
    const { provider, seen } = await serve((_, res) => json(res, 200, completion({ content: "Sure! Here it is: {oops" })));
    expect((await failure(provider.chat!(hi, { json: true }))).code).toBe("bad_json");
    expect(seen[0]!.body.response_format).toEqual({ type: "json_object" });
  });

  it("json mode returns the JSON text without a think block", async () => {
    const { provider } = await serve((_, res) => json(res, 200, completion({ content: '<think>hmm</think>\n{"a":1}' })));
    const reply = await provider.chat!(hi, { json: true });
    expect(JSON.parse(reply.message.content!)).toEqual({ a: 1 });
    expect(reply.message.reasoning).toBe("hmm");
  });

  it("bad response (F13)", async () => {
    const { provider } = await serve((_, res) => json(res, 200, { nothing: true }));
    expect((await failure(provider.chat!(hi, {}))).code).toBe("bad_response");
  });

  it("embed sends the texts and returns vectors in order", async () => {
    const { provider, seen } = await serve((_, res) => json(res, 200, { data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }));
    expect(await provider.embed!(["a", "b"], {})).toEqual([[1, 0], [0, 1]]);
    expect(seen[0]).toMatchObject({ path: "/v1/embeddings", body: { model: "m1", input: ["a", "b"] } });
  });

  it("embed count (F14)", async () => {
    const { provider } = await serve((_, res) => json(res, 200, { data: [{ index: 0, embedding: [1] }] }));
    expect((await failure(provider.embed!(["a", "b"], {}))).code).toBe("bad_response");
  });

  it("tool call that is not an object (F11)", async () => {
    const { provider } = await serve((_, res) =>
      json(res, 200, completion({ content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "click", arguments: "[1]" } }] }, "tool_calls")),
    );
    expect((await failure(provider.chat!(hi, { tools: [tool] }))).code).toBe("bad_tool_call");
  });
});
