/**
 * Interactive setup wizard for the stimm-voice plugin.
 *
 * Quick Tunnel only: no Tailscale legacy path.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ACCESS_MODES,
  LLM_PROVIDERS,
  STT_PROVIDERS,
  TTS_PROVIDERS,
  providerEnvVar,
  type AccessMode,
  type LlmProvider,
  type SttProvider,
  type TtsProvider,
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
  tts?: { provider?: string; model?: string; voice?: string; language?: string; apiKey?: string };
  llm?: { provider?: string; model?: string; apiKey?: string };
  livekit?: { url?: string; apiKey?: string; apiSecret?: string };
  access?: { mode?: string; supervisorSecret?: string };
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
      access: base.access as ExistingConfig["access"],
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
    google: { label: "Google Cloud", defaultModel: "Standard", defaultVoice: "en-US-Standard-A" },
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

const STT_MODEL_OPTIONS: Record<SttProvider, string[]> = {
  deepgram: ["nova-3", "nova-2"],
  openai: ["gpt-4o-mini-transcribe", "gpt-4o-transcribe", "whisper-1"],
  google: ["latest_long", "latest_short", "chirp", "chirp_2"],
  azure: ["en-US", "fr-FR", "de-DE"],
  assemblyai: ["best", "nano"],
  aws: ["default"],
  speechmatics: ["enhanced"],
  clova: ["default"],
  fal: ["default"],
};

const TTS_MODEL_OPTIONS: Record<TtsProvider, string[]> = {
  openai: ["gpt-4o-mini-tts", "gpt-4o-audio-preview"],
  elevenlabs: ["eleven_turbo_v2_5", "eleven_multilingual_v2", "eleven_flash_v2_5"],
  cartesia: ["sonic-2", "sonic-english", "sonic-multilingual"],
  google: ["gemini-2.5-flash-preview-tts", "gemini-2.0-flash-exp", "Standard"],
  azure: ["en-US-JennyNeural", "fr-FR-DeniseNeural"],
  aws: ["standard", "neural", "generative"],
  playai: ["dialog"],
  rime: ["arcana"],
};

const LLM_MODEL_OPTIONS: Record<LlmProvider, string[]> = {
  openai: ["gpt-4o-mini", "gpt-4.1-mini", "gpt-4.1", "gpt-4o"],
  anthropic: ["claude-sonnet-4-20250514", "claude-3-7-sonnet-latest", "claude-3-5-haiku-latest"],
  google: ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-pro"],
  groq: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768"],
  azure: ["gpt-4o-mini", "gpt-4o"],
  cerebras: ["llama-3.3-70b"],
  fireworks: ["llama-v3p3-70b-instruct", "qwen3-235b-a22b"],
  together: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "deepseek-ai/DeepSeek-V3"],
  sambanova: ["Meta-Llama-3.3-70B-Instruct", "DeepSeek-R1"],
};

// ---------------------------------------------------------------------------
// cloudflared helpers (Quick Tunnel).
// ---------------------------------------------------------------------------

function detectCloudflared(): { installed: boolean; version?: string } {
  const probe = spawnSync("cloudflared", ["--version"], { encoding: "utf8" });
  if (probe.status !== 0) return { installed: false };
  const out = `${probe.stdout ?? ""} ${probe.stderr ?? ""}`.trim();
  const line = out.split("\n").find((l) => l.toLowerCase().includes("cloudflared")) ?? out;
  return { installed: true, version: line.trim() || undefined };
}

function runCommandWithInheritedStdio(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; code: number }> {
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(cmd, args, { stdio: "inherit" });
    } catch {
      resolve({ ok: false, code: -1 });
      return;
    }
    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code });
    };
    proc.on("error", () => finish(-1));
    proc.on("close", (code) => finish(code ?? -1));
    const timer = setTimeout(() => {
      if (!done) {
        proc.kill("SIGKILL");
        finish(-1);
      }
    }, timeoutMs);
  });
}

async function installCloudflared(): Promise<{ ok: boolean; message: string }> {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "darwin") {
    const hasBrew = spawnSync("brew", ["--version"], { stdio: "ignore" }).status === 0;
    if (!hasBrew) {
      return { ok: false, message: "Homebrew is required on macOS for automatic install." };
    }
    const res = await runCommandWithInheritedStdio("brew", ["install", "cloudflared"], 180_000);
    return res.ok
      ? { ok: true, message: "cloudflared installed via Homebrew." }
      : { ok: false, message: `brew install failed (exit ${res.code}).` };
  }

  if (platform === "linux") {
    const binUrl =
      arch === "arm64"
        ? "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64"
        : "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64";
    const cmd =
      `curl -fsSL ${JSON.stringify(binUrl)} -o /tmp/cloudflared && ` +
      "chmod +x /tmp/cloudflared && sudo mv /tmp/cloudflared /usr/local/bin/cloudflared";
    const res = await runCommandWithInheritedStdio("sh", ["-c", cmd], 180_000);
    return res.ok
      ? { ok: true, message: "cloudflared installed to /usr/local/bin/cloudflared." }
      : { ok: false, message: `install command failed (exit ${res.code}).` };
  }

  return { ok: false, message: `Automatic install not supported on ${platform}.` };
}

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

type ModelLane = "stt" | "tts" | "llm";

function uniq(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function filterModelsForLane(models: string[], lane: ModelLane, provider: string): string[] {
  if (provider === "openai") {
    if (lane === "stt") {
      return models.filter((id) => /transcribe|whisper/i.test(id));
    }
    if (lane === "tts") {
      return models.filter((id) => /tts|audio/i.test(id));
    }
    return models.filter((id) => !/transcribe|whisper/i.test(id));
  }

  if (provider === "google") {
    if (lane === "tts") {
      return models.filter((id) => /tts|speech/i.test(id));
    }
    if (lane === "stt") {
      return models.filter((id) => /chirp|speech/i.test(id));
    }
  }

  return models;
}

async function fetchJson(
  url: string,
  init: RequestInit = {},
  timeoutMs = 10_000,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

function getLiveKitDocsPluginUrl(lane: ModelLane, provider: string): string {
  return `https://docs.livekit.io/agents/models/${lane}/plugins/${provider}`;
}

function extractModelLikeTokens(raw: string): string[] {
  const tokens = new Set<string>();
  const quoteRegex = /["'`]([A-Za-z0-9._\-/:]{3,120})["'`]/g;
  let match: RegExpExecArray | null;
  while ((match = quoteRegex.exec(raw)) !== null) {
    const value = match[1] ?? "";
    if (!value) continue;
    if (/^https?:\/\//i.test(value)) continue;
    if (/^(true|false|null|undefined)$/i.test(value)) continue;
    if (!/[a-z]/i.test(value)) continue;
    if (!/[0-9]|-|\//.test(value)) continue;
    tokens.add(value);
  }
  return [...tokens];
}

function extractVoiceLikeTokens(raw: string): string[] {
  const tokens = new Set<string>();
  const regexes = [
    /voice(?:_id|_name)?\s*[:=]\s*["'`]([^"'`]{2,120})["'`]/gi,
    /speaker\s*[:=]\s*["'`]([^"'`]{2,120})["'`]/gi,
  ];
  for (const regex of regexes) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(raw)) !== null) {
      const value = (match[1] ?? "").trim();
      if (!value) continue;
      tokens.add(value);
    }
  }
  return [...tokens];
}

function extractLanguageLikeTokens(raw: string): string[] {
  const tokens = new Set<string>();
  const regexes = [
    /languages?\s*[:=]\s*\[\s*["'`]([^"'`]{2,20})["'`]/gi,
    /languages?\s*[:=]\s*["'`]([^"'`]{2,20})["'`]/gi,
    /\b([a-z]{2}-[A-Z]{2})\b/g,
  ];
  for (const regex of regexes) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(raw)) !== null) {
      const value = (match[1] ?? "").trim();
      if (!value) continue;
      tokens.add(value);
    }
  }
  return [...tokens];
}

async function fetchModelsFromLiveKitDocs(lane: ModelLane, provider: string): Promise<string[]> {
  const url = getLiveKitDocsPluginUrl(lane, provider);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return [];
    const html = await response.text();
    const extracted = extractModelLikeTokens(html);
    return filterModelsForLane(uniq(extracted), lane, provider).slice(0, 80);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchVoicesFromLiveKitDocs(lane: ModelLane, provider: string): Promise<string[]> {
  const url = getLiveKitDocsPluginUrl(lane, provider);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return [];
    const html = await response.text();
    return uniq(extractVoiceLikeTokens(html)).slice(0, 80);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLanguagesFromLiveKitDocs(lane: ModelLane, provider: string): Promise<string[]> {
  const url = getLiveKitDocsPluginUrl(lane, provider);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return [];
    const html = await response.text();
    return uniq(extractLanguageLikeTokens(html)).slice(0, 80);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOpenAICompatibleModels(params: {
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
}): Promise<string[]> {
  const base = params.baseUrl.replace(/\/$/, "");
  const json = (await fetchJson(`${base}/v1/models`, {
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      ...(params.headers ?? {}),
    },
  })) as { data?: Array<{ id?: string }> };
  return uniq((json.data ?? []).map((item) => item.id ?? ""));
}

async function fetchProviderModels(params: {
  lane: ModelLane;
  provider: string;
  apiKey: string;
}): Promise<string[]> {
  const { lane, provider, apiKey } = params;
  const key = apiKey.trim();
  if (!key) return [];

  let providerModels: string[] = [];

  try {
    if (provider === "openai") {
      const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com";
      providerModels = await fetchOpenAICompatibleModels({ baseUrl, apiKey: key });
    } else if (provider === "groq" && lane === "llm") {
      providerModels = await fetchOpenAICompatibleModels({
        baseUrl: "https://api.groq.com/openai",
        apiKey: key,
      });
    } else if (provider === "anthropic" && lane === "llm") {
      const json = (await fetchJson("https://api.anthropic.com/v1/models", {
        headers: {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
      })) as { data?: Array<{ id?: string }> };
      providerModels = uniq((json.data ?? []).map((item) => item.id ?? ""));
    } else if (provider === "google") {
      const json = (await fetchJson(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
      )) as { models?: Array<{ name?: string }> };
      providerModels = uniq(
        (json.models ?? []).map((item) => {
          const name = item.name ?? "";
          return name.startsWith("models/") ? name.slice("models/".length) : name;
        }),
      );
    } else if (provider === "elevenlabs" && lane === "tts") {
      const json = (await fetchJson("https://api.elevenlabs.io/v1/models", {
        headers: { "xi-api-key": key },
      })) as Array<{ model_id?: string }>;
      providerModels = uniq((json ?? []).map((item) => item.model_id ?? ""));
    } else if (provider === "cerebras" && lane === "llm") {
      providerModels = await fetchOpenAICompatibleModels({
        baseUrl: "https://api.cerebras.ai",
        apiKey: key,
      });
    } else if (provider === "fireworks" && lane === "llm") {
      providerModels = await fetchOpenAICompatibleModels({
        baseUrl: "https://api.fireworks.ai/inference",
        apiKey: key,
      });
    } else if (provider === "together" && lane === "llm") {
      providerModels = await fetchOpenAICompatibleModels({
        baseUrl: "https://api.together.xyz",
        apiKey: key,
      });
    } else if (provider === "sambanova" && lane === "llm") {
      providerModels = await fetchOpenAICompatibleModels({
        baseUrl: "https://api.sambanova.ai",
        apiKey: key,
      });
    } else if (provider === "deepgram" && lane === "stt") {
      const json = (await fetchJson("https://api.deepgram.com/v1/projects", {
        headers: { Authorization: `Token ${key}` },
      })) as { projects?: unknown[] };
      if (Array.isArray(json.projects)) {
        providerModels = ["nova-3", "nova-2", "base", "enhanced"]; // Deepgram API has no direct model catalog endpoint.
      }
    }
  } catch {
    providerModels = [];
  }

  const filtered = filterModelsForLane(uniq(providerModels), lane, provider);
  if (filtered.length > 0) {
    return filtered;
  }

  // Fallback for providers without usable model listing APIs: derive options from LiveKit plugin docs.
  return fetchModelsFromLiveKitDocs(lane, provider);
}

type ProviderCatalog = {
  models: string[];
  voices: string[];
  languages: string[];
};

async function fetchProviderCatalog(params: {
  lane: ModelLane;
  provider: string;
  apiKey: string;
}): Promise<ProviderCatalog> {
  const { lane, provider, apiKey } = params;
  const models = await fetchProviderModels({ lane, provider, apiKey });
  let voices: string[] = [];
  let languages: string[] = [];

  try {
    if (lane === "tts" && provider === "elevenlabs" && apiKey.trim()) {
      const json = (await fetchJson("https://api.elevenlabs.io/v1/voices", {
        headers: { "xi-api-key": apiKey.trim() },
      })) as { voices?: Array<{ voice_id?: string; name?: string }> };
      voices = uniq((json.voices ?? []).flatMap((item) => [item.voice_id ?? "", item.name ?? ""]));
    }
  } catch {
    voices = [];
  }

  if (voices.length === 0 && lane === "tts") {
    voices = await fetchVoicesFromLiveKitDocs(lane, provider);
  }

  if (lane === "stt" || lane === "tts") {
    languages = await fetchLanguagesFromLiveKitDocs(lane, provider);
  }

  return {
    models: uniq(models),
    voices: uniq(voices),
    languages: uniq(languages),
  };
}

async function promptModelWithChoices(params: {
  c: Clack;
  lane: ModelLane;
  provider: string;
  message: string;
  options: string[];
  initialValue: string;
  placeholder: string;
}): Promise<string | symbol> {
  const { c, message, initialValue, placeholder } = params;
  const currentOptions = uniq(params.options);
  const modelChoice = (await c.select({
    message,
    options: [
      ...currentOptions.map((value) => ({ value, label: value })),
      { value: "__custom__", label: "Custom model…" },
    ],
    initialValue: currentOptions.includes(initialValue) ? initialValue : "__custom__",
  })) as string | symbol;

  if (isCancel(modelChoice)) return modelChoice;
  if (modelChoice !== "__custom__") return modelChoice;

  return c.text({
    message: "Custom model name",
    initialValue,
    placeholder,
  }) as Promise<string | symbol>;
}

async function promptTextOrChoice(params: {
  c: Clack;
  message: string;
  options: string[];
  initialValue: string;
  placeholder: string;
  customLabel?: string;
  allowEmpty?: boolean;
}): Promise<string | symbol> {
  const { c, message, options, initialValue, placeholder, customLabel, allowEmpty } = params;
  const values = uniq(options);
  const selection = (await c.select({
    message,
    options: [
      ...(allowEmpty ? [{ value: "__empty__", label: "Use provider default" }] : []),
      ...values.map((value) => ({ value, label: value })),
      { value: "__custom__", label: customLabel ?? "Custom value…" },
    ],
    initialValue: values.includes(initialValue) ? initialValue : "__custom__",
  })) as string | symbol;

  if (isCancel(selection)) return selection;
  if (selection === "__empty__") return "";
  if (selection !== "__custom__") return selection;

  return c.text({
    message,
    initialValue,
    placeholder,
  }) as Promise<string | symbol>;
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

  // Load existing config to allow skipping sections.
  const existing = loadExistingConfig();

  // -- Check Python venv ---------------------------------------------------

  const venvPath = join(deps.extensionDir, "python", ".venv", "bin", "python");
  if (existsSync(venvPath)) {
    await c.log.success("Python virtual environment found.");
  } else {
    await c.log.warn(
      "Python virtual environment not found. It will be auto-created on first gateway start.",
    );
  }

  // -- cloudflared ---------------------------------------------------------

  const cloudflared = detectCloudflared();
  if (cloudflared.installed) {
    await c.log.success(`cloudflared detected: ${cloudflared.version ?? "installed"}`);
  } else {
    await c.log.warn("cloudflared is not installed (required for access.mode=quick-tunnel).");
    const installNow = await c.confirm({
      message: "Install cloudflared now? (recommended)",
      initialValue: true,
    });
    if (isCancel(installNow)) return c.outro("Setup cancelled.");
    if (installNow) {
      await c.log.step("Installing cloudflared (you may be prompted for sudo password)...");
      const result = await installCloudflared();
      if (!result.ok) {
        await c.log.warn(`Automatic install failed: ${result.message}`);
      }
      const verify = detectCloudflared();
      if (!verify.installed) {
        await c.log.warn(
          "cloudflared still not available. Quick tunnel mode may fail until it is installed.",
        );
      } else {
        await c.log.success(`cloudflared ready: ${verify.version ?? "installed"}`);
      }
    }
  }

  // -- STT ----------------------------------------------------------------

  let sttProvider!: SttProvider;
  let sttModel!: string;
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
    if (isCancel(reconfigureStt)) return c.outro("Setup cancelled.");
    if (!reconfigureStt) {
      sttProvider = existing.stt!.provider as SttProvider;
      sttModel = existing.stt!.model!;
      sttLanguage = existing.stt!.language ?? "";
      sttApiKey = existing.stt!.apiKey ?? "";
    }
  }

  if (!hasSttConfig || !sttModel) {
    const sttProviderResult = (await c.select({
      message: "Speech-to-Text provider",
      options: STT_PROVIDERS.map((id) => ({
        value: id,
        label: STT_META[id].label,
        hint: providerEnvVar(id) ?? "",
      })),
      initialValue: (existing.stt?.provider as SttProvider) ?? "deepgram",
    })) as SttProvider | symbol;
    if (isCancel(sttProviderResult)) return c.outro("Setup cancelled.");
    sttProvider = sttProviderResult;

    const sttEnvName = providerEnvVar(sttProvider);
    const sttEnvValue = sttEnvName ? process.env[sttEnvName] : undefined;

    if (sttEnvValue) {
      const useEnv = await c.confirm({
        message: `${sttEnvName} detected in environment. Use it for STT?`,
        initialValue: true,
      });
      if (isCancel(useEnv)) return c.outro("Setup cancelled.");
      if (!useEnv) {
        const keyResult = (await c.text({
          message: `API key for ${STT_META[sttProvider].label} STT`,
          placeholder: "sk-...",
        })) as string | symbol;
        if (isCancel(keyResult)) return c.outro("Setup cancelled.");
        sttApiKey = keyResult;
      }
    } else {
      const keyResult = (await c.text({
        message: `API key for ${STT_META[sttProvider].label} STT`,
        placeholder: "sk-...",
      })) as string | symbol;
      if (isCancel(keyResult)) return c.outro("Setup cancelled.");
      sttApiKey = keyResult;
    }

    await c.log.step(
      `Fetching available STT models/languages for ${STT_META[sttProvider].label}...`,
    );
    const sttCatalog = await fetchProviderCatalog({
      lane: "stt",
      provider: sttProvider,
      apiKey: sttApiKey,
    });

    const sttModelResult = await promptModelWithChoices({
      c,
      lane: "stt",
      provider: sttProvider,
      message: `STT model for ${STT_META[sttProvider].label}`,
      options: uniq([...sttCatalog.models, ...STT_MODEL_OPTIONS[sttProvider]]),
      initialValue: existing.stt?.model ?? STT_META[sttProvider].defaultModel,
      placeholder: STT_META[sttProvider].defaultModel,
    });
    if (isCancel(sttModelResult)) return c.outro("Setup cancelled.");
    sttModel = sttModelResult;

    const sttLanguageResult = await promptTextOrChoice({
      c,
      message: "STT language code",
      options: sttCatalog.languages,
      initialValue: existing.stt?.language ?? "",
      placeholder: "fr",
      allowEmpty: true,
      customLabel: "Custom language code…",
    });
    if (isCancel(sttLanguageResult)) return c.outro("Setup cancelled.");
    sttLanguage = sttLanguageResult;
  }

  // -- TTS ----------------------------------------------------------------

  let ttsProvider!: TtsProvider;
  let ttsModel!: string;
  let ttsVoice!: string;
  let ttsLanguage: string = "";
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
    if (isCancel(reconfigureTts)) return c.outro("Setup cancelled.");
    if (!reconfigureTts) {
      ttsProvider = existing.tts!.provider as TtsProvider;
      ttsModel = existing.tts!.model!;
      ttsVoice = existing.tts!.voice ?? TTS_META[ttsProvider].defaultVoice;
      ttsLanguage = existing.tts!.language ?? "";
      ttsApiKey = existing.tts!.apiKey ?? "";
    }
  }

  if (!hasTtsConfig || !ttsModel) {
    const ttsProviderResult = (await c.select({
      message: "Text-to-Speech provider",
      options: TTS_PROVIDERS.map((id) => ({
        value: id,
        label: TTS_META[id].label,
        hint: providerEnvVar(id) ?? "",
      })),
      initialValue: (existing.tts?.provider as TtsProvider) ?? "openai",
    })) as TtsProvider | symbol;
    if (isCancel(ttsProviderResult)) return c.outro("Setup cancelled.");
    ttsProvider = ttsProviderResult;

    const ttsEnvName = providerEnvVar(ttsProvider);
    const ttsEnvValue = ttsEnvName ? process.env[ttsEnvName] : undefined;

    // If same provider as STT, offer to reuse the key.
    if (sttProvider === ttsProvider && sttApiKey) {
      const reuse = await c.confirm({
        message: `Reuse the same ${STT_META[sttProvider].label} key for TTS?`,
        initialValue: true,
      });
      if (isCancel(reuse)) return c.outro("Setup cancelled.");
      if (reuse) ttsApiKey = sttApiKey;
    }

    if (!ttsApiKey) {
      if (ttsEnvValue) {
        const useEnv = await c.confirm({
          message: `${ttsEnvName} detected in environment. Use it for TTS?`,
          initialValue: true,
        });
        if (isCancel(useEnv)) return c.outro("Setup cancelled.");
        if (!useEnv) {
          const keyResult = (await c.text({
            message: `API key for ${TTS_META[ttsProvider].label} TTS`,
            placeholder: "sk-...",
          })) as string | symbol;
          if (isCancel(keyResult)) return c.outro("Setup cancelled.");
          ttsApiKey = keyResult;
        }
      } else {
        const keyResult = (await c.text({
          message: `API key for ${TTS_META[ttsProvider].label} TTS`,
          placeholder: "sk-...",
        })) as string | symbol;
        if (isCancel(keyResult)) return c.outro("Setup cancelled.");
        ttsApiKey = keyResult;
      }
    }

    await c.log.step(
      `Fetching available TTS models/voices/languages for ${TTS_META[ttsProvider].label}...`,
    );
    const ttsCatalog = await fetchProviderCatalog({
      lane: "tts",
      provider: ttsProvider,
      apiKey: ttsApiKey,
    });

    const ttsModelResult = await promptModelWithChoices({
      c,
      lane: "tts",
      provider: ttsProvider,
      message: `TTS model for ${TTS_META[ttsProvider].label}`,
      options: uniq([...ttsCatalog.models, ...TTS_MODEL_OPTIONS[ttsProvider]]),
      initialValue: existing.tts?.model ?? TTS_META[ttsProvider].defaultModel,
      placeholder: TTS_META[ttsProvider].defaultModel,
    });
    if (isCancel(ttsModelResult)) return c.outro("Setup cancelled.");
    ttsModel = ttsModelResult;

    const ttsVoiceResult = await promptTextOrChoice({
      c,
      message:
        ttsProvider === "elevenlabs"
          ? "Voice ID for ElevenLabs (voice_id)"
          : `Voice name for ${TTS_META[ttsProvider].label}`,
      options: ttsCatalog.voices,
      initialValue: existing.tts?.voice ?? TTS_META[ttsProvider].defaultVoice,
      placeholder: TTS_META[ttsProvider].defaultVoice,
      customLabel: "Custom voice…",
    });
    if (isCancel(ttsVoiceResult)) return c.outro("Setup cancelled.");
    ttsVoice = ttsVoiceResult;

    const ttsLanguageResult = await promptTextOrChoice({
      c,
      message: "TTS language code",
      options: ttsCatalog.languages,
      initialValue: existing.tts?.language ?? "",
      placeholder: "en-US",
      allowEmpty: true,
      customLabel: "Custom language code…",
    });
    if (isCancel(ttsLanguageResult)) return c.outro("Setup cancelled.");
    ttsLanguage = ttsLanguageResult;
  }

  // -- LLM ----------------------------------------------------------------

  let llmProvider!: LlmProvider;
  let llmModel!: string;
  let llmApiKey: string = "";

  const hasLlmConfig = !!(existing.llm?.provider && existing.llm?.model);

  if (hasLlmConfig) {
    await c.log.info(`  Current LLM: ${existing.llm!.provider} / ${existing.llm!.model}`);
    const reconfigureLlm = await c.confirm({
      message: "Reconfigure LLM (voice agent reasoning)?",
      initialValue: false,
    });
    if (isCancel(reconfigureLlm)) return c.outro("Setup cancelled.");
    if (!reconfigureLlm) {
      llmProvider = existing.llm!.provider as LlmProvider;
      llmModel = existing.llm!.model!;
      llmApiKey = existing.llm!.apiKey ?? "";
    }
  }

  if (!hasLlmConfig || !llmModel) {
    const llmProviderResult = (await c.select({
      message: "LLM provider (for voice agent reasoning)",
      options: LLM_PROVIDERS.map((id) => ({
        value: id,
        label: LLM_META[id].label,
        hint: providerEnvVar(id) ?? "",
      })),
      initialValue: (existing.llm?.provider as LlmProvider) ?? "openai",
    })) as LlmProvider | symbol;
    if (isCancel(llmProviderResult)) return c.outro("Setup cancelled.");
    llmProvider = llmProviderResult;

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
      if (isCancel(reuse)) return c.outro("Setup cancelled.");
      if (reuse) llmApiKey = sameAsSTT ? sttApiKey : ttsApiKey;
    }

    if (!llmApiKey) {
      if (llmEnvValue) {
        const useEnv = await c.confirm({
          message: `${llmEnvName} detected in environment. Use it for LLM?`,
          initialValue: true,
        });
        if (isCancel(useEnv)) return c.outro("Setup cancelled.");
        if (!useEnv) {
          const keyResult = (await c.text({
            message: `API key for ${LLM_META[llmProvider].label} LLM`,
            placeholder: "sk-...",
          })) as string | symbol;
          if (isCancel(keyResult)) return c.outro("Setup cancelled.");
          llmApiKey = keyResult;
        }
      } else {
        const keyResult = (await c.text({
          message: `API key for ${LLM_META[llmProvider].label} LLM`,
          placeholder: "sk-...",
        })) as string | symbol;
        if (isCancel(keyResult)) return c.outro("Setup cancelled.");
        llmApiKey = keyResult;
      }
    }

    await c.log.step(`Fetching available LLM models for ${LLM_META[llmProvider].label}...`);
    const llmCatalog = await fetchProviderCatalog({
      lane: "llm",
      provider: llmProvider,
      apiKey: llmApiKey,
    });

    const llmModelResult = await promptModelWithChoices({
      c,
      lane: "llm",
      provider: llmProvider,
      message: `LLM model for ${LLM_META[llmProvider].label}`,
      options: uniq([...llmCatalog.models, ...LLM_MODEL_OPTIONS[llmProvider]]),
      initialValue: existing.llm?.model ?? LLM_META[llmProvider].defaultModel,
      placeholder: LLM_META[llmProvider].defaultModel,
    });
    if (isCancel(llmModelResult)) return c.outro("Setup cancelled.");
    llmModel = llmModelResult;
  }

  // -- LiveKit ------------------------------------------------------------

  let livekitUrl!: string;
  let livekitApiKey!: string;
  let livekitApiSecret!: string;

  const hasLivekitConfig = !!(existing.livekit?.url && existing.livekit?.apiKey);
  let skipLivekit = false;

  if (hasLivekitConfig) {
    await c.log.info(`  Current LiveKit: ${existing.livekit!.url}`);
    const reconfigureLivekit = await c.confirm({
      message: "Reconfigure LiveKit?",
      initialValue: false,
    });
    if (isCancel(reconfigureLivekit)) return c.outro("Setup cancelled.");
    if (!reconfigureLivekit) {
      livekitUrl = existing.livekit!.url!;
      livekitApiKey = existing.livekit!.apiKey!;
      livekitApiSecret = existing.livekit!.apiSecret ?? "";
      skipLivekit = true;
    }
  }

  if (!skipLivekit) {
    const urlResult = (await c.text({
      message: "LiveKit URL",
      initialValue: existing.livekit?.url ?? "wss://your-project.livekit.cloud",
      placeholder: "wss://your-project.livekit.cloud",
    })) as string | symbol;
    if (isCancel(urlResult)) return c.outro("Setup cancelled.");
    livekitUrl = urlResult;

    const apiKeyResult = (await c.text({
      message: "LiveKit API Key",
      placeholder: "APIxxxxx",
    })) as string | symbol;
    if (isCancel(apiKeyResult)) return c.outro("Setup cancelled.");
    livekitApiKey = apiKeyResult;

    const apiSecretResult = (await c.text({
      message: "LiveKit API Secret",
      placeholder: "secret...",
    })) as string | symbol;
    if (isCancel(apiSecretResult)) return c.outro("Setup cancelled.");
    livekitApiSecret = apiSecretResult;
  }

  // -- Access mode --------------------------------------------------------

  const accessMode = (await c.select({
    message: "Public access mode",
    options: ACCESS_MODES.map((mode) => ({
      value: mode,
      label: mode,
      hint:
        mode === "quick-tunnel"
          ? "Starts cloudflared Quick Tunnel on demand"
          : "No public tunnel (local/LAN only)",
    })),
    initialValue: (existing.access?.mode ??
      (detectCloudflared().installed ? "quick-tunnel" : "none")) as AccessMode,
  })) as AccessMode | symbol;
  if (isCancel(accessMode)) return c.outro("Setup cancelled.");

  const supervisorSecret = (await c.text({
    message: "Supervisor secret (recommended)",
    initialValue: existing.access?.supervisorSecret ?? "",
    placeholder: "leave blank to use env fallback",
  })) as string | symbol;
  if (isCancel(supervisorSecret)) return c.outro("Setup cancelled.");

  // -- Save ---------------------------------------------------------------

  saveConfig({
    enabled: true,
    "voiceAgent.stt.provider": sttProvider,
    "voiceAgent.stt.model": sttModel,
    ...(sttLanguage.trim() ? { "voiceAgent.stt.language": sttLanguage.trim() } : {}),
    ...(sttApiKey.trim() ? { "voiceAgent.stt.apiKey": sttApiKey.trim() } : {}),
    "voiceAgent.tts.provider": ttsProvider,
    "voiceAgent.tts.model": ttsModel,
    "voiceAgent.tts.voice": ttsVoice,
    ...(ttsLanguage.trim() ? { "voiceAgent.tts.language": ttsLanguage.trim() } : {}),
    ...(ttsApiKey.trim() ? { "voiceAgent.tts.apiKey": ttsApiKey.trim() } : {}),
    "voiceAgent.llm.provider": llmProvider,
    "voiceAgent.llm.model": llmModel,
    ...(llmApiKey.trim() ? { "voiceAgent.llm.apiKey": llmApiKey.trim() } : {}),
    "livekit.url": livekitUrl,
    "livekit.apiKey": livekitApiKey,
    "livekit.apiSecret": livekitApiSecret,
    "access.mode": accessMode,
    ...(String(supervisorSecret).trim()
      ? { "access.supervisorSecret": String(supervisorSecret).trim() }
      : {}),
  });

  c.outro(
    "Setup complete. Start a session with `openclaw voice:start` and open the returned shareUrl.",
  );
}
