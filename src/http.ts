// fetch with a timeout, a caller abort, and HTTP failures mapped to FoxmindError
// codes. Every message goes through redact() before it leaves this file.
import { clip, FoxmindError, redact, type ErrorDetails } from "./errors.js";
import type { CallOptions, Tier } from "./types.js";

export interface Origin {
  provider: string;
  tier: Tier;
  /** Secrets to hide from every error message. */
  secrets: (string | undefined)[];
}

export interface Request extends CallOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
}

/** One signal for the caller's abort and the timeout, and a way to tell which fired. */
export function deadline(options: CallOptions, fallbackMs: number) {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? fallbackMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  return { signal, timedOut: () => timeout.aborted && !options.signal?.aborted };
}

export function failure(origin: Origin, code: ConstructorParameters<typeof FoxmindError>[0], message: string, details: ErrorDetails = {}) {
  return new FoxmindError(code, redact(message, origin.secrets), {
    ...details,
    provider: origin.provider,
    tier: origin.tier,
    raw: details.raw === undefined ? undefined : clip(redact(details.raw, origin.secrets)),
    partial: details.partial === undefined ? undefined : redact(details.partial, origin.secrets),
  });
}

/**
 * Map an exception from fetch or a body read to a FoxmindError. When a stream
 * was running, a dropped connection is `stream_interrupted` and the error
 * keeps the text streamed so far.
 */
export function fetchFailure(origin: Origin, error: unknown, timedOut: boolean, url: string, timeoutMs: number, partial?: string): FoxmindError {
  if (error instanceof FoxmindError) return error;
  const details = partial === undefined ? {} : { partial };
  if (timedOut) return failure(origin, "timeout", `No answer from ${url} within ${timeoutMs} ms.`, details);
  if (error instanceof Error && error.name === "AbortError") return failure(origin, "aborted", "The caller stopped the call.", details);
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : String(error);
  if (partial !== undefined) return failure(origin, "stream_interrupted", `The stream from ${url} stopped after ${partial.length} characters: ${cause}`, details);
  return failure(origin, "unreachable", `Cannot reach ${url}: ${cause}`);
}

/** "Retry-After" in seconds or as a date, or "retry-after-ms". */
export function retryAfter(headers: Headers): number | undefined {
  const ms = Number(headers.get("retry-after-ms"));
  if (ms > 0) return ms;
  const value = headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** The server's own words from an error body, in the OpenAI or Anthropic shape. */
function serverMessage(text: string): string {
  try {
    const body = JSON.parse(text) as { error?: string | { message?: string }; message?: string };
    if (typeof body.error === "string") return body.error;
    return body.error?.message ?? body.message ?? text;
  } catch {
    return text;
  }
}

/** Throw the FoxmindError for a non-2xx response. */
export async function httpFailure(origin: Origin, response: Response): Promise<FoxmindError> {
  const said = clip(serverMessage(await response.text().catch(() => "")).trim(), 300);
  const status = response.status;
  const text = `HTTP ${status}${said ? `: ${said}` : ""}`;
  if (status === 429) return failure(origin, "rate_limited", text, { status, retryAfterMs: retryAfter(response.headers) });
  if (status === 401 || status === 403) return failure(origin, "auth", text, { status });
  if ((status === 404 || status === 400) && /model/i.test(said) && /not.?found|does not exist|unknown/i.test(said)) {
    return failure(origin, "model_not_found", text, { status });
  }
  return failure(origin, "http", text, { status });
}

export interface Fetched {
  response: Response;
  /** Map an error from reading the body (a timeout, a dropped connection) to a FoxmindError. */
  fail(error: unknown, partial?: string): FoxmindError;
  json<T>(): Promise<T>;
}

/** fetch() that returns an ok response or throws a FoxmindError. */
export async function call(origin: Origin, url: string, request: Request, fallbackMs: number): Promise<Fetched> {
  const { signal, timedOut } = deadline(request, fallbackMs);
  const fail = (error: unknown, partial?: string) => fetchFailure(origin, error, timedOut(), url, request.timeoutMs ?? fallbackMs, partial);
  let response: Response;
  try {
    response = await fetch(url, {
      method: request.method ?? (request.body === undefined ? "GET" : "POST"),
      headers: { ...(request.body === undefined ? {} : { "content-type": "application/json" }), ...request.headers },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal,
    });
  } catch (error) {
    throw fail(error);
  }
  if (!response.ok) throw await httpFailure(origin, response);
  const json = async <T>() => {
    const text = await response.text().catch((error: unknown) => { throw fail(error); });
    try {
      return JSON.parse(text) as T;
    } catch {
      throw failure(origin, "bad_response", `${url} sent a body that is not JSON: ${clip(text, 120)}`);
    }
  };
  return { response, fail, json };
}
