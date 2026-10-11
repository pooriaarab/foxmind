// The router. It picks a provider in `prefer` order, skips the ones that
// cannot run now, and says in every result and error which provider and tier
// answered and which ones it skipped and why.
import { FoxmindError, type Skip } from "./errors.js";
import type { CallOptions, Capability, ChatOptions, ChatReply, Entity, ExtractOptions, Labels, Message, Probe, Provider, ProviderStatus, Tier } from "./types.js";

export interface MindOptions {
  providers: Provider[];
  /** Provider names or tiers ("browser", "local", "cloud"), best first. Providers not named come after, in `providers` order. */
  prefer?: string[];
  /**
   * The only tiers the router may use. Providers of other tiers are dropped:
   * never probed, never called. Private mode is `only: ["browser", "local"]`.
   */
  only?: Tier[];
  /** When a call fails, try the next provider and list the failure in `skipped`. Default false. */
  fallbackOnError?: boolean;
  /** How long a probe result stays good. Default 30000. */
  probeTtlMs?: number;
  /**
   * Named sub-tasks, each with its own ordered list of providers, for example
   * a small fast "scout" model before the planner. A call picks one with
   * `chat(messages, { role })`. A call without a role uses `plan` when it exists.
   */
  roles?: Record<string, RoleOptions>;
  /** Called after a `shadow` call, once the scout and the planner have both settled. */
  onShadow?: (event: ShadowEvent) => void;
}

export interface RoleOptions {
  /** Provider names, tried in this order. Each runs at most once. A role cannot name a provider that `only` excludes. */
  use: string[];
  /** Skip a provider before the last one when the messages have more characters than this. */
  maxInput?: number;
  /** The longest wait, in milliseconds, for a provider before the last one. Then the role moves on. */
  timeoutMs?: number;
  /** Ask for one JSON object by default. */
  json?: boolean;
  /** "unsure": move on when the reply is not JSON or says `"sure": false`. Implies `json`. */
  escalate?: "unsure";
  /** Run the first provider and the planner side by side, return the planner's answer, and report both to `onShadow`. */
  shadow?: boolean;
}

export interface ShadowEvent {
  role: string;
  scout: ChatResult | { error: Error };
  planner: ChatResult | { error: Error };
}

export interface Answered {
  provider: string;
  tier: Tier;
  model: string;
  ms: number;
  /** Providers tried before this one, and why each did not answer. */
  skipped: Skip[];
  /** The role the call used, if any. */
  role?: string;
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

const aborted = () => new FoxmindError("aborted", "The caller stopped the call.");
const PLANNER = "plan";

/** Where a call may go: every provider, or a role's own list. */
interface Route {
  providers: Provider[];
  role?: string;
  spec?: RoleOptions;
  /** Apply the role's limits also to the last provider (the scout of a shadow call). */
  limitLast?: boolean;
  /** Characters in the messages, for `maxInput`. */
  chars?: number;
  /** Update `status().last`. Default true. */
  record?: boolean;
}

/** Why an `escalate: "unsure"` role moves on from this reply, or undefined to keep it. */
function doubt(reply: ChatReply): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.message.content ?? "");
  } catch {
    return "The reply is not JSON.";
  }
  return typeof parsed === "object" && parsed !== null && (parsed as { sure?: unknown }).sure === false ? 'The reply says "sure": false.' : undefined;
}

/** A result or its error, never a rejection. */
function settle(running: Promise<ChatResult>): Promise<ChatResult | { error: Error }> {
  return running.catch((error: unknown) => ({ error: error instanceof Error ? error : new Error(String(error)) }));
}

/** Run one attempt with a hard deadline. At the deadline the request is stopped and the attempt fails with `timeout`. */
function deadline<T>(ms: number, provider: Provider, options: ChatOptions, run: (options: ChatOptions) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  options.signal?.addEventListener("abort", stop, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new FoxmindError("timeout", `No answer in ${ms} ms, the role's timeoutMs.`, { provider: provider.name, tier: provider.tier }));
      controller.abort();
    }, ms);
  });
  return Promise.race([run({ ...options, signal: controller.signal }), late]).finally(() => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", stop);
  });
}

export function createMind(options: MindOptions): Mind {
  const only = options.only;
  for (const tier of only ?? []) if (!TIERS.has(tier)) throw new TypeError(`only names "${tier}", which is not a tier. Tiers: browser, local, cloud.`);
  const providers = order(options.providers, options.prefer).filter((provider) => !only || only.includes(provider.tier));
  if (only && !providers.length) throw new TypeError(`only: [${only.join(", ")}] leaves no provider. Add a provider of one of those tiers.`);
  const excluded = only ? ` only: [${only.join(", ")}] excluded the other tiers.` : "";
  const ttl = options.probeTtlMs ?? 30_000;
  const probes = new Map<string, { at: number; result: Probe }>();
  let last: MindStatus["last"];

  const roles = new Map<string, Route>();
  for (const [name, spec] of Object.entries(options.roles ?? {})) {
    if (!spec.use?.length) throw new TypeError(`Role "${name}" has an empty use list. Name at least one provider.`);
    if (spec.escalate !== undefined && spec.escalate !== "unsure") throw new TypeError(`Role "${name}" has escalate "${String(spec.escalate)}". The only value is "unsure".`);
    if (spec.shadow && spec.timeoutMs === undefined) throw new TypeError(`Role "${name}" shadows, so it needs timeoutMs: a scout without a deadline can hang forever.`);
    const picked = spec.use.map((entry, index) => {
      if (spec.use.indexOf(entry) !== index) throw new TypeError(`Role "${name}" names "${entry}" twice. Each provider runs at most once.`);
      const provider = providers.find((candidate) => candidate.name === entry);
      const dropped = options.providers.find((candidate) => candidate.name === entry);
      if (!provider && dropped) throw new TypeError(`Role "${name}" uses "${entry}" (${dropped.tier}), which only: [${only?.join(", ")}] excludes. A role cannot cross only.`);
      if (!provider) throw new TypeError(`Role "${name}" uses "${entry}", which is not a provider. Providers: ${providers.map((p) => p.name).join(", ")}.`);
      if (!provider.capabilities.includes("chat")) throw new TypeError(`Role "${name}" uses "${entry}", which cannot chat.`);
      return provider;
    });
    roles.set(name, { providers: picked, role: name, spec });
  }
  const plannerFirst = (roles.get(PLANNER)?.providers ?? providers.filter((provider) => provider.capabilities.includes("chat")))[0];
  for (const route of roles.values()) {
    if (route.spec?.shadow && route.providers[0] === plannerFirst) throw new TypeError(`Role "${route.role}" shadows with ${plannerFirst?.name}, the ${PLANNER} route's first provider, so it compares the ${PLANNER} with itself.`);
  }

  /**
   * A cached or fresh probe. The probe runs on its own timeout, never on the
   * caller's signal, so an abort cannot turn into a cached "unreachable". An
   * abort while the probe runs throws aborted and caches nothing.
   */
  async function probe(provider: Provider, callOptions: CallOptions): Promise<Probe> {
    const cached = probes.get(provider.name);
    if (cached && Date.now() - cached.at < ttl) return cached.result;
    const running = provider.probe().catch((error: unknown): Probe => ({ ok: false, code: "unreachable", reason: String(error) }));
    const signal = callOptions.signal;
    const result = signal
      ? await Promise.race([running, new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(aborted()), { once: true }))])
      : await running;
    if (signal?.aborted) throw aborted();
    probes.set(provider.name, { at: Date.now(), result });
    return result;
  }

  async function call<T>(capability: Capability, callOptions: ChatOptions, run: (provider: Provider, options: ChatOptions) => Promise<T>, route: Route = { providers }): Promise<{ value: T } & Answered> {
    const able = route.providers.filter((provider) => provider.capabilities.includes(capability));
    const spec = route.spec;
    if (!able.length) {
      throw new FoxmindError("no_provider", `No provider can ${capability}. Providers: ${providers.map((p) => `${p.name} (${p.capabilities.join(", ")})`).join("; ") || "none"}.${excluded}`, { skipped: [] });
    }
    const skipped: Skip[] = [];
    for (const [index, provider] of able.entries()) {
      // An abort ends the call here. It never moves the text on to the next provider.
      if (callOptions.signal?.aborted) throw aborted();
      const next = index < able.length - 1;
      // A role's limits guard the cheap attempts. The last provider in `use` is the backstop.
      const limited = spec && (next || route.limitLast);
      if (limited && spec.maxInput !== undefined && (route.chars ?? 0) > spec.maxInput) {
        skipped.push({ provider: provider.name, tier: provider.tier, code: "too_long", reason: `The messages have ${route.chars} characters; role "${route.role}" sends at most ${spec.maxInput} to ${provider.name}.` });
        continue;
      }
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
        const value = limited && spec.timeoutMs !== undefined ? await deadline(spec.timeoutMs, provider, attempt, (o) => run(provider, o)) : await run(provider, attempt);
        const unsure = spec?.escalate && next ? doubt(value as ChatReply) : undefined;
        if (unsure && !streamed) {
          skipped.push({ provider: provider.name, tier: provider.tier, code: "unsure", reason: unsure });
          continue;
        }
        if (route.record !== false) last = { capability, provider: provider.name, tier: provider.tier, model: provider.model, at: new Date().toISOString() };
        return { value, provider: provider.name, tier: provider.tier, model: provider.model, ms: Date.now() - started, skipped, ...(route.role ? { role: route.role } : {}) };
      } catch (error) {
        const failed = error instanceof FoxmindError ? error : new FoxmindError("http", String(error), { provider: provider.name, tier: provider.tier, cause: error });
        // Whatever went wrong, the cached probe no longer tells the truth.
        probes.delete(provider.name);
        // A role's `use` list is the caller's own fallback list, so it moves on without fallbackOnError.
        if ((route.role ? next : options.fallbackOnError) && !streamed && failed.code !== "aborted" && !callOptions.signal?.aborted) {
          skipped.push({ provider: provider.name, tier: provider.tier, code: failed.code, reason: failed.message });
          continue;
        }
        failed.skipped = skipped;
        throw failed;
      }
    }
    const list = skipped.map((skip) => `${skip.provider} (${skip.tier}): ${skip.reason}`).join("; ");
    throw new FoxmindError("no_provider", `No provider could ${capability}. ${list}${excluded}`, { skipped });
  }

  return {
    providers,
    async chat(messages, chatOptions = {}) {
      const { role: name, ...rest } = chatOptions;
      const route = roles.get(name ?? PLANNER);
      if (name !== undefined && !route) throw new TypeError(`No role named "${name}". Roles: ${[...roles.keys()].join(", ") || "none"}.`);
      const shadow = route?.spec?.shadow ? route : undefined;
      // The route whose answer is the result. For a shadow call that is the planner.
      const target = shadow ? (roles.get(PLANNER) ?? { providers }) : (route ?? { providers });
      if (target.spec?.escalate && rest.onDelta) throw new TypeError(`Role "${target.role}" escalates, so it cannot stream: the caller would see text from a provider the role then replaces.`);
      const chars = messages.reduce((sum, message) => sum + (message.content?.length ?? 0), 0);
      // Each route runs with its own role's options.
      const send = async (to: Route, o: ChatOptions): Promise<ChatResult> => {
        const spec = to.spec;
        const own = spec ? { ...o, json: spec.escalate ? true : (o.json ?? spec.json) } : o;
        const { value, ...answered } = await call("chat", own, (provider, x) => provider.chat!(messages, x), { ...to, chars });
        return { ...value, ...answered };
      };
      if (!shadow) return send(target, rest);
      // Shadow: the planner's answer is the result. The scout's answer goes only to onShadow.
      const { onDelta: _quiet, ...silent } = rest;
      const scout = settle(send({ ...shadow, providers: shadow.providers.slice(0, 1), limitLast: true, record: false }, silent));
      const planner = settle(send(target, rest));
      void Promise.all([scout, planner]).then(([s, p]) => {
        try {
          options.onShadow?.({ role: shadow.role!, scout: s, planner: p });
        } catch {
          // A broken hook never breaks the call.
        }
      });
      const answer = await planner;
      if ("error" in answer) throw answer.error;
      return answer;
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
