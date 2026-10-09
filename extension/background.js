// The demo's background page (an event page with a DOM in Firefox MV3). It
// hosts the models, so every view shares one loaded model. Views send it
// requests with browser.runtime.sendMessage; e2e/run.mjs does the same.
import { configureRuntime, gliner2, hasWebGPU, purgeModel, transformers, trialML, wllama } from "../src/browser/index.js";

const providers = new Map();

function provider(message, task = "embed") {
  const key = message.id ?? message.model;
  if (!providers.has(key)) providers.set(key, transformers({ task, model: message.model, device: message.device ?? "auto" }));
  return providers.get(key);
}

const trial = trialML({ task: "embed" });
const entities = gliner2();

const failed = (error) => ({ error: { code: error.code ?? "error", message: error.message } });

async function handle(message) {
  if (message.remoteHost) configureRuntime({ remoteHost: message.remoteHost });
  switch (message.op) {
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
