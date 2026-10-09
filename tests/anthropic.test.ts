// Failure modes F33-F40 in docs/failure-modes.md: the Anthropic Messages API mapped to the OpenAI shape.
import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { anthropic, FoxmindError, type Message } from "../src/index.js";
import { fakeServer, json, type Handler } from "./fake-server.js";

const KEY = "sk-ant-api03-test0123456789SECRET";
const tool = { type: "function" as const, function: { name: "click", description: "Click", parameters: { type: "object", properties: { id: { type: "string" } } } } };
let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

async function serve(handler: Handler) {
  const server = await fakeServer(handler);
  close = server.close;
  return { ...server, provider: anthropic({ apiKey: KEY, baseURL: server.url, model: "claude-test", timeoutMs: 2000 }) };
}

async function failure(promise: Promise<unknown>): Promise<FoxmindError> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(FoxmindError);
  return error as FoxmindError;
}

const message = (content: object[], stop_reason = "end_turn") => ({ id: "msg_1", type: "message", role: "assistant", model: "claude-test", content, stop_reason, usage: { input_tokens: 5, output_tokens: 7 } });

/** Anthropic-style SSE: `event:` and `data:` lines. */
async function events(res: import("node:http").ServerResponse, list: [string, object][], cut = false) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const [event, data] of list) {
    res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
    await new Promise((done) => setTimeout(done, 5));
  }
  if (cut) res.destroy();
  else res.end();
}

describe("anthropic", () => {
  it("request shape (F33, F34)", async () => {
    const { provider, seen } = await serve((_, res) => json(res, 200, message([{ type: "text", text: "done" }])));
    const history: Message[] = [
      { role: "system", content: "Be brief." },
      { role: "user", content: "Click both." },
      { role: "assistant", content: "Sure.", tool_calls: [{ id: "t1", type: "function", function: { name: "click", arguments: '{"id":"a"}' } }, { id: "t2", type: "function", function: { name: "click", arguments: '{"id":"b"}' } }] },
      { role: "tool", tool_call_id: "t1", content: "ok a" },
      { role: "tool", tool_call_id: "t2", content: "ok b" },
      { role: "system", content: "Now summarize." },
    ];
    const reply = await provider.chat!(history, { tools: [tool], maxTokens: 100 });
    const sent = seen[0]!;
    expect(sent.path).toBe("/v1/messages");
    expect(sent.headers).toMatchObject({ "x-api-key": KEY, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" });
    expect(sent.body).toEqual({
      model: "claude-test",
      max_tokens: 100,
      system: "Be brief.",
      tools: [{ name: "click", description: "Click", input_schema: tool.function.parameters }],
      messages: [
        { role: "user", content: "Click both." },
        { role: "assistant", content: [{ type: "text", text: "Sure." }, { type: "tool_use", id: "t1", name: "click", input: { id: "a" } }, { type: "tool_use", id: "t2", name: "click", input: { id: "b" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok a" }, { type: "tool_result", tool_use_id: "t2", content: "ok b" }] },
        { role: "system", content: "Now summarize." },
      ],
    });
    expect(reply.message.content).toBe("done");
  });

  it("bad tool call in history (F35)", async () => {
    const { provider, seen } = await serve((_, res) => json(res, 200, message([])));
    const history: Message[] = [{ role: "user", content: "x" }, { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "click", arguments: "{oops" } }] }];
    expect((await failure(provider.chat!(history, {}))).code).toBe("bad_tool_call");
    expect(seen).toHaveLength(0);
  });

  it("reply shape (F36)", async () => {
    const { provider } = await serve((_, res) => json(res, 200, message([{ type: "text", text: "Clicking." }, { type: "tool_use", id: "t9", name: "click", input: { id: "z" } }], "tool_use")));
    const reply = await provider.chat!([{ role: "user", content: "go" }], { tools: [tool] });
    expect(reply).toMatchObject({
      finishReason: "tool_calls",
      usage: { inputTokens: 5, outputTokens: 7 },
      message: { role: "assistant", content: "Clicking.", tool_calls: [{ id: "t9", type: "function", function: { name: "click", arguments: '{"id":"z"}' } }] },
    });
    for (const [stop, finish] of [["max_tokens", "length"], ["refusal", "content_filter"], ["end_turn", "stop"]]) {
      close?.();
      const again = await serve((_, res) => json(res, 200, message([{ type: "text", text: "x" }], stop)));
      expect((await again.provider.chat!([{ role: "user", content: "go" }], {})).finishReason).toBe(finish);
    }
  });

  it("thinking blocks go back (F36)", async () => {
    const blocks = [{ type: "thinking", thinking: "", signature: "sig" }, { type: "tool_use", id: "t1", name: "click", input: {} }];
    const { provider, seen } = await serve((_, res) => json(res, 200, message(blocks, "tool_use")));
    const first = await provider.chat!([{ role: "user", content: "go" }], { tools: [tool] });
    await provider.chat!([{ role: "user", content: "go" }, first.message, { role: "tool", tool_call_id: "t1", content: "ok" }], { tools: [tool] });
    expect(seen[1]!.body.messages[1]).toEqual({ role: "assistant", content: blocks });
    expect(first.message.tool_calls![0]!.function.arguments).toBe("{}");
  });

  it("json (F37)", async () => {
    const { provider, seen } = await serve((_, res) => json(res, 200, message([{ type: "text", text: 'Here:\n```json\n{"a":1}\n```' }])));
    const reply = await provider.chat!([{ role: "user", content: "go" }], { json: true });
    expect(reply.message.content).toBe('{"a":1}');
    expect(seen[0]!.body.system).toMatch(/JSON/);
    close?.();
    const bad = await serve((_, res) => json(res, 200, message([{ type: "text", text: "no json here" }])));
    expect((await failure(bad.provider.chat!([{ role: "user", content: "go" }], { json: true }))).code).toBe("bad_json");
  });

  const opening: [string, object][] = [["message_start", { message: message([]) }]];

  it("stream (F38)", async () => {
    const { provider, seen } = await serve((_, res) =>
      events(res, [
        ...opening,
        ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "Hel" } }],
        ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "lo" } }],
        ["content_block_stop", { index: 0 }],
        ["content_block_start", { index: 1, content_block: { type: "tool_use", id: "t1", name: "click", input: {} } }],
        ["content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: '{"id":' } }],
        ["content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: '"q"}' } }],
        ["content_block_stop", { index: 1 }],
        ["message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } }],
        ["message_stop", {}],
      ]),
    );
    const pieces: string[] = [];
    const reply = await provider.chat!([{ role: "user", content: "go" }], { tools: [tool], onDelta: (piece) => pieces.push(piece) });
    expect(seen[0]!.body.stream).toBe(true);
    expect(pieces).toEqual(["Hel", "lo"]);
    expect(reply).toMatchObject({ finishReason: "tool_calls", message: { content: "Hello", tool_calls: [{ id: "t1", function: { name: "click", arguments: '{"id":"q"}' } }] } });
  });

  it("stream ends early (F38)", async () => {
    const { provider } = await serve((_, res) =>
      events(res, [...opening, ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }], ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "Par" } }]], true),
    );
    expect(await failure(provider.chat!([{ role: "user", content: "go" }], { onDelta: () => {} }))).toMatchObject({ code: "stream_interrupted", partial: "Par" });
  });

  it("error event (F38)", async () => {
    const { provider } = await serve((_, res) => events(res, [...opening, ["error", { error: { type: "overloaded_error", message: "Overloaded" } }]]));
    const error = await failure(provider.chat!([{ role: "user", content: "go" }], { onDelta: () => {} }));
    expect(error.code).toBe("http");
    expect(error.message).toContain("Overloaded");
  });

  it("busy (F39)", async () => {
    const { provider } = await serve((_, res) => json(res, 429, { type: "error", error: { type: "rate_limit_error", message: "slow" } }, { "retry-after": "3" }));
    expect(await failure(provider.chat!([{ role: "user", content: "go" }], {}))).toMatchObject({ code: "rate_limited", retryAfterMs: 3000 });
    close?.();
    const busy = await serve((_, res) => json(res, 529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
    expect(await failure(busy.provider.chat!([{ role: "user", content: "go" }], {}))).toMatchObject({ code: "http", status: 529 });
  });

  it("probe (F40)", async () => {
    const { provider, seen } = await serve((request, res) =>
      request.path === "/v1/models/claude-test" ? json(res, 200, { id: "claude-test", type: "model" }) : json(res, 404, { type: "error", error: { type: "not_found_error", message: "model: nope" } }),
    );
    expect(await provider.probe()).toMatchObject({ ok: true });
    expect(seen[0]!.headers["x-api-key"]).toBe(KEY);
    const wrong = anthropic({ apiKey: KEY, baseURL: seen.length ? provider.status().where! : "", model: "nope" });
    expect(await wrong.probe()).toMatchObject({ ok: false, code: "model_not_found" });
    expect((await failure(wrong.chat!([{ role: "user", content: "go" }], {}))).code).toBe("model_not_found");
  });

  it("key leak (F40)", async () => {
    const { provider } = await serve((_, res) => json(res, 401, { type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${KEY}` } }));
    const error = await failure(provider.chat!([{ role: "user", content: "go" }], {}));
    expect(error.code).toBe("auth");
    expect((await provider.probe()).code).toBe("auth");
    for (const text of [error.message, String(error.stack), JSON.stringify(error), JSON.stringify(provider), inspect(provider, { depth: 5 }), JSON.stringify(provider.status())]) {
      expect(text).not.toContain("test0123456789SECRET");
    }
    expect(provider.capabilities).not.toContain("embed");
  });
});
