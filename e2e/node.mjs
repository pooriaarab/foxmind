// The Node half of the E2E test: real local servers through the built
// library (dist/). Each call leaves room (maxTokens 1024) in case a model
// thinks before it answers. It runs each server that answers on this machine, and
// records the ones that do not, so the artifact says what ran.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createMind, doctor, llamaServer, ollama } from "../dist/index.js";

const weather = [{ type: "function", function: { name: "get_weather", description: "Get the weather for a city", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }];

/** Run one step; a thrown error fails that check with the error, not the whole run. */
async function step(name, check, run) {
  try {
    await run();
  } catch (error) {
    check(name, false, { code: error.code, message: error.message, raw: error.raw });
  }
}

async function exercise(provider, check, timings) {
  const mind = createMind({ providers: [provider] });
  const label = provider.name;
  await step(`${label}: chat, tools, stream and json`, check, async () => {
  const hello = await mind.chat([{ role: "user", content: "Say hello in three words. /no_think" }], { maxTokens: 1024 });
  timings[`${label}ChatMs`] = hello.ms;
  check(`${label}: chat answers and names its tier`, hello.message.content?.trim().length > 0 && hello.tier === "local", { content: hello.message.content, provider: hello.provider });
  const tool = await mind.chat([{ role: "user", content: "Use the get_weather tool for Paris." }], { tools: weather, maxTokens: 1024, temperature: 0 });
  timings[`${label}ToolCallMs`] = tool.ms;
  check(`${label}: tool call has valid JSON arguments`, tool.message.tool_calls?.[0]?.function.name === "get_weather" && JSON.parse(tool.message.tool_calls[0].function.arguments).city !== undefined, tool.message.tool_calls ?? tool.message.content);
  const pieces = [];
  const streamed = await mind.chat([{ role: "user", content: "Count from one to five in words. /no_think" }], { maxTokens: 1024, onDelta: (piece) => pieces.push(piece) });
  timings[`${label}StreamMs`] = streamed.ms;
  check(`${label}: stream pieces join to the reply`, pieces.length > 1 && pieces.join("") === streamed.message.content, { pieces: pieces.length });
  const json = await mind.chat([{ role: "user", content: 'Return the JSON object {"ok": true} and nothing else. /no_think' }], { json: true, maxTokens: 1024 });
  check(`${label}: json mode returns JSON`, JSON.parse(json.message.content) !== undefined, json.message.content);
  });
}

export async function runNode(record, check) {
  const timings = {};
  const found = await doctor({ timeoutMs: 2000 });
  record.localServers = found.checks.map(({ name, ok, models }) => ({ name, ok, models }));
  const cli = await promisify(execFile)("node", ["dist/bin.js", "doctor", "--json"]).catch((error) => error);
  const report = JSON.parse(cli.stdout);
  check("foxmind doctor --json sees the same servers", JSON.stringify(report.checks.map((c) => c.ok)) === JSON.stringify(found.checks.map((c) => c.ok)), report.checks.map((c) => `${c.name}:${c.ok}`));
  const ran = [];
  const olla = found.checks.find((c) => c.name === "ollama");
  // FOXMIND_E2E_OLLAMA_MODEL picks the model; the default is the first one Ollama lists.
  const pick = process.env.FOXMIND_E2E_OLLAMA_MODEL ?? olla.models?.[0];
  if (olla.ok && pick) {
    ran.push(`ollama (${pick})`);
    // reasoning_effort "none" turns off Qwen3's thinking on Ollama, which can use the whole token budget.
    await exercise(ollama({ model: pick, body: { reasoning_effort: "none" } }), check, timings);
  }
  if (found.checks.find((c) => c.name === "llama-server").ok) {
    ran.push("llama-server");
    await exercise(llamaServer(), check, timings);
  }
  record.node = { ran, skipped: found.checks.filter((c) => !c.ok).map((c) => c.name), timings };
}
