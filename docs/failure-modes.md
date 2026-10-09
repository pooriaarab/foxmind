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
| F6 | The server answers 500. | Throw code `http` with the status and the server's own message. | "500" |
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
