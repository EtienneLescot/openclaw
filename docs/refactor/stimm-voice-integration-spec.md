# Stimm Voice Integration — OpenClaw RFC

> **Status**: Draft v2 — final architecture
> **Authors**: Etienne (Stimm), OpenClaw contributors
> **Date**: 2026-02-20

---

## 1. Vision

Give OpenClaw **real-time, streaming voice conversation** through a dual-agent architecture, powered by [Stimm](https://github.com/etienne/stimm) — a dual-agent voice orchestration framework built on [livekit-agents](https://github.com/livekit/agents).

- **Voice Agent** (Stimm `VoiceAgent`, Python, small fast LLM) — handles the audio pipeline and keeps the conversation fluid.
- **Supervisor** (OpenClaw main agent, TypeScript) — watches the live transcript, reasons about intent, triggers actions, and sends guidance back to the voice agent.

The user talks to one voice. Behind the scenes, two agents collaborate: one for speed, one for depth.

```
              ┌─────────── LiveKit Room ───────────┐
              │                                     │
  ┌────────┐  │  ┌─────────────────────────────┐    │
  │  User  │◄─┼─►│  VoiceAgent  (Stimm)        │    │
  │ (audio)│  │  │  livekit-agents pipeline     │    │
  │        │  │  │  VAD → STT → fast LLM → TTS │    │
  └────────┘  │  └──────────┬───────────────────┘    │
              │     text    │  ▲  text                │
              │ (transcript)│  │  (instructions)      │
              │  stimm      │  │  stimm               │
              │  protocol   ▼  │  protocol             │
              │  ┌──────────────────────────────┐    │
              │  │  Supervisor  (OpenClaw)       │    │
              │  │  @stimm/protocol (TypeScript) │    │
              │  │  Large LLM · tools · memory   │    │
              │  │  routing · channel context     │    │
              │  └──────────────────────────────┘    │
              └─────────────────────────────────────┘
```

---

## 2. Dependencies

```
OpenClaw Extension (@openclaw/stimm-voice)
├── @stimm/protocol  (npm)  — TypeScript types + supervisor client
└── stimm             (pip)  — Python voice agent + orchestration
    └── livekit-agents (pip)  — audio pipeline foundation
        └── livekit-plugins-*  — STT/TTS/LLM/VAD providers
```

---

## 3. Why Dual-Agent

| Approach | Latency | Intelligence | Complexity |
|----------|---------|-------------|------------|
| Single large LLM on voice | High (~2-5s) | Full tools | Low |
| Single small LLM on voice | Low (~0.5s) | Limited | Low |
| **Dual agent (this spec)** | **Low (~0.5s)** | **Full tools** | **Medium** |

**Example flow:**
> User: "Can you check my calendar for tomorrow and book a meeting with Sarah at 2pm?"
> VoiceAgent (instant): "Sure, let me check your calendar for tomorrow."
> Supervisor (background): [calls calendar tool, finds conflict at 2pm]
> Supervisor → VoiceAgent: `instruction: "Conflict at 2pm — dentist. Suggest 3pm or 4pm."`
> VoiceAgent: "I see you have a dentist appointment at 2pm. Would 3pm or 4pm work instead?"

---

## 4. Stimm Protocol (Data Channel Messages)

Both agents communicate via **LiveKit reliable data channel** (JSON, UTF-8). The protocol is defined in Stimm and published as both Python types and TypeScript types (`@stimm/protocol`).

### 4.1 VoiceAgent → Supervisor

```jsonc
// Real-time transcript
{
  "type": "transcript",
  "partial": true,
  "text": "can you check my calendar",
  "timestamp": 1708444800000,
  "confidence": 0.94
}

// Voice agent state changes
{
  "type": "state",
  "state": "listening" | "thinking" | "speaking",
  "timestamp": 1708444800000
}

// Voice agent is about to speak (supervisor can review/override)
{
  "type": "before_speak",
  "text": "Sure, let me check that for you.",
  "turn_id": "t_003"
}

// Turn metrics
{
  "type": "metrics",
  "turn": 3,
  "vad_ms": 12,
  "stt_ms": 340,
  "llm_ttft_ms": 180,
  "tts_ttfb_ms": 220,
  "total_ms": 752
}
```

### 4.2 Supervisor → VoiceAgent

```jsonc
// Instruction: inject text for the voice agent to speak or use as context
{
  "type": "instruction",
  "text": "There is a conflict at 2pm. Suggest 3pm or 4pm.",
  "priority": "normal" | "interrupt",
  "speak": true
}

// Context: add to voice agent working memory
{
  "type": "context",
  "text": "User name is Etienne. Timezone: Europe/Paris.",
  "append": true
}

// Action result: tell voice agent an action completed
{
  "type": "action_result",
  "action": "calendar_check",
  "status": "completed",
  "summary": "Found 3 meetings tomorrow. 2pm has a dentist appointment."
}

// Mode switch
{
  "type": "mode",
  "mode": "autonomous" | "relay" | "hybrid"
}

// Override: cancel voice agent pending response
{
  "type": "override",
  "turn_id": "t_003",
  "replacement": "Actually, your calendar is clear tomorrow. What time works?"
}
```

### 4.3 Voice Agent Modes

| Mode | Behavior |
|------|----------|
| **autonomous** | Voice agent uses its own fast LLM. Default for greetings, small talk, clarifications. |
| **relay** | Voice agent speaks exactly what the supervisor sends. |
| **hybrid** (default) | Voice agent responds autonomously but incorporates supervisor instructions into its next response. |

---

## 5. WhatsApp Integration Strategy

### The Constraint

WhatsApp Business API does not support real-time voice calls. Only voice messages (PTT audio files).

### Approach: Dual-Path

**Path A — Enhanced Voice Message Loop (v1, stays in WhatsApp):**
1. User sends voice note on WhatsApp
2. OpenClaw extension sends audio to Stimm for STT transcription (one-shot)
3. Transcript → OpenClaw main agent processes (tools, memory, reasoning)
4. Response → Stimm TTS → voice note sent back as WhatsApp PTT
5. Fast turnaround (~2-3s), no link needed

**Path B — Voice Link Handoff (v2, real-time):**
1. User sends `/voice` or "let's talk" on WhatsApp
2. OpenClaw replies with a link: `https://voice.openclaw.ai/room/abc123`
3. Browser → WebRTC → LiveKit → full dual-agent real-time conversation
4. Conversation results posted back to WhatsApp thread

---

## 6. OpenClaw Extension Structure

```
extensions/stimm-voice/
├── openclaw.plugin.json            # OpenClaw extension manifest
├── package.json                    # Depends on @stimm/protocol
├── index.ts                        # Extension entry: CLI, RPC, tools
├── src/
│   ├── supervisor.ts               # OpenClaw Supervisor implementation
│   ├── room-manager.ts             # LiveKit room lifecycle
│   ├── whatsapp-bridge.ts          # Path A: voice note → STT → agent → TTS → PTT
│   ├── web-voice.ts                # Path B: browser WebRTC voice UI
│   ├── docker.ts                   # Manage Stimm Python container
│   └── config.ts                   # Voice configuration schema
├── python/                         # The Python voice agent (thin)
│   ├── Dockerfile
│   ├── pyproject.toml              # Depends on stimm[deepgram,openai]
│   └── agent.py                    # ~30 lines: configure VoiceAgent, run worker
└── docker/
    └── docker-compose.stimm.yml    # LiveKit server + voice agent container
```

### python/agent.py (entire Python side for OpenClaw):

```python
from stimm import VoiceAgent
from livekit.plugins import silero, deepgram, openai

agent = VoiceAgent(
    stt=deepgram.STT(),
    tts=openai.TTS(),
    vad=silero.VAD.load(),
    fast_llm=openai.LLM(model="gpt-4o-mini"),
    buffering_level="MEDIUM",
    mode="hybrid",
    instructions="You are a friendly voice assistant for OpenClaw.",
)

if __name__ == "__main__":
    from livekit.agents import WorkerOptions, cli
    cli.run_app(WorkerOptions(entrypoint_fnc=agent.entrypoint))
```

### src/supervisor.ts (core TypeScript logic):

```typescript
import { StimmSupervisorClient, TranscriptMessage } from '@stimm/protocol';

export class OpenClawSupervisor {
  private client: StimmSupervisorClient;
  private mainAgent: OpenClawAgent;

  async onTranscript(msg: TranscriptMessage) {
    if (!msg.partial) {
      const result = await this.mainAgent.process(msg.text, {
        conversationId: this.roomName,
        channel: this.originChannel,
      });
      await this.client.instruct({
        text: result.text,
        speak: true,
        priority: 'normal',
      });
    }
  }
}
```

---

## 7. Configuration

```json
{
  "enabled": true,
  "stimm": {
    "docker": true,
    "image": "ghcr.io/stimm/stimm-agent:latest"
  },
  "livekit": {
    "url": "ws://localhost:7880",
    "apiKey": "devkey",
    "apiSecret": "secret"
  },
  "voiceAgent": {
    "stt": { "provider": "deepgram", "model": "nova-2" },
    "tts": { "provider": "openai", "model": "tts-1", "voice": "alloy" },
    "llm": { "provider": "groq", "model": "llama-3.3-70b-versatile" },
    "bufferingLevel": "MEDIUM",
    "mode": "hybrid"
  }
}
```

---

## 8. Phased Rollout

### Phase 1: Web Voice (prove the architecture)
- [ ] Stimm library v0.1 (VoiceAgent + Supervisor + Protocol + Room)
- [ ] `@stimm/protocol` npm package
- [ ] OpenClaw extension scaffold with Supervisor in TypeScript
- [ ] Web "Talk" button → LiveKit room → dual-agent conversation
- [ ] Docker compose for LiveKit + voice agent

### Phase 2: WhatsApp Voice Enhancement
- [ ] Path A: voice note loop (STT + agent + TTS → PTT reply)
- [ ] Path B: voice link handoff
- [ ] Session context bridging (WhatsApp thread ↔ voice room)

### Phase 3: Multi-Channel + Telephony
- [ ] Telegram voice enhancement
- [ ] SIP telephony via LiveKit SIP
- [ ] Native app Talk Mode upgrade (iOS/Android/macOS)

---

## 9. Open Questions

1. **LiveKit hosting**: Self-hosted (Docker, free) vs LiveKit Cloud (easy, paid)?
2. **Voice agent system prompt**: Full conversation history or recent turns only?
3. **Conflict resolution**: Supervisor instruction while voice agent mid-sentence — interrupt or queue?
4. **Latency budget**: Target end-to-end (VAD end → user hears response)?
5. **Coexistence**: Deprecate `@openclaw/voice-call` (Twilio/Telnyx) or keep alongside?
