// Ready-made settings for the local servers people run on their own machine.
import { FoxmindError } from "../errors.js";
import { openaiCompatible, type OpenAICompatibleOptions } from "./openai.js";
import type { Provider } from "../types.js";

type PresetOptions = Partial<Omit<OpenAICompatibleOptions, "model">>;

/** Underdog Saluki 27B 1.0, from its Hugging Face model card (checked 2026-10-08). */
export const SALUKI = {
  repo: "ConwayResearch/Underdog-Saluki-27B-1.0",
  file: "Underdog-Saluki-27B-1.0-IQ2-mix.gguf",
  sizeGB: 7.89,
  license: "Apache-2.0",
  download: "huggingface-cli download ConwayResearch/Underdog-Saluki-27B-1.0 Underdog-Saluki-27B-1.0-IQ2-mix.gguf --local-dir .",
  serve: "llama-server -m Underdog-Saluki-27B-1.0-IQ2-mix.gguf --jinja -ngl 99 -fa on -c 32768",
} as const;

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Ollama's OpenAI-compatible API. "llama3.2" matches "llama3.2:latest". */
export function ollama(options: PresetOptions & { model: string }): Provider {
  const tagged = options.model.includes(":") ? escape(options.model) : `${escape(options.model)}(:latest)?`;
  const provider = openaiCompatible({
    name: "ollama",
    baseURL: "http://127.0.0.1:11434/v1",
    checkModel: new RegExp(`^${tagged}$`),
    hint: `Start Ollama with "ollama serve", then run "ollama pull ${options.model}".`,
    ...options,
  });
  // Ollama answers 403 to an origin it does not allow, such as moz-extension://.
  const explain = (error: unknown) => {
    if (!(error instanceof FoxmindError) || error.status !== 403) return error;
    return new FoxmindError("auth", 'Ollama refused this origin (HTTP 403). Start it with OLLAMA_ORIGINS="moz-extension://*" to allow Firefox extensions.', { provider: provider.name, tier: provider.tier, status: 403 });
  };
  const { chat, embed } = provider;
  return {
    ...provider,
    chat: (messages, chatOptions) => chat!(messages, chatOptions).catch((error: unknown) => { throw explain(error); }),
    embed: (texts, embedOptions) => embed!(texts, embedOptions).catch((error: unknown) => { throw explain(error); }),
  };
}

/** llama.cpp llama-server. It serves one model, so the name is not checked. */
export function llamaServer(options: PresetOptions & { model?: string } = {}): Provider {
  return openaiCompatible({
    name: "llama-server",
    baseURL: "http://127.0.0.1:8080/v1",
    checkModel: false,
    hint: 'Start it with "llama-server -m <model.gguf> --jinja".',
    ...options,
    model: options.model ?? "default",
  });
}

/** LM Studio's local server. */
export function lmStudio(options: PresetOptions & { model: string }): Provider {
  return openaiCompatible({ name: "lm-studio", baseURL: "http://127.0.0.1:1234/v1", hint: 'Start it with "lms server start".', ...options });
}

/**
 * Underdog Saluki 27B on llama-server: the default planner for private mode.
 * Thinking is off by default with temperature 0, the model card's settings
 * for direct tool calls. `thinking: true` uses its settings for reasoning.
 */
export function saluki(options: PresetOptions & { thinking?: boolean } = {}): Provider {
  const { thinking = false, ...rest } = options;
  const sampling = thinking ? { temperature: 0.6, top_p: 0.95, top_k: 20 } : { temperature: 0 };
  return openaiCompatible({
    name: "saluki",
    baseURL: "http://127.0.0.1:8080/v1",
    checkModel: /saluki/i,
    hint: `Download it with "${SALUKI.download}", then start it with "${SALUKI.serve}".`,
    ...rest,
    model: SALUKI.file,
    body: { ...sampling, chat_template_kwargs: { enable_thinking: thinking }, ...rest.body },
  });
}
