// A local proxy to huggingface.co for the E2E test. It adds CORS headers and
// can cut one model file in half, so the test sees a real broken download.
import { createServer } from "node:http";

export async function startHub() {
  const state = { cut: false, requests: [] };
  const server = createServer(async (req, res) => {
    const path = req.url ?? "/";
    if (!req.headers.range) state.requests.push(path);
    const cors = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
    if (req.method === "OPTIONS") return res.writeHead(204, { ...cors, "access-control-allow-headers": "*" }).end();
    try {
      const range = req.headers.range;
      const upstream = await fetch(`https://huggingface.co${path}`, { redirect: "follow", headers: range ? { range } : {} });
      const body = Buffer.from(await upstream.arrayBuffer());
      const headers = { ...cors, "content-type": upstream.headers.get("content-type") ?? "application/octet-stream" };
      for (const name of ["content-range", "etag"]) if (upstream.headers.get(name)) headers[name] = upstream.headers.get(name);
      if (state.cut && !range && path.endsWith(".onnx") && upstream.ok) {
        state.cut = false;
        res.writeHead(200, { ...headers, "content-length": String(body.length) });
        res.write(body.subarray(0, body.length >> 1));
        setTimeout(() => res.destroy(), 50);
        return;
      }
      res.writeHead(upstream.status, { ...headers, "content-length": String(body.length) }).end(body);
    } catch (error) {
      res.writeHead(502, cors).end(String(error));
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    state,
    close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }),
  };
}
