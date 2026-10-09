// Test-only background ops for e2e/run.mjs. Only the e2e build has them
// (node scripts/build-ext.mjs --e2e). The build AMO signs drops this file.
import { configureRuntime, gliner2, hasWebGPU, purgeModel, transformers, trialML, wllama } from "../../src/browser/index.js";

/** The ops, given the shared trial ML provider (Firefox allows one engine) and the error mapper. */
export function testOps({ trial, failed }) {
  const providers = new Map();
  const entities = gliner2();
  const provider = (message, task = "embed") => {
    const key = message.id ?? message.model;
    if (!providers.has(key)) providers.set(key, transformers({ task, model: message.model, device: message.device ?? "auto" }));
    return providers.get(key);
  };
  const reported = async (chosen, work) => {
    try {
      return { ...(await work()), status: chosen.status() };
    } catch (error) {
      return { ...failed(error), status: chosen.status() };
    }
  };
  const ops = {
    env: async () => ({ crossOriginIsolated: globalThis.crossOriginIsolated, sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined", webgpuAdapter: await hasWebGPU(), userAgent: navigator.userAgent }),
    probe: (message) => provider(message).probe(),
    embed: (message) => reported(provider(message), async () => ({ vectors: await provider(message).embed(message.texts, {}) })),
    chat: (message) => reported(provider(message, "chat"), async () => ({ reply: await provider(message, "chat").chat(message.messages, { tools: message.tools }) })),
    trial: async (message) => {
      if (message.step === "probe") return trial.probe();
      if (message.step === "second") return trialML({ task: "embed", model: "Xenova/paraphrase-MiniLM-L3-v2" }).embed(["x"], {}).catch(failed);
      return reported(trial, async () => ({ vectors: await trial.embed(message.texts, {}) }));
    },
    gliner2: (message) =>
      reported(entities, async () => {
        if (message.step === "status") return entities.status();
        if (message.step === "load") return { loaded: await entities.load() };
        if (message.step === "extract") return { result: await entities.extract(message.text, message.labels, {}) };
        return { result: (await entities.classify([message.text], "referenced", message.labels, {}))[0] };
      }),
    wllama: (message) => {
      const llama = wllama({ model: message.model, modelFile: message.modelFile });
      if (message.step === "probe") return llama.probe();
      return reported(llama, async () => ({ reply: await llama.chat(message.messages, { maxTokens: 24, timeoutMs: message.timeoutMs }) }));
    },
    corrupt: async (message) => {
      // Overwrite this model's cached files with junk, as a broken disk would.
      const cache = await caches.open("transformers-cache");
      const keys = (await cache.keys()).filter((request) => request.url.includes(`/${message.model}/`) && /\.(onnx|json)$/.test(request.url));
      await Promise.all(keys.map((key) => cache.put(key, new Response("not a model"))));
      return { changed: keys.length };
    },
    purge: async (message) => ({ removed: await purgeModel(message.model) }),
  };
  // The test points model downloads at its local proxy.
  return Object.fromEntries(
    Object.entries(ops).map(([name, op]) => [
      name,
      (message) => {
        if (message.remoteHost) configureRuntime({ remoteHost: message.remoteHost });
        return op(message);
      },
    ]),
  );
}
