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

# Write stimm.* / openclaw.* diagnostic logs directly to a file so they are
# visible even when livekit-agents runs entrypoint() in a watchfiles subprocess
# (whose stdout/stderr are not captured by the Node.js parent process).
# The FileHandler is inherited by child processes (fork), so it works in both
# the watcher process and the real worker subprocess.
_log_level_name = os.environ.get("STIMM_LOG_LEVEL", "INFO").upper()
_log_level = getattr(logging, _log_level_name, logging.INFO)
_diag_log_file = os.environ.get("STIMM_DIAG_LOG", "/tmp/stimm-agent.log")

_file_handler = logging.FileHandler(_diag_log_file, mode="a", encoding="utf-8")
_file_handler.setLevel(_log_level)
_file_handler.setFormatter(
    logging.Formatter(
        fmt="%(asctime)s %(levelname)-5s %(name)s %(message)s",
        datefmt="%H:%M:%S",
    )
)

# Apply to stimm.* and openclaw.* — these are the loggers that emit
# [TRANSCRIPT], [SUPERVISOR], [VOICE_AGENT] markers.
for _pkg in ("stimm", "openclaw"):
    _lg = logging.getLogger(_pkg)
    _lg.setLevel(_log_level)
    _lg.addHandler(_file_handler)
    _lg.propagate = False  # don't double-print to root/livekit handlers

import aiohttp  # noqa: E402
from livekit.agents import WorkerOptions, cli  # noqa: E402

from stimm import ConversationSupervisor  # noqa: E402

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

    # Bind audio input to the web client participant identity ("user").
    # STIMM_PARTICIPANT_IDENTITY can override for other topologies.
    from livekit.agents import RoomInputOptions
    from stimm.worker import make_entrypoint

    participant_identity = os.environ.get("STIMM_PARTICIPANT_IDENTITY", "user").strip()
    room_input_options = RoomInputOptions(participant_identity=participant_identity)
    logger.info("Room input participant binding: %s", participant_identity or "<auto>")

    # Delegate entirely to stimm.make_entrypoint — dedup, handlers, supervisor
    # token, and shutdown are all handled there.  OpenClaw only contributes the
    # supervisor factory (HTTP POST to the gateway) and the SOURCE_UNKNOWN patch.
    await make_entrypoint(
        _supervisor_factory,
        room_input_options=room_input_options,
    )(ctx)


if __name__ == "__main__":
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            # Named worker to support explicit room dispatch from OpenClaw.
            agent_name=os.environ.get("STIMM_AGENT_NAME", "stimm-voice"),
        )
    )
