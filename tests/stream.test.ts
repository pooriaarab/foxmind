// Failure modes F16-F20 in docs/failure-modes.md: streamed chat over real HTTP.
import { afterEach, describe, expect, it } from "vitest";
import { FoxmindError, openaiCompatible } from "../src/index.js";
import { fakeServer, sse, type Handler } from "./fake-server.js";

const hi = [{ role: "user" as const, content: "hi" }];
let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

async function serve(handler: Handler) {
  const server = await fakeServer(handler);
  close = server.close;
  return { ...server, provider: openaiCompatible({ baseURL: `${server.url}/v1`, model: "m1", timeoutMs: 2000 }) };
}

async function failure(promise: Promise<unknown>): Promise<FoxmindError> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(FoxmindError);
  return error as FoxmindError;
}

const text = (content: string, finish_reason: string | null = null) => ({ choices: [{ index: 0, delta: { content }, finish_reason }] });
const call = (index: number, args: string, head?: { id: string; name: string }) => ({
  choices: [{ index: 0, delta: { tool_calls: [{ index, ...(head ? { id: head.id, type: "function" } : {}), function: { ...(head ? { name: head.name } : {}), arguments: args } }] }, finish_reason: null }],
});

describe("streaming", () => {
  it("streams text to onDelta and returns the whole reply", async () => {
    const { provider, seen } = await serve((_, res) => sse(res, [text("Hel"), text("lo"), text("", "stop"), { choices: [], usage: { prompt_tokens: 4, completion_tokens: 2 } }, "data: [DONE]\n\n"]));
    const pieces: string[] = [];
    const reply = await provider.chat!(hi, { onDelta: (piece) => pieces.push(piece) });
    expect(seen[0]!.body).toMatchObject({ stream: true });
    expect(pieces).toEqual(["Hel", "lo"]);
    expect(reply).toMatchObject({ message: { role: "assistant", content: "Hello" }, finishReason: "stop", usage: { inputTokens: 4, outputTokens: 2 } });
  });

  it("server down mid-stream (F16)", async () => {
    const { provider } = await serve((_, res) => sse(res, [text("Part"), text("ial")], true));
    const error = await failure(provider.chat!(hi, { onDelta: () => {} }));
    expect(error).toMatchObject({ code: "stream_interrupted", partial: "Partial", provider: "openai-compatible" });
  });

  it("stream ends early (F17)", async () => {
    const { provider } = await serve((_, res) => sse(res, [text("Part")]));
    expect((await failure(provider.chat!(hi, { onDelta: () => {} }))).code).toBe("stream_interrupted");
  });

  it("a finish_reason without [DONE] is a success (F17)", async () => {
    const { provider } = await serve((_, res) => sse(res, [text("Done", "stop")]));
    expect((await provider.chat!(hi, { onDelta: () => {} })).message.content).toBe("Done");
  });

  it("error event (F18)", async () => {
    const { provider } = await serve((_, res) => sse(res, [text("a"), { error: { message: "context size exceeded" } }]));
    const error = await failure(provider.chat!(hi, { onDelta: () => {} }));
    expect(error.code).toBe("http");
    expect(error.message).toContain("context size exceeded");
  });

  it("streamed tool call (F19)", async () => {
    const { provider } = await serve((_, res) =>
      sse(res, [call(0, "", { id: "c1", name: "click" }), call(0, '{"id":'), call(0, '"b2"}'), call(1, "{}", { id: "c2", name: "read" }), { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }, "data: [DONE]\n\n"]),
    );
    const reply = await provider.chat!(hi, { onDelta: () => {} });
    expect(reply.finishReason).toBe("tool_calls");
    expect(reply.message.tool_calls).toEqual([
      { id: "c1", type: "function", function: { name: "click", arguments: '{"id":"b2"}' } },
      { id: "c2", type: "function", function: { name: "read", arguments: "{}" } },
    ]);
  });

  it("streamed bad tool call (F19)", async () => {
    const { provider } = await serve((_, res) => sse(res, [call(0, '{"id":', { id: "c1", name: "click" }), { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }, "data: [DONE]\n\n"]));
    expect((await failure(provider.chat!(hi, { onDelta: () => {} }))).code).toBe("bad_tool_call");
  });

  it("stalled stream (F20)", async () => {
    const { provider } = await serve((_, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(`data: ${JSON.stringify(text("wait"))}\n\n`); });
    const error = await failure(provider.chat!(hi, { onDelta: () => {}, timeoutMs: 300 }));
    expect(error).toMatchObject({ code: "timeout", partial: "wait" });
  });

  it("long healthy stream (F82)", async () => {
    const { provider } = await serve(async (_, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (let i = 0; i < 8; i++) {
        res.write(`data: ${JSON.stringify(text(`w${i} `))}\n\n`);
        await new Promise((done) => setTimeout(done, 100));
      }
      res.end(`data: ${JSON.stringify(text("", "stop"))}\n\ndata: [DONE]\n\n`);
    });
    const reply = await provider.chat!(hi, { onDelta: () => {}, timeoutMs: 300 });
    expect(reply.message.content).toBe("w0 w1 w2 w3 w4 w5 w6 w7 ");
  });
});
