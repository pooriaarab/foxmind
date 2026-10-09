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
