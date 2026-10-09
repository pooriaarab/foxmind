// Failure modes F28-F32 in docs/failure-modes.md: the local server presets.
import { afterEach, describe, expect, it } from "vitest";
import { createMind, llamaServer, lmStudio, ollama, openaiCompatible, saluki, SALUKI } from "../src/index.js";
import { closedPort, completion, fakeServer, json } from "./fake-server.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

/** A fake server whose /v1/models lists `ids`. */
async function serving(ids: string[]) {
  const server = await fakeServer((seen, res) => (seen.path === "/v1/models" ? json(res, 200, { data: ids.map((id) => ({ id })) }) : json(res, 200, completion({ content: "ok" }))));
  close = server.close;
  return server;
}

describe("presets", () => {
  it("saluki wrong model (F28)", async () => {
    const { url } = await serving(["qwen3-0.6b.gguf"]);
    const probe = await saluki({ baseURL: `${url}/v1` }).probe();
    expect(probe).toMatchObject({ ok: false, code: "model_not_found" });
    expect(probe.reason).toContain("qwen3-0.6b.gguf");
    expect(probe.reason).toContain(SALUKI.serve);
  });

  it("saluki matches the GGUF file llama-server lists", async () => {
    const { url } = await serving([`/models/${SALUKI.file}`]);
    expect(await saluki({ baseURL: `${url}/v1` }).probe()).toMatchObject({ ok: true });
  });

  it("ollama not pulled (F29)", async () => {
    const { url } = await serving(["qwen3:0.6b", "llama3.2:latest"]);
    const probe = await ollama({ model: "mistral", baseURL: `${url}/v1` }).probe();
    expect(probe).toMatchObject({ ok: false, code: "model_not_found" });
    expect(probe.reason).toContain("ollama pull mistral");
    expect(await ollama({ model: "llama3.2", baseURL: `${url}/v1` }).probe()).toMatchObject({ ok: true });
    expect(await ollama({ model: "qwen3:0.6b", baseURL: `${url}/v1` }).probe()).toMatchObject({ ok: true });
  });

  it("llama-server any name (F30)", async () => {
    const { url } = await serving(["whatever.gguf"]);
    expect(await llamaServer({ baseURL: `${url}/v1` }).probe()).toMatchObject({ ok: true });
  });

  it("saluki settings (F31)", async () => {
    const server = await serving([SALUKI.file]);
    await saluki({ baseURL: `${server.url}/v1` }).chat!([{ role: "user", content: "hi" }], {});
    expect(server.seen.at(-1)!.body).toMatchObject({ model: SALUKI.file, temperature: 0, chat_template_kwargs: { enable_thinking: false } });
    await saluki({ baseURL: `${server.url}/v1`, thinking: true }).chat!([{ role: "user", content: "hi" }], {});
    expect(server.seen.at(-1)!.body).toMatchObject({ temperature: 0.6, top_p: 0.95, top_k: 20, chat_template_kwargs: { enable_thinking: true } });
  });

  it("preset down (F32)", async () => {
    const baseURL = `${await closedPort()}/v1`;
    for (const [provider, hint] of [[saluki({ baseURL }), "llama-server -m"], [ollama({ model: "qwen3:0.6b", baseURL }), "ollama serve"], [lmStudio({ model: "x", baseURL }), "lms server start"], [llamaServer({ baseURL }), "llama-server -m"]] as const) {
      const probe = await provider.probe();
      expect(probe).toMatchObject({ ok: false, code: "unreachable" });
      expect(probe.reason).toContain(hint);
    }
  });

  it("default addresses and tiers", () => {
    expect(ollama({ model: "m" }).status()).toMatchObject({ name: "ollama", tier: "local", where: "http://127.0.0.1:11434/v1" });
    expect(llamaServer().status()).toMatchObject({ name: "llama-server", where: "http://127.0.0.1:8080/v1" });
    expect(lmStudio({ model: "m" }).status()).toMatchObject({ name: "lm-studio", where: "http://127.0.0.1:1234/v1" });
    expect(saluki().status()).toMatchObject({ name: "saluki", tier: "local", where: "http://127.0.0.1:8080/v1", model: SALUKI.file });
  });

  it("cloud model name (F90)", async () => {
    expect(ollama({ model: "gpt-oss:120b-cloud" }).tier).toBe("cloud");
    expect(ollama({ model: "deepseek-v3.1:cloud" }).tier).toBe("cloud");
    expect(openaiCompatible({ baseURL: "http://127.0.0.1:11434/v1", model: "qwen3-coder:480b-cloud" }).tier).toBe("cloud");
    expect(ollama({ model: "qwen3:0.6b" }).tier).toBe("local");
    const mind = createMind({ providers: [ollama({ model: "qwen3:0.6b" }), ollama({ model: "gpt-oss:120b-cloud", name: "ollama-cloud" })], only: ["browser", "local"] });
    expect(mind.providers.map((provider) => provider.name)).toEqual(["ollama"]);
  });

  it("remote model without the suffix (F91)", async () => {
    const server = await fakeServer((seen, res) => {
      if (seen.path === "/v1/models") return json(res, 200, { data: [{ id: "big:latest" }, { id: "qwen3:0.6b" }] });
      if (seen.path === "/api/tags") return json(res, 200, { models: [{ name: "big:latest", remote_model: "big", remote_host: "https://ollama.com:443" }, { name: "qwen3:0.6b" }] });
      return json(res, 404, {});
    });
    close = server.close;
    const remote = await ollama({ model: "big", baseURL: `${server.url}/v1` }).probe();
    expect(remote).toMatchObject({ ok: false, code: "remote_model" });
    expect(remote.reason).toContain("https://ollama.com:443");
    expect(await ollama({ model: "qwen3:0.6b", baseURL: `${server.url}/v1` }).probe()).toMatchObject({ ok: true });
    expect(await ollama({ model: "big", baseURL: `${server.url}/v1`, tier: "cloud" }).probe()).toMatchObject({ ok: true });
  });
});
