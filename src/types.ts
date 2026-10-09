// The shapes foxmind speaks. Messages, tools and tool calls follow the OpenAI
// chat completions API, so code written for it works here unchanged.

/** Where a provider runs: in the browser, on a server on this machine, or in a cloud you pay with your key. */
export type Tier = "browser" | "local" | "cloud";
export type Capability = "chat" | "embed" | "extract" | "classify";
export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  /** `arguments` is a JSON string. foxmind checks that it parses before it returns it. */
  function: { name: string; arguments: string };
}

export interface Message {
  role: Role;
  content: string | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** The model's thinking, when the server sends it apart from the answer. */
  reasoning?: string;
  /** Provider-specific data to send back unchanged on the next turn (for example Anthropic thinking blocks). */
  provider_data?: Record<string, unknown>;
}

export interface Tool {
  type: "function";
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

export interface CallOptions {
  signal?: AbortSignal;
  /** Stop the call after this many milliseconds. */
  timeoutMs?: number;
}

export interface ChatOptions extends CallOptions {
  tools?: Tool[];
  /** Ask for one JSON object, and fail with `bad_json` when the reply is not JSON. */
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
  /** Stream the reply. Called with each new piece of text. */
  onDelta?: (text: string) => void;
}

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter";

export interface ChatReply {
  message: Message & { role: "assistant" };
  finishReason: FinishReason;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface Probe {
  ok: boolean;
  /** Why the provider cannot run, as an error code. */
  code?: string;
  reason?: string;
  /** Where it runs, for example "webgpu", "wasm" or a server URL. */
  where?: string;
}

export interface ProviderStatus {
  name: string;
  tier: Tier;
  model: string;
  capabilities: readonly Capability[];
  state: "idle" | "loading" | "ready" | "unavailable" | "error";
  where?: string;
  /** Download progress from 0 to 1 while a model loads. */
  progress?: number;
  reason?: string;
}

export interface Provider {
  readonly name: string;
  readonly tier: Tier;
  readonly model: string;
  readonly capabilities: readonly Capability[];
  /** Check, without a model call, that the provider can run now. */
  probe(options?: CallOptions): Promise<Probe>;
  status(): ProviderStatus;
  /** Download and start the model now, not at the first call. */
  load?(options?: CallOptions): Promise<void>;
  chat?(messages: Message[], options: ChatOptions): Promise<ChatReply>;
  embed?(texts: string[], options: CallOptions): Promise<number[][]>;
}
