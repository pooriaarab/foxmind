// A fake model server for the tests. Each test gives a handler; the server
// calls it for every request and records what it got. The calls go over real
// HTTP on 127.0.0.1, so the provider's fetch, headers and body parsing all run.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type Seen = { method: string; path: string; headers: IncomingMessage["headers"]; body: any };
export type Handler = (seen: Seen, res: ServerResponse) => void | Promise<void>;

export async function fakeServer(handler: Handler) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const entry = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
      seen.push(entry);
      void handler(entry, res);
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }),
  };
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
}

/** Write each event as an SSE `data:` line. `cut` drops the connection after the events. */
export async function sse(res: ServerResponse, events: (string | object)[], cut = false) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) {
    res.write(typeof event === "string" ? event : `data: ${JSON.stringify(event)}\n\n`);
    await new Promise((done) => setTimeout(done, 5));
  }
  if (cut) res.destroy();
  else res.end();
}

/** An OpenAI chat completion with one assistant message. */
export function completion(message: Record<string, unknown>, finish_reason = "stop") {
  return { id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason }], usage: { prompt_tokens: 3, completion_tokens: 2 } };
}

/** A port with nothing listening on it. */
export async function closedPort(): Promise<string> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((done) => server.close(() => done()));
  return `http://127.0.0.1:${port}`;
}
