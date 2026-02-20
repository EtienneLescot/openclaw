/**
 * NodeSupervisorClient — Node.js-native replacement for StimmSupervisorClient.
 *
 * Uses @livekit/rtc-node (Rust/FFI) instead of livekit-client (browser WebRTC).
 * Connects to a LiveKit room as a data-only participant, receives Stimm
 * protocol messages, and sends instructions back to the voice agent.
 *
 * Drop-in replacement for StimmSupervisorClient from @stimm/protocol in
 * server-side / Node.js environments where WebRTC APIs are not available.
 */

import { Room, RoomEvent, dispose } from "@livekit/rtc-node";
import type {
  TranscriptMessage,
  StateMessage,
  BeforeSpeakMessage,
  MetricsMessage,
  InstructionMessage,
  ContextMessage,
  ActionResultMessage,
  ModeMessage,
  OverrideMessage,
  StimmMessage,
  AgentMode,
} from "@stimm/protocol";
import { STIMM_TOPIC } from "@stimm/protocol";

// ---------------------------------------------------------------------------
// Event types (mirror @stimm/protocol)
// ---------------------------------------------------------------------------

type VoiceAgentEventMap = {
  transcript: TranscriptMessage;
  state: StateMessage;
  before_speak: BeforeSpeakMessage;
  metrics: MetricsMessage;
};

type VoiceAgentEvent = keyof VoiceAgentEventMap;
type EventHandler<T> = (msg: T) => void | Promise<void>;

export interface NodeSupervisorClientOptions {
  livekitUrl: string;
  token: string;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class NodeSupervisorClient {
  private room: Room;
  private url: string;
  private token: string;
  private handlers: Map<string, Array<EventHandler<unknown>>> = new Map();
  private _connected = false;

  constructor(options: NodeSupervisorClientOptions) {
    this.url = options.livekitUrl;
    this.token = options.token;
    this.room = new Room();
  }

  get connected(): boolean {
    return this._connected;
  }

  // -- Connection -----------------------------------------------------------

  async connect(): Promise<void> {
    this.room.on(RoomEvent.DataReceived, this.onData.bind(this));
    await this.room.connect(this.url, this.token, { autoSubscribe: true, dynacast: false });
    this._connected = true;
  }

  async disconnect(): Promise<void> {
    await this.room.disconnect();
    // dispose() shuts down the Rust FFI event loop; call once per process
    // exit if you have no other @livekit/rtc-node rooms open.
    try {
      await dispose();
    } catch {
      // ignore — already disposed
    }
    this._connected = false;
  }

  // -- Event handling -------------------------------------------------------

  on<E extends VoiceAgentEvent>(event: E, handler: EventHandler<VoiceAgentEventMap[E]>): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler as EventHandler<unknown>);
    this.handlers.set(event, list);
  }

  off<E extends VoiceAgentEvent>(event: E, handler: EventHandler<VoiceAgentEventMap[E]>): void {
    const list = this.handlers.get(event);
    if (!list) return;
    const idx = list.indexOf(handler as EventHandler<unknown>);
    if (idx >= 0) list.splice(idx, 1);
  }

  private onData(payload: Uint8Array, _participant: unknown, _kind: unknown, topic?: string): void {
    if (topic !== STIMM_TOPIC) return;

    try {
      const text = new TextDecoder().decode(payload);
      const msg = JSON.parse(text) as StimmMessage;
      const handlers = this.handlers.get(msg.type) ?? [];
      for (const handler of handlers) {
        Promise.resolve(handler(msg)).catch((err) => {
          console.error(`[stimm] Error in ${msg.type} handler:`, err);
        });
      }
    } catch (err) {
      console.error("[stimm] Failed to deserialize message:", err);
    }
  }

  // -- Sending --------------------------------------------------------------

  private async send(msg: Record<string, unknown>): Promise<void> {
    if (!this.room.localParticipant) {
      throw new Error("[stimm] Not connected — localParticipant is undefined");
    }
    const payload = new TextEncoder().encode(JSON.stringify(msg));
    await this.room.localParticipant.publishData(payload, {
      reliable: true,
      topic: STIMM_TOPIC,
    });
  }

  async instruct(msg: Omit<InstructionMessage, "type">): Promise<void> {
    await this.send({ type: "instruction", ...msg });
  }

  async addContext(msg: Omit<ContextMessage, "type">): Promise<void> {
    await this.send({ type: "context", ...msg });
  }

  async sendActionResult(msg: Omit<ActionResultMessage, "type">): Promise<void> {
    await this.send({ type: "action_result", ...msg });
  }

  async setMode(mode: AgentMode): Promise<void> {
    await this.send({ type: "mode", mode } satisfies ModeMessage);
  }

  async override(msg: Omit<OverrideMessage, "type">): Promise<void> {
    await this.send({ type: "override", ...msg });
  }
}
