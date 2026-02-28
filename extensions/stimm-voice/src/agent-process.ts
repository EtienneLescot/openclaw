/**
 * AgentProcess — manages the Python voice agent as a child process.
 *
 * Spawns `python agent.py dev` (or console mode) and monitors it.
 * Restarts on crash with exponential backoff. Reports health via
 * LiveKit room presence.
 *
 * On first start, auto-creates a Python venv and installs dependencies
 * if the venv does not exist yet.
 */

import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const OBS_JSON_MARKER = "OBS_JSON ";

type SupervisorObsEvent = {
  component: string;
  event: string;
  inference_seq?: number;
  history_len?: number;
  processed_up_to?: number;
  latency_ms?: number;
  structured_json?: boolean;
  action?: string;
  reason?: string;
  text_chars?: number;
  preview?: string;
};

function maybeReadNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function maybeReadString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function maybeReadBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}…`;
}

function parseSupervisorObsEvent(line: string): SupervisorObsEvent | null {
  const markerIndex = line.indexOf(OBS_JSON_MARKER);
  if (markerIndex === -1) return null;
  const payload = line.slice(markerIndex + OBS_JSON_MARKER.length).trim();
  if (!payload.startsWith("{")) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const component = maybeReadString(record.component);
  const event = maybeReadString(record.event);
  if (component !== "conversation_supervisor" || !event) return null;

  return {
    component,
    event,
    inference_seq: maybeReadNumber(record.inference_seq),
    history_len: maybeReadNumber(record.history_len),
    processed_up_to: maybeReadNumber(record.processed_up_to),
    latency_ms: maybeReadNumber(record.latency_ms),
    structured_json: maybeReadBoolean(record.structured_json),
    action: maybeReadString(record.action),
    reason: maybeReadString(record.reason),
    text_chars: maybeReadNumber(record.text_chars),
    preview: maybeReadString(record.preview),
  };
}

function formatSupervisorObsEvent(event: SupervisorObsEvent): string {
  const seq = event.inference_seq ?? "?";

  if (event.event === "inference_started") {
    return (
      `[stimm-voice:supervisor] #${seq} inference_started ` +
      `history_len=${event.history_len ?? "?"} processed_up_to=${event.processed_up_to ?? "?"}`
    );
  }

  if (event.event === "inference_completed") {
    const structured = event.structured_json === true ? "yes" : "no";
    const action = event.action ?? "n/a";
    const reason = event.reason && event.reason.trim() ? truncate(event.reason.trim(), 220) : "n/a";
    return (
      `[stimm-voice:supervisor] #${seq} inference_completed ` +
      `latency_ms=${event.latency_ms ?? "?"} structured_json=${structured} action=${action} reason=${reason}`
    );
  }

  if (event.event === "trigger_sent") {
    const preview =
      event.preview && event.preview.trim() ? truncate(event.preview.trim(), 160) : "";
    return (
      `[stimm-voice:supervisor] #${seq} trigger_sent ` +
      `text_chars=${event.text_chars ?? "?"}${preview ? ` preview=\"${preview}\"` : ""}`
    );
  }

  if (event.event === "no_action") {
    return `[stimm-voice:supervisor] #${seq} no_action`;
  }

  return `[stimm-voice:supervisor] #${seq} event=${event.event}`;
}

function shouldSuppressAgentLine(line: string): boolean {
  const trimmed = line.trim();
  if (line.includes("ignoring text stream with topic")) return true;
  if (line.includes("'lk.transcription'")) return true;
  if (trimmed === "attached") return true;
  return false;
}

export interface AgentProcessOptions {
  /** Path to the Python executable (in the venv). */
  pythonPath: string;
  /** Path to agent.py. */
  agentScript: string;
  /** LiveKit URL the agent connects to. */
  livekitUrl: string;
  /** LiveKit API key. */
  livekitApiKey: string;
  /** LiveKit API secret. */
  livekitApiSecret: string;
  /** Environment variables to forward (API keys, etc.). */
  env?: Record<string, string>;
  /** Max automatic restarts before giving up. */
  maxRestarts?: number;
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
}

export class AgentProcess {
  private proc: ChildProcess | null = null;
  private options: AgentProcessOptions;
  private restartCount = 0;
  private maxRestarts: number;
  private stopped = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: AgentProcessOptions) {
    this.options = options;
    this.maxRestarts = options.maxRestarts ?? 5;
  }

  /** Start the Python voice agent process. */
  start(): void {
    if (this.proc) return;
    this.stopped = false;

    const { pythonPath, agentScript, livekitUrl, livekitApiKey, livekitApiSecret, env, logger } =
      this.options;

    // Auto-create venv if it doesn't exist yet.
    if (!existsSync(pythonPath)) {
      const pythonDir = resolve(agentScript, "..");
      logger.info("[stimm-voice] Python venv not found — setting up automatically...");
      const ok = AgentProcess.ensureVenv(pythonDir, logger);
      if (!ok) return;
      // Verify the venv was created successfully.
      if (!existsSync(pythonPath)) {
        logger.error(
          `[stimm-voice] Venv created but python not found at: ${pythonPath}\n` +
            "Run manually: cd extensions/stimm-voice/python && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt",
        );
        return;
      }
    }
    if (!existsSync(agentScript)) {
      logger.error(`[stimm-voice] agent.py not found at: ${agentScript}`);
      return;
    }

    const childEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      LIVEKIT_URL: livekitUrl,
      LIVEKIT_API_KEY: livekitApiKey,
      LIVEKIT_API_SECRET: livekitApiSecret,
      // Expose stimm.* / openclaw.* DEBUG logs in gateway output so
      // transcript dedup, supervisor accept/drop, and generate_reply
      // triggers are all visible for diagnostics.
      LIVEKIT_LOG_LEVEL: "debug",
      ...env,
    };

    const cwd = resolve(agentScript, "..");

    logger.info(`[stimm-voice] Starting Python voice agent (pid will follow)...`);
    logger.debug?.(`[stimm-voice] python=${pythonPath} script=${agentScript} cwd=${cwd}`);

    // Kill any zombie Python process holding the livekit-agents HTTP port (8081)
    // before spawning a new one, to avoid OSError: address already in use.
    AgentProcess.freePort(8081, logger);

    this.proc = spawn(pythonPath, [agentScript, "dev"], {
      cwd,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const pid = this.proc.pid;
    const logFile = "/tmp/stimm-agent.log";
    logger.info(`[stimm-voice] Voice agent started (PID ${pid}) — Python logs also in ${logFile}`);

    // Write Python logs to a dedicated file for easy grep/tail access.
    import("node:fs").then(({ createWriteStream }) => {
      const logStream = createWriteStream(logFile, { flags: "a" });
      logStream.write(`\n--- stimm-agent PID ${pid} started at ${new Date().toISOString()} ---\n`);

      const forwardLine = (line: string) => {
        logStream.write(line + "\n");
        if (shouldSuppressAgentLine(line)) {
          return;
        }
        const supervisorEvent = parseSupervisorObsEvent(line);
        if (supervisorEvent) {
          logger.info(formatSupervisorObsEvent(supervisorEvent));
          return;
        }
        logger.info(`[stimm-voice:agent] ${line}`);
      };

      // Forward stdout/stderr through the plugin logger AND to the log file.
      this.proc!.stdout?.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString().split("\n").filter(Boolean)) {
          forwardLine(line);
        }
      });

      this.proc!.stderr?.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString().split("\n").filter(Boolean)) {
          // livekit-agents logs to stderr by default — forward as info.
          forwardLine(line);
        }
      });

      this.proc!.on("exit", () => {
        logStream.write(`--- stimm-agent PID ${pid} exited at ${new Date().toISOString()} ---\n`);
        logStream.end();
      });
    });

    this.proc.on("exit", (code, signal) => {
      this.proc = null;
      if (this.stopped) {
        logger.info(`[stimm-voice] Voice agent stopped.`);
        return;
      }

      logger.warn(
        `[stimm-voice] Voice agent exited (code=${code}, signal=${signal}). ` +
          `Restarts: ${this.restartCount}/${this.maxRestarts}`,
      );

      if (this.restartCount >= this.maxRestarts) {
        logger.error(
          `[stimm-voice] Max restarts (${this.maxRestarts}) reached. Not restarting. ` +
            `Check agent logs and restart the gateway.`,
        );
        return;
      }

      // Exponential backoff: 1s, 2s, 4s, 8s, 16s…
      const delay = Math.min(1000 * Math.pow(2, this.restartCount), 30_000);
      this.restartCount++;
      logger.info(`[stimm-voice] Restarting voice agent in ${delay}ms...`);
      this.restartTimer = setTimeout(() => this.start(), delay);
    });
  }

  /** Stop the Python voice agent process. */
  stop(): void {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (!this.proc) return;

    this.options.logger.info(`[stimm-voice] Stopping voice agent (PID ${this.proc.pid})...`);
    this.proc.kill("SIGTERM");

    // Force kill after 5 seconds if it doesn't exit gracefully.
    const forceKill = setTimeout(() => {
      if (this.proc) {
        this.options.logger.warn("[stimm-voice] Force-killing voice agent (SIGKILL).");
        this.proc.kill("SIGKILL");
      }
    }, 5_000);

    this.proc.once("exit", () => clearTimeout(forceKill));
  }

  /** Whether the agent process is currently running. */
  get running(): boolean {
    return this.proc !== null && !this.proc.killed;
  }

  /** Current PID, or null if not running. */
  get pid(): number | null {
    return this.proc?.pid ?? null;
  }

  /** Resolve the default python path within the extension venv. */
  static resolveDefaultPythonPath(extensionDir: string): string {
    return join(extensionDir, "python", ".venv", "bin", "python");
  }

  /** Resolve the default agent.py path. */
  static resolveDefaultAgentScript(extensionDir: string): string {
    return join(extensionDir, "python", "agent.py");
  }

  /**
   * Auto-create and populate the Python venv if it doesn't exist.
   *
   * Steps:
   *   1. Find `python3` on PATH.
   *   2. Create venv at `<pythonDir>/.venv`.
   *   3. Install requirements from `<pythonDir>/requirements.txt`.
   *
   * Returns `true` if the venv is ready, `false` on failure.
   */
  static ensureVenv(
    pythonDir: string,
    logger: {
      info: (msg: string) => void;
      warn: (msg: string) => void;
      error: (msg: string) => void;
    },
  ): boolean {
    const venvDir = join(pythonDir, ".venv");
    const venvPython = join(venvDir, "bin", "python");

    // Already exists? Quick exit.
    if (existsSync(venvPython)) return true;

    // Find a system Python 3.
    const systemPython = AgentProcess.findSystemPython();
    if (!systemPython) {
      logger.error("[stimm-voice] python3 not found on PATH. Install Python 3.10+ and try again.");
      return false;
    }

    try {
      logger.info(`[stimm-voice] Creating venv at ${venvDir} (using ${systemPython})...`);
      execSync(`${systemPython} -m venv ${JSON.stringify(venvDir)}`, {
        cwd: pythonDir,
        stdio: "pipe",
        timeout: 60_000,
      });

      const reqFile = join(pythonDir, "requirements.txt");
      if (existsSync(reqFile)) {
        const pip = join(venvDir, "bin", "pip");
        logger.info("[stimm-voice] Installing Python dependencies (this may take a minute)...");
        const reqs = readFileSync(reqFile, "utf-8").trim();
        logger.info(`[stimm-voice] requirements: ${reqs.split("\n").join(", ")}`);
        execSync(`${JSON.stringify(pip)} install -r ${JSON.stringify(reqFile)}`, {
          cwd: pythonDir,
          stdio: "pipe",
          timeout: 300_000, // 5 min for large installs
        });
        logger.info("[stimm-voice] Python dependencies installed.");
      }

      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[stimm-voice] Failed to create Python venv: ${msg}`);
      logger.error(
        "Try manually: cd extensions/stimm-voice/python && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt",
      );
      return false;
    }
  }

  /**
   * Kill any process holding the given TCP port (Linux/macOS).
   * Used to clean up zombie livekit-agents workers before restart.
   */
  static freePort(port: number, logger: { warn: (msg: string) => void }): void {
    try {
      const result = execSync(`fuser ${port}/tcp 2>/dev/null`, { encoding: "utf-8" }).trim();
      if (result) {
        for (const pid of result.trim().split(/\s+/).filter(Boolean)) {
          try {
            execSync(`kill -9 ${pid} 2>/dev/null`);
            logger.warn(`[stimm-voice] Killed zombie process PID ${pid} holding port ${port}`);
          } catch {
            // Already gone.
          }
        }
      }
    } catch {
      // fuser not available or port already free — ignore.
    }
  }

  /** Find a usable system Python 3 (python3, python). */
  static findSystemPython(): string | null {
    for (const cmd of ["python3", "python"]) {
      try {
        const version = execSync(`${cmd} --version 2>&1`, { encoding: "utf-8" }).trim();
        // Ensure it's Python 3.10+.
        const match = version.match(/Python\s+(\d+)\.(\d+)/);
        if (match && Number(match[1]) >= 3 && Number(match[2]) >= 10) {
          return cmd;
        }
      } catch {
        // Not found, try next.
      }
    }
    return null;
  }
}
