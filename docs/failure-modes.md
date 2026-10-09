# Failure modes

This file lists every way foxmind can fail that we know of. Each row says what
the code does then, and which test proves it. We write a row and its test
before the code. The git history shows that order.

foxmind must never hide a failure. When a provider fails, the error names the
provider, its tier, and a code. When the router skips a provider, the result
or the error lists the skip and the reason.

## HTTP layer (`src/http.ts`)

Every server and cloud provider sends its requests through this layer.
Tests: `tests/http.test.ts`. The tests start a fake server in the test and
call it over real HTTP.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| F1 | The server is not running (connection refused). | Throw code `unreachable` with the URL. | "server down" |
| F2 | The server answers 429 (rate limit). | Throw code `rate_limited` with `retryAfterMs` from `Retry-After` (seconds or a date). Do not retry in secret. | "429" |
| F3 | The server is too slow. | Throw code `timeout` after `timeoutMs`, also when the body stops halfway. A caller abort throws code `aborted`, not `timeout`. | "timeout", "slow body", "abort" |
| F4 | The API key is wrong (401 or 403). | Throw code `auth`. | "401" |
| F5 | The API key leaks into logs. | The key is not in the error message, the stack or `JSON.stringify(error)`. A server error body that echoes the key, or any `sk-…` key, shows `[redacted]`. | "key leak" |
| F6 | The server answers 500. | Throw code `http` with the status and the server's own message. A 501 (for example "this server does not support embeddings") throws code `unsupported`. | "500", "501" |
| F7 | The model name is wrong, and the server says so with 404 or 400. | Throw code `model_not_found`. | "model 404" |
| F8 | The server answers 200 with a body that is not JSON. | Throw code `bad_response`. | "not json" |

## OpenAI-compatible provider (`openaiCompatible`)

Tests: `tests/openai.test.ts`, against a fake OpenAI-compatible server.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| F9 | The server is down when the router asks. | `probe()` returns `ok: false` with code `unreachable`, and does not throw. | "server down" |
| F10 | The server does not have the model. | `probe()` returns code `model_not_found` and lists the models the server has. | "wrong model" |
| F11 | A tool call has arguments that are not valid JSON, or not a JSON object. | Throw code `bad_tool_call` with the tool name and the raw text (redacted, cut to 200 characters). | "malformed tool call" |
| F12 | `json: true`, but the reply is not JSON. | Throw code `bad_json`. | "bad json" |
| F13 | The server answers 200 with a body that has no `choices`. | Throw code `bad_response`. | "bad response" |
| F14 | `embed()` gets a different number of vectors than texts. | Throw code `bad_response`. | "embed count" |
| F15 | The provider object or its status is logged. | The API key is not in `JSON.stringify(provider)`, `util.inspect(provider)` or `status()`. | "key leak" |

## Streaming (`onDelta`)

Tests: `tests/stream.test.ts`, against a fake server that sends server-sent events.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| F16 | The server goes down in the middle of a stream. | Throw code `stream_interrupted` with the text streamed so far in `partial`. | "server down mid-stream" |
| F17 | The stream ends with no `[DONE]` and no `finish_reason`. | Throw code `stream_interrupted`. A clean end with a `finish_reason` but no `[DONE]` is a success. | "stream ends early" |
| F18 | The server sends an error event inside a 200 stream. | Throw code `http` with the server's message. | "error event" |
| F19 | Tool call pieces arrive across many events, and the result is not valid JSON. | Join the pieces by index. Throw code `bad_tool_call` when the joined arguments do not parse. | "streamed tool call", "streamed bad tool call" |
| F20 | The stream stops sending, but the connection stays open. | Throw code `timeout` after `timeoutMs`, with `partial`. | "stalled stream" |

## Router (`createMind`)

Tests: `tests/mind.test.ts`. Most tests use small in-memory providers, so each
case is exact. One test streams from a fake server over real HTTP.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| F21 | No provider has the capability, or every one that has it is down. | Throw code `no_provider`. The message and `skipped` list each provider and why. | "no provider" |
| F22 | The preferred provider is down. | Skip it, use the next one, and list the skip in `result.skipped`. The result names the provider and tier that answered. | "skips a provider that is down" |
| F23 | A provider fails during the call. | By default, throw that error with `skipped`. Do not try another provider in secret. With `fallbackOnError: true`, try the next one and list the failure in `result.skipped`. | "no silent fallback", "fallbackOnError" |
| F24 | A provider fails after some text has streamed. | Never fall back, also with `fallbackOnError`, because the caller already showed that text. | "no fallback after streamed text" |
| F25 | The caller aborts. | Throw `aborted`. Never fall back. | "abort" |
| F26 | A server goes down after a good probe. | The call error clears the cached probe, so the next call probes again. | "probe cache" |
| F27 | `prefer` names a provider or tier that does not exist, or two providers share a name. | `createMind` throws a `TypeError` at once. | "bad config" |

## Local server presets (`ollama`, `llamaServer`, `lmStudio`, `saluki`)

Tests: `tests/presets.test.ts`, against a fake server on a free port.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| F28 | llama-server runs, but it serves a model that is not Saluki. | `saluki().probe()` returns code `model_not_found`, names the model it found, and gives the command that starts Saluki. | "saluki wrong model" |
| F29 | Ollama runs, but the model is not pulled. | `probe()` returns code `model_not_found` with the `ollama pull` command. A model named without a tag matches `<name>:latest`. | "ollama not pulled" |
| F30 | llama-server serves one model under any name. | `llamaServer().probe()` does not check the model name. | "llama-server any name" |
| F31 | Saluki thinks for a long time before a tool call. | `saluki()` turns thinking off and sets temperature 0 by default, as the model card says for tool calls. `thinking: true` uses the card's thinking settings. | "saluki settings" |
| F32 | No local server is running. | Each preset's probe returns `unreachable` with the start command in the reason. | "preset down" |

## Anthropic provider (`anthropic`)

The Anthropic Messages API has a different shape from the OpenAI API. The
provider maps both ways, so a caller sees only the OpenAI shape.
Tests: `tests/anthropic.test.ts`, against a fake Messages API server.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| F33 | System messages are in the wrong place. | Leading system messages become the top-level `system`. Later ones join it too (see F81). | "request shape" |
| F34 | Tool results go out as separate user turns. | Consecutive `tool` messages become one user message with one `tool_result` block each. | "request shape" |
| F35 | A past tool call in the history has arguments that are not JSON. | Throw code `bad_tool_call` before any request goes out. | "bad tool call in history" |
| F36 | The reply shape does not match. | `tool_use` blocks become `tool_calls` with JSON string arguments. Stop reasons map: `tool_use` to `tool_calls`, `max_tokens` to `length`, `refusal` to `content_filter`. Thinking blocks go back unchanged on the next turn through `provider_data`. | "reply shape", "thinking blocks go back" |
| F37 | `json: true`, but there is no JSON mode. | Ask for JSON in the system prompt. Accept a fenced block. Throw `bad_json` when there is no JSON. | "json" |
| F38 | A stream breaks, or ends with no `message_stop`. | Join `text_delta` and `input_json_delta` pieces. Throw `stream_interrupted` with `partial` when the stream ends early. An `error` event throws its mapped code. | "stream", "stream ends early", "error event" |
| F39 | The API is busy (429 or 529). | 429 throws `rate_limited` with `retryAfterMs`. 529 throws `http` with status 529. | "busy" |
| F40 | The key or the model is wrong. | `probe()` asks `GET /v1/models/{model}`: 404 gives `model_not_found`, 401 gives `auth`. The key is never in an error or the status. | "probe", "key leak" |

## `foxmind doctor`

Tests: `tests/doctor.test.ts`. The tests call the CLI's `main()` with fake servers and closed ports.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| F41 | No local server is running. | Each server line says `no`, with the reason and the start command. Exit code 1. | "nothing running" |
| F42 | A server runs. | Its line says `yes` and lists its models. The Saluki line says `yes` only when llama-server serves Saluki. Exit code 0. | "ollama running", "saluki running" |
| F43 | An unknown command or flag. | Print the usage to stderr and exit 2. Probe nothing. | "bad flag" |
| F44 | An API key is in the environment. | doctor does not read keys, so no key can reach its output. | "no keys" |
| F45 | A server accepts the connection but never answers. | Each probe stops after `--timeout` (default 2000 ms), so doctor always finishes. | "hung server" |

## In-browser models (`foxmind/browser`: `transformers`)

These run in a real Firefox. Tests: `e2e/run.mjs` (`pnpm e2e`). The test loads
the demo extension, runs a small embedding model (`Xenova/all-MiniLM-L6-v2`,
about 23 MB) in the background page, and gets the model files through a local
proxy to Hugging Face that can cut a download in half.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| F46 | WebGPU is missing (Linux, Intel Mac, headless). | `device: "auto"` runs on WASM, and `status().where` says `wasm`. `device: "webgpu"` makes `probe()` fail with code `webgpu_missing`, so the router skips it and says why. | "webgpu" |
| F47 | Extension pages have no `SharedArrayBuffer`, so WASM threads cannot start. | The runtime sets one WASM thread, and the model runs. | "no SharedArrayBuffer" |
| F48 | The model download stops halfway. | Throw code `download_failed`. Do not keep the failed load: the next call downloads again and works. | "download cut", "download again" |
| F49 | The cached model files are corrupt. | Delete this model's files from Cache Storage, download once more, and say so in `status().reason`. When the second try fails too, throw code `cache_corrupt`. | "cache corrupt" |
| F50 | The model id does not exist on the hub. | Throw code `model_not_found`. | "wrong model id" |
| F51 | The model needs more memory than the device has. | Throw code `out_of_memory` with a hint to use a smaller model or dtype. No automatic test: no test machine runs out of memory on demand. The mapping is in `src/browser/runtime.ts`. | none (see text) |
| F52 | A second load starts while the first one runs. | Both calls wait for the same load. The model downloads once. | "one download" |

## In-browser chat (`transformers({ task: "chat" })`)

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| F53 | A small model writes a tool call (`<tool_call>…</tool_call>`) whose JSON is broken or cut off. | Throw code `bad_tool_call` with the tool name when the text has one. | `tests/toolcalls.test.ts` |
| F54 | A Qwen3 model thinks out loud before it answers. | Thinking is off by default. A `<think>` block that still comes moves to `message.reasoning`. | `tests/toolcalls.test.ts` |
| F55 | The chat model is about 0.5 GB, too big to download in every CI run. | `e2e/run.mjs` runs it only when `FOXMIND_E2E_HEAVY=1`, and the artifact says which checks ran and which it skipped. | `e2e/run.mjs` "in-browser chat" |

## Firefox trial ML (`trialML`)

`browser.trial.ml` runs Firefox's own inference engine. Tests: `e2e/run.mjs`.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| F56 | `browser.trial.ml` is missing (not Firefox, or the API is off). | `probe()` returns code `unsupported` with the reason. | "trial.ml probe" (checked through the code path in the demo, which runs where it exists) |
| F57 | The user has not granted the optional `trialML` permission. | `probe()` returns code `permission` and says to call `requestTrialML()` from a click. A call throws code `permission`. | "trial.ml before the grant" |
| F58 | Firefox allows one engine per extension, and a second `trialML()` asks for another task or model. | Throw code `unsupported` that names the provider that holds the engine. | "one engine" |
| F59 | The engine returns a shape foxmind does not expect. | Turn nested arrays and tensor-like objects into one vector per text. Throw `bad_response` for anything else. | "trial.ml embed" |
| F60 | Firefox drops the engine when memory is low. | Throw code `out_of_memory`. Firefox makes a new engine on the next call. | none: no test machine runs out of memory on demand |

## GLiNER2 (`gliner2`)

GLiNER2 extracts entities and scores labels on one ONNX graph. The code comes
from foxpilot (MIT, same author). Tests: `e2e/run.mjs`.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| F61 | The model is 614 MB, too big to download in every CI run. | `e2e/run.mjs` runs it only when `FOXMIND_E2E_HEAVY=1`. The artifact says which checks ran. `status().progress` moves during the download. | "gliner2" (heavy) |
| F62 | The JavaScript port drifts from the Python gliner2 library. | Extraction finds the same spans as the Python reference (`e2e/gliner2-reference.json`, from foxpilot), and the top label of each classification is the same. | "gliner2 matches Python" (heavy) |
| F63 | The text is empty, or there are no labels. | Empty text works (the encoder uses "."). No labels returns `{}` and does not run the model. | "gliner2 edge cases" (heavy) |
| F64 | ONNX Runtime has no WebGPU device when outputs sit on the GPU. | Throw a clear error. On WASM, outputs are on the CPU and need no read back. | covered by the WASM run in "gliner2" |

## llama.cpp in Firefox (`wllama`, experimental)

`wllama()` asks `browser.trial.ml` for its llama.cpp backend (GGUF models).
The npm package @wllama/wllama does not run in an extension page: it starts its
worker from a `blob:` URL, which the extension CSP blocks. Tests: `e2e/run.mjs`,
in a second Firefox, because Firefox allows one trial ML engine per extension.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| F65 | The GGUF file is larger than in-browser memory allows (for example Saluki 27B, 7.89 GB). | `probe()` reads the file size with a HEAD request and refuses with code `out_of_memory` before any download. The limit is `maxBytes`, default 4 GB. | "saluki in the browser" |
| F66 | The model is not in an org trial ML allows (Mozilla, Xenova on Hugging Face). | `probe()` returns code `unsupported` and names the rule. | "hub rule" |
| F67 | The llama.cpp backend returns text in a shape we do not expect. | Accept a string, `{ finalOutput }`, `{ output }` or `[{ generated_text }]`. Throw `bad_response` for anything else. | none yet: in our test runs the engine never answered (F68) |
| F68 | The engine never answers. In the Firefox 157 test profile, llama.cpp `runEngine` hangs after `createEngine` works. | Stop the call after `timeoutMs` (default 120 s) and throw code `timeout`. | "tiny GGUF" |

## Demo panel (`extension/panel.html`)

The demo runs as the toolbar popup and in the sidebar. The models live in the
background page, so every view shares them. Tests: `e2e/run.mjs` "demo panel".

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| F69 | The panel shows a tier as working when it is not, or the reverse. | The panel's rows for Ollama (11434) and llama-server (8080) match what `foxmind doctor` finds on the same machine at the same time. | "demo panel rows match doctor" |
| F70 | No local server runs, and the user clicks Run. | The panel shows code `no_provider` and why each provider was skipped. When a server runs, it shows the answer and which provider and tier answered. | "demo panel test prompt" |
| F72 | Ollama refuses the extension's origin with 403 (it allows `moz-extension://` only when `OLLAMA_ORIGINS` says so). | Throw code `auth` with the fix: start Ollama with `OLLAMA_ORIGINS=moz-extension://*`. | "demo panel test prompt" |
| F70a | Ollama is not running (as on a CI runner). The panel still listed "ollama" in `prefer`, so `createMind` threw a `TypeError` and the test prompt showed an error. | `prefer` names only the servers the panel found. A failed E2E check prints what it saw, and CI uploads `artifacts/` when the E2E job fails. | "demo panel test prompt", with Ollama unreachable from Firefox |
| F71 | The embedding test runs on a device the panel does not name. | The panel shows the similarity, the device (`webgpu` or `wasm`) and the time. | "demo panel embedding" |

## Redirects (review fix)

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| F73 | A server answers 301, 302, 307 or 308 and points to another host. fetch would follow it and send `Authorization`, `x-api-key` or a custom key header there. | Never follow a redirect. Throw code `http` with the status and the target, and send nothing to the target. | `tests/http.test.ts` "redirect", `tests/anthropic.test.ts` "redirect" |

## Router probes and aborts (review fix)

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| F74 | The caller aborts while the router probes a local provider. The failed probe got cached, and the router went on to the next provider, so the next call sent the text to the cloud. | Throw code `aborted` at once and try no other provider. Never cache a probe that the abort stopped. A probe runs on its own timeout, not on the caller's signal. | `tests/mind.test.ts` "abort during a probe" |
| F75 | A call fails with `timeout`, `http`, `auth` or another code, and the cached probe still says the provider is fine. | Any failed call clears that provider's cached probe. | `tests/mind.test.ts` "probe cache after any failure" |

## Private mode: `only` (review fix)

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| F76 | `prefer: ["local"]` only reorders, so when every local provider is down the router sends page text to a cloud provider. | `only: ["browser", "local"]` drops every other tier. The router never probes or calls them, and `no_provider` says that `only` excluded them. | `tests/mind.test.ts` "only keeps text local" |
| F77 | `only` names a tier that does not exist, or leaves no provider. | `createMind` throws a `TypeError` at once. | `tests/mind.test.ts` "only config" |

## Model loading: WebGPU failure on a cached model (review fix)

Tests: `tests/loader.test.ts`. They run `loadOnce` in Node with a fake Cache
Storage and a fake WebGPU adapter, and a fake `open()` that fails on purpose.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| F78 | A cached model fails on WebGPU for a GPU reason. The loader called that cache corruption, deleted the files (614 MB for GLiNER2), downloaded them again, failed again on WebGPU, and never tried WASM. | With `device: "auto"`, try WASM first. Keep the cache. Say in `status().reason` that WebGPU failed. | "webgpu fails, wasm works, cache kept" |
| F79 | The cached files really are broken (a parse error on both devices). | Delete the files only after both devices fail, download once more, and say so. | "both fail, then repair" |
| F80 | `device: "webgpu"` (no second device) fails for a reason that does not point at the files. | Throw `bad_response`. Do not delete the cache. Delete it only for an error that points at the files (a parse error). | "explicit webgpu keeps the cache" |

## Anthropic: system messages later in the chat (review fix)

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| F81 | A system message after the first turn went into `messages` with role `system`. Many Anthropic models answer that with 400. | Join every system message, in order, into the top-level `system`. This replaces the "later ones stay in place" part of F33. | `tests/anthropic.test.ts` "request shape" |

## Timeouts on long streams (review fix)

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| F82 | `timeoutMs` counted the whole request, so a healthy stream (Saluki at 10 to 20 tokens a second) was cut after 120 s. | `timeoutMs` is the time to the response headers and the longest gap between two body chunks. A stream that keeps sending may run as long as it needs. A stream that stops for longer than `timeoutMs` still throws `timeout` with `partial`. | `tests/stream.test.ts` "long healthy stream", `tests/http.test.ts` "slow body that keeps sending" |

## Streamed tool call pieces (review fix)

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| F83 | A server sends tool call pieces with no `index`, so every call merged into the first one. A server that repeats the name in each piece got the name twice ("clickclick"). | A piece with no `index` and a new `id` starts a new call. The name is set once, from the first piece that has it. | `tests/stream.test.ts` "tool calls with no index", "name sent twice" |

## Aborts and checks for in-browser calls (review fix)

Tests: `tests/trialml.test.ts` (a fake `browser.trial.ml` in Node) and
`tests/browser-chat.test.ts` (a fake transformers.js pipeline in Node).

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| F84 | The caller aborts, or `timeoutMs` passes, during a trial ML call. foxmind waited for the engine anyway. | Throw `aborted` or `timeout` at once. (Firefox gives no way to stop the engine itself.) | "trial.ml abort", "trial.ml timeout" |
| F85 | `trialML` chat with `json: true` returned text that is not JSON. | Run the same reply checks as every provider: throw `bad_json`. | "trial.ml json" |
| F86 | Each new engine added one more `onProgress` listener. | Add the listener once per page. | "one progress listener" |
| F87 | In-browser chat (`transformers`) ignored `signal` and `timeoutMs`. | Stop the generation with transformers.js' stopping criteria and throw `aborted` or `timeout`. | "chat abort", "chat timeout" |

## The released demo extension (review fix)

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| F88 | The AMO build shipped test-only code: background ops that overwrite or delete cached models, a `remoteHost` that any extension page could set through a message, and a content script on `http://127.0.0.1/*`. | `pnpm build:ext` (the build AMO signs) has none of them. `node scripts/build-ext.mjs --e2e` makes the test build, which `pnpm e2e` uses. | `tests/release-build.test.ts` |
| F89 | A model file changes on the hub or on the way, and nothing checks it. | Not handled yet. transformers.js has no hash check, and foxmind does not hash files after download. Hugging Face lists a SHA-256 for each LFS file in its API, so a check is possible. The README says so under Limits. | none (known gap) |
