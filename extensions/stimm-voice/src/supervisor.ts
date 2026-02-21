/**
 * OpenClawSupervisor — TypeScript supervisor that bridges Stimm and OpenClaw.
 *
 * Architecture: Conversation Buffer
 * ──────────────────────────────────
 * The small LLM (Python side) handles the user naturally — filler, acks,
 * follow-up questions.  Meanwhile this supervisor maintains a rolling
 * buffer of the conversation (user turns + small-LLM turns captured via
 * before_speak).  An async processing loop periodically drains
 * *unprocessed* entries, sends them as context to the big LLM (OpenClaw
 * agent), and relays meaningful answers back as instructions.
 *
 * The big LLM receives the full unprocessed conversation chunk so it can
 * answer multiple questions at once.  Instructions are sent with
 * priority "normal" — the small LLM naturally weaves them in via
 * `build_context_with_instructions` rather than hard-interrupting.
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

// ---------------------------------------------------------------------------
// Conversation Buffer
// ---------------------------------------------------------------------------

interface BufferEntry {
  role: "user" | "assistant";
  text: string;
  ts: number;
  /** Set to true once the big LLM has processed this entry. */
  processed: boolean;
}

/**
 * OpenClaw supervisor — maintains a conversation buffer, periodically
 * sends unprocessed turns to the big LLM, and relays answers back.
 */
export class OpenClawSupervisor {
  private client: NodeSupervisorClient;
  private deps: SupervisorDeps;
  private roomName: string;
  private originChannel: string;

  // -- Conversation buffer --------------------------------------------------
  private buffer: BufferEntry[] = [];
  /** Max entries to keep (rolling window). */
  private maxBufferSize = 40;

  // -- Async processing loop ------------------------------------------------
  private loopTimer: ReturnType<typeof setInterval> | null = null;
  /** How often the loop checks for unprocessed entries (ms). */
  private loopIntervalMs = 1_500;
  /** Minimum quiet time after last user turn before processing (ms). */
  private quietMs = 1_200;
  private processing = false;

  /** Timestamp of the last user turn added to the buffer. */
  private lastUserTurnTs = 0;

  /** Accumulated partial transcript text for debounce. */
  private pendingPartial = "";
  private partialTimer: ReturnType<typeof setTimeout> | null = null;
  private partialDebounceMs = 400;

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

  /** Connect to the LiveKit room and start the processing loop. */
  async connect(): Promise<void> {
    await this.client.connect();
    this.deps.logger.info(`[stimm-voice] Supervisor connected to room ${this.roomName}`);
    this.startLoop();
  }

  /** Disconnect from the room and stop the loop. */
  async disconnect(): Promise<void> {
    this.stopLoop();
    if (this.partialTimer) clearTimeout(this.partialTimer);
    await this.client.disconnect();
    this.deps.logger.info(`[stimm-voice] Supervisor disconnected from room ${this.roomName}`);
  }

  get connected(): boolean {
    return this.client.connected;
  }

  // -- Conversation buffer helpers ------------------------------------------

  private pushEntry(role: "user" | "assistant", text: string): void {
    this.buffer.push({ role, text, ts: Date.now(), processed: false });
    // Trim to rolling window.
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer = this.buffer.slice(-this.maxBufferSize);
    }
  }

  /** Return unprocessed entries and mark them as processed. */
  private drainUnprocessed(): BufferEntry[] {
    const entries = this.buffer.filter((e) => !e.processed);
    for (const e of entries) e.processed = true;
    return entries;
  }

  /** Format buffer entries as a transcript block for the big LLM. */
  private formatTranscript(entries: BufferEntry[]): string {
    return entries.map((e) => `[${e.role === "user" ? "User" : "SmallLLM"}]: ${e.text}`).join("\n");
  }

  // -- Event handlers -------------------------------------------------------

  private async onTranscript(msg: TranscriptMessage): Promise<void> {
    if (msg.partial) {
      // Accumulate partials — flush on final or timeout.
      this.pendingPartial = msg.text;
      if (this.partialTimer) clearTimeout(this.partialTimer);
      this.partialTimer = setTimeout(() => {
        this.partialTimer = null;
        if (this.pendingPartial) {
          this.commitUserTurn(this.pendingPartial);
          this.pendingPartial = "";
        }
      }, this.partialDebounceMs);
      return;
    }

    // Final transcript — cancel partial timer and commit.
    if (this.partialTimer) {
      clearTimeout(this.partialTimer);
      this.partialTimer = null;
    }
    this.pendingPartial = "";
    this.commitUserTurn(msg.text);
  }

  private commitUserTurn(text: string): void {
    if (!text.trim()) return;
    this.pushEntry("user", text);
    this.lastUserTurnTs = Date.now();
    this.deps.logger.info(`[stimm-voice] Buffer ← user: "${text}"`);
  }

  private onState(msg: StateMessage): void {
    this.deps.logger.debug?.(`[stimm-voice] Voice agent state: ${msg.state}`);
  }

  private onBeforeSpeak(msg: BeforeSpeakMessage): void {
    // Capture what the small LLM is about to say so the big LLM
    // has full conversational context.
    if (msg.text?.trim()) {
      this.pushEntry("assistant", msg.text);
      this.deps.logger.debug?.(`[stimm-voice] Buffer ← assistant: "${msg.text.slice(0, 80)}"`);
    }
  }

  private onMetrics(msg: MetricsMessage): void {
    this.deps.logger.debug?.(`[stimm-voice] Turn ${msg.turn} metrics — total: ${msg.total_ms}ms`);
  }

  // -- Async processing loop ------------------------------------------------

  private startLoop(): void {
    if (this.loopTimer) return;
    this.loopTimer = setInterval(() => {
      void this.tick();
    }, this.loopIntervalMs);
    this.deps.logger.debug?.("[stimm-voice] Processing loop started");
  }

  private stopLoop(): void {
    if (this.loopTimer) {
      clearInterval(this.loopTimer);
      this.loopTimer = null;
    }
  }

  /**
   * One tick of the processing loop.
   *
   * Checks if there are unprocessed buffer entries, waits for a quiet
   * period after the last user turn, then sends the batch to the big LLM.
   */
  private async tick(): Promise<void> {
    // Already processing — skip this tick.
    if (this.processing) return;

    // No unprocessed entries — nothing to do.
    const hasUnprocessed = this.buffer.some((e) => !e.processed);
    if (!hasUnprocessed) return;

    // Wait for the user to stop talking (quiet period).
    const elapsed = Date.now() - this.lastUserTurnTs;
    if (elapsed < this.quietMs) return;

    this.processing = true;
    try {
      await this.processBuffer();
    } catch (err) {
      this.deps.logger.error(
        `[stimm-voice] Processing error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.processing = false;
    }
  }

  /**
   * Drain unprocessed buffer entries, build a context prompt,
   * send it to the big LLM, and relay the answer back.
   */
  private async processBuffer(): Promise<void> {
    const entries = this.drainUnprocessed();
    if (entries.length === 0) return;

    // Only the user turns matter for the prompt — but we include
    // small-LLM turns for context so the big LLM knows what was
    // already said and doesn't repeat.
    const hasUserTurn = entries.some((e) => e.role === "user");
    if (!hasUserTurn) return; // Only assistant chatter — skip.

    const transcript = this.formatTranscript(entries);
    this.deps.logger.info(`[stimm-voice] Processing ${entries.length} turns:\n${transcript}`);

    // Build a prompt that gives the big LLM the conversation context.
    const prompt =
      `Here is the recent voice conversation (unprocessed turns):\n` +
      `${transcript}\n\n` +
      `Respond to the user's questions/requests. If the SmallLLM already ` +
      `answered something correctly, don't repeat it. Focus on what ` +
      `the user actually needs. Be concise (voice format).`;

    const response = await this.deps.processMessage(prompt, {
      roomName: this.roomName,
      channel: this.originChannel,
    });

    if (!response?.trim()) {
      this.deps.logger.warn("[stimm-voice] Empty response from big LLM");
      return;
    }

    // The big LLM responds with [NO_ACTION] when the conversation is
    // just small talk that the small LLM handles fine.  Skip silently.
    if (response.trim() === "[NO_ACTION]" || response.includes("[NO_ACTION]")) {
      this.deps.logger.info("[stimm-voice] Big LLM: [NO_ACTION] — small talk, skipping");
      return;
    }

    // Send the full conversation context so the small LLM can stay
    // consistent on future turns.
    const fullContext = this.buffer
      .slice(-20)
      .map((e) => `[${e.role === "user" ? "User" : "Assistant"}]: ${e.text}`)
      .join("\n");

    await this.client.addContext({
      text: `Recent conversation:\n${fullContext}\n\nSupervisor answer: ${response}`,
      append: false, // Replace — always send the latest snapshot.
    });

    // Send the answer as an interrupt instruction — cut the small LLM's
    // filler and speak the real answer immediately.  This is safe with the
    // buffer architecture: the big LLM processes once per batch (not per
    // utterance), so we won't get cascading interrupts.
    await this.client.instruct({
      text: response,
      speak: true,
      priority: "interrupt",
    });

    this.deps.logger.info(`[stimm-voice] Instruction sent: "${response.slice(0, 120)}"`);
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
