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
    OPENCLAW_SUPERVISOR_SECRET
                             Optional shared secret sent as
                             X-Stimm-Supervisor-Secret header.
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
from datetime import timedelta

import aiohttp
from livekit import api as lkapi
from livekit.agents import AgentSession, JobContext, RoomInputOptions, WorkerOptions, cli

from stimm import ConversationSupervisor

logger = logging.getLogger("openclaw.voice")
_UNKNOWN_SOURCE_PATCHED = False


def _patch_unknown_mic_source_fallback() -> None:
    """Allow SOURCE_UNKNOWN as fallback for mobile/browser mic tracks.

    Some WebRTC clients publish audio tracks that are labeled SOURCE_UNKNOWN.
    livekit-agents RoomIO input currently filters only SOURCE_MICROPHONE, which
    drops those tracks and produces a silent pipeline.
    """
    global _UNKNOWN_SOURCE_PATCHED
    if _UNKNOWN_SOURCE_PATCHED:
        return

    try:
        from livekit import rtc
        from livekit.agents.voice.room_io import _input as room_input  # pyright: ignore[reportPrivateImportUsage]

        cls = room_input._ParticipantAudioInputStream  # pyright: ignore[reportAttributeAccessIssue]
        orig_init = cls.__init__

        def patched_init(self, *args, **kwargs):  # type: ignore[no-untyped-def]
            orig_init(self, *args, **kwargs)
            try:
                self._accepted_sources.add(rtc.TrackSource.SOURCE_UNKNOWN)
            except Exception:
                pass

        cls.__init__ = patched_init
        _UNKNOWN_SOURCE_PATCHED = True
        logger.info("Applied SOURCE_UNKNOWN audio-source fallback patch")
    except Exception as exc:
        logger.warning("Could not apply SOURCE_UNKNOWN fallback patch: %s", exc)


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
            backend_input_preamble=ConversationSupervisor.DEFAULT_AGNOSTIC_DECISION_PREAMBLE,
        )
        self.supervisor_url = supervisor_url
        self.room_name = room_name
        self.channel = channel

    async def process(self, history: str, system_prompt: str | None) -> str:
        """POST history + backend system prompt to OpenClaw /stimm/supervisor."""
        return await self._post_to_openclaw(history=history, system_prompt=system_prompt)

    async def _post_to_openclaw(self, *, history: str, system_prompt: str | None) -> str:
        """POST payload to the OpenClaw /stimm/supervisor endpoint."""
        try:
            async with aiohttp.ClientSession() as http:
                async with http.post(
                    self.supervisor_url,
                    json={
                        "roomName": self.room_name,
                        "channel": self.channel,
                        "history": history,
                        "systemPrompt": system_prompt,
                    },
                    headers={
                        "X-Stimm-Supervisor-Secret": os.environ.get(
                            "OPENCLAW_SUPERVISOR_SECRET", ""
                        )
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
    _patch_unknown_mic_source_fallback()

    # Local copy of stimm.worker entrypoint with one OpenClaw-specific tweak:
    # fix remote participant binding to the web client identity ("user").
    from livekit.rtc import IceTransportType, RtcConfiguration

    await ctx.connect(
        rtc_config=RtcConfiguration(
            ice_transport_type=IceTransportType.TRANSPORT_ALL,
        )
    )

    from stimm.worker import make_agent

    agent = make_agent()
    session = AgentSession()

    @session.on("user_input_transcribed")
    def _on_transcript(ev) -> None:  # type: ignore[no-untyped-def]
        import asyncio

        asyncio.ensure_future(
            agent.publish_transcript(ev.transcript, partial=not ev.is_final)
        )

    @session.on("conversation_item_added")
    def _on_conversation_item(ev) -> None:  # type: ignore[no-untyped-def]
        import asyncio

        item = getattr(ev, "item", None)
        role = getattr(item, "role", None)
        if role != "assistant":
            return
        text = getattr(item, "text_content", None)
        if isinstance(text, str) and text.strip():
            asyncio.ensure_future(agent.publish_before_speak(text))

    participant_identity = os.environ.get("STIMM_PARTICIPANT_IDENTITY", "user").strip()
    room_input_options = (
        RoomInputOptions(participant_identity=participant_identity)
        if participant_identity
        else RoomInputOptions()
    )
    logger.info(
        "Room input participant binding: %s",
        participant_identity or "<auto>",
    )

    await session.start(
        agent=agent,
        room=ctx.room,
        room_input_options=room_input_options,
    )

    agent.protocol.bind(ctx.room)

    channel = os.environ.get("OPENCLAW_CHANNEL", os.environ.get("STIMM_CHANNEL", "default"))
    supervisor = _supervisor_factory(ctx.room.name, channel)

    livekit_url = os.environ.get("LIVEKIT_URL", "ws://localhost:7880")
    api_key = os.environ.get("LIVEKIT_API_KEY", "devkey")
    api_secret = os.environ.get("LIVEKIT_API_SECRET", "secret")

    sup_token = (
        lkapi.AccessToken(api_key, api_secret)
        .with_identity(f"stimm-supervisor-{ctx.room.name}")
        .with_ttl(timedelta(seconds=3600))
        .with_grants(
            lkapi.VideoGrants(
                room_join=True,
                room=ctx.room.name,
                can_publish=False,
                can_subscribe=True,
                can_publish_data=True,
            )
        )
    )

    try:
        await supervisor.connect(livekit_url, sup_token.to_jwt())
        supervisor.start_loop()
        logger.info(
            "Supervisor connected — room=%s channel=%s",
            ctx.room.name,
            channel,
        )
    except Exception as exc:
        logger.error("Supervisor failed to connect (continuing without): %s", exc)

    import asyncio

    disconnect = asyncio.Event()

    async def _on_shutdown() -> None:
        supervisor.stop_loop()
        try:
            await supervisor.disconnect()
        except Exception:
            pass
        disconnect.set()

    ctx.add_shutdown_callback(_on_shutdown)
    await disconnect.wait()


if __name__ == "__main__":
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            # Named worker to support explicit room dispatch from OpenClaw.
            agent_name=os.environ.get("STIMM_AGENT_NAME", "stimm-voice"),
        )
    )
