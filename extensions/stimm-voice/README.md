# @openclaw/stimm-voice

Stimm Voice is an OpenClaw extension for real-time voice conversations.

It uses a dual-agent architecture:

- A fast Python voice agent (LiveKit + STT/TTS/LLM) handles low-latency speech.
- OpenClaw acts as the supervisor for reasoning, tools, and long-context decisions.

## Presentation

What this extension provides:

- Real-time voice sessions backed by LiveKit rooms.
- Browser entrypoint at `web.path` (default: `/voice`).
- Claim-token flow for web access (`/voice/claim`) with one-time, short-lived claims.
- Optional Cloudflare Quick Tunnel for temporary public access.
- Optional supervisor shared secret for `POST /stimm/supervisor`.

## Install

### Prerequisites

- Node.js 22+
- Python 3.10+
- OpenClaw gateway installed and working
- LiveKit deployment:
  - local (`ws://localhost:7880`) or
  - cloud (`wss://<your-project>.livekit.cloud`)

### Local install from this repo

```bash
openclaw plugins install --link ./extensions/stimm-voice
cd ./extensions/stimm-voice
pnpm install
```

Then restart the OpenClaw gateway.

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
