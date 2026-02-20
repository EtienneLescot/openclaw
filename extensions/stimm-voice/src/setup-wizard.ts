/**
 * Interactive setup wizard for the stimm-voice plugin.
 *
 * Prompts the user for provider choices, API keys, and LiveKit config.
 * Saves results via `openclaw config set` commands.
 *
 * Usage: `openclaw voice:setup`
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  STT_PROVIDERS,
  TTS_PROVIDERS,
  LLM_PROVIDERS,
  providerEnvVar,
  type SttProvider,
  type TtsProvider,
  type LlmProvider,
} from "./config.js";

// ---------------------------------------------------------------------------
// Config writer — shells out to `openclaw config set` for safety.
// ---------------------------------------------------------------------------

const CONFIG_PREFIX = "plugins.entries.stimm-voice.config";

function setConfig(key: string, value: string): void {
  const full = `${CONFIG_PREFIX}.${key}`;
  execSync(`openclaw config set ${full} ${JSON.stringify(value)}`, {
    stdio: "inherit",
  });
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

  // -- STT ----------------------------------------------------------------

  const sttProvider = (await c.select({
    message: "Speech-to-Text provider",
    options: STT_PROVIDERS.map((id) => ({
      value: id,
      label: `${STT_META[id].label}`,
      hint: providerEnvVar(id) ?? "",
    })),
    initialValue: "deepgram" as SttProvider,
  })) as SttProvider | symbol;

  if (isCancel(sttProvider)) {
    c.outro("Setup cancelled.");
    return;
  }

  const sttModel = (await c.text({
    message: `STT model for ${STT_META[sttProvider].label}`,
    initialValue: STT_META[sttProvider].defaultModel,
    placeholder: STT_META[sttProvider].defaultModel,
  })) as string | symbol;

  if (isCancel(sttModel)) {
    c.outro("Setup cancelled.");
    return;
  }

  const sttEnvName = providerEnvVar(sttProvider);
  const sttEnvValue = sttEnvName ? process.env[sttEnvName] : undefined;
  let sttApiKey: string | symbol = "";

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
      sttApiKey = (await c.text({
        message: `API key for ${STT_META[sttProvider].label} STT`,
        placeholder: "sk-...",
      })) as string | symbol;
    }
  } else {
    sttApiKey = (await c.text({
      message: `API key for ${STT_META[sttProvider].label} STT`,
      placeholder: "sk-...",
    })) as string | symbol;
  }

  if (isCancel(sttApiKey)) {
    c.outro("Setup cancelled.");
    return;
  }

  // -- TTS ----------------------------------------------------------------

  const ttsProvider = (await c.select({
    message: "Text-to-Speech provider",
    options: TTS_PROVIDERS.map((id) => ({
      value: id,
      label: `${TTS_META[id].label}`,
      hint: providerEnvVar(id) ?? "",
    })),
    initialValue: "openai" as TtsProvider,
  })) as TtsProvider | symbol;

  if (isCancel(ttsProvider)) {
    c.outro("Setup cancelled.");
    return;
  }

  const ttsModel = (await c.text({
    message: `TTS model for ${TTS_META[ttsProvider].label}`,
    initialValue: TTS_META[ttsProvider].defaultModel,
    placeholder: TTS_META[ttsProvider].defaultModel,
  })) as string | symbol;

  if (isCancel(ttsModel)) {
    c.outro("Setup cancelled.");
    return;
  }

  const ttsVoice = (await c.text({
    message: `Voice name for ${TTS_META[ttsProvider].label}`,
    initialValue: TTS_META[ttsProvider].defaultVoice,
    placeholder: TTS_META[ttsProvider].defaultVoice,
  })) as string | symbol;

  if (isCancel(ttsVoice)) {
    c.outro("Setup cancelled.");
    return;
  }

  const ttsEnvName = providerEnvVar(ttsProvider);
  const ttsEnvValue = ttsEnvName ? process.env[ttsEnvName] : undefined;
  let ttsApiKey: string | symbol = "";

  // If same provider as STT, offer to reuse the key.
  if (sttProvider === ttsProvider && (sttApiKey || sttEnvValue)) {
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
        ttsApiKey = (await c.text({
          message: `API key for ${TTS_META[ttsProvider].label} TTS`,
          placeholder: "sk-...",
        })) as string | symbol;
      }
    } else {
      ttsApiKey = (await c.text({
        message: `API key for ${TTS_META[ttsProvider].label} TTS`,
        placeholder: "sk-...",
      })) as string | symbol;
    }
  }

  if (isCancel(ttsApiKey)) {
    c.outro("Setup cancelled.");
    return;
  }

  // -- LLM ----------------------------------------------------------------

  const llmProvider = (await c.select({
    message: "LLM provider (for voice agent reasoning)",
    options: LLM_PROVIDERS.map((id) => ({
      value: id,
      label: `${LLM_META[id].label}`,
      hint: providerEnvVar(id) ?? "",
    })),
    initialValue: "openai" as LlmProvider,
  })) as LlmProvider | symbol;

  if (isCancel(llmProvider)) {
    c.outro("Setup cancelled.");
    return;
  }

  const llmModel = (await c.text({
    message: `LLM model for ${LLM_META[llmProvider].label}`,
    initialValue: LLM_META[llmProvider].defaultModel,
    placeholder: LLM_META[llmProvider].defaultModel,
  })) as string | symbol;

  if (isCancel(llmModel)) {
    c.outro("Setup cancelled.");
    return;
  }

  const llmEnvName = providerEnvVar(llmProvider);
  const llmEnvValue = llmEnvName ? process.env[llmEnvName] : undefined;
  let llmApiKey: string | symbol = "";

  // Offer reuse if same provider as STT or TTS.
  const sameAsSTT = llmProvider === sttProvider && (sttApiKey || sttEnvValue);
  const sameAsTTS = llmProvider === ttsProvider && (ttsApiKey || ttsEnvValue);

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
      llmApiKey = sameAsSTT ? (sttApiKey as string) : (ttsApiKey as string);
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
        llmApiKey = (await c.text({
          message: `API key for ${LLM_META[llmProvider].label} LLM`,
          placeholder: "sk-...",
        })) as string | symbol;
      }
    } else {
      llmApiKey = (await c.text({
        message: `API key for ${LLM_META[llmProvider].label} LLM`,
        placeholder: "sk-...",
      })) as string | symbol;
    }
  }

  if (isCancel(llmApiKey)) {
    c.outro("Setup cancelled.");
    return;
  }

  // -- LiveKit (optional) --------------------------------------------------

  const configureLivekit = await c.confirm({
    message: "Configure LiveKit connection? (skip for local dev defaults)",
    initialValue: false,
  });

  if (isCancel(configureLivekit)) {
    c.outro("Setup cancelled.");
    return;
  }

  let livekitUrl = "";
  let livekitApiKey = "";
  let livekitApiSecret = "";

  if (configureLivekit) {
    const url = await c.text({
      message: "LiveKit server URL",
      initialValue: "ws://localhost:7880",
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

  // -- Save ---------------------------------------------------------------

  const s = c.spinner();
  s.start("Saving configuration...");

  try {
    setConfig("enabled", "true");
    setConfig("voiceAgent.stt.provider", sttProvider);
    setConfig("voiceAgent.stt.model", String(sttModel));
    if (sttApiKey) setConfig("voiceAgent.stt.apiKey", String(sttApiKey));
    setConfig("voiceAgent.tts.provider", ttsProvider);
    setConfig("voiceAgent.tts.model", String(ttsModel));
    setConfig("voiceAgent.tts.voice", String(ttsVoice));
    if (ttsApiKey) setConfig("voiceAgent.tts.apiKey", String(ttsApiKey));
    setConfig("voiceAgent.llm.provider", llmProvider);
    setConfig("voiceAgent.llm.model", String(llmModel));
    if (llmApiKey) setConfig("voiceAgent.llm.apiKey", String(llmApiKey));

    if (livekitUrl) setConfig("livekit.url", livekitUrl);
    if (livekitApiKey) setConfig("livekit.apiKey", livekitApiKey);
    if (livekitApiSecret) setConfig("livekit.apiSecret", livekitApiSecret);

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
      "",
    ].join("\n"),
  );

  c.outro(
    "Setup complete! Start a voice session with: openclaw voice:start\n" +
      "Or open the web UI at: http://localhost:<port>/voice",
  );
}
