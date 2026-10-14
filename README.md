# foxmind

[![npm version](https://img.shields.io/npm/v/foxmind)](https://www.npmjs.com/package/foxmind)
[![Downloads/month](https://img.shields.io/npm/dm/foxmind)](https://www.npmjs.com/package/foxmind)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Quickstart](#send-your-first-chat) · [API reference](#runtime-surfaces) · [Provider coverage](#coverage) · [FAQ](#faq)

foxmind is an open-source JavaScript model router for developers who use browser inference, local model servers, and caller-supplied cloud keys.
It exposes chat, embeddings, entity extraction, and classification.
Results name the provider and execution tier; supported capabilities depend on the provider.

## Install

```bash
npm install foxmind
```

The Node.js library and CLI require Node.js 24 or later.
TypeScript declarations are included; there are no required runtime dependencies.
For Transformers.js browser providers, install the optional peer dependency:

```bash
npm install @huggingface/transformers
```

## Send your first chat

Install Ollama and start its local server in one terminal:

```bash
ollama serve
```

In another terminal, download the model:

```bash
ollama pull qwen3:0.6b
```

Save this as `example.mjs`, then run `node example.mjs`.
No API key, environment variable, or `.env` file is needed for this local example.

```js
import { createMind, ollama } from "foxmind";

const mind = createMind({
  providers: [ollama({ model: "qwen3:0.6b" })],
  only: ["local"],
});
const result = await mind.chat(
  [{ role: "user", content: "Say hello." }],
  { maxTokens: 1024 },
);
console.log(result.message.content);
console.log(`answered by ${result.provider} (${result.tier})`);
```

Success prints model text followed by `answered by ollama (local)`.
If the server or model is missing, the error lists the failed provider probe.
For Firefox extensions, start Ollama with `OLLAMA_ORIGINS="moz-extension://*"`.

## How it works

```text
Call -> allowed tiers -> capability filter -> ordered providers -> cached probe
                                                            -> result + provider + tier + skipped
```

`only` excludes tiers before any probe or call.
`prefer` changes provider order without restricting tiers.
Unavailable providers enter `skipped`; call failures throw unless fallback is enabled.
Named chat roles have their own explicit fallback lists.

## Why it exists

An application can use browser models, Ollama, and a cloud key through different protocols.
AI SDK offers a provider abstraction; LiteLLM offers a Python SDK and a gateway.
foxmind combines tier restrictions, model probes, and explicit routing inside a JavaScript library.
It provides no managed inference endpoint.

## Compare

Checked on 2026-10-14 against [AI SDK provider documentation](https://ai-sdk.dev/docs/foundations/providers-and-models)
and [LiteLLM documentation](https://docs.litellm.ai/docs/).

| Property | foxmind | AI SDK | LiteLLM |
|---|---|---|---|
| Scope | Browser/local/cloud model router | Standard model-provider abstraction | Model SDK and AI gateway |
| Deployment | JavaScript library | Application SDK | Python library or self-hosted gateway |
| Configuration | Provider objects, tiers, named roles | Provider packages and registry | SDK options or gateway configuration |
| Coverage model | Ten exported provider factories | First-party and community providers | SDK and gateway model integrations |

## Coverage

The source exports six server/cloud factories and four browser factories: ten total.
Presets and wrappers are included in that count; it is not a count of independent inference engines.
`—` means the factory does not expose that capability.

| Factory / integration | Chat | Embed | Extract / classify | Verification status |
|---|---|---|---|---|
| `openaiCompatible`: OpenAI-compatible HTTP | ✓ | ✓ | — | HTTP fixtures; live cloud keys pending |
| `anthropic`: Anthropic Messages API | ✓ | — | — | HTTP fixtures; live key pending |
| `ollama`: Ollama | ✓ | ✓ | — | Implemented preset and remote-model probe |
| `llamaServer`: llama.cpp llama-server | ✓ | ✓ | — | Implemented OpenAI-compatible preset |
| `lmStudio`: LM Studio | ✓ | ✓ | — | Implemented OpenAI-compatible preset |
| `saluki`: Underdog Saluki on llama-server | ✓ | ✓ | — | Preset tested with fixtures; live model pending |
| `transformers`: Hugging Face Transformers.js | ✓ | ✓ | — | Select one task per provider; WASM path implemented |
| `gliner2`: GLiNER2 | — | — | ✓ | Browser implementation; WebGPU verification pending |
| `trialML`: Mozilla Firefox inference | ✓ | ✓ | — | Select one task; optional permission required |
| `wllama`: Firefox llama.cpp backend | Experimental | — | — | Recorded Firefox runs timed out; no success claim |

Checkmarks describe implemented methods, not model-level guarantees or credential checks.
This rewrite runs local fixture tests and does not re-run model downloads, Firefox inference, or cloud credentials.
OpenAI and OpenRouter use `openaiCompatible`; they have no separate factory.
Servers must support the requested model and endpoint.

## Common use cases

1. Firefox extension developers use Transformers.js embeddings for local bookmark search.
2. Ollama agent builders restrict routing with `only: ["browser", "local"]`.
3. GLiNER2 application developers extract names and classify text inside a browser page.
4. Node.js developers route planning and checking to separate llama-server instances with named roles.
5. Anthropic application developers map Messages API replies into the common chat shape with their own key.

## Features

- **Tier policy:** exclude browser, local, or cloud execution; see [routing](#how-it-works).
- **Provider diagnostics:** probes, status, download progress, and skipped reasons; see [doctor](#cli-foxmind-doctor).
- **Chat roles:** ordered providers, input limits, deadlines, escalation, and shadow evaluation; see [roles](#roles-a-mixture-of-local-models).
- **Streaming and tool calls:** provider-specific support with checked JSON arguments; see [limits](#delivery-and-behavior-limits).
- **Browser inference:** optional Transformers.js and Firefox trial ML providers; see the [browser API](#foxmindbrowser-extension-pages-and-web-pages).

## Runtime surfaces

### `foxmind` (Node and the browser)

| Export | What it does |
|---|---|
| `createMind({ providers, only?, prefer?, fallbackOnError?, probeTtlMs?, roles?, onShadow? })` | Makes the router. `only` is the list of tiers it may use (private mode: `["browser", "local"]`); it never probes or calls the others. `prefer` takes provider names or tiers and only changes the order. |
| `mind.chat(messages, { role?, tools?, json?, onDelta?, temperature?, maxTokens?, timeoutMs?, signal? })` | Chat in the OpenAI shape. `onDelta` streams text. `json: true` fails with `bad_json` when the reply is not JSON. Tool call arguments are checked: they must be a JSON object. `timeoutMs` is the longest wait for the headers and then for each next piece of the body, so a slow stream that keeps sending is not cut. |
| `mind.embed(texts)` | One vector per text: `{ vectors, provider, tier, model, ms, skipped }`. |
| `mind.extract(text, labels, { threshold? })` | GLiNER2 entities per label: `{ entities: { label: [{ text, confidence, start, end }] } }`. |
| `mind.classify(texts, prompt, labels)` | GLiNER2 label scores per text: `{ scores: [{ label: probability }] }`. |
| `mind.status()` | Each provider's state (`idle`, `loading`, `ready`, `unavailable`, `error`), where it runs, download progress, and the last provider that answered. |
| `mind.probe()` / `mind.load(name)` | Probe every provider now. Download and start one model now. |
| `openaiCompatible({ baseURL, model, apiKey?, embedModel?, body?, checkModel?, timeoutMs? })` | Any OpenAI-compatible server: llama-server, Ollama, LM Studio, OpenAI, OpenRouter. The tier is `local` for localhost, else `cloud`. |
| `ollama({ model })`, `llamaServer()`, `lmStudio({ model })` | Presets with the usual local address and the start command in each failed probe. |
| `saluki({ thinking? })`, `SALUKI` | Underdog Saluki 27B on llama-server, the default planner for private mode. Thinking is off and temperature is 0 by default, the model card's settings for tool calls. |
| `anthropic({ apiKey, model?, maxTokens? })` | The Anthropic Messages API, mapped to the OpenAI shape. The default model is `claude-opus-5-5`. |
| `doctor(options)`, `formatDoctor(report)` | The `foxmind doctor` check as a function. |
| `FoxmindError` | Every failure. `code` is one of `no_provider`, `unreachable`, `timeout`, `aborted`, `rate_limited` (with `retryAfterMs`), `auth`, `model_not_found`, `http`, `stream_interrupted` (with `partial`), `bad_tool_call` (with `raw`), `bad_json`, `bad_response`, `unsupported`, `download_failed`, `cache_corrupt`, `out_of_memory`, `webgpu_missing`, `permission`. |

To run Saluki, follow its [model card](https://huggingface.co/ConwayResearch/Underdog-Saluki-27B-1.0):

```bash
huggingface-cli download ConwayResearch/Underdog-Saluki-27B-1.0 Underdog-Saluki-27B-1.0-IQ2-mix.gguf --local-dir .
llama-server -m Underdog-Saluki-27B-1.0-IQ2-mix.gguf --jinja -ngl 99 -fa on -c 32768
```

### Roles: a mixture of local models

A role sends one kind of sub-task to its own ordered list of providers. Use it
to give short, simple jobs to a small fast model (the "scout") and keep
planning on the big one.

```js
const mind = createMind({
  providers: [saluki(), llamaServer({ name: "scout", baseURL: "http://127.0.0.1:8082/v1", model: "qwen3.5-4b", body: { temperature: 0, chat_template_kwargs: { enable_thinking: false } } })],
  only: ["browser", "local"],
  roles: {
    plan: { use: ["saluki"] },
    read: { use: ["scout", "saluki"], maxInput: 6000, timeoutMs: 20000 },
    check: { use: ["scout", "saluki"], escalate: "unsure" },
    fields: { use: ["scout", "saluki"], json: true },
  },
  onShadow: ({ role, scout, planner }) => record(role, scout, planner),
});
const result = await mind.chat(messages, { role: "read", json: true }); // result.role, result.skipped
```

| Option | What it does |
|---|---|
| `use` | Provider names, tried in order. A down or failed provider moves the call on, and `skipped` says why. Each provider runs at most once. A role that names a provider `only` excludes makes `createMind` throw. |
| `maxInput` | Skip a provider before the last one when the messages are longer than this many characters (code `too_long`). |
| `timeoutMs` | A hard deadline for each provider before the last one (code `timeout`). The request is stopped. |
| `json` | Ask for JSON by default. A provider that answers prose fails with `bad_json`, and the role moves on. |
| `escalate: "unsure"` | Move on when the reply is not JSON or says `"sure": false` (code `unsure`). The last provider's answer is returned as it is. It cannot stream. |
| `shadow: true` | Run the first provider and the planner side by side. The result is always the planner's, made with the planner's own options; `onShadow` gets both when both settle, so you can measure how often they agree. A shadow role needs `timeoutMs`, and its first provider must differ from the planner's. |

The planner is the `plan` role, or the router without roles when there is no
`plan` role. A call without `role` goes to the planner. An unknown role throws.

### `foxmind/browser` (extension pages and web pages)

| Export | What it does |
|---|---|
| `transformers({ task: "embed" \| "chat", model?, device?, dtype? })` | transformers.js. Defaults: `Xenova/all-MiniLM-L6-v2` for embed, `onnx-community/Qwen3-0.6B-ONNX` for chat. `device: "auto"` uses WebGPU when the browser has an adapter, else WASM, and `status().where` says which. |
| `gliner2({ model?, device?, dtype? })` | GLiNER2 extract and classify. Default model: `pooria/gliner2-multi-v1-agent-batch-ONNX` (614 MB at fp16). |
| `trialML({ task, model?, device? })`, `requestTrialML()` | Firefox's own engine, `browser.trial.ml`. Call `requestTrialML()` from a click to get the optional `trialML` permission. |
| `wllama({ model, modelFile, maxBytes? })` | Experimental. A GGUF model on Firefox's llama.cpp backend through trial ML. It refuses files over `maxBytes` (default 4 GB) before the download. |
| `configureRuntime({ wasmPaths?, remoteHost? })` | Where ONNX Runtime's WASM files are (default: `ort/` in the extension) and which model hub to use. |
| `hasWebGPU()`, `purgeModel(model)` | Detect a WebGPU adapter. Delete one model's files from Cache Storage. |

Each cached model file that does not load is deleted and downloaded once more,
and `status().reason` says so. A download that stops is not kept, so the next
call downloads again.

### CLI: `foxmind doctor`

```bash
npx foxmind doctor
```

```text
foxmind doctor · Node v25.9.0 · darwin arm64

local    ollama        yes  http://127.0.0.1:11434/v1    models: qwen3:0.6b
local    llama-server  yes  http://127.0.0.1:8080/v1     models: qwen3-0.6b.gguf
local    saluki        no   http://127.0.0.1:8080/v1     llama-server serves qwen3-0.6b.gguf, not Saluki. Download it with "huggingface-cli download ConwayResearch/Underdog-Saluki-27B-1.0 Underdog-Saluki-27B-1.0-IQ2-mix.gguf --local-dir .", then start it with "llama-server -m Underdog-Saluki-27B-1.0-IQ2-mix.gguf --jinja -ngl 99 -fa on -c 32768".
local    lm-studio     no   http://127.0.0.1:1234/v1     Cannot reach http://127.0.0.1:1234/v1/models: connect ECONNREFUSED 127.0.0.1:1234. Start it with "lms server start".
browser  WebGPU, trial.ml and in-browser models: doctor runs in Node and cannot check them. Load the demo extension in Firefox.
cloud    anthropic and cloud openaiCompatible: these need your own key. doctor does not read keys.
```

Flags: `--json`, `--ollama URL`, `--llama-server URL`, `--lm-studio URL`,
`--timeout MS`. The exit code is 0 when at least one server works, 1 when none
does, and 2 for bad input. There is no MCP server.

### Extension

`extension/` is a small Firefox extension. Its panel opens from the toolbar and
in the sidebar. It shows which tiers work, sends a prompt to a local
server, and compares two sentences with an in-browser embedding model. Build it
with `pnpm build:ext` and load `dist-ext/manifest.json` from `about:debugging`.
`pnpm build:ext` makes the build AMO signs. `node scripts/build-ext.mjs --e2e`
makes the test build that `pnpm e2e` loads; only it has the test-only ops and
the content script. To let it reach Ollama, start Ollama with
`OLLAMA_ORIGINS="moz-extension://*"`.
Ollama refuses extension origins without it.

## Delivery and behavior limits

- We did not run Saluki 27B. We tested the `saluki()` preset against a fake
  server and checked that it refuses to run in the browser. The Saluki
  benchmark numbers are from its vendor (Underdog Bench, 120 tasks), not from
  us.
- A 27B model in the browser is not proven. `wllama()` refuses GGUF files over
  4 GB, and trial ML takes models only from the Mozilla and Xenova orgs.
- `wllama()` is experimental. In our Firefox 157 runs, the llama.cpp engine
  started but never answered, so the call ends with code `timeout`.
- We tested `anthropic()` and cloud `openaiCompatible()` against fake servers
  only. No real API key was used.
- Small in-browser chat models are slow on WASM (about 28 s per answer for
  Qwen3-0.6B), and they call a tool only when the prompt asks for it.
- We ran GLiNER2 on WASM only. Its WebGPU read-back code comes from foxpilot
  and has no foxmind test yet.
- For a model as small as MiniLM, WebGPU was not faster than WASM in our
  headed run.
- `json: true` on Anthropic is a system-prompt rule plus a JSON check, not
  constrained decoding.
- foxmind retries only one thing: a call to a local server that got no response headers (2 more tries, inside one timeout). The server may have got it. A cloud call never retries. On `rate_limited`, use `retryAfterMs` to decide.
- Firefox unloads an idle background page, and the loaded model goes with it.
  An open popup or sidebar keeps the page loaded.
- Firefox allows one trial ML engine per extension.
- The in-browser providers do not run in Node. The server and cloud tiers do.
- Ollama can run a model on ollama.com. foxmind treats a model named
  `*-cloud` or `*:cloud` as tier `cloud` (for `ollama()` and for
  `openaiCompatible()` on localhost), so `only: ["browser", "local"]` drops it.
  For other names, `ollama().probe()` reads `/api/tags` and refuses a model
  with a `remote_host` unless you pass `tier: "cloud"`. Other local servers
  that forward to a remote model are not detected.
- ONNX Runtime adds about 27 MB of WASM to an extension.
- foxmind does not check model files against a hash after the download, and
  transformers.js does not either. Hugging Face lists a SHA-256 for each LFS
  file in its API, so a check is possible later.

## Integration guides

- [Ollama local chat](#send-your-first-chat): start the server and select an allowed tier.
- [llama-server and Saluki setup](#foxmind-node-and-the-browser): configure a local model and tool-call template.
- [Firefox browser inference](#foxmindbrowser-extension-pages-and-web-pages): configure providers, model files, and optional permissions.
- [Model diagnostics CLI](#cli-foxmind-doctor): check local endpoints and print startup hints.

## Status

foxmind is a 0.x library; provider defaults and API shapes can change before 1.0.
Report problems through [GitHub issues](https://github.com/pooriaarab/foxmind/issues).
Public case studies are not yet published.
The Firefox demo is a development surface; an approved add-on listing is not claimed here.

## FAQ

### What is foxmind?

foxmind is a JavaScript router for browser, local-server, and cloud model providers.
Its four inference operations are chat, embed, extract, and classify.

### Which integrations are verified?

foxmind has local fixture tests for routing and HTTP providers.
Cloud keys, the Saluki model, and browser inference are not reverified by this README change.

### Does foxmind provide a managed inference service?

foxmind runs inside your application.
You run local servers or supply your own provider keys.

### How is foxmind different from AI SDK?

foxmind exposes execution tiers, local probes, and named chat roles.
[AI SDK](https://ai-sdk.dev/docs/foundations/providers-and-models) standardizes model access through its provider architecture.

### How is foxmind different from LiteLLM?

foxmind is a JavaScript library with browser inference providers.
[LiteLLM](https://docs.litellm.ai/docs/) offers a Python SDK and an AI gateway deployment.

### How do I keep foxmind calls local?

foxmind excludes cloud providers when `only` allows browser and local tiers.
Other local servers can forward remotely; inspect your server configuration.

### Does foxmind fall back after an error?

foxmind normally throws call failures; `fallbackOnError: true` enables general fallback.
Named roles use their explicit provider lists, and streamed text or an abort blocks fallback.

### Does every foxmind provider support tool calls?

foxmind exposes tools on supported chat providers.
Firefox trial ML rejects tools; tool quality still depends on the model.

## Development

```bash
pnpm install
pnpm ci:local
pnpm e2e
```

The local gate checks lint, types, tests, builds, and the extension listing.
End-to-end tests separately call available model servers and start Firefox.
Set `FOXMIND_E2E_HEAVY=1` to include larger browser model downloads.

## License

[MIT](https://opensource.org/license/mit)
