// The shapes foxmind speaks. Messages, tools and tool calls follow the OpenAI
// chat completions API, so code written for it works here unchanged.

/** Where a provider runs: in the browser, on a server on this machine, or in a cloud you pay with your key. */
export type Tier = "browser" | "local" | "cloud";

export interface CallOptions {
  signal?: AbortSignal;
  /** Stop the call after this many milliseconds. */
  timeoutMs?: number;
}
