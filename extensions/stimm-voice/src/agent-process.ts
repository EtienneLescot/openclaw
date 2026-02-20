/**
 * AgentProcess — manages the Python voice agent as a child process.
 *
 * Spawns `python agent.py dev` (or console mode) and monitors it.
 * Restarts on crash with exponential backoff. Reports health via
 * LiveKit room presence.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

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

    // Validate paths before spawning.
    if (!existsSync(pythonPath)) {
      logger.error(`[stimm-voice] Python not found at: ${pythonPath}`);
      logger.error(
        "[stimm-voice] Run the setup script: cd extensions/stimm-voice/python && ./dev-setup.sh",
      );
      return;
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
      ...env,
    };

    const cwd = resolve(agentScript, "..");

    logger.info(`[stimm-voice] Starting Python voice agent (pid will follow)...`);
    logger.debug?.(`[stimm-voice] python=${pythonPath} script=${agentScript} cwd=${cwd}`);

    this.proc = spawn(pythonPath, [agentScript, "dev"], {
      cwd,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const pid = this.proc.pid;
    logger.info(`[stimm-voice] Voice agent started (PID ${pid})`);

    // Forward stdout/stderr through the plugin logger.
    this.proc.stdout?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        logger.info(`[stimm-voice:agent] ${line}`);
      }
    });

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        // livekit-agents logs to stderr by default — forward as info.
        logger.info(`[stimm-voice:agent] ${line}`);
      }
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
}
