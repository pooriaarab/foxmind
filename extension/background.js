// The demo's background page (an event page with a DOM in Firefox MV3). It
// hosts the models, so every view shares one loaded model. Views send it
// requests with browser.runtime.sendMessage; e2e/run.mjs does the same.
import { configureRuntime, gliner2, hasWebGPU, purgeModel, transformers, trialML, wllama } from "../src/browser/index.js";
import { createMind, llamaServer, ollama, saluki } from "../src/index.js";

const providers = new Map();

function provider(message, task = "embed") {
  const key = message.id ?? message.model;
  if (!providers.has(key)) providers.set(key, transformers({ task, model: message.model, device: message.device ?? "auto" }));
  return providers.get(key);
}

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
  const mind = createMind({ providers: servers, prefer });
  const result = await mind.chat([{ role: "user", content: prompt }], { maxTokens: 200 });
  return { content: result.message.content, provider: result.provider, tier: result.tier, ms: result.ms, skipped: result.skipped };
}

async function pair(texts) {
  const started = Date.now();
  const [a, b] = await embedder.embed(texts, {});
  return { similarity: a.reduce((sum, x, i) => sum + x * b[i], 0), where: embedder.status().where, ms: Date.now() - started };
}
const entities = gliner2();

const failed = (error) => ({ error: { code: error.code ?? "error", message: error.message } });

async function handle(message) {
  if (message.remoteHost) configureRuntime({ remoteHost: message.remoteHost });
  switch (message.op) {
    case "tiers":
      return tiers();
    case "local-chat":
      return localChat(message.prompt);
    case "pair":
      return pair(message.texts);
    case "env":
      return { crossOriginIsolated: globalThis.crossOriginIsolated, sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined", webgpuAdapter: await hasWebGPU(), userAgent: navigator.userAgent };
    case "probe":
      return provider(message).probe();
    case "embed": {
      const chosen = provider(message);
      try {
        return { vectors: await chosen.embed(message.texts, {}), status: chosen.status() };
      } catch (error) {
        return { ...failed(error), status: chosen.status() };
      }
    }
    case "chat": {
      const chosen = provider(message, "chat");
      try {
        return { reply: await chosen.chat(message.messages, { tools: message.tools }), status: chosen.status() };
      } catch (error) {
        return { ...failed(error), status: chosen.status() };
      }
    }
    case "trial": {
      if (message.step === "probe") return trial.probe();
      if (message.step === "second") return trialML({ task: "embed", model: "Xenova/paraphrase-MiniLM-L3-v2" }).embed(["x"], {}).catch(failed);
      try {
        return { vectors: await trial.embed(message.texts, {}), status: trial.status() };
      } catch (error) {
        return { ...failed(error), status: trial.status() };
      }
    }
    case "gliner2": {
      try {
        if (message.step === "status") return entities.status();
        if (message.step === "load") return { loaded: await entities.load(), status: entities.status() };
        if (message.step === "extract") return { result: await entities.extract(message.text, message.labels, {}) };
        return { result: (await entities.classify([message.text], "referenced", message.labels, {}))[0] };
      } catch (error) {
        return { ...failed(error), status: entities.status() };
      }
    }
    case "wllama": {
      const llama = wllama({ model: message.model, modelFile: message.modelFile });
      if (message.step === "probe") return llama.probe();
      try {
        return { reply: await llama.chat(message.messages, { maxTokens: 24, timeoutMs: message.timeoutMs }), status: llama.status() };
      } catch (error) {
        return { ...failed(error), status: llama.status() };
      }
    }
    case "corrupt": {
      // Overwrite this model's cached files with junk, as a broken disk would.
      const cache = await caches.open("transformers-cache");
      const keys = (await cache.keys()).filter((request) => request.url.includes(`/${message.model}/`) && /\.(onnx|json)$/.test(request.url));
      await Promise.all(keys.map((key) => cache.put(key, new Response("not a model"))));
      return { changed: keys.length };
    }
    case "purge":
      return { removed: await purgeModel(message.model) };
    default:
      return { error: { code: "unsupported", message: `Unknown op ${message.op}` } };
  }
}

browser.runtime.onMessage.addListener((message) => handle(message).catch(failed));
