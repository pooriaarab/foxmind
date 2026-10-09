// Failure modes F41-F45 in docs/failure-modes.md: the foxmind doctor command.
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { SALUKI } from "../src/index.js";
import { closedPort, fakeServer, json } from "./fake-server.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(closers.splice(0).map((close) => close())); });

async function run(argv: string[]) {
  let out = "";
  let err = "";
  const code = await main(argv, { out: (text) => (out += text), err: (text) => (err += text) });
  return { code, out, err };
}

async function listing(ids: string[]) {
  const server = await fakeServer((_, res) => json(res, 200, { data: ids.map((id) => ({ id })) }));
  closers.push(server.close);
  return server.url;
}

async function allClosed() {
  const down = await closedPort();
  return ["--ollama", down, "--llama-server", down, "--lm-studio", down];
}

describe("foxmind doctor", () => {
  it("nothing running (F41)", async () => {
    const { code, out } = await run(["doctor", ...(await allClosed())]);
    expect(code).toBe(1);
    expect(out).toMatch(/ollama\s+no/);
    expect(out).toMatch(/llama-server\s+no/);
    expect(out).toContain("ollama serve");
    expect(out).toContain(SALUKI.serve);
  });

  it("ollama running (F42)", async () => {
    const url = await listing(["qwen3:0.6b"]);
    const { code, out } = await run(["doctor", ...(await allClosed()), "--ollama", url]);
    expect(code).toBe(0);
    expect(out).toMatch(/ollama\s+yes.*qwen3:0\.6b/);
    expect(out).toMatch(/saluki\s+no/);
  });

  it("saluki running (F42)", async () => {
    const url = await listing([SALUKI.file]);
    const { code, out } = await run(["doctor", "--json", ...(await allClosed()), "--llama-server", url]);
    expect(code).toBe(0);
    const report = JSON.parse(out) as { checks: { name: string; ok: boolean; models?: string[] }[] };
    expect(report.checks.find((check) => check.name === "saluki")).toMatchObject({ ok: true });
    expect(report.checks.find((check) => check.name === "llama-server")).toMatchObject({ ok: true, models: [SALUKI.file] });
  });

  it("bad flag (F43)", async () => {
    expect(await run(["doctor", "--nope"])).toMatchObject({ code: 2, out: "", err: expect.stringContaining("Usage") });
    expect(await run(["dance"])).toMatchObject({ code: 2, err: expect.stringContaining("Usage") });
    expect(await run(["doctor", "--timeout", "soon"])).toMatchObject({ code: 2 });
  });

  it("no keys (F44)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-doctor-test-0123456789";
    try {
      const { out } = await run(["doctor", ...(await allClosed())]);
      expect(out).not.toContain("sk-ant-doctor-test");
      expect(out).toMatch(/cloud/);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("hung server (F45)", async () => {
    const hung = await fakeServer(() => {});
    closers.push(hung.close);
    const started = Date.now();
    const { out } = await run(["doctor", ...(await allClosed()), "--ollama", hung.url, "--timeout", "300"]);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(out).toMatch(/ollama\s+no.*300 ms/);
  });
});
