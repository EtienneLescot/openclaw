"""OpenClaw voice agent worker.

Architecture
────────────

  User/Phone ──► LiveKit Room
                      │
               ┌──────┴──────────────────────┐
               │  VoiceAgent   (fast path)    │  ← stimm.VoiceAgent
               │  VAD → STT → fast LLM → TTS │
               └──────┬──────────────────────┘
                      │  Stimm data-channel protocol
               ┌──────┴──────────────────────┐
               │  OpenClawSupervisor          │  ← this file
               │  extends ConversationSupervisor (stimm)
               │  data-only, no audio         │
               └──────┬──────────────────────┘
                      │  HTTP POST /stimm/supervisor
               ┌──────┴──────────────────────┐
               │  OpenClaw gateway            │
               │  big LLM + tools             │
               └─────────────────────────────┘

``OpenClawSupervisor`` is the only OpenClaw-specific piece: it implements the
abstract ``process()`` method by POSTing the conversation history to the
OpenClaw gateway. All generic worker logic (providers, entrypoint) lives in
``stimm.worker``.

Environment variables consumed by this file:
    OPENCLAW_SUPERVISOR_URL  URL of the OpenClaw gateway supervisor endpoint
                             (default: http://127.0.0.1:18789/stimm/supervisor)
    OPENCLAW_CHANNEL         channel name sent to the gateway; overrides STIMM_CHANNEL
                             (default: value of STIMM_CHANNEL, itself defaulting to "default")

All other environment variables (STT/TTS/LLM providers, STIMM_BUFFERING,
STIMM_MODE, STIMM_INSTRUCTIONS, STIMM_CHANNEL, LIVEKIT_*) are consumed by
stimm.worker — see stimm/worker.py for the full reference.

Run with:
    python agent.py dev
"""

from __future__ import annotations

import logging
import os

import aiohttp
from livekit.agents import WorkerOptions, cli

from stimm import ConversationSupervisor

logger = logging.getLogger("openclaw.voice")


class OpenClawSupervisor(ConversationSupervisor):
    """Supervisor that POSTs conversation history to an OpenClaw gateway.

    Calls ``POST /stimm/supervisor`` on the OpenClaw gateway and injects
    the response into the voice agent's context.

    Args:
        supervisor_url: OpenClaw supervisor endpoint URL.
        room_name: LiveKit room name (for routing on the gateway side).
        channel: Origin channel (e.g. ``"web"``, ``"telegram"``).
        quiet_s / loop_interval_s / max_turns: forwarded to base class.
    """

    def __init__(
        self,
        *,
        supervisor_url: str,
        room_name: str,
        channel: str = "web",
        quiet_s: float = 2.5,
        loop_interval_s: float = 1.5,
        max_turns: int = 40,
    ) -> None:
        super().__init__(
            quiet_s=quiet_s,
            loop_interval_s=loop_interval_s,
            max_turns=max_turns,
        )
        self.supervisor_url = supervisor_url
        self.room_name = room_name
        self.channel = channel

    async def process(self, history: str) -> str:
        """POST history to the OpenClaw /stimm/supervisor endpoint."""
        try:
            async with aiohttp.ClientSession() as http:
                async with http.post(
                    self.supervisor_url,
                    json={
                        "roomName": self.room_name,
                        "channel": self.channel,
                        "history": history,
                    },
                    timeout=aiohttp.ClientTimeout(total=30),
                ) as resp:
                    data = await resp.json()
                    if resp.status != 200:
                        logger.error(
                            "OpenClaw /stimm/supervisor HTTP %s: %s",
                            resp.status,
                            data,
                        )
                        return self.NO_ACTION
                    text = data.get("text") or self.NO_ACTION
                    if text == self.NO_ACTION:
                        logger.info("OpenClaw supervisor returned NO_ACTION")
                    else:
                        logger.info("OpenClaw supervisor returned context: %s", text)
                    return text
        except Exception as exc:
            logger.error("OpenClaw supervisor HTTP call failed: %s", exc)
            return self.NO_ACTION


def _supervisor_factory(room_name: str, channel: str) -> OpenClawSupervisor:
    return OpenClawSupervisor(
        supervisor_url=os.environ.get(
            "OPENCLAW_SUPERVISOR_URL", "http://127.0.0.1:18789/stimm/supervisor"
        ),
        room_name=room_name,
        # STIMM_CHANNEL is set by make_entrypoint; OPENCLAW_CHANNEL is the
        # OpenClaw-specific override kept for backward compatibility.
        channel=os.environ.get("OPENCLAW_CHANNEL", channel),
    )


# Top-level function so multiprocessing can pickle it (closures are not picklable).
async def entrypoint(ctx):  # type: ignore[no-untyped-def]
    from stimm.worker import make_entrypoint as _make

    await _make(_supervisor_factory)(ctx)


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
