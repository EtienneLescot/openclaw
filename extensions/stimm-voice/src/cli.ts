/**
 * CLI subcommand registration for the stimm-voice plugin.
 *
 * Exposes `openclaw voice [start|stop|status|setup]` commands.
 */

import qrcode from "qrcode-terminal";
import type { StimmVoiceConfig } from "./config.js";

type VoiceSession = {
  roomName: string;
  clientToken: string;
  createdAt: number;
  originChannel: string;
  supervisor: { connected: boolean };
  shareUrl?: string;
  claimToken?: string;
};

type RoomManager = {
  createSession: (opts: { roomName?: string; originChannel: string }) => Promise<VoiceSession>;
  endSession: (room: string) => Promise<boolean>;
  listSessions: () => VoiceSession[];
};

function renderQrAscii(data: string): Promise<string> {
  return new Promise((resolve) => {
    qrcode.generate(data, { small: true }, (output: string) => {
      resolve(output.trimEnd());
    });
  });
}

interface VoiceCliDeps {
  program: {
    command: (name: string) => {
      description: (d: string) => any;
      option: (flags: string, desc: string, defaultValue?: string) => any;
      action: (fn: (...args: any[]) => Promise<void>) => any;
    };
  };
  config: StimmVoiceConfig;
  ensureRuntime: () => Promise<{ roomManager: RoomManager }>;
  logger: { info: (message: string) => void; error: (message: string) => void };
  /** Extension root directory (for venv detection in setup). */
  extensionDir?: string;
}

export function registerStimmVoiceCli(deps: VoiceCliDeps): void {
  const { program, config, ensureRuntime, logger } = deps;

  const voice = program,
    cmd = voice.command("voice");
  cmd
    .description("Stimm voice session management")
    .option("--channel <channel>", "Origin channel for routing", "web");

  const start = program.command("voice:start");
  start
    .description("Start a new voice session")
    .option("--channel <channel>", "Origin channel", "web")
    .option("--room <name>", "Custom room name")
    .option("--wait", "Keep process alive and end the session on exit (Ctrl+C / SIGTERM)")
    .action(async (opts: { channel: string; room?: string; wait?: boolean }) => {
      if (!config.enabled) {
        logger.error("[stimm-voice] Plugin is disabled. Set stimm-voice.enabled=true in config.");
        return;
      }
      const rt = await ensureRuntime();
      const session = await rt.roomManager.createSession({
        roomName: opts.room,
        originChannel: opts.channel,
      });
      logger.info(`Voice session started!`);
      logger.info(`  Room:  ${session.roomName}`);
      if (session.shareUrl) {
        logger.info(`  Share URL: ${session.shareUrl}`);
        if (session.claimToken) {
          logger.info(`  Claim token: ${session.claimToken}`);
        }
        const qr = await renderQrAscii(session.shareUrl);
        logger.info("  Scan this QR code from your phone:");
        logger.info("");
        for (const line of qr.split("\n")) {
          logger.info(`  ${line}`);
        }
        logger.info("");
        logger.info(`  Open the Share URL on your phone to connect.`);
      } else {
        logger.info(`  Token: ${session.clientToken}`);
        logger.info(`  Use this token to connect from a LiveKit client.`);
      }

      if (opts.wait) {
        logger.info(`  Press Ctrl+C (or send SIGTERM) to end the session and exit.`);
        let exiting = false;
        const cleanup = async () => {
          if (exiting) return;
          exiting = true;
          logger.info(`\n[stimm-voice] Ending session "${session.roomName}"…`);
          try {
            const rt2 = await ensureRuntime();
            const ok = await rt2.roomManager.endSession(session.roomName);
            if (ok) {
              logger.info(`[stimm-voice] Session ended.`);
            } else {
              logger.info(`[stimm-voice] Session already gone (remote teardown?).`);
            }
          } catch (err) {
            logger.error(
              `[stimm-voice] Failed to end session: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          process.exit(0);
        };
        process.once("SIGINT", () => void cleanup());
        process.once("SIGTERM", () => void cleanup());
        // Keep the event loop alive until a signal fires.
        await new Promise<void>((_resolve) => {
          /* intentionally unresolved — exits via signal handlers above */
        });
      }
    });

  const stop = program.command("voice:stop");
  stop
    .description("Stop a voice session")
    .option("--room <name>", "Room name to stop")
    .action(async (opts: { room: string }) => {
      if (!opts.room) {
        logger.error("--room is required");
        return;
      }
      const rt = await ensureRuntime();
      const ok = await rt.roomManager.endSession(opts.room);
      if (ok) {
        logger.info(`Voice session stopped: ${opts.room}`);
      } else {
        logger.error(`No active session found: ${opts.room}`);
      }
    });

  const status = program.command("voice:status");
  status.description("List active voice sessions").action(async () => {
    const rt = await ensureRuntime();
    const sessions = rt.roomManager.listSessions();
    if (sessions.length === 0) {
      logger.info("No active voice sessions.");
      return;
    }
    for (const s of sessions) {
      const age = Math.round((Date.now() - s.createdAt) / 1000);
      logger.info(
        `  ${s.roomName}  channel=${s.originChannel}  age=${age}s  supervisor=${s.supervisor.connected ? "connected" : "disconnected"}`,
      );
    }
  });

  const setup = program.command("voice:setup");
  setup
    .description("Interactive setup wizard — choose providers, models, and API keys")
    .action(async () => {
      const { runSetupWizard } = await import("./setup-wizard.js");
      await runSetupWizard({
        logger,
        extensionDir: deps.extensionDir ?? "",
      });
    });

  const doctor = program.command("voice:doctor");
  doctor.description("Check voice pipeline prerequisites").action(async () => {
    const { spawnSync } = await import("node:child_process");

    if (config.access.mode === "quick-tunnel") {
      const probe = spawnSync("cloudflared", ["--version"], { encoding: "utf8" });
      if (probe.status === 0) {
        logger.info("  ✅ cloudflared: installed");
      } else {
        logger.info(
          "  ❌ cloudflared: not installed — https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
        );
      }
      logger.info("  ℹ️  Access mode: quick-tunnel");
    } else {
      logger.info("  ℹ️  Access mode: none (no public tunnel)");
    }

    // Check LiveKit config.
    logger.info(`  ℹ️  LiveKit: ${config.livekit.url}`);

    // Check plugin enabled.
    if (config.enabled) {
      logger.info("  ✅ Plugin: enabled");
    } else {
      logger.info("  ❌ Plugin: disabled — set stimm-voice.enabled=true");
    }
  });
}
