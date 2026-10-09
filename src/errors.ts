// One error type for every failure, with a code a caller can branch on.
import type { Tier } from "./types.js";

export type ErrorCode =
  | "no_provider"
  | "unreachable"
  | "timeout"
  | "aborted"
  | "rate_limited"
  | "auth"
  | "model_not_found"
  | "http"
  | "stream_interrupted"
  | "bad_tool_call"
  | "bad_json"
  | "bad_response"
  | "unsupported"
  | "download_failed"
  | "cache_corrupt"
  | "out_of_memory"
  | "webgpu_missing"
  | "permission";

/** A provider the router did not use, and why. */
export interface Skip {
  provider: string;
  tier: Tier;
  code: string;
  reason: string;
}

export interface ErrorDetails {
  provider?: string;
  tier?: Tier;
  status?: number;
  retryAfterMs?: number;
  /** The text that failed to parse (tool arguments or JSON), cut to 200 characters. */
  raw?: string;
  /** Text streamed before the failure. */
  partial?: string;
  skipped?: Skip[];
  cause?: unknown;
}

export class FoxmindError extends Error {
  readonly code: ErrorCode;
  provider?: string;
  tier?: Tier;
  status?: number;
  retryAfterMs?: number;
  raw?: string;
  partial?: string;
  skipped?: Skip[];

  constructor(code: ErrorCode, message: string, details: ErrorDetails = {}) {
    const where = details.provider ? `${details.provider}${details.tier ? ` (${details.tier})` : ""}: ` : "";
    super(`${where}${message}`, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "FoxmindError";
    this.code = code;
    const { cause: _cause, ...rest } = details;
    Object.assign(this, rest);
  }

  toJSON() {
    const { code, provider, tier, status, retryAfterMs, raw, partial, skipped } = this;
    return { name: this.name, message: this.message, code, provider, tier, status, retryAfterMs, raw, partial, skipped };
  }
}

/** Matches common API key shapes, so a key the caller did not give us is still hidden. */
const KEY_SHAPES = /\b(sk-[A-Za-z0-9_-]{8,}|sk-ant-[A-Za-z0-9_-]{8,}|hf_[A-Za-z0-9]{8,}|AIza[A-Za-z0-9_-]{20,})/g;

/** Replace every secret and every key-shaped string in text with "[redacted]". */
export function redact(text: string, secrets: (string | undefined)[] = []): string {
  let out = text;
  for (const secret of secrets) if (secret && secret.length >= 4) out = out.split(secret).join("[redacted]");
  return out.replace(KEY_SHAPES, "[redacted]");
}

/** Cut text for an error message. */
export function clip(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
