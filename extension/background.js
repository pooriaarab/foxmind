// The demo's background page (an event page with a DOM in Firefox MV3). It
// hosts the models, so every view shares one loaded model. Views send it
// requests with browser.runtime.sendMessage; e2e/run.mjs does the same.
import { configureRuntime, hasWebGPU, purgeModel, transformers } from "../src/browser/index.js";

const providers = new Map();

function provider(message) {
  const key = message.id ?? message.model;
  if (!providers.has(key)) providers.set(key, transformers({ task: "embed", model: message.model, device: message.device ?? "auto" }));
  return providers.get(key);
}

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
