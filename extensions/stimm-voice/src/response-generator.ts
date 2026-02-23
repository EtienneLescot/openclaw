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
  decision?: {
    action: "NO_ACTION" | "TRIGGER";
    reason?: string;
  };
  debug?: {
    provider: string;
    model: string;
    payloadCount: number;
    nonErrorTextCount: number;
    aborted: boolean;
    payloadPreview: Array<{ isError: boolean; text: string }>;
  };
};

type SupervisorStructuredResponse = {
  action: "NO_ACTION" | "TRIGGER";
  text?: string;
  reason?: string;
};

type SessionEntry = {
  sessionId: string;
  updatedAt: number;
};

function parseSupervisorStructuredResponse(raw: string): SupervisorStructuredResponse | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as Partial<SupervisorStructuredResponse>;
    if (parsed.action !== "NO_ACTION" && parsed.action !== "TRIGGER") {
      return null;
    }
    return {
      action: parsed.action,
      text: typeof parsed.text === "string" ? parsed.text : undefined,
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
    };
  } catch {
    return null;
  }
}

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
    `You are ${agentName}, a helpful voice assistant working as a supervisor ` +
      `in a dual-agent voice system. A small fast LLM handles the live conversation ` +
      `with the user (greetings, acknowledgements, filler). You receive batches of ` +
      `their conversation and decide whether to intervene.\n\n` +
      `RULES:\n` +
      `1. Return exactly [NO_ACTION] ONLY if the latest user message was already ` +
      `answered correctly by the small LLM in the provided history.\n` +
      `2. If the latest user message is a direct question and there is no clear/correct ` +
      `assistant answer after it, you MUST answer now (do not return [NO_ACTION]).\n` +
      `3. If the user asks a factual or technical question, provide the best concise answer now.\n` +
      `4. If the user asks something that requires tools (search, calendar, etc.) ` +
      `→ use your tools and respond with the result.\n` +
      `5. NEVER repeat what the small LLM already said correctly.\n` +
      `6. Respond in the SAME LANGUAGE the user is speaking.\n` +
      `7. Do NOT use sessions_send or any messaging tool — reply with plain text.\n` +
      `8. Never output NO_REPLY or HEARTBEAT_OK in this mode.\n` +
      `9. Output MUST be a single JSON object with this schema only:\n` +
      `   {"action":"NO_ACTION"|"TRIGGER","text":"<string when TRIGGER, else empty>","reason":"<short debug reason>"}\n` +
      `   No markdown, no prose outside JSON.\n` +
      `CONTEXT: room=${roomName}, channel=${channel}.\n` +
      `Your text reply will be spoken aloud to the user via the voice agent.`;

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

    const payloads = result.payloads ?? [];
    const payloadPreview = payloads.slice(0, 5).map((p) => ({
      isError: Boolean(p.isError),
      text: String(p.text ?? "")
        .trim()
        .slice(0, 200),
    }));

    // Extract text payloads from agent result.
    const texts = payloads
      .filter((p) => p.text && !p.isError)
      .map((p) => p.text?.trim())
      .filter(Boolean);
    const rawReply = texts.join(" ").trim();
    const structured = rawReply ? parseSupervisorStructuredResponse(rawReply) : null;
    let reply: string | null;
    let decision: StimmResponseResult["decision"] | undefined;
    if (structured) {
      decision = {
        action: structured.action,
        reason: structured.reason,
      };
      reply =
        structured.action === "TRIGGER" && (structured.text ?? "").trim().length > 0
          ? structured.text!.trim()
          : null;
    } else {
      // Backward-compatible fallback for non-JSON replies.
      reply = rawReply || null;
    }
    const debug: NonNullable<StimmResponseResult["debug"]> = {
      provider,
      model,
      payloadCount: payloads.length,
      nonErrorTextCount: texts.length,
      aborted: Boolean(result.meta?.aborted),
      payloadPreview,
    };

    if (!reply && result.meta?.aborted) {
      return { text: null, error: "Agent response was aborted", debug, decision };
    }

    return { text: reply, debug, decision };
  } catch (err) {
    return {
      text: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
