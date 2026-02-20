import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock core-bridge — prevent dynamic import of dist/extensionAPI.js.
// ---------------------------------------------------------------------------

const mockRunEmbeddedPiAgent = vi.fn(async () => ({
  payloads: [{ text: "Agent reply here", isError: false }],
  meta: {},
}));

vi.mock("./core-bridge.js", () => ({
  loadCoreAgentDeps: vi.fn(async () => ({
    resolveAgentDir: () => "/tmp/agent",
    resolveAgentWorkspaceDir: () => "/tmp/agent/workspace",
    resolveAgentIdentity: () => ({ name: "TestBot" }),
    resolveThinkingDefault: () => "off",
    runEmbeddedPiAgent: mockRunEmbeddedPiAgent,
    resolveAgentTimeoutMs: () => 30_000,
    ensureAgentWorkspace: vi.fn(async () => {}),
    resolveStorePath: () => "/tmp/sessions.json",
    loadSessionStore: () => ({}),
    saveSessionStore: vi.fn(async () => {}),
    resolveSessionFilePath: () => "/tmp/session.jsonl",
    DEFAULT_MODEL: "gpt-4o-mini",
    DEFAULT_PROVIDER: "openai",
  })),
}));

// Import after mocks.
const { generateStimmResponse } = await import("./response-generator.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseCoreConfig = {
  session: { store: "/tmp/store" },
  messages: {},
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("generateStimmResponse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns text from the agent pipeline", async () => {
    const result = await generateStimmResponse({
      coreConfig: baseCoreConfig,
      roomName: "room-1",
      channel: "web",
      text: "Hello voice agent",
    });

    expect(result.text).toBe("Agent reply here");
    expect(result.error).toBeUndefined();
    expect(mockRunEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Hello voice agent",
        messageProvider: "stimm-voice",
        lane: "voice",
        verboseLevel: "off",
      }),
    );
  });

  it("returns null text when agent has no payloads", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({
      payloads: [],
      meta: {},
    });

    const result = await generateStimmResponse({
      coreConfig: baseCoreConfig,
      roomName: "room-2",
      channel: "telegram",
      text: "Hmm",
    });

    expect(result.text).toBeNull();
  });

  it("returns error when agent aborts", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({
      payloads: [],
      meta: { aborted: true },
    });

    const result = await generateStimmResponse({
      coreConfig: baseCoreConfig,
      roomName: "room-3",
      channel: "web",
      text: "timeout test",
    });

    expect(result.text).toBeNull();
    expect(result.error).toContain("aborted");
  });

  it("filters out error payloads", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({
      payloads: [
        { text: "Error happened", isError: true },
        { text: "Good reply", isError: false },
      ],
      meta: {},
    });

    const result = await generateStimmResponse({
      coreConfig: baseCoreConfig,
      roomName: "room-4",
      channel: "web",
      text: "mixed payloads",
    });

    expect(result.text).toBe("Good reply");
  });

  it("joins multiple text payloads with space", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({
      payloads: [
        { text: "Part one.", isError: false },
        { text: "Part two.", isError: false },
      ],
      meta: {},
    });

    const result = await generateStimmResponse({
      coreConfig: baseCoreConfig,
      roomName: "room-5",
      channel: "web",
      text: "multi",
    });

    expect(result.text).toBe("Part one. Part two.");
  });

  it("returns error on agent exception", async () => {
    mockRunEmbeddedPiAgent.mockRejectedValueOnce(new Error("LLM timeout"));

    const result = await generateStimmResponse({
      coreConfig: baseCoreConfig,
      roomName: "room-6",
      channel: "web",
      text: "fail",
    });

    expect(result.text).toBeNull();
    expect(result.error).toBe("LLM timeout");
  });

  it("uses custom model when provided", async () => {
    await generateStimmResponse({
      coreConfig: baseCoreConfig,
      roomName: "room-7",
      channel: "web",
      text: "custom model",
      model: "anthropic/claude-sonnet-4-20250514",
    });

    expect(mockRunEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
      }),
    );
  });

  it("builds a system prompt with agent name and channel/room info", async () => {
    await generateStimmResponse({
      coreConfig: baseCoreConfig,
      roomName: "my-room",
      channel: "whatsapp",
      text: "test prompt",
    });

    expect(mockRunEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        extraSystemPrompt: expect.stringContaining("TestBot"),
      }),
    );
    expect(mockRunEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        extraSystemPrompt: expect.stringContaining("whatsapp"),
      }),
    );
    expect(mockRunEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        extraSystemPrompt: expect.stringContaining("my-room"),
      }),
    );
  });
});
