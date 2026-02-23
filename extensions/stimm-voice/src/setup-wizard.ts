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

const STT_DEFAULTS: Record<SttProvider, string> = {
  deepgram: "nova-3",
  openai: "gpt-4o-mini-transcribe",
  google: "latest_long",
  azure: "en-US",
  assemblyai: "best",
  aws: "default",
  speechmatics: "default",
  clova: "default",
  fal: "default",
};

const TTS_DEFAULTS: Record<TtsProvider, { model: string; voice: string }> = {
  openai: { model: "gpt-4o-mini-tts", voice: "ash" },
  elevenlabs: { model: "eleven_turbo_v2_5", voice: "rachel" },
  cartesia: { model: "sonic-2", voice: "default" },
  google: { model: "en-US-Neural2-F", voice: "default" },
  azure: { model: "en-US-JennyNeural", voice: "default" },
  aws: { model: "neural", voice: "Joanna" },
  playai: { model: "default", voice: "default" },
  rime: { model: "default", voice: "default" },
};

const LLM_DEFAULTS: Record<LlmProvider, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-sonnet-4-20250514",
  google: "gemini-2.0-flash",
  groq: "llama-3.3-70b-versatile",
  azure: "gpt-4o-mini",
  cerebras: "llama-3.3-70b",
  fireworks: "llama-v3p3-70b-instruct",
  together: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
  sambanova: "Meta-Llama-3.3-70B-Instruct",
};

export interface SetupWizardDeps {
  logger: { info: (msg: string) => void; error: (msg: string) => void };
  extensionDir: string;
}

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
      return {
        ok: false,
        message: "Homebrew is required on macOS for automatic install.",
      };
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

  return {
    ok: false,
    message: `Automatic install not supported on ${platform}.`,
  };
}

export async function runSetupWizard(deps: SetupWizardDeps): Promise<void> {
  const c = await clack();
  c.intro("Stimm Voice — Setup Wizard");

  const venvPath = join(deps.extensionDir, "python", ".venv", "bin", "python");
  if (existsSync(venvPath)) {
    await c.log.success("Python virtual environment found.");
  } else {
    await c.log.warn(
      "Python virtual environment not found. It will be auto-created on first gateway start.",
    );
  }

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

  const sttProvider = (await c.select({
    message: "Speech-to-Text provider",
    options: STT_PROVIDERS.map((id) => ({
      value: id,
      label: id,
      hint: providerEnvVar(id) ?? "",
    })),
    initialValue: "deepgram",
  })) as SttProvider | symbol;
  if (isCancel(sttProvider)) return c.outro("Setup cancelled.");

  const sttModel = (await c.text({
    message: "STT model",
    initialValue: STT_DEFAULTS[sttProvider],
  })) as string | symbol;
  if (isCancel(sttModel)) return c.outro("Setup cancelled.");

  const ttsProvider = (await c.select({
    message: "Text-to-Speech provider",
    options: TTS_PROVIDERS.map((id) => ({
      value: id,
      label: id,
      hint: providerEnvVar(id) ?? "",
    })),
    initialValue: "openai",
  })) as TtsProvider | symbol;
  if (isCancel(ttsProvider)) return c.outro("Setup cancelled.");

  const ttsModel = (await c.text({
    message: "TTS model",
    initialValue: TTS_DEFAULTS[ttsProvider].model,
  })) as string | symbol;
  if (isCancel(ttsModel)) return c.outro("Setup cancelled.");

  const ttsVoice = (await c.text({
    message: "TTS voice",
    initialValue: TTS_DEFAULTS[ttsProvider].voice,
  })) as string | symbol;
  if (isCancel(ttsVoice)) return c.outro("Setup cancelled.");

  const llmProvider = (await c.select({
    message: "LLM provider",
    options: LLM_PROVIDERS.map((id) => ({
      value: id,
      label: id,
      hint: providerEnvVar(id) ?? "",
    })),
    initialValue: "openai",
  })) as LlmProvider | symbol;
  if (isCancel(llmProvider)) return c.outro("Setup cancelled.");

  const llmModel = (await c.text({
    message: "LLM model",
    initialValue: LLM_DEFAULTS[llmProvider],
  })) as string | symbol;
  if (isCancel(llmModel)) return c.outro("Setup cancelled.");

  const livekitUrl = (await c.text({
    message: "LiveKit URL",
    initialValue: "wss://your-project.livekit.cloud",
  })) as string | symbol;
  if (isCancel(livekitUrl)) return c.outro("Setup cancelled.");

  const livekitApiKey = (await c.text({
    message: "LiveKit API Key",
    placeholder: "APIxxxxx",
  })) as string | symbol;
  if (isCancel(livekitApiKey)) return c.outro("Setup cancelled.");

  const livekitApiSecret = (await c.text({
    message: "LiveKit API Secret",
    placeholder: "secret...",
  })) as string | symbol;
  if (isCancel(livekitApiSecret)) return c.outro("Setup cancelled.");

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
    initialValue: detectCloudflared().installed ? "quick-tunnel" : "none",
  })) as AccessMode | symbol;
  if (isCancel(accessMode)) return c.outro("Setup cancelled.");

  const supervisorSecret = (await c.text({
    message: "Supervisor secret (recommended)",
    placeholder: "leave blank to use env fallback",
  })) as string | symbol;
  if (isCancel(supervisorSecret)) return c.outro("Setup cancelled.");

  saveConfig({
    enabled: true,
    "voiceAgent.stt.provider": sttProvider,
    "voiceAgent.stt.model": sttModel,
    "voiceAgent.tts.provider": ttsProvider,
    "voiceAgent.tts.model": ttsModel,
    "voiceAgent.tts.voice": ttsVoice,
    "voiceAgent.llm.provider": llmProvider,
    "voiceAgent.llm.model": llmModel,
    "livekit.url": livekitUrl,
    "livekit.apiKey": livekitApiKey,
    "livekit.apiSecret": livekitApiSecret,
    "access.mode": accessMode,
    ...(supervisorSecret.trim() ? { "access.supervisorSecret": supervisorSecret.trim() } : {}),
  });

  c.outro(
    "Setup complete. Start a session with `openclaw voice:start` and open the returned shareUrl.",
  );
}
