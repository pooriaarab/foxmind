// The E2E test: install the built demo extension (dist-ext/) in a real
// Firefox, run in-browser models in its background page, and write
// artifacts/e2e-<date>.json with every check and timing.
// Usage: pnpm e2e [--headed]. Env: FIREFOX (the Firefox binary).
import { launch, writeArtifact } from "create-foxkit/e2e";
import { startHub } from "./hub.mjs";

const record = { startedAt: new Date().toISOString(), checks: [], timings: {} };
const check = (name, ok, actual) => record.checks.push({ name, ok: Boolean(ok), actual });
const MODEL = "Xenova/all-MiniLM-L6-v2";
const cosine = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);

const hub = await startHub();
let fox;
try {
  fox = await launch({
    extension: "dist-ext",
    headless: !process.argv.includes("--headed"),
    // Keep the event page alive through long downloads in the test.
    // Firefox's remote agent turns browser.ml.enable off for automation
    // (RecommendedPreferences.sys.mjs). A normal profile has it on.
    prefs: { "extensions.background.idle.timeout": 600_000, "browser.ml.enable": true },
  });
  record.firefox = await fox.browser.version();
  const page = await fox.openExtensionPage("popup.html");
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
  } else {
    record.skipped = [...(record.skipped ?? []), "in-browser chat (Qwen3-0.6B, about 0.5 GB): set FOXMIND_E2E_HEAVY=1 to run it (F55)"];
  }
} catch (error) {
  record.error = error instanceof Error ? error.stack ?? error.message : String(error);
} finally {
  await fox?.close();
  await hub.close();
}
record.passed = !record.error && record.checks.length > 0 && record.checks.every((c) => c.ok);
const path = writeArtifact("artifacts", process.argv.includes("--headed") ? "e2e-headed" : "e2e", record);
for (const c of record.checks) console.log(`${c.ok ? "ok " : "BAD"} ${c.name}`);
console.log(JSON.stringify(record.timings));
console.log(`${record.passed ? "PASS" : "FAIL"}${record.error ? `: ${record.error}` : ""} | ${path}`);
process.exitCode = record.passed ? 0 : 1;
