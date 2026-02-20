/**
 * Stimm Voice plugin configuration — Zod schema + types.
 *
 * Each voice pipeline (STT, TTS, LLM) is independently configurable:
 *   provider  — which livekit-plugins-* to use
 *   model     — model name string passed to the plugin constructor
 *   apiKey    — API key for that provider (env-var fallback chain)
 *
 * Config path: plugins.entries.stimm-voice.config.*
 * Example:
 *   openclaw config set plugins.entries.stimm-voice.config.voiceAgent.tts.provider elevenlabs
 *   openclaw config set plugins.entries.stimm-voice.config.voiceAgent.tts.model eleven_turbo_v2_5
 *   openclaw config set plugins.entries.stimm-voice.config.voiceAgent.tts.apiKey sk-...
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Provider lists — all livekit-agents plugins available on PyPI (v1.4.x).
// Keep these in sync when new plugins are released.
// ---------------------------------------------------------------------------

/** STT providers supported by livekit-plugins-*. */
export const STT_PROVIDERS = [
  "deepgram",
  "openai",
  "google",
  "azure",
  "assemblyai",
  "aws",
  "speechmatics",
  "clova",
  "fal",
] as const;

/** TTS providers supported by livekit-plugins-*. */
export const TTS_PROVIDERS = [
  "openai",
  "elevenlabs",
  "cartesia",
  "google",
  "azure",
  "aws",
  "playai",
  "rime",
] as const;

/** LLM providers supported by livekit-plugins-*. */
export const LLM_PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "groq",
  "azure",
  "cerebras",
  "fireworks",
  "together",
  "sambanova",
] as const;

export type SttProvider = (typeof STT_PROVIDERS)[number];
export type TtsProvider = (typeof TTS_PROVIDERS)[number];
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

// ---------------------------------------------------------------------------
// Per-pipeline schemas — provider + model + apiKey.
// ---------------------------------------------------------------------------

export const SttConfigSchema = z.object({
  /** livekit-plugins-* STT provider. */
  provider: z.enum(STT_PROVIDERS).default("deepgram"),
  /** Model name passed to the provider constructor (e.g. "nova-3", "gpt-4o-mini-transcribe"). */
  model: z.string().default("nova-3"),
  /** API key for the STT provider. Falls back to STIMM_STT_API_KEY → provider-specific env. */
  apiKey: z.string().optional(),
  /** Language code (e.g. "en", "en-US"). Provider-dependent. */
  language: z.string().optional(),
});

export const TtsConfigSchema = z.object({
  /** livekit-plugins-* TTS provider. */
  provider: z.enum(TTS_PROVIDERS).default("openai"),
  /** Model name (e.g. "gpt-4o-mini-tts", "eleven_turbo_v2_5", "sonic-2"). */
  model: z.string().default("gpt-4o-mini-tts"),
  /** Voice name or ID. Provider-dependent (e.g. "ash", "rachel"). */
  voice: z.string().default("ash"),
  /** API key for the TTS provider. Falls back to STIMM_TTS_API_KEY → provider-specific env. */
  apiKey: z.string().optional(),
});

export const LlmConfigSchema = z.object({
  /** livekit-plugins-* LLM provider. */
  provider: z.enum(LLM_PROVIDERS).default("openai"),
  /** Model name (e.g. "gpt-4o-mini", "claude-sonnet-4-20250514", "gemini-2.0-flash"). */
  model: z.string().default("gpt-4o-mini"),
  /** API key for the LLM provider. Falls back to STIMM_LLM_API_KEY → provider-specific env. */
  apiKey: z.string().optional(),
});

// ---------------------------------------------------------------------------
// LiveKit, spawn, web, and top-level schemas.
// ---------------------------------------------------------------------------

export const LiveKitConfigSchema = z.object({
  url: z.string().default("ws://localhost:7880"),
  apiKey: z.string().default("devkey"),
  apiSecret: z.string().default("secret"),
});

export const AgentSpawnConfigSchema = z.object({
  /** Auto-spawn the Python voice agent as a child process of the gateway. */
  autoSpawn: z.boolean().default(true),
  /** Path to the Python executable. Resolved from the extension venv by default. */
  pythonPath: z.string().optional(),
  /** Path to agent.py. Resolved from the extension dir by default. */
  agentScript: z.string().optional(),
  /** Max automatic restarts before giving up. */
  maxRestarts: z.number().default(5),
});

export const VoiceAgentConfigSchema = z.object({
  docker: z.boolean().default(true),
  image: z.string().default("ghcr.io/stimm-ai/stimm-agent:latest"),
  stt: SttConfigSchema.default(() => SttConfigSchema.parse({})),
  tts: TtsConfigSchema.default(() => TtsConfigSchema.parse({})),
  llm: LlmConfigSchema.default(() => LlmConfigSchema.parse({})),
  bufferingLevel: z.enum(["NONE", "LOW", "MEDIUM", "HIGH"]).default("MEDIUM"),
  mode: z.enum(["autonomous", "relay", "hybrid"]).default("hybrid"),
  spawn: AgentSpawnConfigSchema.default(() => AgentSpawnConfigSchema.parse({})),
});

export const WebConfigSchema = z.object({
  enabled: z.boolean().default(true),
  path: z.string().default("/voice"),
});

export const StimmVoiceConfigSchema = z.object({
  enabled: z.boolean().default(false),
  livekit: LiveKitConfigSchema.default(() => LiveKitConfigSchema.parse({})),
  voiceAgent: VoiceAgentConfigSchema.default(() => VoiceAgentConfigSchema.parse({})),
  web: WebConfigSchema.default(() => WebConfigSchema.parse({})),
});

export type StimmVoiceConfig = z.infer<typeof StimmVoiceConfigSchema>;
export type LiveKitConfig = z.infer<typeof LiveKitConfigSchema>;
export type VoiceAgentConfig = z.infer<typeof VoiceAgentConfigSchema>;
export type AgentSpawnConfig = z.infer<typeof AgentSpawnConfigSchema>;
export type SttConfig = z.infer<typeof SttConfigSchema>;
export type TtsConfig = z.infer<typeof TtsConfigSchema>;
export type LlmConfig = z.infer<typeof LlmConfigSchema>;

// ---------------------------------------------------------------------------
// Provider → env-var name map. Used for API key fallback resolution.
// ---------------------------------------------------------------------------

const PROVIDER_ENV_MAP: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  deepgram: "DEEPGRAM_API_KEY",
  elevenlabs: "ELEVENLABS_API_KEY",
  cartesia: "CARTESIA_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  groq: "GROQ_API_KEY",
  azure: "AZURE_API_KEY",
  assemblyai: "ASSEMBLYAI_API_KEY",
  aws: "AWS_ACCESS_KEY_ID",
  cerebras: "CEREBRAS_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  together: "TOGETHER_API_KEY",
  sambanova: "SAMBANOVA_API_KEY",
  playai: "PLAYAI_API_KEY",
  rime: "RIME_API_KEY",
  speechmatics: "SPEECHMATICS_API_KEY",
  clova: "CLOVA_API_KEY",
  fal: "FAL_KEY",
};

/** Look up the idiomatic env-var name for a provider's API key. */
export function providerEnvVar(provider: string): string | undefined {
  return PROVIDER_ENV_MAP[provider];
}

/**
 * Parse raw plugin config into a validated StimmVoiceConfig.
 * Applies env-var fallback chain for per-pipeline API keys:
 *   config value → STIMM_{STT|TTS|LLM}_API_KEY → provider-specific env
 */
export function resolveStimmVoiceConfig(raw: unknown): StimmVoiceConfig {
  const value =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const config = StimmVoiceConfigSchema.parse(value);

  // Per-pipeline API key fallback chain.
  config.voiceAgent.stt.apiKey ??=
    process.env.STIMM_STT_API_KEY ?? providerEnvFallback(config.voiceAgent.stt.provider);
  config.voiceAgent.tts.apiKey ??=
    process.env.STIMM_TTS_API_KEY ?? providerEnvFallback(config.voiceAgent.tts.provider);
  config.voiceAgent.llm.apiKey ??=
    process.env.STIMM_LLM_API_KEY ?? providerEnvFallback(config.voiceAgent.llm.provider);

  // LiveKit env fallbacks.
  if (config.livekit.url === "ws://localhost:7880" && process.env.LIVEKIT_URL) {
    config.livekit.url = process.env.LIVEKIT_URL;
  }
  if (config.livekit.apiKey === "devkey" && process.env.LIVEKIT_API_KEY) {
    config.livekit.apiKey = process.env.LIVEKIT_API_KEY;
  }
  if (config.livekit.apiSecret === "secret" && process.env.LIVEKIT_API_SECRET) {
    config.livekit.apiSecret = process.env.LIVEKIT_API_SECRET;
  }

  return config;
}

/** Resolve provider-specific env var value, or undefined. */
function providerEnvFallback(provider: string): string | undefined {
  const envName = PROVIDER_ENV_MAP[provider];
  return envName ? process.env[envName] : undefined;
}
