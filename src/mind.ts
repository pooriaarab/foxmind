// The router. It picks a provider in `prefer` order, skips the ones that
// cannot run now, and says in every result and error which provider and tier
// answered and which ones it skipped and why.
import { FoxmindError, type Skip } from "./errors.js";
import type { CallOptions, Capability, ChatOptions, ChatReply, Entity, ExtractOptions, Labels, Message, Probe, Provider, ProviderStatus, Tier } from "./types.js";

export interface MindOptions {
  providers: Provider[];
  /** Provider names or tiers ("browser", "local", "cloud"), best first. Providers not named come after, in `providers` order. */
  prefer?: string[];
  /** When a call fails, try the next provider and list the failure in `skipped`. Default false. */
  fallbackOnError?: boolean;
  /** How long a probe result stays good. Default 30000. */
  probeTtlMs?: number;
}

export interface Answered {
  provider: string;
  tier: Tier;
  model: string;
  ms: number;
  /** Providers tried before this one, and why each did not answer. */
  skipped: Skip[];
}

export type ChatResult = ChatReply & Answered;
export interface EmbedResult extends Answered { vectors: number[][] }
export interface ExtractResult extends Answered { entities: Record<string, Entity[]> }
export interface ClassifyResult extends Answered { scores: Record<string, number>[] }

export interface MindStatus {
  providers: ProviderStatus[];
  last?: { capability: Capability; provider: string; tier: Tier; model: string; at: string };
}

export interface Mind {
  readonly providers: readonly Provider[];
  chat(messages: Message[], options?: ChatOptions): Promise<ChatResult>;
  embed(texts: string[], options?: CallOptions): Promise<EmbedResult>;
  extract(text: string, labels: Labels, options?: ExtractOptions): Promise<ExtractResult>;
  classify(texts: string[], prompt: string, labels: Labels, options?: CallOptions): Promise<ClassifyResult>;
  /** Probe every provider now, past the cache. */
  probe(options?: CallOptions): Promise<(Probe & { provider: string; tier: Tier })[]>;
  /** Download and start one provider's model now. */
  load(name: string, options?: CallOptions): Promise<void>;
  status(): MindStatus;
}

const TIERS = new Set(["browser", "local", "cloud"]);

function order(providers: Provider[], prefer: string[] = []): Provider[] {
  const names = new Set<string>();
  for (const provider of providers) {
    if (names.has(provider.name)) throw new TypeError(`createMind got two providers named "${provider.name}". Give each one its own name.`);
    names.add(provider.name);
  }
  for (const entry of prefer) {
    if (!names.has(entry) && !TIERS.has(entry)) throw new TypeError(`prefer names "${entry}", which is not a provider name or a tier. Providers: ${[...names].join(", ")}.`);
  }
  const ranked = prefer.flatMap((entry) => providers.filter((provider) => provider.name === entry || provider.tier === entry));
  return [...new Set([...ranked, ...providers])];
}

export function createMind(options: MindOptions): Mind {
  const providers = order(options.providers, options.prefer);
  const ttl = options.probeTtlMs ?? 30_000;
  const probes = new Map<string, { at: number; result: Probe }>();
  let last: MindStatus["last"];

  async function probe(provider: Provider, callOptions: CallOptions): Promise<Probe> {
    const cached = probes.get(provider.name);
    if (cached && Date.now() - cached.at < ttl) return cached.result;
    const result = await provider.probe({ signal: callOptions.signal }).catch((error: unknown) => ({ ok: false, code: "unreachable", reason: String(error) }));
    probes.set(provider.name, { at: Date.now(), result });
    return result;
  }

  async function call<T>(capability: Capability, callOptions: ChatOptions, run: (provider: Provider, options: ChatOptions) => Promise<T>): Promise<{ value: T } & Answered> {
    const able = providers.filter((provider) => provider.capabilities.includes(capability));
    if (!able.length) {
      throw new FoxmindError("no_provider", `No provider can ${capability}. Providers: ${providers.map((p) => `${p.name} (${p.capabilities.join(", ")})`).join("; ") || "none"}.`, { skipped: [] });
    }
    const skipped: Skip[] = [];
    for (const provider of able) {
      const probed = await probe(provider, callOptions);
      if (!probed.ok) {
        skipped.push({ provider: provider.name, tier: provider.tier, code: probed.code ?? "unavailable", reason: probed.reason ?? "The probe failed." });
        continue;
      }
      // Once text reached the caller, a second provider would repeat it, so a stream never falls back.
      let streamed = false;
      const onDelta = callOptions.onDelta;
      const attempt = onDelta ? { ...callOptions, onDelta: (text: string) => { streamed = true; onDelta(text); } } : callOptions;
      const started = Date.now();
      try {
        const value = await run(provider, attempt);
        last = { capability, provider: provider.name, tier: provider.tier, model: provider.model, at: new Date().toISOString() };
        return { value, provider: provider.name, tier: provider.tier, model: provider.model, ms: Date.now() - started, skipped };
      } catch (error) {
        const failed = error instanceof FoxmindError ? error : new FoxmindError("http", String(error), { provider: provider.name, tier: provider.tier, cause: error });
        if (failed.code === "unreachable" || failed.code === "stream_interrupted") probes.delete(provider.name);
        if (options.fallbackOnError && !streamed && failed.code !== "aborted") {
          skipped.push({ provider: provider.name, tier: provider.tier, code: failed.code, reason: failed.message });
          continue;
        }
        failed.skipped = skipped;
        throw failed;
      }
    }
    const list = skipped.map((skip) => `${skip.provider} (${skip.tier}): ${skip.reason}`).join("; ");
    throw new FoxmindError("no_provider", `No provider could ${capability}. ${list}`, { skipped });
  }

  return {
    providers,
    async chat(messages, chatOptions = {}) {
      const { value, ...answered } = await call("chat", chatOptions, (provider, o) => provider.chat!(messages, o));
      return { ...value, ...answered };
    },
    async embed(texts, embedOptions = {}) {
      const { value, ...answered } = await call("embed", embedOptions, (provider, o) => provider.embed!(texts, o));
      return { vectors: value, ...answered };
    },
    async extract(text, labels, extractOptions = {}) {
      const { value, ...answered } = await call("extract", extractOptions, (provider, o) => provider.extract!(text, labels, o));
      return { entities: value, ...answered };
    },
    async classify(texts, prompt, labels, classifyOptions = {}) {
      const { value, ...answered } = await call("classify", classifyOptions, (provider, o) => provider.classify!(texts, prompt, labels, o));
      return { scores: value, ...answered };
    },
    async probe(probeOptions = {}) {
      probes.clear();
      return Promise.all(providers.map(async (provider) => ({ ...(await probe(provider, probeOptions)), provider: provider.name, tier: provider.tier })));
    },
    async load(name, loadOptions = {}) {
      const provider = providers.find((candidate) => candidate.name === name);
      if (!provider) throw new TypeError(`No provider named "${name}".`);
      await provider.load?.(loadOptions);
    },
    status: () => ({ providers: providers.map((provider) => provider.status()), ...(last ? { last } : {}) }),
  };
}
