// A fake llama-server for the E2E test, on 127.0.0.1:8080 where the demo
// panel and foxmind doctor look for one. CI runners have no model server, so
// without it the panel's test prompt could only ever fail. When something
// already listens on 8080 (a real llama-server), the test uses that instead.
import { createServer } from "node:http";

const MODEL = "fake-llama.gguf";

function reply(body) {
  if (body.tools?.length) {
    const name = body.tools[0].function.name;
    return { content: null, tool_calls: [{ id: "call_fake", type: "function", function: { name, arguments: '{"city":"Paris"}' } }] };
  }
  if (body.response_format?.type === "json_object") return { content: '{"ok": true}' };
  return { content: "ready" };
}

export async function startFakeLlama() {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (req.url === "/v1/models") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", data: [{ id: MODEL }] }));
      if (req.url !== "/v1/chat/completions") return res.writeHead(404).end();
      const body = JSON.parse(raw || "{}");
      const message = { role: "assistant", ...reply(body) };
      const finish = message.tool_calls ? "tool_calls" : "stop";
      if (!body.stream) {
        return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      if (message.tool_calls) send({ tool_calls: [{ index: 0, ...message.tool_calls[0] }] });
      else for (const piece of message.content.match(/.{1,2}/g)) send({ content: piece });
      send({}, finish);
      res.end("data: [DONE]\n\n");
    });
  });
  const listening = await new Promise((done) => {
    server.once("error", () => done(false));
    server.listen(8080, "127.0.0.1", () => done(true));
  });
  if (!listening) return undefined;
  return { model: MODEL, close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }) };
}
