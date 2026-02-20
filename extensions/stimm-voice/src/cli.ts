/**
 * CLI subcommand registration for the stimm-voice plugin.
 *
 * Exposes `openclaw voice [start|stop|status|join]` commands.
 */

import type { RoomManager } from "./room-manager.js";
import type { StimmVoiceConfig } from "./config.js";

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
  status
    .description("List active voice sessions")
    .action(async () => {
      const rt = await ensureRuntime();
      const sessions = rt.roomManager.listSessions();
      if (sessions.length === 0) {
        logger.info("No active voice sessions.");
        return;
      }
      for (const s of sessions) {
        const age = Math.round((Date.now() - s.createdAt) / 1000);
        logger.info(`  ${s.roomName}  channel=${s.originChannel}  age=${age}s  supervisor=${s.supervisor.connected ? "connected" : "disconnected"}`);
      }
    });
}
