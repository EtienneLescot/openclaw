import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { SupervisorDeps } from "./supervisor.js";
import { OpenClawSupervisor } from "./supervisor.js";

// ---------------------------------------------------------------------------
// Mock ./node-supervisor-client — prevent real LiveKit connections.
// ---------------------------------------------------------------------------

const mockInstruct = vi.fn();
const mockAddContext = vi.fn();
const mockSendActionResult = vi.fn();
const mockSetMode = vi.fn();
const mockConnect = vi.fn();
const mockDisconnect = vi.fn();
let capturedHandlers: Record<string, Function> = {};

vi.mock("./node-supervisor-client.js", () => {
  return {
    NodeSupervisorClient: class FakeClient {
      _connected = false;

      constructor(_opts: unknown) {}

      get connected(): boolean {
        return this._connected;
      }

      async connect() {
        this._connected = true;
        return mockConnect();
      }

      async disconnect() {
        this._connected = false;
        return mockDisconnect();
      }

      on(event: string, handler: Function) {
        capturedHandlers[event] = handler;
      }

      async instruct(...args: unknown[]) {
        return mockInstruct(...args);
      }

      async addContext(...args: unknown[]) {
        return mockAddContext(...args);
      }

      async sendActionResult(...args: unknown[]) {
        return mockSendActionResult(...args);
      }

      async setMode(...args: unknown[]) {
        return mockSetMode(...args);
      }
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDeps(overrides: Partial<SupervisorDeps> = {}): SupervisorDeps {
  return {
    processMessage: vi.fn(async () => "Agent says hello"),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    ...overrides,
  };
}

const defaultOpts = {
  livekitUrl: "ws://localhost:7880",
  token: "fake-token",
  roomName: "test-room",
  originChannel: "web",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenClawSupervisor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    capturedHandlers = {};
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("connects and disconnects via the protocol client", async () => {
    const deps = createDeps();
    const sup = new OpenClawSupervisor(deps, defaultOpts);
    await sup.connect();
    expect(mockConnect).toHaveBeenCalled();
    expect(sup.connected).toBe(true);

    await sup.disconnect();
    expect(mockDisconnect).toHaveBeenCalled();
  });

  it("registers handlers for transcript, state, before_speak, metrics", () => {
    const deps = createDeps();
    new OpenClawSupervisor(deps, defaultOpts);
    expect(capturedHandlers).toHaveProperty("transcript");
    expect(capturedHandlers).toHaveProperty("state");
    expect(capturedHandlers).toHaveProperty("before_speak");
    expect(capturedHandlers).toHaveProperty("metrics");
  });

  describe("transcript handling", () => {
    it("processes final transcripts through processMessage and instructs", async () => {
      const processMessage = vi.fn(async () => "Here is my answer");
      const deps = createDeps({ processMessage });
      const sup = new OpenClawSupervisor(deps, defaultOpts);
      await sup.connect();

      // Simulate a final transcript event.
      await capturedHandlers.transcript({
        type: "transcript",
        partial: false,
        text: "What is the weather?",
        timestamp: Date.now(),
        confidence: 0.98,
      });

      expect(processMessage).toHaveBeenCalledWith("What is the weather?", {
        roomName: "test-room",
        channel: "web",
      });
      expect(mockInstruct).toHaveBeenCalledWith({
        text: "Here is my answer",
        speak: true,
        priority: "normal",
      });
    });

    it("accumulates partial transcripts and debounces", async () => {
      const processMessage = vi.fn(async () => "Debounced reply");
      const deps = createDeps({ processMessage });
      const sup = new OpenClawSupervisor(deps, defaultOpts);
      await sup.connect();

      // Send partial transcripts.
      await capturedHandlers.transcript({
        type: "transcript",
        partial: true,
        text: "What",
        timestamp: Date.now(),
        confidence: 0.5,
      });

      await capturedHandlers.transcript({
        type: "transcript",
        partial: true,
        text: "What is the",
        timestamp: Date.now(),
        confidence: 0.6,
      });

      // Not processed yet (still within debounce window).
      expect(processMessage).not.toHaveBeenCalled();

      // Advance past debounce timeout (300ms).
      await vi.advanceTimersByTimeAsync(400);

      expect(processMessage).toHaveBeenCalledWith("What is the", {
        roomName: "test-room",
        channel: "web",
      });
    });

    it("skips empty transcripts", async () => {
      const processMessage = vi.fn(async () => "reply");
      const deps = createDeps({ processMessage });
      const sup = new OpenClawSupervisor(deps, defaultOpts);
      await sup.connect();

      await capturedHandlers.transcript({
        type: "transcript",
        partial: false,
        text: "   ",
        timestamp: Date.now(),
        confidence: 0.9,
      });

      expect(processMessage).not.toHaveBeenCalled();
    });

    it("does not send instruction when processMessage returns empty", async () => {
      const processMessage = vi.fn(async () => "");
      const deps = createDeps({ processMessage });
      const sup = new OpenClawSupervisor(deps, defaultOpts);
      await sup.connect();

      await capturedHandlers.transcript({
        type: "transcript",
        partial: false,
        text: "hello",
        timestamp: Date.now(),
        confidence: 0.9,
      });

      expect(processMessage).toHaveBeenCalled();
      expect(mockInstruct).not.toHaveBeenCalled();
    });

    it("logs errors from processMessage without crashing", async () => {
      const processMessage = vi.fn(async () => {
        throw new Error("agent broke");
      });
      const deps = createDeps({ processMessage });
      const sup = new OpenClawSupervisor(deps, defaultOpts);
      await sup.connect();

      // Should not throw.
      await capturedHandlers.transcript({
        type: "transcript",
        partial: false,
        text: "trigger error",
        timestamp: Date.now(),
        confidence: 0.9,
      });

      expect(deps.logger.error).toHaveBeenCalledWith(expect.stringContaining("agent broke"));
    });
  });

  describe("direct commands", () => {
    it("instruct() sends instruction via protocol client", async () => {
      const deps = createDeps();
      const sup = new OpenClawSupervisor(deps, defaultOpts);
      await sup.connect();

      await sup.instruct("Say hello", { speak: true, priority: "interrupt" });
      expect(mockInstruct).toHaveBeenCalledWith({
        text: "Say hello",
        speak: true,
        priority: "interrupt",
      });
    });

    it("addContext() sends context via protocol client", async () => {
      const deps = createDeps();
      const sup = new OpenClawSupervisor(deps, defaultOpts);
      await sup.connect();

      await sup.addContext("User prefers French", { append: true });
      expect(mockAddContext).toHaveBeenCalledWith({
        text: "User prefers French",
        append: true,
      });
    });

    it("sendActionResult() sends result via protocol client", async () => {
      const deps = createDeps();
      const sup = new OpenClawSupervisor(deps, defaultOpts);
      await sup.connect();

      await sup.sendActionResult("search", "success", "Found 3 results");
      expect(mockSendActionResult).toHaveBeenCalledWith({
        action: "search",
        status: "success",
        summary: "Found 3 results",
      });
    });

    it("setMode() sends mode change via protocol client", async () => {
      const deps = createDeps();
      const sup = new OpenClawSupervisor(deps, defaultOpts);
      await sup.connect();

      await sup.setMode("autonomous");
      expect(mockSetMode).toHaveBeenCalledWith("autonomous");
    });
  });
});
