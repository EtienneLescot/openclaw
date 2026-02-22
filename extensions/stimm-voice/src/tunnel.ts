/**
 * Tunnel helpers — expose the gateway and LiveKit via Tailscale Funnel.
 *
 * Extracted from the voice-call extension pattern but kept self-contained
 * to avoid cross-extension coupling.
 *
 * Tailscale Funnel supports ports 443, 8443, and 10000.
 * Default mapping:
 *   - Port 443  → gateway (serves /voice HTML + REST API)
 *   - Port 8443 → LiveKit (WebRTC signaling)
 */

import { spawn } from "node:child_process";
import type { StimmVoiceConfig } from "./config.js";

export interface TunnelInfo {
  /** Public HTTPS URL for the gateway (e.g. https://host.ts.net/voice). */
  gatewayUrl: string;
  /** Public WSS URL for LiveKit (e.g. wss://host.ts.net:8443). */
  livekitUrl: string;
  /** Tailscale DNS name for the node. */
  dnsName: string;
}

interface TunnelLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// Tailscale CLI helpers
// ---------------------------------------------------------------------------

function runTailscaleCommand(
  args: string[],
  timeoutMs = 5000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn("tailscale", args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve({ code: -1, stdout: "", stderr: "spawn failed" });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };

    proc.on("error", () => done(-1)); // ENOENT when binary missing
    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data;
    });
    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data;
    });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      done(-1);
    }, timeoutMs);

    proc.on("close", (code) => done(code ?? -1));
  });
}

export interface TailscaleStatus {
  installed: boolean;
  loggedIn: boolean;
  dnsName: string | null;
}

/** Check Tailscale installation and login state. */
export async function getTailscaleStatus(): Promise<TailscaleStatus> {
  const { code, stdout } = await runTailscaleCommand(["status", "--json"]);
  if (code !== 0) {
    return { installed: false, loggedIn: false, dnsName: null };
  }

  try {
    const status = JSON.parse(stdout);
    const dnsName: string | null = status.Self?.DNSName?.replace(/\.$/, "") || null;
    const loggedIn = !!dnsName;
    return { installed: true, loggedIn, dnsName };
  } catch {
    return { installed: true, loggedIn: false, dnsName: null };
  }
}

/** Check whether `tailscale` binary is on PATH. */
export async function isTailscaleInstalled(): Promise<boolean> {
  const { code } = await runTailscaleCommand(["version"]);
  return code === 0;
}

// ---------------------------------------------------------------------------
// Tailscale install / login
// ---------------------------------------------------------------------------

/** Run a shell command with sudo, streaming output line-by-line via callback. */
function runSudoCommand(
  command: string,
  args: string[],
  opts: { timeoutMs?: number; onOutput?: (line: string) => void } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { timeoutMs = 60_000, onOutput } = opts;
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn("sudo", [command, ...args], {
        stdio: ["inherit", "pipe", "pipe"],
      });
    } catch {
      resolve({ code: -1, stdout: "", stderr: "spawn failed" });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };

    proc.on("error", () => done(-1)); // ENOENT if sudo/command missing
    proc.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      if (onOutput) {
        for (const line of text.split("\n").filter(Boolean)) {
          onOutput(line);
        }
      }
    });
    proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      if (onOutput) {
        for (const line of text.split("\n").filter(Boolean)) {
          onOutput(line);
        }
      }
    });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      done(-1);
    }, timeoutMs);

    proc.on("close", (code) => done(code ?? -1));
  });
}

export interface InstallResult {
  success: boolean;
  message: string;
}

/**
 * Install Tailscale using the official install script.
 *
 * Linux: `curl -fsSL https://tailscale.com/install.sh | sudo sh`
 * macOS: attempts `brew install tailscale` if Homebrew is available.
 */
export async function installTailscale(onOutput?: (line: string) => void): Promise<InstallResult> {
  const platform = process.platform;

  if (platform === "linux") {
    // Download install script then pipe to sudo sh.
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn("sh", ["-c", "curl -fsSL https://tailscale.com/install.sh | sudo sh"], {
        stdio: ["inherit", "pipe", "pipe"],
      });
    } catch {
      return { success: false, message: "Failed to spawn shell for install." };
    }

    let stderr = "";
    proc.on("error", () => {}); // prevent unhandled exception
    proc.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      if (onOutput) {
        for (const line of text.split("\n").filter(Boolean)) onOutput(line);
      }
    });
    proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      if (onOutput) {
        for (const line of text.split("\n").filter(Boolean)) onOutput(line);
      }
    });

    const code = await new Promise<number>((resolve) => {
      proc.on("error", () => resolve(-1));
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve(-1);
      }, 120_000);
      proc.on("close", (c) => {
        clearTimeout(timer);
        resolve(c ?? -1);
      });
    });

    if (code !== 0) {
      return { success: false, message: `Install failed (exit ${code}): ${stderr.slice(-200)}` };
    }
    return { success: true, message: "Tailscale installed successfully." };
  }

  if (platform === "darwin") {
    // Try Homebrew first.
    const { code, stderr } = await runSudoCommand("brew", ["install", "tailscale"], {
      timeoutMs: 120_000,
      onOutput,
    });
    if (code === 0) {
      return { success: true, message: "Tailscale installed via Homebrew." };
    }
    return {
      success: false,
      message:
        `brew install failed (exit ${code}). ` +
        "Install manually from https://tailscale.com/download\n" +
        stderr.slice(-200),
    };
  }

  return {
    success: false,
    message: `Automatic install not supported on ${platform}. Visit https://tailscale.com/download`,
  };
}

export interface LoginResult {
  success: boolean;
  /** Auth URL the user must open in a browser (null if already logged in). */
  authUrl: string | null;
  message: string;
}

/**
 * Start Tailscale login. Runs `sudo tailscale up` which outputs an auth URL.
 *
 * The returned authUrl should be displayed to the user. The function resolves
 * once `tailscale up` completes (user finished auth) or times out.
 */
export async function loginTailscale(onOutput?: (line: string) => void): Promise<LoginResult> {
  // `tailscale up` prints the auth URL to stderr and blocks until auth completes.
  const authUrlPattern = /https:\/\/login\.tailscale\.com\/[^\s]+/;
  let authUrl: string | null = null;

  const { code, stderr } = await runSudoCommand("tailscale", ["up"], {
    timeoutMs: 180_000, // 3 min for user to authenticate
    onOutput: (line) => {
      const match = authUrlPattern.exec(line);
      if (match) authUrl = match[0];
      onOutput?.(line);
    },
  });

  if (code === 0) {
    return {
      success: true,
      authUrl,
      message: "Tailscale login successful.",
    };
  }

  // Extract auth URL from stderr even if process was killed / timed out.
  if (!authUrl) {
    const match = authUrlPattern.exec(stderr);
    if (match) authUrl = match[0];
  }

  return {
    success: false,
    authUrl,
    message: `tailscale up exited with code ${code}. ${stderr.slice(-200)}`,
  };
}

// ---------------------------------------------------------------------------
// Funnel setup / teardown
// ---------------------------------------------------------------------------

interface FunnelRouteOpts {
  port: number;
  localUrl: string;
  logger: TunnelLogger;
}

async function setupFunnelRoute(opts: FunnelRouteOpts): Promise<boolean> {
  // tailscale funnel --bg --yes --set-path / <port> <localUrl>
  // For port-specific funnel: tailscale funnel <port> <localUrl>
  const args = ["funnel", "--bg", "--yes", String(opts.port), opts.localUrl];
  const { code, stderr } = await runTailscaleCommand(args, 15_000);
  if (code !== 0) {
    opts.logger.warn(
      `[stimm-voice] Tailscale funnel setup failed for port ${opts.port}: ${stderr}`,
    );
    return false;
  }
  return true;
}

async function cleanupFunnelRoute(port: number): Promise<void> {
  await runTailscaleCommand(["funnel", "off", String(port)], 5000);
}

/**
 * Set up Tailscale Funnel routes for the gateway and LiveKit.
 *
 * @returns TunnelInfo with public URLs, or null if setup fails.
 */
export async function setupTunnel(
  config: StimmVoiceConfig,
  gatewayPort: number,
  logger: TunnelLogger,
): Promise<TunnelInfo | null> {
  if (config.tunnel.provider === "none") {
    return null;
  }

  // Verify Tailscale is available and logged in.
  const status = await getTailscaleStatus();
  if (!status.installed) {
    logger.error(
      "[stimm-voice] Tailscale is not installed. Install it from https://tailscale.com/download",
    );
    return null;
  }
  if (!status.loggedIn || !status.dnsName) {
    logger.error("[stimm-voice] Tailscale is not logged in. Run: tailscale login");
    return null;
  }

  const { dnsName } = status;
  const gwFunnelPort = config.tunnel.gatewayFunnelPort;
  const lkFunnelPort = config.tunnel.livekitFunnelPort;

  // Resolve local LiveKit port from the URL (ws://localhost:7880 → 7880).
  const lkUrl = new URL(
    config.livekit.url.replace("ws://", "http://").replace("wss://", "https://"),
  );
  const lkLocalPort = lkUrl.port || "7880";

  logger.info(
    `[stimm-voice] Setting up Tailscale Funnel: gateway :${gwFunnelPort} → :${gatewayPort}, LiveKit :${lkFunnelPort} → :${lkLocalPort}`,
  );

  // Set up gateway funnel.
  const gwOk = await setupFunnelRoute({
    port: gwFunnelPort,
    localUrl: `http://127.0.0.1:${gatewayPort}`,
    logger,
  });

  if (!gwOk) {
    logger.error("[stimm-voice] Failed to set up gateway tunnel.");
    return null;
  }

  // Set up LiveKit funnel.
  const lkOk = await setupFunnelRoute({
    port: lkFunnelPort,
    localUrl: `http://127.0.0.1:${lkLocalPort}`,
    logger,
  });

  if (!lkOk) {
    logger.warn("[stimm-voice] Failed to set up LiveKit tunnel. Voice may not work remotely.");
    // Still return gateway URL — partial setup is better than nothing.
  }

  const gatewayPortSuffix = gwFunnelPort === 443 ? "" : `:${gwFunnelPort}`;
  const livekitPortSuffix = lkFunnelPort === 443 ? "" : `:${lkFunnelPort}`;

  const info: TunnelInfo = {
    gatewayUrl: `https://${dnsName}${gatewayPortSuffix}${config.web.path}`,
    livekitUrl: `wss://${dnsName}${livekitPortSuffix}`,
    dnsName,
  };

  logger.info(`[stimm-voice] 🌐 Public voice URL: ${info.gatewayUrl}`);
  logger.info(`[stimm-voice] 🔗 Public LiveKit URL: ${info.livekitUrl}`);

  return info;
}

/** Tear down Tailscale Funnel routes. */
export async function cleanupTunnel(config: StimmVoiceConfig): Promise<void> {
  if (config.tunnel.provider === "none") return;
  await Promise.all([
    cleanupFunnelRoute(config.tunnel.gatewayFunnelPort),
    cleanupFunnelRoute(config.tunnel.livekitFunnelPort),
  ]);
}
