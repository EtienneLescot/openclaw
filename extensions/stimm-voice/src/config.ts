/**
 * Stimm Voice plugin configuration — Zod schema + types.
 */

import { z } from "zod";

export const LiveKitConfigSchema = z.object({
  url: z.string().default("ws://localhost:7880"),
  apiKey: z.string().default("devkey"),
  apiSecret: z.string().default("secret"),
});

export const SttConfigSchema = z.object({
  provider: z.enum(["deepgram", "google", "openai"]).default("deepgram"),
  model: z.string().default("nova-2"),
});

export const TtsConfigSchema = z.object({
  provider: z.enum(["openai", "elevenlabs", "cartesia", "google"]).default("openai"),
  model: z.string().default("tts-1"),
  voice: z.string().default("alloy"),
});

export const LlmConfigSchema = z.object({
  provider: z.string().default("openai"),
  model: z.string().default("gpt-4o-mini"),
});

export const VoiceAgentConfigSchema = z.object({
  docker: z.boolean().default(true),
  image: z.string().default("ghcr.io/stimm-ai/stimm-agent:latest"),
  stt: SttConfigSchema.default(() => SttConfigSchema.parse({})),
  tts: TtsConfigSchema.default(() => TtsConfigSchema.parse({})),
  llm: LlmConfigSchema.default(() => LlmConfigSchema.parse({})),
  bufferingLevel: z.enum(["NONE", "LOW", "MEDIUM", "HIGH"]).default("MEDIUM"),
  mode: z.enum(["autonomous", "relay", "hybrid"]).default("hybrid"),
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

/**
 * Parse raw plugin config into a validated StimmVoiceConfig.
 */
export function resolveStimmVoiceConfig(raw: unknown): StimmVoiceConfig {
  const value =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return StimmVoiceConfigSchema.parse(value);
}
