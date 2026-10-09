// The demo panel, used as the popup and as the sidebar. It asks the
// background page (which hosts the models) for each result.
import { requestTrialML } from "../src/browser/index.js";

const $ = (id) => document.getElementById(id);
const ask = (message) => browser.runtime.sendMessage(message);

function row(name, ok, text) {
  const tr = document.querySelector(`[data-row="${name}"]`);
  tr.dataset.ok = String(ok);
  tr.querySelector(".state").textContent = text;
}

async function showTiers() {
  const tiers = await ask({ op: "tiers" });
  row("webgpu", tiers.webgpu, tiers.webgpu ? "yes: models run on the GPU" : "no: models run on WASM (CPU)");
  const trial = tiers.trialml;
  row("trialml", trial.ok, trial.ok ? "yes" : `no: ${trial.reason}`);
  $("allow-trialml").hidden = trial.code !== "permission";
  for (const name of ["llama-server", "saluki", "ollama"]) {
    const check = tiers.servers[name];
    row(name, check.ok, check.ok ? `yes: ${check.models.join(", ") || "no models"}` : `no: ${check.reason}`);
  }
  document.body.dataset.ready = "1";
}

$("allow-trialml").addEventListener("click", async () => {
  if (await requestTrialML()) await showTiers();
});

$("run").addEventListener("click", async () => {
  const out = $("chat-result");
  out.dataset.done = "";
  out.textContent = "Running…";
  const reply = await ask({ op: "local-chat", prompt: $("prompt").value });
  out.textContent = reply.error
    ? `${reply.error.code}: ${reply.error.message}`
    : `${reply.content}\n\nanswered by ${reply.provider} (${reply.tier}) in ${reply.ms} ms${reply.skipped.length ? `; skipped ${reply.skipped.map((s) => `${s.provider} (${s.code})`).join(", ")}` : ""}`;
  out.dataset.done = "1";
});

$("embed").addEventListener("click", async () => {
  const out = $("embed-result");
  out.dataset.done = "";
  out.textContent = "Loading the model (about 23 MB, once)…";
  const result = await ask({ op: "pair", texts: [$("text-a").value, $("text-b").value] });
  out.textContent = result.error ? `${result.error.code}: ${result.error.message}` : `similarity ${result.similarity.toFixed(3)} on ${result.where} in ${result.ms} ms`;
  out.dataset.done = "1";
});

showTiers();
