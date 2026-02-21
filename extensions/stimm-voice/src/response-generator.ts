/**
 * Stimm voice response generator — routes transcripts through the
 * embedded Pi agent (same agent infra as messaging/voice-call).
 *
 * Text in → agent pipeline → text out.
 */

import crypto from "node:crypto";
import { loadCoreAgentDeps, type CoreConfig, type CoreAgentDeps } from "./core-bridge.js";

export type StimmResponseParams = {
  /** Core OpenClaw config. */
  coreConfig: CoreConfig;
  /** Unique room name (used as session scope). */
  roomName: string;
  /** Originating channel (e.g. "web", "whatsapp"). */
  channel: string;
  /** The user's transcribed text. */
  text: string;
  /** Optional model override (e.g. "anthropic/claude-sonnet-4-20250514"). */
  model?: string;
  /** Optional extra system prompt appended to identity. */
  extraSystemPrompt?: string;
};

export type StimmResponseResult = {
  text: string | null;
  error?: string;
};

type SessionEntry = {
  sessionId: string;
  updatedAt: number;
};

/**
 * Generate a response to a voice transcript using the OpenClaw agent pipeline.
 *
 * Creates/reuses a session per room, maintains conversation history,
 * and gives the agent full tool access.
 */
export async function generateStimmResponse(
  params: StimmResponseParams,
): Promise<StimmResponseResult> {
  const { coreConfig, roomName, channel, text, extraSystemPrompt } = params;

  let deps: CoreAgentDeps;
  try {
    deps = await loadCoreAgentDeps();
  } catch (err) {
    return {
      text: null,
      error: err instanceof Error ? err.message : "Unable to load core agent deps",
    };
  }

  const cfg = coreConfig;
  const agentId = "main";

  // Session scoped to roomName so each voice session has its own conversation.
  const sessionKey = `stimm:${roomName}`;

  // Resolve paths.
  const storePath = deps.resolveStorePath(cfg.session?.store, { agentId });
  const agentDir = deps.resolveAgentDir(cfg, agentId);
  const workspaceDir = deps.resolveAgentWorkspaceDir(cfg, agentId);

  await deps.ensureAgentWorkspace({ dir: workspaceDir });

  // Load or create session entry.
  const sessionStore = deps.loadSessionStore(storePath);
  const now = Date.now();
  let sessionEntry = sessionStore[sessionKey] as SessionEntry | undefined;

  if (!sessionEntry) {
    sessionEntry = { sessionId: crypto.randomUUID(), updatedAt: now };
    sessionStore[sessionKey] = sessionEntry;
    await deps.saveSessionStore(storePath, sessionStore);
  }

  const sessionId = sessionEntry.sessionId;
  const sessionFile = deps.resolveSessionFilePath(sessionId, sessionEntry, { agentId });

  // Resolve model from param → agent config primary model → core defaults.
  // Prefer the configured primary model so the voice lane uses the same
  // provider the user already set up (e.g. openrouter/gemini) rather than
  // falling back to the hardcoded anthropic default.
  const configuredPrimary = (
    cfg as Record<string, unknown> & { agents?: { defaults?: { model?: { primary?: string } } } }
  )?.agents?.defaults?.model?.primary;
  const modelRef =
    params.model ?? configuredPrimary ?? `${deps.DEFAULT_PROVIDER}/${deps.DEFAULT_MODEL}`;
  const slashIdx = modelRef.indexOf("/");
  const provider = slashIdx === -1 ? deps.DEFAULT_PROVIDER : modelRef.slice(0, slashIdx);
  const model = slashIdx === -1 ? modelRef : modelRef.slice(slashIdx + 1);

  const thinkLevel = deps.resolveThinkingDefault({ cfg, provider, model });

  // Build system prompt — incorporate agent identity.
  const identity = deps.resolveAgentIdentity(cfg, agentId);
  const agentName = identity?.name?.trim() || "assistant";

  const basePrompt =
    extraSystemPrompt ??
    `You are ${agentName}, a helpful voice assistant. ` +
      `Keep responses concise and conversational — 1–3 sentences. ` +
      `Be natural and friendly. The user is speaking to you via a real-time voice interface ` +
      `(channel: ${channel}, room: ${roomName}). You have access to tools — use them when helpful.`;

  const timeoutMs = deps.resolveAgentTimeoutMs({ cfg });
  const runId = `stimm:${roomName}:${Date.now()}`;

  try {
    const result = await deps.runEmbeddedPiAgent({
      sessionId,
      sessionKey,
      messageProvider: "stimm-voice",
      sessionFile,
      workspaceDir,
      config: cfg,
      prompt: text,
      provider,
      model,
      thinkLevel,
      verboseLevel: "off",
      timeoutMs,
      runId,
      lane: "voice",
      extraSystemPrompt: basePrompt,
      agentDir,
    });

    // Extract text payloads from agent result.
    const texts = (result.payloads ?? [])
      .filter((p) => p.text && !p.isError)
      .map((p) => p.text?.trim())
      .filter(Boolean);

    const reply = texts.join(" ") || null;

    if (!reply && result.meta?.aborted) {
      return { text: null, error: "Agent response was aborted" };
    }

    return { text: reply };
  } catch (err) {
    return {
      text: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
