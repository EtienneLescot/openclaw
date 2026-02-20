import { describe, expect, it } from "vitest";
import { resolveStimmVoiceConfig, StimmVoiceConfigSchema } from "./config.js";

describe("config", () => {
  describe("resolveStimmVoiceConfig", () => {
    it("returns sensible defaults when given empty input", () => {
      const cfg = resolveStimmVoiceConfig({});
      expect(cfg.enabled).toBe(false);
      expect(cfg.livekit.url).toBe("ws://localhost:7880");
      expect(cfg.livekit.apiKey).toBe("devkey");
      expect(cfg.livekit.apiSecret).toBe("secret");
      expect(cfg.voiceAgent.docker).toBe(true);
      expect(cfg.voiceAgent.mode).toBe("hybrid");
      expect(cfg.voiceAgent.bufferingLevel).toBe("MEDIUM");
      expect(cfg.voiceAgent.stt.provider).toBe("deepgram");
      expect(cfg.voiceAgent.tts.provider).toBe("openai");
      expect(cfg.voiceAgent.llm.model).toBe("gpt-4o-mini");
      expect(cfg.web.enabled).toBe(true);
      expect(cfg.web.path).toBe("/voice");
    });

    it("accepts null/undefined/non-object input gracefully", () => {
      expect(resolveStimmVoiceConfig(null).enabled).toBe(false);
      expect(resolveStimmVoiceConfig(undefined).enabled).toBe(false);
      expect(resolveStimmVoiceConfig("garbage").enabled).toBe(false);
      expect(resolveStimmVoiceConfig(42).enabled).toBe(false);
    });

    it("merges partial overrides", () => {
      const cfg = resolveStimmVoiceConfig({
        enabled: true,
        livekit: { url: "wss://my-livekit.example.com" },
        voiceAgent: { mode: "relay", llm: { model: "claude-sonnet-4-20250514" } },
      });
      expect(cfg.enabled).toBe(true);
      expect(cfg.livekit.url).toBe("wss://my-livekit.example.com");
      // Defaults still filled in for unspecified keys
      expect(cfg.livekit.apiKey).toBe("devkey");
      expect(cfg.voiceAgent.mode).toBe("relay");
      expect(cfg.voiceAgent.llm.model).toBe("claude-sonnet-4-20250514");
      // Untouched nested defaults
      expect(cfg.voiceAgent.stt.provider).toBe("deepgram");
    });

    it("validates enum values", () => {
      expect(() => StimmVoiceConfigSchema.parse({ voiceAgent: { mode: "invalid" } })).toThrow();
      expect(() =>
        StimmVoiceConfigSchema.parse({ voiceAgent: { bufferingLevel: "SUPER" } }),
      ).toThrow();
    });

    it("disables web endpoint when overridden", () => {
      const cfg = resolveStimmVoiceConfig({ web: { enabled: false } });
      expect(cfg.web.enabled).toBe(false);
    });
  });
});
