/**
 * RoomManager — manages LiveKit rooms for Stimm voice sessions.
 *
 * Creates rooms, generates tokens, connects supervisors,
 * and tracks active voice sessions.
 */

import { RoomServiceClient, AccessToken, VideoGrant } from "livekit-server-sdk";
import type { LiveKitConfig, VoiceAgentConfig } from "./config.js";
import { OpenClawSupervisor, type SupervisorDeps, type SupervisorOptions } from "./supervisor.js";

export interface VoiceSession {
  roomName: string;
  supervisor: OpenClawSupervisor;
  clientToken: string;
  createdAt: number;
  originChannel: string;
}

export interface RoomManagerOptions {
  livekit: LiveKitConfig;
  voiceAgent: VoiceAgentConfig;
  supervisorDeps: SupervisorDeps;
}

export class RoomManager {
  private livekit: LiveKitConfig;
  private sessions = new Map<string, VoiceSession>();
  private roomService: RoomServiceClient;
  private supervisorDeps: SupervisorDeps;
  private logger: SupervisorDeps["logger"];

  constructor(opts: RoomManagerOptions) {
    this.livekit = opts.livekit;
    this.supervisorDeps = opts.supervisorDeps;
    this.logger = opts.supervisorDeps.logger;
    const httpUrl = opts.livekit.url.replace("ws://", "http://").replace("wss://", "https://");
    this.roomService = new RoomServiceClient(httpUrl, opts.livekit.apiKey, opts.livekit.apiSecret);
  }

  /** Create a new voice session: LiveKit room + supervisor. */
  async createSession(opts: {
    roomName?: string;
    originChannel: string;
    userIdentity?: string;
  }): Promise<VoiceSession> {
    const roomName = opts.roomName ?? `stimm-${randomHex(8)}`;

    // Create the LiveKit room.
    await this.roomService.createRoom({ name: roomName });
    this.logger.info(`[stimm-voice] Created LiveKit room: ${roomName}`);

    // Generate supervisor token (data-only, no audio).
    const supervisorToken = await this.generateToken({
      identity: "stimm-supervisor",
      roomName,
      canPublish: false,
      canSubscribe: true,
      canPublishData: true,
    });

    // Create and connect the OpenClaw supervisor.
    const supervisorOpts: SupervisorOptions = {
      livekitUrl: this.livekit.url,
      token: supervisorToken,
      roomName,
      originChannel: opts.originChannel,
    };
    const supervisor = new OpenClawSupervisor(this.supervisorDeps, supervisorOpts);
    await supervisor.connect();

    // Generate client token (audio + data).
    const clientToken = await this.generateToken({
      identity: opts.userIdentity ?? "user",
      roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    const session: VoiceSession = {
      roomName,
      supervisor,
      clientToken,
      createdAt: Date.now(),
      originChannel: opts.originChannel,
    };

    this.sessions.set(roomName, session);
    this.logger.info(
      `[stimm-voice] Voice session started: ${roomName} (origin: ${opts.originChannel})`,
    );
    return session;
  }

  /** End a voice session and clean up. */
  async endSession(roomName: string): Promise<boolean> {
    const session = this.sessions.get(roomName);
    if (!session) return false;

    try {
      await session.supervisor.disconnect();
    } catch {
      // Best-effort disconnect.
    }

    try {
      await this.roomService.deleteRoom(roomName);
    } catch {
      // Room may already be gone.
    }

    this.sessions.delete(roomName);
    this.logger.info(`[stimm-voice] Voice session ended: ${roomName}`);
    return true;
  }

  /** Get an active session by room name. */
  getSession(roomName: string): VoiceSession | undefined {
    return this.sessions.get(roomName);
  }

  /** List all active sessions. */
  listSessions(): VoiceSession[] {
    return [...this.sessions.values()];
  }

  /** End all sessions (called on stop). */
  async stopAll(): Promise<void> {
    const rooms = [...this.sessions.keys()];
    await Promise.allSettled(rooms.map((r) => this.endSession(r)));
  }

  // -- Token generation -----------------------------------------------------

  private async generateToken(opts: {
    identity: string;
    roomName: string;
    canPublish?: boolean;
    canSubscribe?: boolean;
    canPublishData?: boolean;
    ttlSeconds?: number;
  }): Promise<string> {
    const token = new AccessToken(this.livekit.apiKey, this.livekit.apiSecret, {
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

function randomHex(bytes: number): string {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  return [...array].map((b) => b.toString(16).padStart(2, "0")).join("");
}
