/**
 * OpenClawSupervisor — TypeScript supervisor that bridges Stimm and OpenClaw.
 *
 * Connects to a LiveKit room via @stimm/protocol, receives real-time
 * transcripts from the VoiceAgent, dispatches them through the OpenClaw
 * agent pipeline, and sends instructions back to the voice agent.
 */

import type {
  TranscriptMessage,
  StateMessage,
  BeforeSpeakMessage,
  MetricsMessage,
} from "@stimm/protocol";
import { NodeSupervisorClient } from "./node-supervisor-client.js";

export interface SupervisorDeps {
  /** Process a user message through the OpenClaw agent and return a text response. */
  processMessage: (text: string, opts: { roomName: string; channel: string }) => Promise<string>;
  logger: {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
    debug?: (message: string) => void;
  };
}

export interface SupervisorOptions {
  livekitUrl: string;
  token: string;
  roomName: string;
  /** Originating channel (e.g. "whatsapp", "web", "telegram") for routing. */
  originChannel: string;
}

/**
 * OpenClaw supervisor — watches voice transcripts, feeds them through
 * the main agent, and sends instructions back to the voice agent.
 */
export class OpenClawSupervisor {
  private client: NodeSupervisorClient;
  private deps: SupervisorDeps;
  private roomName: string;
  private originChannel: string;
  private processing = false;

  /** Accumulated partial transcript for debounce. */
  private pendingText = "";
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceMs = 300;

  constructor(deps: SupervisorDeps, opts: SupervisorOptions) {
    this.deps = deps;
    this.roomName = opts.roomName;
    this.originChannel = opts.originChannel;
    this.client = new NodeSupervisorClient({
      livekitUrl: opts.livekitUrl,
      token: opts.token,
    });

    this.client.on("transcript", this.onTranscript.bind(this));
    this.client.on("state", this.onState.bind(this));
    this.client.on("before_speak", this.onBeforeSpeak.bind(this));
    this.client.on("metrics", this.onMetrics.bind(this));
  }

  /** Connect to the LiveKit room. */
  async connect(): Promise<void> {
    await this.client.connect();
    this.deps.logger.info(`[stimm-voice] Supervisor connected to room ${this.roomName}`);
  }

  /** Disconnect from the room. */
  async disconnect(): Promise<void> {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    await this.client.disconnect();
    this.deps.logger.info(`[stimm-voice] Supervisor disconnected from room ${this.roomName}`);
  }

  get connected(): boolean {
    return this.client.connected;
  }

  // -- Event handlers -------------------------------------------------------

  private async onTranscript(msg: TranscriptMessage): Promise<void> {
    if (msg.partial) {
      // Accumulate partial transcripts — wait for final or debounce timeout.
      this.pendingText = msg.text;
      this.resetDebounce();
      return;
    }

    // Final transcript — cancel debounce and process.
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    await this.processTranscript(msg.text);
  }

  private onState(msg: StateMessage): void {
    this.deps.logger.debug?.(`[stimm-voice] Voice agent state: ${msg.state}`);
  }

  private onBeforeSpeak(msg: BeforeSpeakMessage): void {
    // Could implement review/override logic here in the future.
    this.deps.logger.debug?.(
      `[stimm-voice] Voice agent about to speak: "${msg.text.slice(0, 80)}..."`,
    );
  }

  private onMetrics(msg: MetricsMessage): void {
    this.deps.logger.debug?.(
      `[stimm-voice] Turn ${msg.turn} metrics — total: ${msg.total_ms}ms (VAD: ${msg.vad_ms}, STT: ${msg.stt_ms}, LLM TTFT: ${msg.llm_ttft_ms}, TTS TTFB: ${msg.tts_ttfb_ms})`,
    );
  }

  // -- Core processing ------------------------------------------------------

  private resetDebounce(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(async () => {
      this.debounceTimer = null;
      if (this.pendingText) {
        const text = this.pendingText;
        this.pendingText = "";
        await this.processTranscript(text);
      }
    }, this.debounceMs);
  }

  /**
   * Send a final transcript through the OpenClaw agent pipeline
   * and forward the response as an instruction to the voice agent.
   */
  private async processTranscript(text: string): Promise<void> {
    if (!text.trim()) return;
    if (this.processing) {
      // Queue or drop — for now, log and skip.
      this.deps.logger.debug?.(
        `[stimm-voice] Skipping transcript (still processing previous): "${text.slice(0, 60)}"`,
      );
      return;
    }

    this.processing = true;
    try {
      this.deps.logger.info(`[stimm-voice] Processing: "${text}"`);

      const response = await this.deps.processMessage(text, {
        roomName: this.roomName,
        channel: this.originChannel,
      });

      if (response) {
        await this.client.instruct({
          text: response,
          speak: true,
          priority: "normal",
        });
        this.deps.logger.info(`[stimm-voice] Instruction sent: "${response.slice(0, 120)}"`);
      } else {
        this.deps.logger.warn(
          `[stimm-voice] Empty response from agent for: "${text.slice(0, 60)}"`,
        );
      }
    } catch (err) {
      this.deps.logger.error(
        `[stimm-voice] Error processing transcript: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.processing = false;
    }
  }

  // -- Direct commands (for tools / gateway methods) ------------------------

  /** Send a text instruction to the voice agent. */
  async instruct(
    text: string,
    opts?: { speak?: boolean; priority?: "normal" | "interrupt" },
  ): Promise<void> {
    await this.client.instruct({
      text,
      speak: opts?.speak ?? true,
      priority: opts?.priority ?? "normal",
    });
  }

  /** Add context to the voice agent's working memory. */
  async addContext(text: string, opts?: { append?: boolean }): Promise<void> {
    await this.client.addContext({
      text,
      append: opts?.append ?? true,
    });
  }

  /** Notify the voice agent that an action completed. */
  async sendActionResult(action: string, status: string, summary: string): Promise<void> {
    await this.client.sendActionResult({ action, status, summary });
  }

  /** Switch the voice agent's operating mode. */
  async setMode(mode: "autonomous" | "relay" | "hybrid"): Promise<void> {
    await this.client.setMode(mode);
  }
}
