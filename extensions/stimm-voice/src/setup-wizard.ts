/**
 * Interactive setup wizard for the stimm-voice plugin.
 *
 * Prompts the user for provider choices, API keys, and LiveKit config.
 * Saves results via `openclaw config set` commands.
 *
 * Usage: `openclaw voice:setup`
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  STT_PROVIDERS,
  TTS_PROVIDERS,
  LLM_PROVIDERS,
  providerEnvVar,
  type SttProvider,
  type TtsProvider,
  type LlmProvider,
  type TunnelProvider,
} from "./config.js";

// ---------------------------------------------------------------------------
// Config writer — reads/writes ~/.openclaw/openclaw.json directly.
// ---------------------------------------------------------------------------

function deepSet(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (typeof current[key] !== "object" || current[key] === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[path[path.length - 1]] = value;
}

/**
 * Batch-write multiple config keys into ~/.openclaw/openclaw.json.
 * Reads once, deep-merges, writes once.
 */
function saveConfig(entries: Record<string, unknown>): void {
  const configPath = join(homedir(), ".openclaw", "openclaw.json");
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  }
  for (const [dotKey, value] of Object.entries(entries)) {
    const fullPath = `plugins.entries.stimm-voice.config.${dotKey}`;
    deepSet(config, fullPath.split("."), value);
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Config reader — load existing stimm-voice config from openclaw.json.
// ---------------------------------------------------------------------------

interface ExistingConfig {
  stt?: { provider?: string; model?: string; language?: string; apiKey?: string };
  tts?: { provider?: string; model?: string; voice?: string; apiKey?: string };
  llm?: { provider?: string; model?: string; apiKey?: string };
  livekit?: { url?: string; apiKey?: string; apiSecret?: string };
  tunnel?: { provider?: string };
}

function deepGet(obj: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = obj;
  for (const key of path) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function loadExistingConfig(): ExistingConfig {
  const configPath = join(homedir(), ".openclaw", "openclaw.json");
  if (!existsSync(configPath)) return {};
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    const base = deepGet(raw, ["plugins", "entries", "stimm-voice", "config"]) as
      | Record<string, unknown>
      | undefined;
    if (!base) return {};
    const va = base.voiceAgent as Record<string, unknown> | undefined;
    return {
      stt: va?.stt as ExistingConfig["stt"],
      tts: va?.tts as ExistingConfig["tts"],
      llm: va?.llm as ExistingConfig["llm"],
      livekit: base.livekit as ExistingConfig["livekit"],
      tunnel: base.tunnel as ExistingConfig["tunnel"],
    };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Provider metadata (labels, default models, descriptions).
// ---------------------------------------------------------------------------

const STT_META: Record<SttProvider, { label: string; defaultModel: string }> = {
  deepgram: { label: "Deepgram", defaultModel: "nova-3" },
  openai: { label: "OpenAI", defaultModel: "gpt-4o-mini-transcribe" },
  google: { label: "Google Cloud", defaultModel: "latest_long" },
  azure: { label: "Azure Speech", defaultModel: "en-US" },
  assemblyai: { label: "AssemblyAI", defaultModel: "best" },
  aws: { label: "Amazon Transcribe", defaultModel: "default" },
  speechmatics: { label: "Speechmatics", defaultModel: "default" },
  clova: { label: "Clova (Naver)", defaultModel: "default" },
  fal: { label: "fal.ai", defaultModel: "default" },
};

const TTS_META: Record<TtsProvider, { label: string; defaultModel: string; defaultVoice: string }> =
  {
    openai: { label: "OpenAI", defaultModel: "gpt-4o-mini-tts", defaultVoice: "ash" },
    elevenlabs: { label: "ElevenLabs", defaultModel: "eleven_turbo_v2_5", defaultVoice: "rachel" },
    cartesia: { label: "Cartesia", defaultModel: "sonic-2", defaultVoice: "default" },
    google: { label: "Google Cloud", defaultModel: "en-US-Neural2-F", defaultVoice: "default" },
    azure: { label: "Azure Speech", defaultModel: "en-US-JennyNeural", defaultVoice: "default" },
    aws: { label: "Amazon Polly", defaultModel: "neural", defaultVoice: "Joanna" },
    playai: { label: "PlayAI", defaultModel: "default", defaultVoice: "default" },
    rime: { label: "Rime", defaultModel: "default", defaultVoice: "default" },
  };

const LLM_META: Record<LlmProvider, { label: string; defaultModel: string }> = {
  openai: { label: "OpenAI", defaultModel: "gpt-4o-mini" },
  anthropic: { label: "Anthropic", defaultModel: "claude-sonnet-4-20250514" },
  google: { label: "Google Gemini", defaultModel: "gemini-2.0-flash" },
  groq: { label: "Groq", defaultModel: "llama-3.3-70b-versatile" },
  azure: { label: "Azure OpenAI", defaultModel: "gpt-4o-mini" },
  cerebras: { label: "Cerebras", defaultModel: "llama-3.3-70b" },
  fireworks: { label: "Fireworks", defaultModel: "llama-v3p3-70b-instruct" },
  together: { label: "Together AI", defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
  sambanova: { label: "SambaNova", defaultModel: "Meta-Llama-3.3-70B-Instruct" },
};

// ---------------------------------------------------------------------------
// Prompt helpers (dynamic import of @clack/prompts).
// ---------------------------------------------------------------------------

type Clack = typeof import("@clack/prompts");
let _clack: Clack | null = null;

async function clack(): Promise<Clack> {
  if (!_clack) {
    _clack = await import("@clack/prompts");
  }
  return _clack;
}

function isCancel(value: unknown): value is symbol {
  return typeof value === "symbol";
}

// ---------------------------------------------------------------------------
// Setup wizard
// ---------------------------------------------------------------------------

export interface SetupWizardDeps {
  logger: { info: (msg: string) => void; error: (msg: string) => void };
  extensionDir: string;
}

export async function runSetupWizard(deps: SetupWizardDeps): Promise<void> {
  const c = await clack();

  c.intro("Stimm Voice — Setup Wizard");

  // -- Check Python venv ---------------------------------------------------

  const venvPath = join(deps.extensionDir, "python", ".venv");
  const venvExists = existsSync(join(venvPath, "bin", "python"));

  if (!venvExists) {
    await c.log.warn(
      "Python virtual environment not found.\n" +
        "The agent will auto-create it on first start, or you can run:\n" +
        `  cd ${deps.extensionDir}/python && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`,
    );
  } else {
    await c.log.success("Python virtual environment found.");
  }

  // Load existing config to allow skipping sections.
  const existing = loadExistingConfig();

  // -- STT ----------------------------------------------------------------

  let sttProvider: SttProvider;
  let sttModel: string;
  let sttLanguage: string = "";
  let sttApiKey: string = "";

  const hasSttConfig = !!(existing.stt?.provider && existing.stt?.model);

  if (hasSttConfig) {
    await c.log.info(
      `  Current STT: ${existing.stt!.provider} / ${existing.stt!.model}` +
        (existing.stt!.language ? ` (${existing.stt!.language})` : ""),
    );
    const reconfigureStt = await c.confirm({
      message: "Reconfigure Speech-to-Text?",
      initialValue: false,
    });
    if (isCancel(reconfigureStt)) {
      c.outro("Setup cancelled.");
      return;
    }
    if (!reconfigureStt) {
      sttProvider = existing.stt!.provider as SttProvider;
      sttModel = existing.stt!.model!;
      sttLanguage = existing.stt!.language ?? "";
      sttApiKey = existing.stt!.apiKey ?? "";
    }
  }

  // Only prompt if not already set from existing config.
  if (!hasSttConfig || !sttModel!) {
    const sttProviderResult = (await c.select({
      message: "Speech-to-Text provider",
      options: STT_PROVIDERS.map((id) => ({
        value: id,
        label: `${STT_META[id].label}`,
        hint: providerEnvVar(id) ?? "",
      })),
      initialValue: (existing.stt?.provider as SttProvider) ?? ("deepgram" as SttProvider),
    })) as SttProvider | symbol;

    if (isCancel(sttProviderResult)) {
      c.outro("Setup cancelled.");
      return;
    }
    sttProvider = sttProviderResult;

    const sttModelResult = (await c.text({
      message: `STT model for ${STT_META[sttProvider].label}`,
      initialValue: existing.stt?.model ?? STT_META[sttProvider].defaultModel,
      placeholder: STT_META[sttProvider].defaultModel,
    })) as string | symbol;

    if (isCancel(sttModelResult)) {
      c.outro("Setup cancelled.");
      return;
    }
    sttModel = sttModelResult;

    const sttLanguageResult = (await c.text({
      message: "STT language code (e.g. fr, en-US, es) — leave blank to use provider default",
      initialValue: existing.stt?.language ?? "",
      placeholder: "fr",
    })) as string | symbol;

    if (isCancel(sttLanguageResult)) {
      c.outro("Setup cancelled.");
      return;
    }
    sttLanguage = sttLanguageResult;

    const sttEnvName = providerEnvVar(sttProvider);
    const sttEnvValue = sttEnvName ? process.env[sttEnvName] : undefined;

    if (sttEnvValue) {
      const useEnv = await c.confirm({
        message: `${sttEnvName} detected in environment. Use it for STT?`,
        initialValue: true,
      });
      if (isCancel(useEnv)) {
        c.outro("Setup cancelled.");
        return;
      }
      if (!useEnv) {
        const keyResult = (await c.text({
          message: `API key for ${STT_META[sttProvider].label} STT`,
          placeholder: "sk-...",
        })) as string | symbol;
        if (isCancel(keyResult)) {
          c.outro("Setup cancelled.");
          return;
        }
        sttApiKey = keyResult;
      }
    } else {
      const keyResult = (await c.text({
        message: `API key for ${STT_META[sttProvider].label} STT`,
        placeholder: "sk-...",
      })) as string | symbol;
      if (isCancel(keyResult)) {
        c.outro("Setup cancelled.");
        return;
      }
      sttApiKey = keyResult;
    }
  }

  // -- TTS ----------------------------------------------------------------

  let ttsProvider: TtsProvider;
  let ttsModel: string;
  let ttsVoice: string;
  let ttsApiKey: string = "";

  const hasTtsConfig = !!(existing.tts?.provider && existing.tts?.model);

  if (hasTtsConfig) {
    await c.log.info(
      `  Current TTS: ${existing.tts!.provider} / ${existing.tts!.model}` +
        (existing.tts!.voice ? ` (voice: ${existing.tts!.voice})` : ""),
    );
    const reconfigureTts = await c.confirm({
      message: "Reconfigure Text-to-Speech?",
      initialValue: false,
    });
    if (isCancel(reconfigureTts)) {
      c.outro("Setup cancelled.");
      return;
    }
    if (!reconfigureTts) {
      ttsProvider = existing.tts!.provider as TtsProvider;
      ttsModel = existing.tts!.model!;
      ttsVoice = existing.tts!.voice ?? TTS_META[ttsProvider].defaultVoice;
      ttsApiKey = existing.tts!.apiKey ?? "";
    }
  }

  if (!hasTtsConfig || !ttsModel!) {
    const ttsProviderResult = (await c.select({
      message: "Text-to-Speech provider",
      options: TTS_PROVIDERS.map((id) => ({
        value: id,
        label: `${TTS_META[id].label}`,
        hint: providerEnvVar(id) ?? "",
      })),
      initialValue: (existing.tts?.provider as TtsProvider) ?? ("openai" as TtsProvider),
    })) as TtsProvider | symbol;

    if (isCancel(ttsProviderResult)) {
      c.outro("Setup cancelled.");
      return;
    }
    ttsProvider = ttsProviderResult;

    const ttsModelResult = (await c.text({
      message: `TTS model for ${TTS_META[ttsProvider].label}`,
      initialValue: existing.tts?.model ?? TTS_META[ttsProvider].defaultModel,
      placeholder: TTS_META[ttsProvider].defaultModel,
    })) as string | symbol;

    if (isCancel(ttsModelResult)) {
      c.outro("Setup cancelled.");
      return;
    }
    ttsModel = ttsModelResult;

    const ttsVoiceResult = (await c.text({
      message: `Voice name for ${TTS_META[ttsProvider].label}`,
      initialValue: existing.tts?.voice ?? TTS_META[ttsProvider].defaultVoice,
      placeholder: TTS_META[ttsProvider].defaultVoice,
    })) as string | symbol;

    if (isCancel(ttsVoiceResult)) {
      c.outro("Setup cancelled.");
      return;
    }
    ttsVoice = ttsVoiceResult;

    const ttsEnvName = providerEnvVar(ttsProvider);
    const ttsEnvValue = ttsEnvName ? process.env[ttsEnvName] : undefined;

    // If same provider as STT, offer to reuse the key.
    if (sttProvider === ttsProvider && sttApiKey) {
      const reuse = await c.confirm({
        message: `Reuse the same ${STT_META[sttProvider].label} key for TTS?`,
        initialValue: true,
      });
      if (isCancel(reuse)) {
        c.outro("Setup cancelled.");
        return;
      }
      if (reuse) {
        ttsApiKey = sttApiKey;
      }
    }

    if (!ttsApiKey) {
      if (ttsEnvValue) {
        const useEnv = await c.confirm({
          message: `${ttsEnvName} detected in environment. Use it for TTS?`,
          initialValue: true,
        });
        if (isCancel(useEnv)) {
          c.outro("Setup cancelled.");
          return;
        }
        if (!useEnv) {
          const keyResult = (await c.text({
            message: `API key for ${TTS_META[ttsProvider].label} TTS`,
            placeholder: "sk-...",
          })) as string | symbol;
          if (isCancel(keyResult)) {
            c.outro("Setup cancelled.");
            return;
          }
          ttsApiKey = keyResult;
        }
      } else {
        const keyResult = (await c.text({
          message: `API key for ${TTS_META[ttsProvider].label} TTS`,
          placeholder: "sk-...",
        })) as string | symbol;
        if (isCancel(keyResult)) {
          c.outro("Setup cancelled.");
          return;
        }
        ttsApiKey = keyResult;
      }
    }
  }

  // -- LLM ----------------------------------------------------------------

  let llmProvider: LlmProvider;
  let llmModel: string;
  let llmApiKey: string = "";

  const hasLlmConfig = !!(existing.llm?.provider && existing.llm?.model);

  if (hasLlmConfig) {
    await c.log.info(`  Current LLM: ${existing.llm!.provider} / ${existing.llm!.model}`);
    const reconfigureLlm = await c.confirm({
      message: "Reconfigure LLM (voice agent reasoning)?",
      initialValue: false,
    });
    if (isCancel(reconfigureLlm)) {
      c.outro("Setup cancelled.");
      return;
    }
    if (!reconfigureLlm) {
      llmProvider = existing.llm!.provider as LlmProvider;
      llmModel = existing.llm!.model!;
      llmApiKey = existing.llm!.apiKey ?? "";
    }
  }

  if (!hasLlmConfig || !llmModel!) {
    const llmProviderResult = (await c.select({
      message: "LLM provider (for voice agent reasoning)",
      options: LLM_PROVIDERS.map((id) => ({
        value: id,
        label: `${LLM_META[id].label}`,
        hint: providerEnvVar(id) ?? "",
      })),
      initialValue: (existing.llm?.provider as LlmProvider) ?? ("openai" as LlmProvider),
    })) as LlmProvider | symbol;

    if (isCancel(llmProviderResult)) {
      c.outro("Setup cancelled.");
      return;
    }
    llmProvider = llmProviderResult;

    const llmModelResult = (await c.text({
      message: `LLM model for ${LLM_META[llmProvider].label}`,
      initialValue: existing.llm?.model ?? LLM_META[llmProvider].defaultModel,
      placeholder: LLM_META[llmProvider].defaultModel,
    })) as string | symbol;

    if (isCancel(llmModelResult)) {
      c.outro("Setup cancelled.");
      return;
    }
    llmModel = llmModelResult;

    const llmEnvName = providerEnvVar(llmProvider);
    const llmEnvValue = llmEnvName ? process.env[llmEnvName] : undefined;

    // Offer reuse if same provider as STT or TTS.
    const sameAsSTT = llmProvider === sttProvider && sttApiKey;
    const sameAsTTS = llmProvider === ttsProvider && ttsApiKey;

    if (sameAsSTT || sameAsTTS) {
      const reuse = await c.confirm({
        message: `Reuse the same ${LLM_META[llmProvider].label} key for LLM?`,
        initialValue: true,
      });
      if (isCancel(reuse)) {
        c.outro("Setup cancelled.");
        return;
      }
      if (reuse) {
        llmApiKey = sameAsSTT ? sttApiKey : ttsApiKey;
      }
    }

    if (!llmApiKey) {
      if (llmEnvValue) {
        const useEnv = await c.confirm({
          message: `${llmEnvName} detected in environment. Use it for LLM?`,
          initialValue: true,
        });
        if (isCancel(useEnv)) {
          c.outro("Setup cancelled.");
          return;
        }
        if (!useEnv) {
          const keyResult = (await c.text({
            message: `API key for ${LLM_META[llmProvider].label} LLM`,
            placeholder: "sk-...",
          })) as string | symbol;
          if (isCancel(keyResult)) {
            c.outro("Setup cancelled.");
            return;
          }
          llmApiKey = keyResult;
        }
      } else {
        const keyResult = (await c.text({
          message: `API key for ${LLM_META[llmProvider].label} LLM`,
          placeholder: "sk-...",
        })) as string | symbol;
        if (isCancel(keyResult)) {
          c.outro("Setup cancelled.");
          return;
        }
        llmApiKey = keyResult;
      }
    }
  }

  // -- LiveKit (optional) --------------------------------------------------

  let livekitUrl = existing.livekit?.url ?? "";
  let livekitApiKey = existing.livekit?.apiKey ?? "";
  let livekitApiSecret = existing.livekit?.apiSecret ?? "";

  const hasLivekitConfig = !!existing.livekit?.url;

  if (hasLivekitConfig) {
    await c.log.info(`  Current LiveKit: ${existing.livekit!.url}`);
  }

  const configureLivekit = await c.confirm({
    message: hasLivekitConfig
      ? "Reconfigure LiveKit connection?"
      : "Configure LiveKit connection? (skip for local dev defaults)",
    initialValue: false,
  });

  if (isCancel(configureLivekit)) {
    c.outro("Setup cancelled.");
    return;
  }

  if (configureLivekit) {
    const url = await c.text({
      message: "LiveKit server URL",
      initialValue: existing.livekit?.url ?? "ws://localhost:7880",
      placeholder: "wss://your-livekit.livekit.cloud",
    });
    if (isCancel(url)) {
      c.outro("Setup cancelled.");
      return;
    }
    livekitUrl = url as string;

    const key = await c.text({
      message: "LiveKit API Key",
      placeholder: "APIxxxxx",
    });
    if (isCancel(key)) {
      c.outro("Setup cancelled.");
      return;
    }
    livekitApiKey = key as string;

    const secret = await c.text({
      message: "LiveKit API Secret",
      placeholder: "secret",
    });
    if (isCancel(secret)) {
      c.outro("Setup cancelled.");
      return;
    }
    livekitApiSecret = secret as string;
  }

  // -- Tunnel (remote access) ----------------------------------------------

  const { getTailscaleStatus, installTailscale, loginTailscale } = await import("./tunnel.js");
  let tsStatus = await getTailscaleStatus();

  let tunnelProvider: TunnelProvider = "none";

  // Step 1: Install Tailscale if missing.
  if (!tsStatus.installed) {
    const wantInstall = await c.confirm({
      message: "Tailscale is not installed. Install it now for remote access? (requires sudo)",
      initialValue: true,
    });

    if (isCancel(wantInstall)) {
      c.outro("Setup cancelled.");
      return;
    }

    if (wantInstall) {
      await c.log.step("Installing Tailscale (you may be prompted for your sudo password)...");

      const result = await installTailscale();

      if (result.success) {
        await c.log.success("Tailscale installed ✓");
        // Re-check status after install.
        tsStatus = await getTailscaleStatus();
      } else {
        await c.log.warn("Tailscale installation failed: " + result.message);
      }
    } else {
      await c.log.info(
        "Skipped — voice will be LAN-only. You can install later: https://tailscale.com/download",
      );
    }
  }

  // Step 2: Login if installed but not logged in.
  if (tsStatus.installed && !tsStatus.loggedIn) {
    const wantLogin = await c.confirm({
      message: "Tailscale is installed but not logged in. Log in now? (requires sudo)",
      initialValue: true,
    });

    if (isCancel(wantLogin)) {
      c.outro("Setup cancelled.");
      return;
    }

    if (wantLogin) {
      await c.log.step(
        "Running `sudo tailscale up` — follow the instructions below to authenticate.",
      );

      const loginResult = await loginTailscale();

      if (loginResult.success) {
        await c.log.success("Tailscale login successful ✓");
        tsStatus = await getTailscaleStatus();
      } else {
        await c.log.warn(
          "Tailscale login did not complete.\n" + "You can retry later with: sudo tailscale up",
        );
      }
    }
  }

  // Step 3: Offer Funnel if logged in.
  if (tsStatus.installed && tsStatus.loggedIn) {
    await c.log.success(`Tailscale connected — logged in as ${tsStatus.dnsName}`);

    const enableTunnel = await c.confirm({
      message:
        "Enable Tailscale Funnel? This makes /voice accessible from the internet (phone, etc.)",
      initialValue: true,
    });

    if (isCancel(enableTunnel)) {
      c.outro("Setup cancelled.");
      return;
    }

    if (enableTunnel) {
      tunnelProvider = "tailscale-funnel";
      await c.log.info(
        [
          "",
          "  Tailscale Funnel will expose two ports:",
          "    443  → OpenClaw gateway (serves /voice web UI)",
          "    8443 → LiveKit (WebRTC signaling)",
          "",
          `  Public URL: https://${tsStatus.dnsName}/voice`,
          "",
        ].join("\n"),
      );
    }
  }

  // -- Save ---------------------------------------------------------------

  const s = c.spinner();
  s.start("Saving configuration...");

  try {
    const entries: Record<string, unknown> = {
      enabled: true,
      "voiceAgent.stt.provider": sttProvider,
      "voiceAgent.stt.model": String(sttModel),
      "voiceAgent.tts.provider": ttsProvider,
      "voiceAgent.tts.model": String(ttsModel),
      "voiceAgent.tts.voice": String(ttsVoice),
      "voiceAgent.llm.provider": llmProvider,
      "voiceAgent.llm.model": String(llmModel),
    };
    if (sttApiKey) entries["voiceAgent.stt.apiKey"] = String(sttApiKey);
    if (sttLanguage) entries["voiceAgent.stt.language"] = String(sttLanguage);
    if (ttsApiKey) entries["voiceAgent.tts.apiKey"] = String(ttsApiKey);
    if (llmApiKey) entries["voiceAgent.llm.apiKey"] = String(llmApiKey);
    if (livekitUrl) entries["livekit.url"] = livekitUrl;
    if (livekitApiKey) entries["livekit.apiKey"] = livekitApiKey;
    if (livekitApiSecret) entries["livekit.apiSecret"] = livekitApiSecret;

    // Tunnel config.
    entries["tunnel.provider"] = tunnelProvider;

    saveConfig(entries);

    s.stop("Configuration saved.");
  } catch (err) {
    s.stop("Failed to save configuration.");
    deps.logger.error(
      `[stimm-voice] Config save error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  // -- Summary ------------------------------------------------------------

  await c.log.info(
    [
      "",
      "  STT:  " + STT_META[sttProvider].label + " / " + sttModel,
      "  TTS:  " + TTS_META[ttsProvider].label + " / " + ttsModel + " (voice: " + ttsVoice + ")",
      "  LLM:  " + LLM_META[llmProvider].label + " / " + llmModel,
      livekitUrl ? "  LiveKit: " + livekitUrl : "  LiveKit: localhost:7880 (dev default)",
      tunnelProvider === "tailscale-funnel"
        ? `  Tunnel: Tailscale Funnel (${tsStatus.dnsName})`
        : "  Tunnel: none (LAN-only)",
      "",
    ].join("\n"),
  );

  const outroUrl =
    tunnelProvider === "tailscale-funnel" && tsStatus.dnsName
      ? `https://${tsStatus.dnsName}/voice`
      : "http://localhost:<port>/voice";

  c.outro(
    "Setup complete! Start a voice session with: openclaw voice:start\n" +
      `Or open the web UI at: ${outroUrl}`,
  );
}
