import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveStimmVoiceConfig, StimmVoiceConfigSchema, providerEnvVar } from "./config.js";

// Env vars that may affect config resolution.
const ENV_KEYS = [
  "OPENAI_API_KEY",
  "DEEPGRAM_API_KEY",
  "ELEVENLABS_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "CARTESIA_API_KEY",
  "STIMM_STT_API_KEY",
  "STIMM_TTS_API_KEY",
  "STIMM_LLM_API_KEY",
  "LIVEKIT_URL",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
] as const;

describe("config", () => {
  describe("providerEnvVar", () => {
    it("maps known providers to env var names", () => {
      expect(providerEnvVar("openai")).toBe("OPENAI_API_KEY");
      expect(providerEnvVar("deepgram")).toBe("DEEPGRAM_API_KEY");
      expect(providerEnvVar("elevenlabs")).toBe("ELEVENLABS_API_KEY");
      expect(providerEnvVar("anthropic")).toBe("ANTHROPIC_API_KEY");
      expect(providerEnvVar("google")).toBe("GOOGLE_API_KEY");
      expect(providerEnvVar("groq")).toBe("GROQ_API_KEY");
      expect(providerEnvVar("cartesia")).toBe("CARTESIA_API_KEY");
    });

    it("returns undefined for unknown providers", () => {
      expect(providerEnvVar("not-a-provider")).toBeUndefined();
    });
  });

  describe("resolveStimmVoiceConfig", () => {
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
      // Save and clear env vars that affect resolution.
      for (const key of ENV_KEYS) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
      }
    });

    afterEach(() => {
      for (const key of ENV_KEYS) {
        if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
        else delete process.env[key];
      }
    });

    // -- Defaults -----------------------------------------------------------

    it("returns sensible defaults when given empty input", () => {
      const cfg = resolveStimmVoiceConfig({});
      expect(cfg.enabled).toBe(false);
      expect(cfg.livekit.url).toBe("ws://localhost:7880");
      expect(cfg.livekit.apiKey).toBe("devkey");
      expect(cfg.livekit.apiSecret).toBe("secret");
      expect(cfg.voiceAgent.docker).toBe(true);
      expect(cfg.voiceAgent.mode).toBe("hybrid");
      expect(cfg.voiceAgent.bufferingLevel).toBe("MEDIUM");
      // STT defaults
      expect(cfg.voiceAgent.stt.provider).toBe("deepgram");
      expect(cfg.voiceAgent.stt.model).toBe("nova-3");
      expect(cfg.voiceAgent.stt.apiKey).toBeUndefined();
      // TTS defaults
      expect(cfg.voiceAgent.tts.provider).toBe("openai");
      expect(cfg.voiceAgent.tts.model).toBe("gpt-4o-mini-tts");
      expect(cfg.voiceAgent.tts.voice).toBe("ash");
      expect(cfg.voiceAgent.tts.apiKey).toBeUndefined();
      // LLM defaults
      expect(cfg.voiceAgent.llm.provider).toBe("openai");
      expect(cfg.voiceAgent.llm.model).toBe("gpt-4o-mini");
      expect(cfg.voiceAgent.llm.apiKey).toBeUndefined();
      // Web
      expect(cfg.web.enabled).toBe(true);
      expect(cfg.web.path).toBe("/voice");
    });

    it("accepts null/undefined/non-object input gracefully", () => {
      expect(resolveStimmVoiceConfig(null).enabled).toBe(false);
      expect(resolveStimmVoiceConfig(undefined).enabled).toBe(false);
      expect(resolveStimmVoiceConfig("garbage").enabled).toBe(false);
      expect(resolveStimmVoiceConfig(42).enabled).toBe(false);
    });

    // -- Overrides ----------------------------------------------------------

    it("merges partial overrides", () => {
      const cfg = resolveStimmVoiceConfig({
        enabled: true,
        livekit: { url: "wss://my-livekit.example.com" },
        voiceAgent: {
          mode: "relay",
          llm: { model: "claude-sonnet-4-20250514", provider: "anthropic" },
        },
      });
      expect(cfg.enabled).toBe(true);
      expect(cfg.livekit.url).toBe("wss://my-livekit.example.com");
      expect(cfg.livekit.apiKey).toBe("devkey");
      expect(cfg.voiceAgent.mode).toBe("relay");
      expect(cfg.voiceAgent.llm.model).toBe("claude-sonnet-4-20250514");
      expect(cfg.voiceAgent.llm.provider).toBe("anthropic");
      expect(cfg.voiceAgent.stt.provider).toBe("deepgram");
    });

    it("allows choosing all STT providers", () => {
      for (const provider of ["deepgram", "openai", "google", "azure", "assemblyai", "aws"]) {
        const cfg = resolveStimmVoiceConfig({ voiceAgent: { stt: { provider } } });
        expect(cfg.voiceAgent.stt.provider).toBe(provider);
      }
    });

    it("allows choosing all TTS providers", () => {
      for (const provider of ["openai", "elevenlabs", "cartesia", "google", "azure", "aws"]) {
        const cfg = resolveStimmVoiceConfig({ voiceAgent: { tts: { provider } } });
        expect(cfg.voiceAgent.tts.provider).toBe(provider);
      }
    });

    it("allows choosing all LLM providers", () => {
      for (const provider of ["openai", "anthropic", "google", "groq", "azure", "cerebras"]) {
        const cfg = resolveStimmVoiceConfig({ voiceAgent: { llm: { provider } } });
        expect(cfg.voiceAgent.llm.provider).toBe(provider);
      }
    });

    it("validates provider enum values", () => {
      expect(() =>
        StimmVoiceConfigSchema.parse({ voiceAgent: { stt: { provider: "bogus" } } }),
      ).toThrow();
      expect(() =>
        StimmVoiceConfigSchema.parse({ voiceAgent: { tts: { provider: "bogus" } } }),
      ).toThrow();
      expect(() =>
        StimmVoiceConfigSchema.parse({ voiceAgent: { llm: { provider: "bogus" } } }),
      ).toThrow();
      expect(() => StimmVoiceConfigSchema.parse({ voiceAgent: { mode: "invalid" } })).toThrow();
      expect(() =>
        StimmVoiceConfigSchema.parse({ voiceAgent: { bufferingLevel: "SUPER" } }),
      ).toThrow();
    });

    it("accepts per-pipeline API keys in config", () => {
      const cfg = resolveStimmVoiceConfig({
        voiceAgent: {
          stt: { apiKey: "dg-test" },
          tts: { apiKey: "sk-tts-test" },
          llm: { apiKey: "sk-llm-test" },
        },
      });
      expect(cfg.voiceAgent.stt.apiKey).toBe("dg-test");
      expect(cfg.voiceAgent.tts.apiKey).toBe("sk-tts-test");
      expect(cfg.voiceAgent.llm.apiKey).toBe("sk-llm-test");
    });

    it("disables web endpoint when overridden", () => {
      const cfg = resolveStimmVoiceConfig({ web: { enabled: false } });
      expect(cfg.web.enabled).toBe(false);
    });

    // -- Per-pipeline env-var fallback chain --------------------------------

    describe("per-pipeline API key env-var fallbacks", () => {
      it("STT: STIMM_STT_API_KEY takes priority over provider env", () => {
        process.env.STIMM_STT_API_KEY = "stimm-stt";
        process.env.DEEPGRAM_API_KEY = "dg-env";
        const cfg = resolveStimmVoiceConfig({});
        expect(cfg.voiceAgent.stt.apiKey).toBe("stimm-stt");
      });

      it("STT: falls back to provider-specific env when no STIMM_STT_API_KEY", () => {
        process.env.DEEPGRAM_API_KEY = "dg-env";
        const cfg = resolveStimmVoiceConfig({});
        expect(cfg.voiceAgent.stt.apiKey).toBe("dg-env");
      });

      it("TTS: STIMM_TTS_API_KEY takes priority over provider env", () => {
        process.env.STIMM_TTS_API_KEY = "stimm-tts";
        process.env.OPENAI_API_KEY = "sk-env";
        const cfg = resolveStimmVoiceConfig({});
        expect(cfg.voiceAgent.tts.apiKey).toBe("stimm-tts");
      });

      it("TTS: falls back to provider-specific env (e.g. ELEVENLABS_API_KEY)", () => {
        process.env.ELEVENLABS_API_KEY = "el-env";
        const cfg = resolveStimmVoiceConfig({
          voiceAgent: { tts: { provider: "elevenlabs" } },
        });
        expect(cfg.voiceAgent.tts.apiKey).toBe("el-env");
      });

      it("LLM: STIMM_LLM_API_KEY takes priority over provider env", () => {
        process.env.STIMM_LLM_API_KEY = "stimm-llm";
        process.env.OPENAI_API_KEY = "sk-env";
        const cfg = resolveStimmVoiceConfig({});
        expect(cfg.voiceAgent.llm.apiKey).toBe("stimm-llm");
      });

      it("LLM: falls back to ANTHROPIC_API_KEY when provider is anthropic", () => {
        process.env.ANTHROPIC_API_KEY = "ant-env";
        const cfg = resolveStimmVoiceConfig({
          voiceAgent: { llm: { provider: "anthropic" } },
        });
        expect(cfg.voiceAgent.llm.apiKey).toBe("ant-env");
      });

      it("explicit config apiKey takes precedence over all env vars", () => {
        process.env.STIMM_STT_API_KEY = "stimm-stt";
        process.env.DEEPGRAM_API_KEY = "dg-env";
        const cfg = resolveStimmVoiceConfig({
          voiceAgent: { stt: { apiKey: "explicit-key" } },
        });
        expect(cfg.voiceAgent.stt.apiKey).toBe("explicit-key");
      });
    });

    // -- LiveKit env fallbacks ----------------------------------------------

    describe("LiveKit env-var fallbacks", () => {
      it("falls back to LIVEKIT_URL env var", () => {
        process.env.LIVEKIT_URL = "wss://cloud.livekit.io";
        const cfg = resolveStimmVoiceConfig({});
        expect(cfg.livekit.url).toBe("wss://cloud.livekit.io");
      });

      it("falls back to LIVEKIT_API_KEY / LIVEKIT_API_SECRET env vars", () => {
        process.env.LIVEKIT_API_KEY = "cloud-key";
        process.env.LIVEKIT_API_SECRET = "cloud-secret";
        const cfg = resolveStimmVoiceConfig({});
        expect(cfg.livekit.apiKey).toBe("cloud-key");
        expect(cfg.livekit.apiSecret).toBe("cloud-secret");
      });
    });

    // -- Spawn config -------------------------------------------------------

    it("returns spawn defaults", () => {
      const cfg = resolveStimmVoiceConfig({});
      expect(cfg.voiceAgent.spawn.autoSpawn).toBe(true);
      expect(cfg.voiceAgent.spawn.pythonPath).toBeUndefined();
      expect(cfg.voiceAgent.spawn.agentScript).toBeUndefined();
      expect(cfg.voiceAgent.spawn.maxRestarts).toBe(5);
    });

    it("accepts spawn overrides", () => {
      const cfg = resolveStimmVoiceConfig({
        voiceAgent: {
          spawn: {
            autoSpawn: false,
            pythonPath: "/usr/bin/python3",
            maxRestarts: 10,
          },
        },
      });
      expect(cfg.voiceAgent.spawn.autoSpawn).toBe(false);
      expect(cfg.voiceAgent.spawn.pythonPath).toBe("/usr/bin/python3");
      expect(cfg.voiceAgent.spawn.maxRestarts).toBe(10);
    });
  });
});
