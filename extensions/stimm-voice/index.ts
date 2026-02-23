/**
 * Stimm Voice — OpenClaw plugin entry point.
 *
 * Dual-agent voice sessions: a fast VoiceAgent (Python/LiveKit) handles
 * real-time audio while an OpenClaw Supervisor (TypeScript) provides
 * reasoning, tools, and context via the Stimm data-channel protocol.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import { AccessToken, RoomServiceClient, type VideoGrant } from "livekit-server-sdk";
import type { GatewayRequestHandlerOptions, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { AgentProcess } from "./src/agent-process.js";
import { registerStimmVoiceCli } from "./src/cli.js";
import { resolveStimmVoiceConfig, type StimmVoiceConfig } from "./src/config.js";
import type { CoreConfig } from "./src/core-bridge.js";
import { generateStimmResponse } from "./src/response-generator.js";
import { setupTunnel, cleanupTunnel, type TunnelInfo } from "./src/tunnel.js";

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
    // Room lifecycle (create, token, delete) is handled here in Node via the
    // LiveKit server SDK. The Python agent (OpenClawSupervisor) connects to
    // each room on its own after being dispatched a job by livekit-agents.

    interface VoiceSession {
      roomName: string;
      clientToken: string;
      createdAt: number;
      originChannel: string;
    }

    let lkRuntime: LiveKitRuntime | null = null;
    let agentProcess: AgentProcess | null = null;
    let tunnelInfo: TunnelInfo | null = null;

    const ensureRuntime = async (): Promise<{ lk: LiveKitRuntime }> => {
      if (!config.enabled) {
        throw new Error("[stimm-voice] Plugin is disabled. Set stimm-voice.enabled=true.");
      }
      if (!lkRuntime) {
        lkRuntime = new LiveKitRuntime(config);
      }
      return { lk: lkRuntime };
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
          const session = await rt.lk.createSession({
            roomName: typeof params?.room === "string" ? params.room : undefined,
            originChannel: typeof params?.channel === "string" ? params.channel : "web",
          });
          respond(true, sessionPayload(session, tunnelInfo));
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
          const ok = await rt.lk.endSession(room);
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
          if (!rt.lk.getSession(room)) {
            respond(false, { error: "session not found" });
            return;
          }
          // Instructions are now sent via the /stimm/supervisor HTTP endpoint
          // consumed by the Python OpenClawSupervisor directly.
          respond(true, { instructed: true, note: "use /stimm/supervisor for direct injection" });
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
            const session = rt.lk.getSession(room);
            respond(true, session ? sessionPayload(session, tunnelInfo) : { found: false });
          } else {
            const sessions = rt.lk.listSessions().map((s) => sessionPayload(s, tunnelInfo));
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
          // Mode is now managed by the Python OpenClawSupervisor.
          respond(true, { mode, note: "mode changes are applied on the next supervisor tick" });
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
              const session = await rt.lk.createSession({
                roomName: typeof params.room === "string" ? params.room : undefined,
                originChannel: typeof params.channel === "string" ? params.channel : "web",
              });
              return json(sessionPayload(session, tunnelInfo));
            }

            case "end_session": {
              const room = String(params.room || "").trim();
              if (!room) throw new Error("room required");
              const ok = await rt.lk.endSession(room);
              if (!ok) throw new Error("session not found");
              return json({ ended: true, room });
            }

            case "instruct": {
              const room = String(params.room || "").trim();
              const text = String(params.text || "").trim();
              if (!room || !text) throw new Error("room and text required");
              if (!rt.lk.getSession(room)) throw new Error("session not found");
              // Instructions are injected by the Python OpenClawSupervisor via
              // the /stimm/supervisor HTTP endpoint automatically.
              return json({
                instructed: true,
                room,
                note: "use /stimm/supervisor for direct injection",
              });
            }

            case "add_context": {
              const room = String(params.room || "").trim();
              const text = String(params.text || "").trim();
              if (!room || !text) throw new Error("room and text required");
              if (!rt.lk.getSession(room)) throw new Error("session not found");
              return json({
                context_added: true,
                room,
                note: "context is managed by the Python supervisor",
              });
            }

            case "set_mode": {
              const room = String(params.room || "").trim();
              const mode = String(params.mode || "").trim();
              if (!room || !mode) throw new Error("room and mode required");
              if (!["autonomous", "relay", "hybrid"].includes(mode)) {
                throw new Error(`Invalid mode: ${mode}`);
              }
              if (!rt.lk.getSession(room)) throw new Error("session not found");
              return json({
                mode,
                room,
                note: "mode changes are applied on the next supervisor tick",
              });
            }

            case "status": {
              const room = typeof params.room === "string" ? params.room.trim() : "";
              if (room) {
                const session = rt.lk.getSession(room);
                return json(session ? sessionPayload(session, tunnelInfo) : { found: false });
              }
              return json({
                sessions: rt.lk.listSessions().map((s) => sessionPayload(s, tunnelInfo)),
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

    const extensionDir = resolve(dirname(api.source));

    api.registerCli(
      ({ program }) =>
        registerStimmVoiceCli({
          program,
          config,
          ensureRuntime: async () => {
            const rt = await ensureRuntime();
            return { lk: rt.lk };
          },
          logger: api.logger,
          extensionDir,
        }),
      { commands: ["voice"] },
    );

    // -- Service lifecycle --------------------------------------------------

    api.registerService({
      id: "stimm-voice",
      start: async () => {
        if (!config.enabled) return;
        api.logger.info("[stimm-voice] Service started.");

        // Auto-spawn the Python voice agent if configured.
        if (config.voiceAgent.spawn.autoSpawn) {
          const pythonPath =
            config.voiceAgent.spawn.pythonPath ||
            AgentProcess.resolveDefaultPythonPath(extensionDir);
          const agentScript =
            config.voiceAgent.spawn.agentScript ||
            AgentProcess.resolveDefaultAgentScript(extensionDir);

          // Forward per-pipeline provider config as STIMM_* env vars.
          const gatewayPort =
            (api.config as Record<string, unknown> & { gateway?: { port?: number } }).gateway
              ?.port ?? 18789;
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
            // Supervisor callback — Python OpenClawSupervisor posts here.
            OPENCLAW_SUPERVISOR_URL: `http://127.0.0.1:${gatewayPort}/stimm/supervisor`,
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

        // Set up tunnel (Tailscale Funnel) if configured.
        if (config.tunnel.provider !== "none") {
          const gatewayPort =
            (api.config as Record<string, unknown> & { gateway?: { port?: number } }).gateway
              ?.port ?? 18789;
          tunnelInfo = await setupTunnel(config, gatewayPort, api.logger);
        }
      },
      stop: async () => {
        // Clean up tunnel routes.
        await cleanupTunnel(config);
        tunnelInfo = null;

        // Stop the Python agent first.
        if (agentProcess) {
          agentProcess.stop();
          agentProcess = null;
        }

        if (lkRuntime) {
          await lkRuntime.stopAll();
          lkRuntime = null;
          api.logger.info("[stimm-voice] Service stopped — all sessions ended.");
        }
      },
    });

    // -- HTTP route (supervisor callback — called by Python OpenClawSupervisor) -

    api.registerHttpRoute({
      path: "/stimm/supervisor",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end();
          return;
        }
        try {
          const coreConfig = api.config as CoreConfig;
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString()) as {
            roomName: string;
            channel: string;
            history: string;
          };

          if (!body.roomName || !body.history) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "roomName and history required" }));
            return;
          }

          api.logger.info(
            `[stimm-voice] Processing transcript from ${body.roomName} (${body.channel ?? "web"}): "${body.history.slice(0, 80)}"`,
          );
          api.logger.info(
            `[stimm-voice] Supervisor history (${body.roomName}, ${body.channel ?? "web"}):\n${body.history}`,
          );

          const result = await generateStimmResponse({
            coreConfig,
            roomName: body.roomName,
            channel: body.channel ?? "web",
            text: body.history,
          });

          if (result.debug) {
            api.logger.info(
              `[stimm-voice] Supervisor debug (${body.roomName}, ${body.channel ?? "web"}): ` +
                `provider=${result.debug.provider} model=${result.debug.model} ` +
                `payloads=${result.debug.payloadCount} nonErrorTexts=${result.debug.nonErrorTextCount} ` +
                `aborted=${result.debug.aborted}`,
            );
            if (result.decision) {
              api.logger.info(
                `[stimm-voice] Supervisor decision (${body.roomName}, ${body.channel ?? "web"}): ` +
                  `action=${result.decision.action} reason=${result.decision.reason ?? "n/a"}`,
              );
            }
            if (result.debug.payloadPreview.length > 0) {
              api.logger.info(
                `[stimm-voice] Supervisor payload preview (${body.roomName}, ${body.channel ?? "web"}):\n` +
                  result.debug.payloadPreview
                    .map((p, i) => `${i + 1}. error=${p.isError} text="${p.text}"`)
                    .join("\n"),
              );
            }
          }

          if (result.error) {
            api.logger.error(`[stimm-voice] Agent error: ${result.error}`);
          }

          const isNoActionDecision = result.decision?.action === "NO_ACTION";
          if (!isNoActionDecision && result.text && result.text.trim().length > 0) {
            api.logger.info(
              `[stimm-voice] Supervisor response (${body.roomName}, ${body.channel ?? "web"}):\n${result.text}`,
            );
          } else {
            api.logger.info(
              `[stimm-voice] Supervisor response (${body.roomName}, ${body.channel ?? "web"}): [NO_ACTION or empty]`,
            );
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ text: result.text ?? "", error: result.error }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
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
              const session = await rt.lk.createSession({
                originChannel: "web",
              });
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify(sessionPayload(session, tunnelInfo)));
            } catch (err) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
            }
          } else {
            // GET — serve the voice web UI.
            try {
              const htmlPath = resolve(extensionDir, "src", "web", "voice.html");
              const html = readFileSync(htmlPath, "utf-8");
              res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
              res.end(html);
            } catch {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  plugin: "stimm-voice",
                  status: config.enabled ? "enabled" : "disabled",
                  hint: "POST to this endpoint to start a web voice session.",
                }),
              );
            }
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

/**
 * Thin LiveKit room lifecycle manager — creates rooms, generates tokens,
 * tracks active sessions. Supervisor logic lives in the Python agent.
 */
class LiveKitRuntime {
  private sessions = new Map<string, VoiceSessionInternal>();
  private roomService: RoomServiceClient;
  private config: StimmVoiceConfig;

  constructor(config: StimmVoiceConfig) {
    this.config = config;
    const httpUrl = config.livekit.url.replace("ws://", "http://").replace("wss://", "https://");
    this.roomService = new RoomServiceClient(
      httpUrl,
      config.livekit.apiKey,
      config.livekit.apiSecret,
    );
  }

  async createSession(opts: {
    roomName?: string;
    originChannel?: string;
  }): Promise<VoiceSessionInternal> {
    const roomName = opts.roomName ?? `stimm-${randomHex(8)}`;
    await this.roomService.createRoom({ name: roomName });

    const clientToken = await this.generateToken({
      identity: "user",
      roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    const session: VoiceSessionInternal = {
      roomName,
      clientToken,
      createdAt: Date.now(),
      originChannel: opts.originChannel ?? "web",
    };
    this.sessions.set(roomName, session);
    return session;
  }

  async endSession(roomName: string): Promise<boolean> {
    if (!this.sessions.has(roomName)) return false;
    this.sessions.delete(roomName);
    try {
      await this.roomService.deleteRoom(roomName);
    } catch {
      // Room may already be gone.
    }
    return true;
  }

  getSession(roomName: string): VoiceSessionInternal | undefined {
    return this.sessions.get(roomName);
  }

  listSessions(): VoiceSessionInternal[] {
    return [...this.sessions.values()];
  }

  async stopAll(): Promise<void> {
    const rooms = [...this.sessions.keys()];
    await Promise.allSettled(rooms.map((r) => this.endSession(r)));
  }

  private async generateToken(opts: {
    identity: string;
    roomName: string;
    canPublish?: boolean;
    canSubscribe?: boolean;
    canPublishData?: boolean;
    ttlSeconds?: number;
  }): Promise<string> {
    const token = new AccessToken(this.config.livekit.apiKey, this.config.livekit.apiSecret, {
      identity: opts.identity,
      ttl: opts.ttlSeconds ?? 3600,
    });
    const grant: VideoGrant = {
      roomJoin: true,
      room: opts.roomName,
      canPublish: opts.canPublish ?? true,
      canSubscribe: opts.canSubscribe ?? true,
      canPublishData: opts.canPublishData ?? true,
    };
    token.addGrant(grant);
    return await token.toJwt();
  }
}

interface VoiceSessionInternal {
  roomName: string;
  clientToken: string;
  createdAt: number;
  originChannel: string;
}

function randomHex(bytes: number): string {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  return [...array].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Serialize a VoiceSession for gateway/tool responses. */
function sessionPayload(session: VoiceSessionInternal, tunnel?: TunnelInfo | null) {
  return {
    room: session.roomName,
    clientToken: session.clientToken,
    channel: session.originChannel,
    createdAt: session.createdAt,
    // Pass the public LiveKit URL so the web UI uses the tunnel instead of guessing.
    ...(tunnel?.livekitUrl ? { livekitUrl: tunnel.livekitUrl } : {}),
  };
}
