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
// StimmProviders — types for providers.json shipped with the stimm package.
// Data lives in stimm; openclaw only holds fetch/UI logic.
// ---------------------------------------------------------------------------

type ProviderApiConf = {
  kind: string;
  baseUrl?: string;
  modelsUrl?: string;
  voicesUrl?: string;
  probeUrl?: string;
  authScheme?: string;
  authHeader?: string;
  apiVersion?: string;
  includeFilter?: string;
  excludeFilter?: string;
};

type SttEntry = {
  id: string;
  label: string;
  defaultModel: string;
  presets: string[];
  api: ProviderApiConf;
};
type TtsEntry = {
  id: string;
  label: string;
  defaultModel: string;
  defaultVoice: string;
  presets: string[];
  api: ProviderApiConf;
};
type LlmEntry = {
  id: string;
  label: string;
  defaultModel: string;
  presets: string[];
  api: ProviderApiConf;
};

type StimmProviders = {
  stt: SttEntry[];
  tts: TtsEntry[];
  llm: LlmEntry[];
};

/**
 * Load providers.json from stimm (source of truth for provider metadata).
 * Tries, in order:
 *  1. Installed stimm package inside the extension Python venv (normal path — stimm is a dep).
 *  2. Sibling stimm repo on disk (dev workflow, before the venv is initialised).
 * Returns null only if the venv isn't set up yet and no sibling repo is found.
 */
function loadStimmProviders(extensionDir: string): StimmProviders | null {
  // 1. Python venv — stimm is a declared dependency, so providers.json lives inside it.
  const pythonExe = join(extensionDir, "python", ".venv", "bin", "python");
  if (existsSync(pythonExe)) {
    try {
      const result = spawnSync(
        pythonExe,
        [
          "-c",
          "import stimm, os; print(os.path.join(os.path.dirname(stimm.__file__), 'providers.json'))",
        ],
        { encoding: "utf8", timeout: 5_000 },
      );
      if (result.status === 0) {
        const jsonPath = result.stdout.trim();
        if (existsSync(jsonPath)) {
          return JSON.parse(readFileSync(jsonPath, "utf-8")) as StimmProviders;
        }
      }
    } catch {
      /* fall through */
    }
  }

  // 2. Sibling stimm repo on disk (dev workflow — venv not yet initialised).
  // extensionDir = .../openclaw/extensions/stimm-voice  →  ../../../stimm
  const siblingPath = join(
    extensionDir,
    "..",
    "..",
    "..",
    "stimm",
    "src",
    "stimm",
    "providers.json",
  );
  if (existsSync(siblingPath)) {
    try {
      return JSON.parse(readFileSync(siblingPath, "utf-8")) as StimmProviders;
    } catch {
      /* fall through */
    }
  }

  return null;
}

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

/** Apply include/exclude filters from a ProviderApiConf to a list of model IDs. */
function applyModelFilters(models: string[], api: ProviderApiConf): string[] {
  let result = models;
  if (api.includeFilter)
    result = result.filter((id) => new RegExp(api.includeFilter!, "i").test(id));
  if (api.excludeFilter)
    result = result.filter((id) => !new RegExp(api.excludeFilter!, "i").test(id));
  return result;
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
    return uniq(extracted).slice(0, 80);
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

/**
 * Fetch live models from a provider using the API configuration declared in providers.json.
 * Falls back to LiveKit docs scraping for providers that have no usable model catalog API.
 */
async function fetchProviderModels(
  lane: ModelLane,
  entry: SttEntry | TtsEntry | LlmEntry,
  apiKey: string,
): Promise<string[]> {
  const key = apiKey.trim();
  if (!key) return [];

  const { api } = entry;
  let raw: string[] = [];

  try {
    if (api.kind === "openai-compat") {
      // Support OPENAI_BASE_URL override for openai provider, use entry baseUrl for others.
      const base =
        entry.id === "openai"
          ? (process.env.OPENAI_BASE_URL ?? api.baseUrl ?? "https://api.openai.com")
          : (api.baseUrl ?? "https://api.openai.com");
      raw = await fetchOpenAICompatibleModels({ baseUrl: base, apiKey: key });
    } else if (api.kind === "anthropic") {
      const url = api.modelsUrl ?? "https://api.anthropic.com/v1/models";
      const json = (await fetchJson(url, {
        headers: {
          "x-api-key": key,
          "anthropic-version": api.apiVersion ?? "2023-06-01",
        },
      })) as { data?: Array<{ id?: string }> };
      raw = uniq((json.data ?? []).map((item) => item.id ?? ""));
    } else if (api.kind === "google") {
      const json = (await fetchJson(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
      )) as { models?: Array<{ name?: string }> };
      raw = uniq(
        (json.models ?? []).map((item) => {
          const name = item.name ?? "";
          return name.startsWith("models/") ? name.slice("models/".length) : name;
        }),
      );
    } else if (api.kind === "elevenlabs") {
      const url = api.modelsUrl ?? "https://api.elevenlabs.io/v1/models";
      const authKey = api.authHeader ?? "xi-api-key";
      const json = (await fetchJson(url, { headers: { [authKey]: key } })) as Array<{
        model_id?: string;
      }>;
      raw = uniq((json ?? []).map((item) => item.model_id ?? ""));
    } else if (api.kind === "deepgram") {
      // Deepgram exposes no public model catalog; validate key via projects probe then return presets.
      const probeUrl = api.probeUrl ?? "https://api.deepgram.com/v1/projects";
      const scheme = api.authScheme ?? "token";
      const authHeader = scheme === "token" ? `Token ${key}` : `Bearer ${key}`;
      const json = (await fetchJson(probeUrl, { headers: { Authorization: authHeader } })) as {
        projects?: unknown[];
      };
      if (Array.isArray(json.projects)) raw = [...entry.presets];
    }
  } catch {
    raw = [];
  }

  const filtered = applyModelFilters(uniq(raw), api);
  if (filtered.length > 0) return filtered;

  // Fallback: scrape LiveKit plugin docs when no catalog API is available.
  return fetchModelsFromLiveKitDocs(lane, entry.id);
}

type ProviderCatalog = {
  models: string[];
  voices: string[];
  voiceChoices?: Array<{ value: string; label: string }>;
  languages: string[];
};

/**
 * Fetch the full catalog (models + voices + languages) for a provider entry.
 * Voice and language sources are declared in providers.json; actual data comes from
 * provider APIs or LiveKit docs.
 */
async function fetchProviderCatalog(
  lane: ModelLane,
  entry: SttEntry | TtsEntry | LlmEntry,
  apiKey: string,
): Promise<ProviderCatalog> {
  const { api } = entry;
  const key = apiKey.trim();
  const models = await fetchProviderModels(lane, entry, key);
  let voices: string[] = [];
  let voiceChoices: Array<{ value: string; label: string }> = [];
  let languages: string[] = [];

  // Voices — provider APIs that expose a voice catalog.
  try {
    if (lane === "tts" && api.kind === "elevenlabs" && key && api.voicesUrl) {
      const authKey = api.authHeader ?? "xi-api-key";
      const json = (await fetchJson(api.voicesUrl, { headers: { [authKey]: key } })) as {
        voices?: Array<{ voice_id?: string; name?: string }>;
      };
      const list = (json.voices ?? []).flatMap((voice) => {
        const id = (voice.voice_id ?? "").trim();
        if (!id) return [];
        const name = (voice.name ?? "").trim();
        return [{ value: id, label: name ? `${name} (${id})` : id }];
      });
      voiceChoices = uniqByValue(list);
      voices = voiceChoices.map((choice) => choice.value);
    }
  } catch {
    voices = [];
    voiceChoices = [];
  }

  if (voices.length === 0 && lane === "tts") {
    voices = await fetchVoicesFromLiveKitDocs(lane, entry.id);
  }

  if (lane === "stt" || lane === "tts") {
    languages = await fetchLanguagesFromLiveKitDocs(lane, entry.id);
  }

  return {
    models: uniq(models),
    voices: uniq(voices),
    ...(voiceChoices.length > 0 ? { voiceChoices } : {}),
    languages: uniq(languages),
  };
}

function uniqByValue(values: Array<{ value: string; label: string }>): Array<{
  value: string;
  label: string;
}> {
  const seen = new Set<string>();
  const output: Array<{ value: string; label: string }> = [];
  for (const item of values) {
    if (seen.has(item.value)) continue;
    seen.add(item.value);
    output.push(item);
  }
  return output;
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

async function promptMappedTextOrChoice(params: {
  c: Clack;
  message: string;
  options: Array<{ value: string; label: string }>;
  initialValue: string;
  placeholder: string;
  customLabel?: string;
  allowEmpty?: boolean;
}): Promise<string | symbol> {
  const { c, message, options, initialValue, placeholder, customLabel, allowEmpty } = params;
  const values = uniqByValue(options);
  const selection = (await c.select({
    message,
    options: [
      ...(allowEmpty ? [{ value: "__empty__", label: "Use provider default" }] : []),
      ...values,
      { value: "__custom__", label: customLabel ?? "Custom value…" },
    ],
    initialValue: values.some((option) => option.value === initialValue)
      ? initialValue
      : "__custom__",
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

  // -- Load provider catalog from stimm (source of truth) -----------------

  await c.log.step("Loading provider catalog from stimm...");
  const catalog = loadStimmProviders(deps.extensionDir);
  if (!catalog) {
    await c.log.warn(
      "Could not load providers.json from stimm (venv not ready, sibling repo not found, and GitHub fetch failed). " +
        "Provider lists will be empty — you can still type values manually.",
    );
  }

  // Catalog accessor helpers
  const sttMeta = (id: string): SttEntry =>
    catalog?.stt.find((p) => p.id === id) ??
    ({
      id,
      label: id,
      defaultModel: "default",
      presets: [],
      api: { kind: "livekit-docs" },
    } satisfies SttEntry);
  const ttsMeta = (id: string): TtsEntry =>
    catalog?.tts.find((p) => p.id === id) ??
    ({
      id,
      label: id,
      defaultModel: "default",
      defaultVoice: "default",
      presets: [],
      api: { kind: "livekit-docs" },
    } satisfies TtsEntry);
  const llmMeta = (id: string): LlmEntry =>
    catalog?.llm.find((p) => p.id === id) ??
    ({
      id,
      label: id,
      defaultModel: "default",
      presets: [],
      api: { kind: "livekit-docs" },
    } satisfies LlmEntry);

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
    const sttEntries = catalog?.stt ?? [];
    const sttProviderResult = (await c.select({
      message: "Speech-to-Text provider",
      options: sttEntries.map(({ id, label }) => ({
        value: id,
        label,
        hint: providerEnvVar(id as SttProvider) ?? "",
      })),
      initialValue: existing.stt?.provider ?? "deepgram",
    })) as SttProvider | symbol;
    if (isCancel(sttProviderResult)) return c.outro("Setup cancelled.");
    sttProvider = sttProviderResult;
    const sttEntry = sttMeta(sttProvider);

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
          message: `API key for ${sttEntry.label} STT`,
          placeholder: "sk-...",
        })) as string | symbol;
        if (isCancel(keyResult)) return c.outro("Setup cancelled.");
        sttApiKey = keyResult;
      }
    } else {
      const keyResult = (await c.text({
        message: `API key for ${sttEntry.label} STT`,
        placeholder: "sk-...",
      })) as string | symbol;
      if (isCancel(keyResult)) return c.outro("Setup cancelled.");
      sttApiKey = keyResult;
    }

    await c.log.step(`Fetching available STT models/languages for ${sttEntry.label}...`);
    const sttLiveCatalog = await fetchProviderCatalog("stt", sttEntry, sttApiKey);

    const sttModelResult = await promptModelWithChoices({
      c,
      lane: "stt",
      provider: sttProvider,
      message: `STT model for ${sttEntry.label}`,
      options: uniq([...sttLiveCatalog.models, ...sttEntry.presets]),
      initialValue: existing.stt?.model ?? sttEntry.defaultModel,
      placeholder: sttEntry.defaultModel,
    });
    if (isCancel(sttModelResult)) return c.outro("Setup cancelled.");
    sttModel = sttModelResult;

    const sttLanguageResult = await promptTextOrChoice({
      c,
      message: "STT language code",
      options: sttLiveCatalog.languages,
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
      ttsVoice = existing.tts!.voice ?? ttsMeta(existing.tts!.provider ?? "openai").defaultVoice;
      ttsLanguage = existing.tts!.language ?? "";
      ttsApiKey = existing.tts!.apiKey ?? "";
    }
  }

  if (!hasTtsConfig || !ttsModel) {
    const ttsEntries = catalog?.tts ?? [];
    const ttsProviderResult = (await c.select({
      message: "Text-to-Speech provider",
      options: ttsEntries.map(({ id, label }) => ({
        value: id,
        label,
        hint: providerEnvVar(id as TtsProvider) ?? "",
      })),
      initialValue: existing.tts?.provider ?? "openai",
    })) as TtsProvider | symbol;
    if (isCancel(ttsProviderResult)) return c.outro("Setup cancelled.");
    ttsProvider = ttsProviderResult;
    const ttsEntry = ttsMeta(ttsProvider);

    const ttsEnvName = providerEnvVar(ttsProvider);
    const ttsEnvValue = ttsEnvName ? process.env[ttsEnvName] : undefined;

    // If same provider as STT, offer to reuse the key.
    if (sttProvider === ttsProvider && sttApiKey) {
      const reuse = await c.confirm({
        message: `Reuse the same ${sttMeta(sttProvider).label} key for TTS?`,
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
            message: `API key for ${ttsEntry.label} TTS`,
            placeholder: "sk-...",
          })) as string | symbol;
          if (isCancel(keyResult)) return c.outro("Setup cancelled.");
          ttsApiKey = keyResult;
        }
      } else {
        const keyResult = (await c.text({
          message: `API key for ${ttsEntry.label} TTS`,
          placeholder: "sk-...",
        })) as string | symbol;
        if (isCancel(keyResult)) return c.outro("Setup cancelled.");
        ttsApiKey = keyResult;
      }
    }

    await c.log.step(`Fetching available TTS models/voices/languages for ${ttsEntry.label}...`);
    const ttsLiveCatalog = await fetchProviderCatalog("tts", ttsEntry, ttsApiKey);

    const ttsModelResult = await promptModelWithChoices({
      c,
      lane: "tts",
      provider: ttsProvider,
      message: `TTS model for ${ttsEntry.label}`,
      options: uniq([...ttsLiveCatalog.models, ...ttsEntry.presets]),
      initialValue: existing.tts?.model ?? ttsEntry.defaultModel,
      placeholder: ttsEntry.defaultModel,
    });
    if (isCancel(ttsModelResult)) return c.outro("Setup cancelled.");
    ttsModel = ttsModelResult;

    const ttsVoiceResult = ttsLiveCatalog.voiceChoices?.length
      ? await promptMappedTextOrChoice({
          c,
          message: `Voice for ${ttsEntry.label}`,
          options: ttsLiveCatalog.voiceChoices,
          initialValue: existing.tts?.voice ?? ttsEntry.defaultVoice,
          placeholder: ttsEntry.defaultVoice,
          customLabel: "Custom voice ID…",
        })
      : await promptTextOrChoice({
          c,
          message:
            ttsProvider === "elevenlabs"
              ? "Voice ID for ElevenLabs (voice_id)"
              : ttsProvider === "cartesia"
                ? "Voice ID for Cartesia (UUID)"
                : `Voice name for ${ttsEntry.label}`,
          options: ttsLiveCatalog.voices,
          initialValue: existing.tts?.voice ?? ttsEntry.defaultVoice,
          placeholder: ttsEntry.defaultVoice,
          customLabel: "Custom voice…",
        });
    if (isCancel(ttsVoiceResult)) return c.outro("Setup cancelled.");
    ttsVoice = ttsVoiceResult;

    const ttsLanguageResult = await promptTextOrChoice({
      c,
      message: "TTS language code",
      options: ttsLiveCatalog.languages,
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
    const llmEntries = catalog?.llm ?? [];
    const llmProviderResult = (await c.select({
      message: "LLM provider (for voice agent reasoning)",
      options: llmEntries.map(({ id, label }) => ({
        value: id,
        label,
        hint: providerEnvVar(id as LlmProvider) ?? "",
      })),
      initialValue: existing.llm?.provider ?? "openai",
    })) as LlmProvider | symbol;
    if (isCancel(llmProviderResult)) return c.outro("Setup cancelled.");
    llmProvider = llmProviderResult;
    const llmEntry = llmMeta(llmProvider);

    const llmEnvName = providerEnvVar(llmProvider);
    const llmEnvValue = llmEnvName ? process.env[llmEnvName] : undefined;

    // Offer reuse if same provider as STT or TTS.
    const sameAsSTT = llmProvider === sttProvider && sttApiKey;
    const sameAsTTS = llmProvider === ttsProvider && ttsApiKey;

    if (sameAsSTT || sameAsTTS) {
      const reuse = await c.confirm({
        message: `Reuse the same ${llmEntry.label} key for LLM?`,
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
            message: `API key for ${llmEntry.label} LLM`,
            placeholder: "sk-...",
          })) as string | symbol;
          if (isCancel(keyResult)) return c.outro("Setup cancelled.");
          llmApiKey = keyResult;
        }
      } else {
        const keyResult = (await c.text({
          message: `API key for ${llmEntry.label} LLM`,
          placeholder: "sk-...",
        })) as string | symbol;
        if (isCancel(keyResult)) return c.outro("Setup cancelled.");
        llmApiKey = keyResult;
      }
    }

    await c.log.step(`Fetching available LLM models for ${llmEntry.label}...`);
    const llmLiveCatalog = await fetchProviderCatalog("llm", llmEntry, llmApiKey);

    const llmModelResult = await promptModelWithChoices({
      c,
      lane: "llm",
      provider: llmProvider,
      message: `LLM model for ${llmEntry.label}`,
      options: uniq([...llmLiveCatalog.models, ...llmEntry.presets]),
      initialValue: existing.llm?.model ?? llmEntry.defaultModel,
      placeholder: llmEntry.defaultModel,
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
