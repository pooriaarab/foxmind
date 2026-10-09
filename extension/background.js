// The demo's background page (an event page with a DOM in Firefox MV3). It
// hosts the models, so every view shares one loaded model. Views send it
// requests with browser.runtime.sendMessage.
import { hasWebGPU, transformers, trialML } from "../src/browser/index.js";
import { createMind, llamaServer, ollama, saluki } from "../src/index.js";
import { testOps } from "./e2e/ops.js";

const trial = trialML({ task: "embed" });
const embedder = transformers({ task: "embed" });

/** The models a local server lists, or why it cannot be reached. */
async function models(url) {
  try {
    const response = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    return { ok: true, models: ((await response.json()).data ?? []).map((model) => model.id) };
  } catch (error) {
    return { ok: false, reason: `not running (${error.message})` };
  }
}

async function tiers() {
  const [llama, olla] = await Promise.all([models("http://127.0.0.1:8080"), models("http://127.0.0.1:11434")]);
  const serving = llama.models?.find((id) => /saluki/i.test(id));
  return {
    webgpu: await hasWebGPU(),
    trialml: await trial.probe(),
    servers: {
      "llama-server": llama,
      saluki: serving ? { ok: true, models: [serving] } : { ok: false, reason: llama.ok ? "llama-server serves another model" : "llama-server is not running" },
      ollama: olla,
    },
  };
}

async function localChat(prompt) {
  const found = await tiers();
  const servers = [saluki(), llamaServer()];
  if (found.servers.ollama.models?.length) servers.push(ollama({ model: found.servers.ollama.models[0] }));
  // prefer may name only providers that exist: Ollama is left out when it is not running.
  const prefer = ["saluki", "llama-server", "ollama"].filter((name) => servers.some((server) => server.name === name));
  const mind = createMind({ providers: servers, only: ["local"], prefer });
  const result = await mind.chat([{ role: "user", content: prompt }], { maxTokens: 200 });
  return { content: result.message.content, provider: result.provider, tier: result.tier, ms: result.ms, skipped: result.skipped };
}

async function pair(texts) {
  const started = Date.now();
  const [a, b] = await embedder.embed(texts, {});
  return { similarity: a.reduce((sum, x, i) => sum + x * b[i], 0), where: embedder.status().where, ms: Date.now() - started };
}
const failed = (error) => ({ error: { code: error.code ?? "error", message: error.message } });

const ops = {
  tiers: () => tiers(),
  "local-chat": (message) => localChat(message.prompt),
  pair: (message) => pair(message.texts),
};
// The e2e build (--e2e) adds test-only ops. __E2E__ is false in the build AMO
// signs, so esbuild drops the ops and their module from it.
if (__E2E__) Object.assign(ops, testOps({ trial, failed }));

browser.runtime.onMessage.addListener(async (message) => {
  const op = ops[message.op];
  if (!op) return { error: { code: "unsupported", message: `Unknown op ${message.op}` } };
  return op(message).catch(failed);
});
