// What works on this machine: probes each local server and lists its models.
// It never reads API keys, so it cannot print one.
import { call, type Origin } from "./http.js";
import { SALUKI } from "./providers/presets.js";

export interface DoctorOptions {
  ollama?: string;
  llamaServer?: string;
  lmStudio?: string;
  timeoutMs?: number;
}

export interface Check {
  tier: "local";
  name: string;
  ok: boolean;
  where: string;
  models?: string[];
  reason?: string;
}

export interface Report {
  node: string;
  platform: string;
  checks: Check[];
  browser: string;
  cloud: string;
}

const START: Record<string, string> = {
  ollama: 'Start it with "ollama serve".',
  "llama-server": 'Start it with "llama-server -m <model.gguf> --jinja".',
  "lm-studio": 'Start it with "lms server start".',
};

function api(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

async function models(name: string, where: string, timeoutMs: number): Promise<Check> {
  const origin: Origin = { provider: name, tier: "local", secrets: [] };
  try {
    const fetched = await call(origin, `${where}/models`, { timeoutMs }, timeoutMs);
    const ids = ((await fetched.json<{ data?: { id: string }[] }>()).data ?? []).map((model) => model.id);
    return { tier: "local", name, ok: true, where, models: ids };
  } catch (error) {
    const message = error instanceof Error ? error.message.replace(/^[^:]+\(local\): /, "") : String(error);
    return { tier: "local", name, ok: false, where, reason: `${message.replace(/\.?$/, ".")} ${START[name]}` };
  }
}

export async function doctor(options: DoctorOptions = {}): Promise<Report> {
  const timeoutMs = options.timeoutMs ?? 2000;
  const llama = api(options.llamaServer ?? "http://127.0.0.1:8080");
  const [ollama, llamaServer, lmStudio] = await Promise.all([
    models("ollama", api(options.ollama ?? "http://127.0.0.1:11434"), timeoutMs),
    models("llama-server", llama, timeoutMs),
    models("lm-studio", api(options.lmStudio ?? "http://127.0.0.1:1234"), timeoutMs),
  ]);
  const serving = llamaServer.models?.find((id) => /saluki/i.test(id));
  const saluki: Check = serving
    ? { tier: "local", name: "saluki", ok: true, where: llama, models: [serving] }
    : {
        tier: "local",
        name: "saluki",
        ok: false,
        where: llama,
        reason: `${llamaServer.ok ? `llama-server serves ${llamaServer.models?.join(", ") || "no model"}, not Saluki.` : "llama-server is not running."} Download it with "${SALUKI.download}", then start it with "${SALUKI.serve}".`,
      };
  return {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    checks: [ollama, llamaServer, saluki, lmStudio],
    browser: "WebGPU, trial.ml and in-browser models: doctor runs in Node and cannot check them. Load the demo extension in Firefox.",
    cloud: "anthropic and cloud openaiCompatible: these need your own key. doctor does not read keys.",
  };
}

export function format(report: Report): string {
  const rows = report.checks.map((check) => {
    const detail = check.ok ? `models: ${check.models?.join(", ") || "none"}` : check.reason;
    return `${check.tier.padEnd(8)} ${check.name.padEnd(13)} ${(check.ok ? "yes" : "no").padEnd(4)} ${check.where.padEnd(28)} ${detail}`;
  });
  return [`foxmind doctor · Node ${report.node} · ${report.platform}`, "", ...rows, `browser  ${report.browser}`, `cloud    ${report.cloud}`, ""].join("\n");
}
