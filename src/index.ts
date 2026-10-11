// The public API of foxmind for Node and the browser.
export { FoxmindError, type ErrorCode, type Skip } from "./errors.js";
export { openaiCompatible, type OpenAICompatibleOptions } from "./providers/openai.js";
export type * from "./types.js";
export { createMind, type Answered, type ChatResult, type ClassifyResult, type EmbedResult, type ExtractResult, type Mind, type MindOptions, type MindStatus, type RoleOptions, type ShadowEvent } from "./mind.js";
export { llamaServer, lmStudio, ollama, saluki, SALUKI } from "./providers/presets.js";
export { anthropic, type AnthropicOptions } from "./providers/anthropic.js";
export { doctor, format as formatDoctor, type Check, type DoctorOptions, type Report } from "./doctor.js";
