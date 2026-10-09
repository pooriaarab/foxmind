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
| F33 | System messages are in the wrong place. | Leading system messages become the top-level `system`. Later ones stay in place. | "request shape" |
| F34 | Tool results go out as separate user turns. | Consecutive `tool` messages become one user message with one `tool_result` block each. | "request shape" |
| F35 | A past tool call in the history has arguments that are not JSON. | Throw code `bad_tool_call` before any request goes out. | "bad tool call in history" |
| F36 | The reply shape does not match. | `tool_use` blocks become `tool_calls` with JSON string arguments. Stop reasons map: `tool_use` to `tool_calls`, `max_tokens` to `length`, `refusal` to `content_filter`. Thinking blocks go back unchanged on the next turn through `provider_data`. | "reply shape", "thinking blocks go back" |
| F37 | `json: true`, but there is no JSON mode. | Ask for JSON in the system prompt. Accept a fenced block. Throw `bad_json` when there is no JSON. | "json" |
| F38 | A stream breaks, or ends with no `message_stop`. | Join `text_delta` and `input_json_delta` pieces. Throw `stream_interrupted` with `partial` when the stream ends early. An `error` event throws its mapped code. | "stream", "stream ends early", "error event" |
| F39 | The API is busy (429 or 529). | 429 throws `rate_limited` with `retryAfterMs`. 529 throws `http` with status 529. | "busy" |
| F40 | The key or the model is wrong. | `probe()` asks `GET /v1/models/{model}`: 404 gives `model_not_found`, 401 gives `auth`. The key is never in an error or the status. | "probe", "key leak" |
