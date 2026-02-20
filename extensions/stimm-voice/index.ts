/**
 * Stimm Voice — OpenClaw plugin entry point.
 *
 * Dual-agent voice sessions: a fast VoiceAgent (Python/LiveKit) handles
 * real-time audio while an OpenClaw Supervisor (TypeScript) provides
 * reasoning, tools, and context via the Stimm data-channel protocol.
 */

import { dirname, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import type { GatewayRequestHandlerOptions, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { AgentProcess } from "./src/agent-process.js";
import { registerStimmVoiceCli } from "./src/cli.js";
import { resolveStimmVoiceConfig, type StimmVoiceConfig } from "./src/config.js";
import type { CoreConfig } from "./src/core-bridge.js";
import { generateStimmResponse } from "./src/response-generator.js";
import { RoomManager, type VoiceSession } from "./src/room-manager.js";
import type { SupervisorDeps } from "./src/supervisor.js";

// ---------------------------------------------------------------------------
// Tool schema — flat object, no Type.Union (per repo guardrails).
// ---------------------------------------------------------------------------

const ACTIONS = [
  "start_session",
  "end_session",
  "instruct",
  "add_context",
  "set_mode",
  "status",
] as const;

function stringEnum<T extends readonly string[]>(values: T, opts: { description?: string } = {}) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    ...opts,
  });
}

const StimmVoiceToolSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description: `Action: ${ACTIONS.join(", ")}`,
  }),
  room: Type.Optional(
    Type.String({
      description: "Room name (for end_session, instruct, add_context, set_mode, status)",
    }),
  ),
  channel: Type.Optional(Type.String({ description: "Origin channel for routing (default: web)" })),
  text: Type.Optional(
    Type.String({ description: "Text to instruct the voice agent, or context to add" }),
  ),
  mode: Type.Optional(
    stringEnum(["autonomous", "relay", "hybrid"] as const, { description: "Voice agent mode" }),
  ),
  speak: Type.Optional(
    Type.Boolean({ description: "Whether the voice agent should speak the instruction aloud" }),
  ),
});

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const stimmVoicePlugin = {
  id: "stimm-voice",
  name: "Stimm Voice",
  description: "Real-time voice conversations powered by Stimm dual-agent architecture",

  register(api: OpenClawPluginApi) {
    const config = resolveStimmVoiceConfig(api.pluginConfig);

    // -- Lazy runtime -------------------------------------------------------

    let roomManager: RoomManager | null = null;
    let roomManagerPromise: Promise<RoomManager> | null = null;
    let agentProcess: AgentProcess | null = null;

    const ensureRuntime = async (): Promise<{ roomManager: RoomManager }> => {
      if (!config.enabled) {
        throw new Error("[stimm-voice] Plugin is disabled. Set stimm-voice.enabled=true.");
      }
      if (roomManager) return { roomManager };
      if (!roomManagerPromise) {
        roomManagerPromise = initRoomManager(config, api);
      }
      roomManager = await roomManagerPromise;
      return { roomManager };
    };

    // -- Gateway methods ----------------------------------------------------

    const sendError = (respond: (ok: boolean, payload?: unknown) => void, err: unknown) => {
      respond(false, { error: err instanceof Error ? err.message : String(err) });
    };

    api.registerGatewayMethod(
      "stimm.start",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const rt = await ensureRuntime();
          const session = await rt.roomManager.createSession({
            roomName: typeof params?.room === "string" ? params.room : undefined,
            originChannel: typeof params?.channel === "string" ? params.channel : "web",
          });
          respond(true, sessionPayload(session));
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "stimm.end",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const room = typeof params?.room === "string" ? params.room.trim() : "";
          if (!room) {
            respond(false, { error: "room required" });
            return;
          }
          const rt = await ensureRuntime();
          const ok = await rt.roomManager.endSession(room);
          respond(ok, ok ? { ended: true } : { error: "session not found" });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "stimm.instruct",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const room = typeof params?.room === "string" ? params.room.trim() : "";
          const text = typeof params?.text === "string" ? params.text.trim() : "";
          if (!room || !text) {
            respond(false, { error: "room and text required" });
            return;
          }
          const rt = await ensureRuntime();
          const session = rt.roomManager.getSession(room);
          if (!session) {
            respond(false, { error: "session not found" });
            return;
          }
          const speak = typeof params?.speak === "boolean" ? params.speak : true;
          await session.supervisor.instruct(text, { speak });
          respond(true, { instructed: true });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "stimm.status",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const rt = await ensureRuntime();
          const room = typeof params?.room === "string" ? params.room.trim() : "";
          if (room) {
            const session = rt.roomManager.getSession(room);
            respond(true, session ? sessionPayload(session) : { found: false });
          } else {
            const sessions = rt.roomManager.listSessions().map(sessionPayload);
            respond(true, {
              sessions,
              agent: agentProcess
                ? { running: agentProcess.running, pid: agentProcess.pid }
                : { running: false, pid: null },
            });
          }
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "stimm.mode",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const room = typeof params?.room === "string" ? params.room.trim() : "";
          const mode = typeof params?.mode === "string" ? params.mode.trim() : "";
          if (!room || !mode) {
            respond(false, { error: "room and mode required" });
            return;
          }
          if (!["autonomous", "relay", "hybrid"].includes(mode)) {
            respond(false, { error: `Invalid mode: ${mode}` });
            return;
          }
          const rt = await ensureRuntime();
          const session = rt.roomManager.getSession(room);
          if (!session) {
            respond(false, { error: "session not found" });
            return;
          }
          await session.supervisor.setMode(mode as "autonomous" | "relay" | "hybrid");
          respond(true, { mode });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    // -- Tool ---------------------------------------------------------------

    api.registerTool({
      name: "stimm_voice",
      label: "Stimm Voice",
      description:
        "Start, control, and end real-time voice sessions. " +
        "Uses Stimm dual-agent architecture: a fast VoiceAgent handles audio " +
        "while OpenClaw provides reasoning and tools.",
      parameters: StimmVoiceToolSchema,
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const json = (payload: unknown) => ({
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          details: payload,
        });

        try {
          const rt = await ensureRuntime();
          const action = typeof params?.action === "string" ? params.action : "";

          switch (action) {
            case "start_session": {
              const session = await rt.roomManager.createSession({
                roomName: typeof params.room === "string" ? params.room : undefined,
                originChannel: typeof params.channel === "string" ? params.channel : "web",
              });
              return json(sessionPayload(session));
            }

            case "end_session": {
              const room = String(params.room || "").trim();
              if (!room) throw new Error("room required");
              const ok = await rt.roomManager.endSession(room);
              if (!ok) throw new Error("session not found");
              return json({ ended: true, room });
            }

            case "instruct": {
              const room = String(params.room || "").trim();
              const text = String(params.text || "").trim();
              if (!room || !text) throw new Error("room and text required");
              const session = rt.roomManager.getSession(room);
              if (!session) throw new Error("session not found");
              const speak = typeof params.speak === "boolean" ? params.speak : true;
              await session.supervisor.instruct(text, { speak });
              return json({ instructed: true, room });
            }

            case "add_context": {
              const room = String(params.room || "").trim();
              const text = String(params.text || "").trim();
              if (!room || !text) throw new Error("room and text required");
              const session = rt.roomManager.getSession(room);
              if (!session) throw new Error("session not found");
              await session.supervisor.addContext(text);
              return json({ context_added: true, room });
            }

            case "set_mode": {
              const room = String(params.room || "").trim();
              const mode = String(params.mode || "").trim();
              if (!room || !mode) throw new Error("room and mode required");
              if (!["autonomous", "relay", "hybrid"].includes(mode)) {
                throw new Error(`Invalid mode: ${mode}`);
              }
              const session = rt.roomManager.getSession(room);
              if (!session) throw new Error("session not found");
              await session.supervisor.setMode(mode as "autonomous" | "relay" | "hybrid");
              return json({ mode, room });
            }

            case "status": {
              const room = typeof params.room === "string" ? params.room.trim() : "";
              if (room) {
                const session = rt.roomManager.getSession(room);
                return json(session ? sessionPayload(session) : { found: false });
              }
              return json({
                sessions: rt.roomManager.listSessions().map(sessionPayload),
                agent: agentProcess
                  ? { running: agentProcess.running, pid: agentProcess.pid }
                  : { running: false, pid: null },
              });
            }

            default:
              throw new Error(`Unknown action: ${action}`);
          }
        } catch (err) {
          return json({
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    });

    // -- CLI ----------------------------------------------------------------

    api.registerCli(
      ({ program }) =>
        registerStimmVoiceCli({
          program,
          config,
          ensureRuntime,
          logger: api.logger,
        }),
      { commands: ["voice"] },
    );

    // -- Service lifecycle --------------------------------------------------

    api.registerService({
      id: "stimm-voice",
      start: async () => {
        if (!config.enabled) return;
        try {
          await ensureRuntime();
          api.logger.info("[stimm-voice] Service started.");
        } catch (err) {
          api.logger.error(
            `[stimm-voice] Failed to start: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        // Auto-spawn the Python voice agent if configured.
        if (config.voiceAgent.spawn.autoSpawn) {
          const extensionDir = resolve(dirname(api.source));
          const pythonPath =
            config.voiceAgent.spawn.pythonPath ||
            AgentProcess.resolveDefaultPythonPath(extensionDir);
          const agentScript =
            config.voiceAgent.spawn.agentScript ||
            AgentProcess.resolveDefaultAgentScript(extensionDir);

          // Forward per-pipeline provider config as STIMM_* env vars.
          const env: Record<string, string> = {
            STIMM_STT_PROVIDER: config.voiceAgent.stt.provider,
            STIMM_STT_MODEL: config.voiceAgent.stt.model,
            STIMM_TTS_PROVIDER: config.voiceAgent.tts.provider,
            STIMM_TTS_MODEL: config.voiceAgent.tts.model,
            STIMM_TTS_VOICE: config.voiceAgent.tts.voice,
            STIMM_LLM_PROVIDER: config.voiceAgent.llm.provider,
            STIMM_LLM_MODEL: config.voiceAgent.llm.model,
            STIMM_BUFFERING: config.voiceAgent.bufferingLevel,
            STIMM_MODE: config.voiceAgent.mode,
          };
          // Per-pipeline API keys (only set if resolved).
          if (config.voiceAgent.stt.apiKey) env.STIMM_STT_API_KEY = config.voiceAgent.stt.apiKey;
          if (config.voiceAgent.tts.apiKey) env.STIMM_TTS_API_KEY = config.voiceAgent.tts.apiKey;
          if (config.voiceAgent.llm.apiKey) env.STIMM_LLM_API_KEY = config.voiceAgent.llm.apiKey;
          // Language (optional).
          if (config.voiceAgent.stt.language) {
            env.STIMM_STT_LANGUAGE = config.voiceAgent.stt.language;
          }

          agentProcess = new AgentProcess({
            pythonPath,
            agentScript,
            livekitUrl: config.livekit.url,
            livekitApiKey: config.livekit.apiKey,
            livekitApiSecret: config.livekit.apiSecret,
            env,
            maxRestarts: config.voiceAgent.spawn.maxRestarts,
            logger: api.logger,
          });
          agentProcess.start();
        }
      },
      stop: async () => {
        // Stop the Python agent first.
        if (agentProcess) {
          agentProcess.stop();
          agentProcess = null;
        }

        if (!roomManagerPromise) return;
        try {
          const rm = await roomManagerPromise;
          await rm.stopAll();
          api.logger.info("[stimm-voice] Service stopped — all sessions ended.");
        } finally {
          roomManagerPromise = null;
          roomManager = null;
        }
      },
    });

    // -- HTTP route (web voice endpoint) ------------------------------------

    if (config.web.enabled) {
      api.registerHttpRoute({
        path: config.web.path,
        handler: async (req, res) => {
          if (req.method === "POST") {
            // Start a new session and return client token for the browser SDK.
            try {
              const rt = await ensureRuntime();
              const session = await rt.roomManager.createSession({
                originChannel: "web",
              });
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify(sessionPayload(session)));
            } catch (err) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
            }
          } else {
            // GET — return a minimal info page.
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                plugin: "stimm-voice",
                status: config.enabled ? "enabled" : "disabled",
                hint: "POST to this endpoint to start a web voice session.",
              }),
            );
          }
        },
      });
    }
  },
};

export default stimmVoicePlugin;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function initRoomManager(
  config: StimmVoiceConfig,
  api: OpenClawPluginApi,
): Promise<RoomManager> {
  const coreConfig = api.config as CoreConfig;

  const supervisorDeps: SupervisorDeps = {
    processMessage: async (text, opts) => {
      // Route transcript through the embedded Pi agent (same infra as voice-call).
      // Maintains a per-room session with full tool access and conversation history.
      api.logger.info(
        `[stimm-voice] Processing transcript from ${opts.roomName} (${opts.channel}): "${text.slice(0, 80)}"`,
      );

      const result = await generateStimmResponse({
        coreConfig,
        roomName: opts.roomName,
        channel: opts.channel,
        text,
      });

      if (result.error) {
        api.logger.error(`[stimm-voice] Agent error: ${result.error}`);
      }

      return result.text ?? "";
    },
    logger: api.logger,
  };

  return new RoomManager({
    livekit: config.livekit,
    voiceAgent: config.voiceAgent,
    supervisorDeps,
  });
}

/** Serialize a VoiceSession for gateway/tool responses (omit internals). */
function sessionPayload(session: VoiceSession) {
  return {
    room: session.roomName,
    clientToken: session.clientToken,
    channel: session.originChannel,
    createdAt: session.createdAt,
    supervisorConnected: session.supervisor.connected,
  };
}
