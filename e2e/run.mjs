// The E2E test: install the built demo extension (dist-ext/) in a real
// Firefox, run in-browser models in its background page, and write
// artifacts/e2e-<date>.json with every check and timing.
// Usage: pnpm e2e [--headed]. Env: FIREFOX (the Firefox binary).
import { launch, poll, writeArtifact } from "create-foxkit/e2e";
import { readFileSync } from "node:fs";
import { doctor } from "../dist/index.js";
import { startFakeLlama } from "./fake-llama.mjs";
import { startHub } from "./hub.mjs";

const record = { startedAt: new Date().toISOString(), checks: [], timings: {} };
const check = (name, ok, actual) => record.checks.push({ name, ok: Boolean(ok), actual });
const MODEL = "Xenova/all-MiniLM-L6-v2";
// Firefox's remote agent turns off trial ML and Remote Settings for automation
// (RecommendedPreferences.sys.mjs). A normal profile has both on; trial ML
// needs Remote Settings for its llama.cpp runtime.
const PREFS = {
  "extensions.background.idle.timeout": 600_000,
  "browser.ml.enable": true,
  "services.settings.server": "https://firefox.settings.services.mozilla.com/v1",
};
const cosine = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
const best = (scores) => Object.entries(scores).toSorted((a, b) => b[1] - a[1])[0][0];

const hub = await startHub();
// A fake llama-server on :8080 unless a real one runs there, so the demo panel's test prompt always has a server.
const fakeLlama = await startFakeLlama();
record.llamaServer = fakeLlama ? `fake (${fakeLlama.model})` : "already running on :8080";
let fox;
try {
  fox = await launch({
    extension: "dist-ext",
    headless: !process.argv.includes("--headed"),
    // Keep the event page alive through long downloads in the test.
    prefs: PREFS,
  });
  record.firefox = await fox.browser.version();
  const page = await fox.openExtensionPage("panel.html");
  /** Send one request to the background page, and time it. */
  const ask = async (message) => {
    const started = Date.now();
    const reply = await page.evaluate((m) => browser.runtime.sendMessage(m), message);
    return { ...reply, ms: Date.now() - started };
  };
  const embed = (id, extra = {}) => ask({ op: "embed", id, model: MODEL, remoteHost: hub.url, texts: ["a cat sleeps", "a kitten naps", "a truck drives"], ...extra });

  record.env = await ask({ op: "env" });
  check("no SharedArrayBuffer in the extension page (F47)", record.env.crossOriginIsolated === false, record.env);

  hub.state.cut = true;
  const cut = await embed("cut");
  check("download cut gives download_failed (F48)", cut.error?.code === "download_failed", cut.error);

  const cold = await embed("cut");
  record.timings.coldLoadAndEmbedMs = cold.ms;
  const [cat, kitten, truck] = cold.vectors ?? [];
  check("download again works after a cut (F48)", cold.vectors?.length === 3 && cat.length === 384, { dims: cat?.length, where: cold.status?.where });
  check("embedding: kitten is nearer to cat than truck", cat && cosine(cat, kitten) > cosine(cat, truck), cat && { kitten: cosine(cat, kitten), truck: cosine(cat, truck) });
  check("auto device runs and reports where (F46)", ["wasm", "webgpu"].includes(cold.status?.where), cold.status);

  const before = hub.state.requests.filter((path) => path.endsWith(".onnx")).length;
  const [one, two] = await Promise.all([embed("twice"), embed("twice")]);
  record.timings.warmLoadAndEmbedMs = Math.max(one.ms, two.ms);
  const onnxFetches = hub.state.requests.filter((path) => path.endsWith(".onnx")).length - before;
  check("one download for two calls at once, served from cache (F52)", one.vectors && two.vectors && onnxFetches === 0, { onnxFetches });

  const again = await embed("twice", { texts: ["hello"] });
  record.timings.loadedEmbedMs = again.ms;

  const corrupt = await ask({ op: "corrupt", model: MODEL });
  const repaired = await embed("repaired");
  check("cache corrupt: purge, download again, and say so (F49)", corrupt.changed > 0 && repaired.vectors?.length === 3 && /repaired/i.test(repaired.status?.reason ?? ""), { changed: corrupt.changed, reason: repaired.status?.reason, error: repaired.error });

  const missing = await embed("missing", { model: "Xenova/foxmind-no-such-model" });
  check("wrong model id gives model_not_found (F50)", missing.error?.code === "model_not_found", missing.error);

  const gpu = await ask({ op: "probe", id: "gpu", model: MODEL, device: "webgpu", remoteHost: hub.url });
  if (record.env.webgpuAdapter) {
    const run = await embed("gpu", { device: "webgpu" });
    record.timings.webgpuColdEmbedMs = run.ms;
    check("webgpu present: the model runs on webgpu (F46)", gpu.ok && run.status?.where === "webgpu", run.status ?? run.error);
  } else {
    check("webgpu missing: probe says webgpu_missing (F46)", gpu.ok === false && gpu.code === "webgpu_missing", gpu);
  }

  // The demo panel: tier rows, the test prompt and the embedding test.
  const [found] = await Promise.all([doctor({ timeoutMs: 2000 }), poll(page, () => document.body.dataset.ready === "1", undefined, 60_000)]);
  const rows = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll("[data-row]")].map((row) => [row.dataset.row, row.dataset.ok])));
  const expected = Object.fromEntries(found.checks.filter((c) => c.name === "ollama" || c.name === "llama-server").map((c) => [c.name, String(c.ok)]));
  check("demo panel rows match doctor (F69)", rows.ollama === expected.ollama && rows["llama-server"] === expected["llama-server"] && rows.webgpu === String(record.env.webgpuAdapter), { rows, expected });
  await page.evaluate(() => { document.getElementById("prompt").value = "Reply with the word ready. /no_think"; document.getElementById("run").click(); });
  const said = await poll(page, () => document.getElementById("chat-result").dataset.done && document.getElementById("chat-result").textContent, undefined, 180_000);
  const up = (name) => found.checks.some((c) => c.ok && c.name === name);
  // Ollama refuses extension origins unless OLLAMA_ORIGINS allows them, and must say so.
  const wanted = up("llama-server") ? /answered by llama-server \(local\)/ : up("ollama") ? /answered by ollama \(local\)|OLLAMA_ORIGINS/ : /no_provider/;
  check("demo panel test prompt (F70)", wanted.test(said), said);
  await page.evaluate(() => document.getElementById("embed").click());
  const similar = await poll(page, () => document.getElementById("embed-result").dataset.done && document.getElementById("embed-result").textContent, undefined, 120_000);
  check("demo panel embedding (F71)", /similarity 0\.\d+ on (webgpu|wasm) in \d+ ms/.test(similar), similar);
  record.panel = { rows, said, similar };
  if (process.env.FOXMIND_SCREENSHOT) {
    // BiDi cannot screenshot moz-extension: pages, so the test copies the
    // panel's live markup and styles into a normal page and captures that.
    const html = await page.evaluate(() => `<!doctype html><html><head><meta charset="utf-8"><style>${[...document.styleSheets].flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText)).join("\n")}</style></head>${document.body.outerHTML}</html>`);
    const shot = await fox.browser.newPage();
    await shot.setViewport({ width: 420, height: 720 });
    await shot.setContent(html);
    await shot.screenshot({ path: process.env.FOXMIND_SCREENSHOT, fullPage: true });
    await shot.close();
  }

  const ungranted = await ask({ op: "trial", step: "probe" });
  check("trial.ml before the grant: probe says permission (F57)", ungranted.ok === false && ungranted.code === "permission", ungranted);
  // permissions.request needs a real click, and WebDriver BiDi cannot click in
  // extension pages. So the test grants trialML the way the click would: through
  // Firefox's permission store, from the browser window (chrome scope).
  const tree = await fox.browser.connection.send("browsingContext.getTree", { "moz:scope": "chrome" });
  await fox.browser.connection.send("script.evaluate", {
    expression: `ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs").ExtensionPermissions.add("${fox.extensionId}", { permissions: ["trialML"], origins: [] }, WebExtensionPolicy.getByID("${fox.extensionId}").extension)`,
    target: { context: tree.result.contexts[0].context },
    awaitPromise: true,
  });
  const trial = await ask({ op: "trial", step: "embed", texts: ["a cat sleeps", "a kitten naps", "a truck drives"] });
  record.timings.trialMlColdEmbedMs = trial.ms;
  const [tcat, tkitten, ttruck] = trial.vectors ?? [];
  check("trial.ml embed: 384 numbers per text, kitten nearer cat (F59)", tcat?.length === 384 && cosine(tcat, tkitten) > cosine(tcat, ttruck), trial.error ?? { dims: tcat?.length, status: trial.status });
  const warm = await ask({ op: "trial", step: "embed", texts: ["hello"] });
  record.timings.trialMlWarmEmbedMs = warm.ms;
  const second = await ask({ op: "trial", step: "second" });
  check("one engine: a second trialML() is refused (F58)", second.error?.code === "unsupported" && /one trial\.ml engine/.test(second.error.message), second.error);

  if (process.env.FOXMIND_E2E_HEAVY === "1") {
    const tools = [{ type: "function", function: { name: "get_weather", description: "Get the weather for a city", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }];
    const hello = await ask({ op: "chat", id: "qwen", messages: [{ role: "user", content: "Say hello in three words." }] });
    record.timings.chatColdMs = hello.ms;
    check("in-browser chat: Qwen3-0.6B answers (F55)", typeof hello.reply?.message?.content === "string" && hello.reply.message.content.length > 0, hello.reply?.message ?? hello.error);
    const weather = await ask({ op: "chat", id: "qwen", tools, messages: [{ role: "user", content: "Use the get_weather tool to get the weather in Paris." }] });
    record.timings.chatToolCallMs = weather.ms;
    check("in-browser chat: Qwen3-0.6B calls a tool (F55)", weather.reply?.message?.tool_calls?.[0]?.function?.name === "get_weather", weather.reply?.message ?? weather.error);
    record.chatWhere = weather.status?.where;

    const reference = JSON.parse(readFileSync("e2e/gliner2-reference.json", "utf8")).cases;
    const started = Date.now();
    const load = ask({ op: "gliner2", step: "load" });
    let progress = 0;
    while (Date.now() - started < 600_000) {
      const status = await ask({ op: "gliner2", step: "status" });
      progress = Math.max(progress, status.progress ?? 0);
      if (status.state === "ready" || status.state === "error") break;
      await new Promise((done) => setTimeout(done, 1000));
    }
    const loaded = await load;
    record.timings.gliner2LoadMs = Date.now() - started;
    check("gliner2: loads, and progress moves during the download (F61)", !loaded.error && progress > 0, loaded.error ?? { progress });
    const mismatches = [];
    for (const c of reference) {
      const got = await ask({ op: "gliner2", step: c.kind, text: c.text, labels: c.labels });
      if (got.error) mismatches.push({ text: c.text, error: got.error });
      else if (c.kind === "extract") {
        for (const [label, want] of Object.entries(c.result.entities ?? {})) {
          const texts = (got.result[label] ?? []).map((e) => e.text);
          if (JSON.stringify(texts) !== JSON.stringify(want.map((e) => e.text))) mismatches.push({ text: c.text, label, got: texts, want: want.map((e) => e.text) });
        }
      } else {
        if (best(got.result) !== best(c.result)) mismatches.push({ text: c.text, got: best(got.result), want: best(c.result) });
      }
      record.timings[`gliner2_${c.kind}LastMs`] = got.ms;
    }
    check("gliner2 matches Python on every reference case (F62)", mismatches.length === 0, { cases: reference.length, mismatches, where: loaded.status?.where });
    const empty = await ask({ op: "gliner2", step: "extract", text: "", labels: { place: undefined } });
    const none = await ask({ op: "gliner2", step: "extract", text: "Paris", labels: {} });
    check("gliner2 edge cases: empty text, no labels (F63)", !empty.error && none.result && Object.keys(none.result).length === 0, { empty, none });
  } else {
    record.skipped = [...(record.skipped ?? []), "in-browser chat (Qwen3-0.6B, about 0.5 GB) and GLiNER2 (614 MB): set FOXMIND_E2E_HEAVY=1 to run them (F55, F61-F63)"];
  }

  // Firefox allows one trial ML engine per extension, so llama.cpp gets its own Firefox.
  await fox.close();
  fox = await launch({ extension: "dist-ext", headless: !process.argv.includes("--headed"), prefs: PREFS });
  const page2 = await fox.openExtensionPage("panel.html");
  const tree2 = await fox.browser.connection.send("browsingContext.getTree", { "moz:scope": "chrome" });
  await fox.browser.connection.send("script.evaluate", {
    expression: `ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs").ExtensionPermissions.add("${fox.extensionId}", { permissions: ["trialML"], origins: [] }, WebExtensionPolicy.getByID("${fox.extensionId}").extension)`,
    target: { context: tree2.result.contexts[0].context },
    awaitPromise: true,
  });
  const ask2 = async (message) => {
    const started = Date.now();
    const reply = await page2.evaluate((m) => browser.runtime.sendMessage(m), message);
    return { ...reply, ms: Date.now() - started };
  };
  const saluki = await ask2({ op: "wllama", step: "probe", model: "ConwayResearch/Underdog-Saluki-27B-1.0", modelFile: "Underdog-Saluki-27B-1.0-IQ2-mix.gguf" });
  check("saluki in the browser: refused before download (F65)", saluki.ok === false && saluki.code === "out_of_memory", saluki);
  const outside = await ask2({ op: "wllama", step: "probe", model: "ggml-org/models", modelFile: "tinyllamas/stories260K.gguf" });
  check("hub rule: a model outside Mozilla and Xenova is refused (F66)", outside.ok === false && outside.code === "unsupported", outside);
  const tiny = await ask2({ op: "wllama", step: "chat", model: "Mozilla/llama-test-model", modelFile: "tiny-llama.gguf", timeoutMs: 30_000, messages: [{ role: "user", content: "Once upon a time" }] });
  record.timings.wllamaTinyChatMs = tiny.ms;
  record.wllama = tiny.reply ? "answered" : tiny.error?.code;
  check("tiny GGUF: text, or code timeout when the engine never answers (F67, F68)", typeof tiny.reply?.message?.content === "string" || tiny.error?.code === "timeout", tiny.reply?.message ?? tiny.error);
} catch (error) {
  record.error = error instanceof Error ? error.stack ?? error.message : String(error);
} finally {
  await fox?.close();
  await hub.close();
  await fakeLlama?.close();
}
record.passed = !record.error && record.checks.length > 0 && record.checks.every((c) => c.ok);
const path = writeArtifact("artifacts", process.argv.includes("--headed") ? "e2e-headed" : "e2e", record);
for (const c of record.checks) console.log(`${c.ok ? "ok " : "BAD"} ${c.name}`);
console.log(JSON.stringify(record.timings));
console.log(`${record.passed ? "PASS" : "FAIL"}${record.error ? `: ${record.error}` : ""} | ${path}`);
process.exitCode = record.passed ? 0 : 1;
