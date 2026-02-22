/**
 * CLI subcommand registration for the stimm-voice plugin.
 *
 * Exposes `openclaw voice [start|stop|status|setup]` commands.
 */

import type { StimmVoiceConfig } from "./config.js";
import type { RoomManager } from "./room-manager.js";

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
    .action(async (opts: { channel: string; room?: string }) => {
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
      logger.info(`  Token: ${session.clientToken}`);
      logger.info(`  Use this token to connect from a LiveKit client.`);
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
    const { getTailscaleStatus } = await import("./tunnel.js");

    // Check Tailscale.
    const ts = await getTailscaleStatus();
    if (ts.installed) {
      if (ts.loggedIn) {
        logger.info(`  ✅ Tailscale: logged in (${ts.dnsName})`);
      } else {
        logger.info("  ⚠️  Tailscale: installed but not logged in — run `tailscale login`");
      }
    } else {
      logger.info("  ❌ Tailscale: not installed — https://tailscale.com/download");
    }

    // Check tunnel config.
    if (config.tunnel.provider === "tailscale-funnel") {
      if (ts.loggedIn && ts.dnsName) {
        const gwPort =
          config.tunnel.gatewayFunnelPort === 443 ? "" : `:${config.tunnel.gatewayFunnelPort}`;
        logger.info(`  ✅ Tunnel: Tailscale Funnel → https://${ts.dnsName}${gwPort}/voice`);
      } else {
        logger.info("  ⚠️  Tunnel: configured but Tailscale not ready");
      }
    } else {
      logger.info("  ℹ️  Tunnel: none (LAN-only) — run `openclaw voice:setup` to enable");
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
