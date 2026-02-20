import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SupervisorDeps } from "./supervisor.js";

// ---------------------------------------------------------------------------
// Mock livekit-server-sdk — prevent real HTTP calls.
// ---------------------------------------------------------------------------

const mockCreateRoom = vi.fn(async () => ({}));
const mockDeleteRoom = vi.fn(async () => {});

vi.mock("livekit-server-sdk", () => {
  return {
    RoomServiceClient: class FakeRoomService {
      constructor() {}
      createRoom = mockCreateRoom;
      deleteRoom = mockDeleteRoom;
    },
    AccessToken: class FakeAccessToken {
      constructor() {}
      addGrant() {}
      async toJwt() {
        return "mock-jwt-token";
      }
    },
    VideoGrant: class {},
  };
});

// Mock node-supervisor-client (no LiveKit connection).
vi.mock("./node-supervisor-client.js", () => {
  return {
    NodeSupervisorClient: class FakeClient {
      _connected = false;
      get connected() {
        return this._connected;
      }
      async connect() {
        this._connected = true;
      }
      async disconnect() {
        this._connected = false;
      }
      on() {}
      async instruct() {}
      async addContext() {}
      async sendActionResult() {}
      async setMode() {}
    },
  };
});

// Import after mocks are set up.
const { RoomManager } = await import("./room-manager.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDeps(): SupervisorDeps {
  return {
    processMessage: vi.fn(async () => "ok"),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
}

function createManager(depsOverride?: Partial<SupervisorDeps>) {
  const deps = { ...createDeps(), ...depsOverride };
  return new RoomManager({
    livekit: { url: "ws://localhost:7880", apiKey: "devkey", apiSecret: "secret" },
    voiceAgent: {
      docker: true,
      image: "ghcr.io/stimm-ai/stimm-agent:latest",
      stt: { provider: "deepgram" as const, model: "nova-2" },
      tts: { provider: "openai" as const, model: "tts-1", voice: "alloy" },
      llm: { provider: "openai", model: "gpt-4o-mini" },
      bufferingLevel: "MEDIUM" as const,
      mode: "hybrid" as const,
      spawn: { autoSpawn: false, maxRestarts: 5 },
    },
    supervisorDeps: deps,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RoomManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createSession", () => {
    it("creates a LiveKit room and returns a session with token", async () => {
      const rm = createManager();
      const session = await rm.createSession({ originChannel: "web" });

      expect(mockCreateRoom).toHaveBeenCalled();
      expect(session.roomName).toMatch(/^stimm-/);
      expect(session.clientToken).toBe("mock-jwt-token");
      expect(session.originChannel).toBe("web");
      expect(session.createdAt).toBeGreaterThan(0);
      expect(session.supervisor.connected).toBe(true);
    });

    it("uses a custom room name when provided", async () => {
      const rm = createManager();
      const session = await rm.createSession({
        roomName: "my-custom-room",
        originChannel: "telegram",
      });

      expect(session.roomName).toBe("my-custom-room");
      expect(session.originChannel).toBe("telegram");
    });

    it("stores the session for later retrieval", async () => {
      const rm = createManager();
      const session = await rm.createSession({
        roomName: "lookupable",
        originChannel: "web",
      });

      const found = rm.getSession("lookupable");
      expect(found).toBeDefined();
      expect(found!.roomName).toBe(session.roomName);
    });
  });

  describe("endSession", () => {
    it("disconnects supervisor, deletes room, and removes from map", async () => {
      const rm = createManager();
      const session = await rm.createSession({
        roomName: "to-end",
        originChannel: "web",
      });

      const ok = await rm.endSession("to-end");
      expect(ok).toBe(true);
      expect(mockDeleteRoom).toHaveBeenCalledWith("to-end");
      expect(rm.getSession("to-end")).toBeUndefined();
    });

    it("returns false for unknown room", async () => {
      const rm = createManager();
      const ok = await rm.endSession("nonexistent");
      expect(ok).toBe(false);
    });
  });

  describe("listSessions", () => {
    it("returns all active sessions", async () => {
      const rm = createManager();
      await rm.createSession({ roomName: "a", originChannel: "web" });
      await rm.createSession({ roomName: "b", originChannel: "telegram" });

      const list = rm.listSessions();
      expect(list).toHaveLength(2);
      expect(list.map((s) => s.roomName).sort()).toEqual(["a", "b"]);
    });
  });

  describe("stopAll", () => {
    it("ends all sessions", async () => {
      const rm = createManager();
      await rm.createSession({ roomName: "x", originChannel: "web" });
      await rm.createSession({ roomName: "y", originChannel: "web" });

      await rm.stopAll();
      expect(rm.listSessions()).toHaveLength(0);
      expect(mockDeleteRoom).toHaveBeenCalledTimes(2);
    });
  });

  describe("getSession", () => {
    it("returns undefined for missing session", () => {
      const rm = createManager();
      expect(rm.getSession("nope")).toBeUndefined();
    });
  });
});
