# openclaw-stimm-voice

Stimm Voice is a third-party OpenClaw plugin for real-time voice conversations.

It uses a dual-agent architecture:

- A fast Python voice agent (LiveKit + STT/TTS/LLM) handles low-latency speech.
- OpenClaw acts as the supervisor for reasoning, tools, and long-context decisions.

## Presentation

What this plugin provides:

- Real-time voice sessions backed by LiveKit rooms.
- Browser entrypoint at `web.path` (default: `/voice`).
- Claim-token flow for web access (`/voice/claim`) with one-time, short-lived claims.
- Optional Cloudflare Quick Tunnel for temporary public access.
- Optional supervisor shared secret for `POST /stimm/supervisor`.

## Install

### Prerequisites

- Node.js 22+
- Python 3.10+
- OpenClaw gateway ≥ 2026.2.0 installed and running
- LiveKit deployment:
  - local (`ws://localhost:7880`) or
  - cloud (`wss://<your-project>.livekit.cloud`)

### Install from npm

```bash
openclaw plugins install openclaw-stimm-voice
```

### Install from GitHub (latest)

```bash
openclaw plugins install https://github.com/EtienneLescot/openclaw-stimm-voice
```

Then restart the OpenClaw gateway.

Python dependencies use Stimm extras as the single installation contract:

- Base/default profile from [python/requirements.txt](python/requirements.txt): `stimm[deepgram,openai]`
- Additional provider plugins are installed by the setup wizard based on selected STT/TTS/LLM providers (`stimm[...]`).

## Config

Set config under `plugins.entries.stimm-voice.config`.

```json5
{
  enabled: true,
  livekit: {
    url: "wss://your-project.livekit.cloud",
    apiKey: "APIxxxxx",
    apiSecret: "your-secret",
  },
  web: {
    enabled: true,
    path: "/voice",
  },
  access: {
    mode: "quick-tunnel", // "none" | "quick-tunnel"
    claimTtlSeconds: 120,
    livekitTokenTtlSeconds: 300,
    supervisorSecret: "change-me",
    allowDirectWebSessionCreate: false,
    claimRateLimitPerMinute: 20,
  },
  voiceAgent: {
    spawn: { autoSpawn: true },
    stt: { provider: "deepgram", model: "nova-3" },
    tts: { provider: "openai", model: "gpt-4o-mini-tts", voice: "ash" },
    llm: { provider: "openai", model: "gpt-4o-mini" },
    bufferingLevel: "MEDIUM",
    mode: "hybrid",
  },
}
```

Notes:

- The extension is disabled by default (`enabled: false`).
- `access.mode="quick-tunnel"` requires `cloudflared` on PATH.
- `voiceAgent.tts.voice` is provider-specific: OpenAI uses voice names (`ash`, `alloy`), ElevenLabs uses `voice_id`, and Cartesia uses voice UUIDs.
- API keys can be set directly in plugin config, or via env fallbacks (`STIMM_STT_API_KEY`, `STIMM_TTS_API_KEY`, `STIMM_LLM_API_KEY`, then provider-specific env vars).
- `access.supervisorSecret` also supports env fallback (`STIMM_SUPERVISOR_SECRET`, then `OPENCLAW_SUPERVISOR_SECRET`).

## Usage

### Start session from CLI/tool/gateway

```bash
openclaw voice:start --channel web
```

### Supervisor logs (high-level)

Use this command to inspect supervisor observability quickly without manual `grep`:

```bash
openclaw voice:logs --limit 40
```

Interactive follow mode:

```bash
openclaw voice:logs --watch --interval 2
```

Options:

- `--raw`: print raw `OBS_JSON` lines from `/tmp/stimm-agent.log`
- `--limit <n>`: number of entries to print (default: `40`)
- `--watch`: keep watching and print new entries continuously (Ctrl+C to stop)
- `--interval <s>`: refresh interval for watch mode in seconds (default: `2`)
- `--all-events`: include `inference_started` (hidden by default to reduce noise)

The command prints two sections:

- Stimm supervisor `OBS_JSON` events (`inference_started`, `inference_completed`, `trigger_sent`, `no_action`)
- Gateway-side synthesized lines (`[stimm-voice:supervisor]`) when available

`stimm.start` / `stimm_voice:start_session` returns:

- room metadata
- `shareUrl` (when quick tunnel is enabled)
- one-time `claimToken`

### Browser flow

1. Open the returned `shareUrl` on phone.
2. The page calls `POST /voice/claim` with the claim token.
3. Gateway validates claim and returns a short-lived LiveKit token.
4. Browser joins LiveKit.

### HTTP endpoints

- `GET <web.path>`: serves the web voice UI.
- `POST <web.path>/claim`: claim exchange endpoint.
- `POST <web.path>`: disabled by default (`403`) unless `access.allowDirectWebSessionCreate=true`.
- `POST /stimm/supervisor`: internal supervisor callback (protected if `access.supervisorSecret` is set).

### Gateway methods

- `stimm.start`
- `stimm.end`
- `stimm.status`
- `stimm.instruct`
- `stimm.mode`

### Tool

Tool name: `stimm_voice`

Actions:

- `start_session`
- `end_session`
- `status`
- `instruct`
- `add_context`
- `set_mode`
