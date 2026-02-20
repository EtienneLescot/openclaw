import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub child_process.spawn.
const mockKill = vi.fn();
const mockSpawn = vi.fn(() => {
  const EventEmitter = require("node:events").EventEmitter;
  const { Readable } = require("node:stream");
  const proc = new EventEmitter();
  proc.pid = 12345;
  proc.killed = false;
  proc.kill = vi.fn((signal?: string) => {
    proc.killed = true;
    if (signal === "SIGTERM") {
      setTimeout(() => proc.emit("exit", 0, "SIGTERM"), 10);
    }
  });
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  proc.stdin = null;
  return proc;
});

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => (mockSpawn as Function)(...args),
}));

const mockExistsSync = vi.fn(() => true);
vi.mock("node:fs", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    existsSync: (...args: unknown[]) => (mockExistsSync as Function)(...args),
  };
});

// Import after mocks.
const { AgentProcess } = await import("./agent-process.js");

type AgentProcessInstance = InstanceType<typeof AgentProcess>;

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe("AgentProcess", () => {
  let agent: AgentProcessInstance;
  const logger = makeLogger();

  const baseOpts = {
    pythonPath: "/fake/python",
    agentScript: "/fake/agent.py",
    livekitUrl: "ws://localhost:7880",
    livekitApiKey: "devkey",
    livekitApiSecret: "secret",
    logger,
    maxRestarts: 2,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    logger.info.mockClear();
    logger.warn.mockClear();
    logger.error.mockClear();
    logger.debug.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts a process and reports running", () => {
    agent = new AgentProcess(baseOpts);
    agent.start();
    expect(agent.running).toBe(true);
    expect(agent.pid).toBe(12345);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Voice agent started (PID 12345)"),
    );
    agent.stop();
  });

  it("does not double-start", () => {
    agent = new AgentProcess(baseOpts);
    agent.start();
    agent.start(); // no-op
    expect(agent.running).toBe(true);
    agent.stop();
  });

  it("reports not running after stop", async () => {
    agent = new AgentProcess(baseOpts);
    agent.start();
    agent.stop();
    // Process receives SIGTERM, emits exit after 10ms.
    await vi.advanceTimersByTimeAsync(50);
    expect(agent.running).toBe(false);
    expect(agent.pid).toBeNull();
  });

  it("resolves default python path", () => {
    const p = AgentProcess.resolveDefaultPythonPath("/ext/stimm-voice");
    expect(p).toBe(join("/ext/stimm-voice", "python", ".venv", "bin", "python"));
  });

  it("resolves default agent script path", () => {
    const p = AgentProcess.resolveDefaultAgentScript("/ext/stimm-voice");
    expect(p).toBe(join("/ext/stimm-voice", "python", "agent.py"));
  });

  it("errors when python path does not exist", () => {
    mockExistsSync.mockReturnValueOnce(false);

    agent = new AgentProcess(baseOpts);
    agent.start();
    expect(agent.running).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Python not found"));
  });

  it("passes API keys in env", () => {
    agent = new AgentProcess({
      ...baseOpts,
      env: { OPENAI_API_KEY: "sk-test", DEEPGRAM_API_KEY: "dg-test" },
    });
    agent.start();

    const callArgs = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1];
    const childEnv = callArgs[2].env;
    expect(childEnv.LIVEKIT_URL).toBe("ws://localhost:7880");
    expect(childEnv.LIVEKIT_API_KEY).toBe("devkey");
    expect(childEnv.LIVEKIT_API_SECRET).toBe("secret");
    expect(childEnv.OPENAI_API_KEY).toBe("sk-test");
    expect(childEnv.DEEPGRAM_API_KEY).toBe("dg-test");
    agent.stop();
  });
});
