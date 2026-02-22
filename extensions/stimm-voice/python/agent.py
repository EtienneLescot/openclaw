"""OpenClaw voice agent — thin wrapper around Stimm VoiceAgent.

This is the entire Python side needed for OpenClaw. The VoiceAgent
handles the audio pipeline (VAD → STT → fast LLM → TTS) and
communicates with the OpenClaw supervisor via the Stimm protocol.

Provider selection is driven by STIMM_* env vars set by the TS side:
    STIMM_STT_PROVIDER / STIMM_STT_MODEL / STIMM_STT_API_KEY / STIMM_STT_LANGUAGE
    STIMM_TTS_PROVIDER / STIMM_TTS_MODEL / STIMM_TTS_API_KEY / STIMM_TTS_VOICE
    STIMM_LLM_PROVIDER / STIMM_LLM_MODEL / STIMM_LLM_API_KEY

Run with:
    python agent.py dev
"""

from __future__ import annotations

import asyncio
import importlib
import os
from typing import Any

from livekit.agents import AgentSession, JobContext, WorkerOptions, cli
from livekit.plugins import silero

from stimm import VoiceAgent

# ---------------------------------------------------------------------------
# Dynamic provider loading — maps provider names to livekit-plugins-* modules.
# ---------------------------------------------------------------------------

# STT providers: must expose an STT class.
STT_PROVIDERS: dict[str, str] = {
    "deepgram": "livekit.plugins.deepgram",
    "openai": "livekit.plugins.openai",
    "google": "livekit.plugins.google",
    "azure": "livekit.plugins.azure",
    "assemblyai": "livekit.plugins.assemblyai",
    "aws": "livekit.plugins.aws",
    "speechmatics": "livekit.plugins.speechmatics",
    "clova": "livekit.plugins.clova",
    "fal": "livekit.plugins.fal",
}

# TTS providers: must expose a TTS class.
TTS_PROVIDERS: dict[str, str] = {
    "openai": "livekit.plugins.openai",
    "elevenlabs": "livekit.plugins.elevenlabs",
    "cartesia": "livekit.plugins.cartesia",
    "google": "livekit.plugins.google",
    "azure": "livekit.plugins.azure",
    "aws": "livekit.plugins.aws",
    "playai": "livekit.plugins.playai",
    "rime": "livekit.plugins.rime",
}

# LLM providers: must expose an LLM class.
LLM_PROVIDERS: dict[str, str] = {
    "openai": "livekit.plugins.openai",
    "anthropic": "livekit.plugins.anthropic",
    "google": "livekit.plugins.google",
    "groq": "livekit.plugins.groq",
    "azure": "livekit.plugins.azure",
}


def _load_plugin(provider_map: dict[str, str], provider: str) -> Any:
    """Import and return a livekit-plugins-* module by provider name."""
    module_name = provider_map.get(provider)
    if not module_name:
        raise ValueError(
            f"Unknown provider '{provider}'. "
            f"Available: {', '.join(sorted(provider_map.keys()))}"
        )
    try:
        return importlib.import_module(module_name)
    except ImportError as exc:
        raise ImportError(
            f"Provider '{provider}' requires: pip install livekit-plugins-{provider}"
        ) from exc


def _make_stt() -> Any:
    """Build the STT instance from env config."""
    provider = os.environ.get("STIMM_STT_PROVIDER", "deepgram")
    model = os.environ.get("STIMM_STT_MODEL", "nova-3")
    api_key = os.environ.get("STIMM_STT_API_KEY")
    language = os.environ.get("STIMM_STT_LANGUAGE")

    mod = _load_plugin(STT_PROVIDERS, provider)
    kwargs: dict[str, Any] = {"model": model}
    if api_key:
        kwargs["api_key"] = api_key
    if language:
        kwargs["language"] = language
    # detect_language is NOT supported in streaming mode by livekit-plugins-deepgram;
    # set an explicit language code via STIMM_STT_LANGUAGE or voiceAgent.stt.language.
    return mod.STT(**kwargs)


def _make_tts() -> Any:
    """Build the TTS instance from env config."""
    provider = os.environ.get("STIMM_TTS_PROVIDER", "openai")
    model = os.environ.get("STIMM_TTS_MODEL", "gpt-4o-mini-tts")
    voice = os.environ.get("STIMM_TTS_VOICE", "ash")
    api_key = os.environ.get("STIMM_TTS_API_KEY")

    mod = _load_plugin(TTS_PROVIDERS, provider)
    kwargs: dict[str, Any] = {"model": model}
    # ElevenLabs uses `voice_id`; most other providers use `voice`.
    if provider == "elevenlabs":
        kwargs["voice_id"] = voice
    else:
        kwargs["voice"] = voice
    if api_key:
        kwargs["api_key"] = api_key
    return mod.TTS(**kwargs)


def _make_llm() -> Any:
    """Build the LLM instance from env config."""
    provider = os.environ.get("STIMM_LLM_PROVIDER", "openai")
    model = os.environ.get("STIMM_LLM_MODEL", "gpt-4o-mini")
    api_key = os.environ.get("STIMM_LLM_API_KEY")

    mod = _load_plugin(LLM_PROVIDERS, provider)
    kwargs: dict[str, Any] = {"model": model}
    if api_key:
        kwargs["api_key"] = api_key
    return mod.LLM(**kwargs)


def make_agent() -> VoiceAgent:
    return VoiceAgent(
        stt=_make_stt(),
        tts=_make_tts(),
        vad=silero.VAD.load(),
        fast_llm=_make_llm(),
        buffering_level=os.environ.get("STIMM_BUFFERING", "MEDIUM"),  # type: ignore[arg-type]
        mode=os.environ.get("STIMM_MODE", "hybrid"),  # type: ignore[arg-type]
        instructions=(
            "You are a voice assistant. You work alongside a supervisor AI "
            "called Stimmy who has access to tools, memory, and real knowledge. "
            "You handle the live conversation; Stimmy thinks in the background.\n\n"
            "IDENTITY & TRANSPARENCY:\n"
            "- You are the voice interface. Stimmy is your supervisor.\n"
            "- Be HONEST about this setup. Never pretend to know things you don't.\n"
            "- When the user asks a factual/technical question, say things like: "
            "'Je demande à Stimmy', 'Je me renseigne auprès de mon superviseur', "
            "'Laisse-moi vérifier avec Stimmy'.\n\n"
            "CONTEXT UPDATES FROM STIMMY:\n"
            "Stimmy updates your context in real time. The context may contain:\n"
            "- Background info or facts: absorb them silently, use if relevant.\n"
            "- A [SPEAK_EXACTLY] block: say that text to the user right now, "
            "verbatim, introducing it naturally "
            "('Stimmy me dit que...', 'J'ai le retour de Stimmy :'). "
            "Do NOT paraphrase. Do NOT add your own guesses.\n\n"
            "WHAT YOU CAN DO ON YOUR OWN:\n"
            "- Greetings, small talk, acknowledgements, follow-up questions.\n"
            "- Simple tasks: 'raconte une histoire', 'dis un mot drôle', etc.\n"
            "- Confirm understanding, ask for clarification.\n\n"
            "RULES:\n"
            "1. Always respond in the SAME LANGUAGE the user is speaking.\n"
            "2. Keep responses short and natural (1-2 sentences).\n"
            "3. NEVER invent facts, names, or technical details.\n"
            "4. If the user asks multiple things at once, handle what you can "
            "and explicitly say you're asking Stimmy for the rest."
        ),
    )


async def entrypoint(ctx: JobContext) -> None:
    # Use TRANSPORT_ALL so the Python agent can reach LiveKit via the host IP
    # (192.168.1.x / 127.0.0.1). TRANSPORT_NOHOST blocked all host candidates
    # which made the PeerConnection time out when node_ip is the LAN IP.
    from livekit.rtc import RtcConfiguration, IceTransportType

    rtc_config = RtcConfiguration(
        ice_transport_type=IceTransportType.TRANSPORT_ALL,
    )

    await ctx.connect(rtc_config=rtc_config)
    agent = make_agent()

    session = AgentSession()

    # Forward STT transcripts to the supervisor via the Stimm protocol.
    # The supervisor (Node side) buffers the conversation and periodically
    # sends batches to the big LLM.
    @session.on("user_input_transcribed")
    def _on_transcript(ev) -> None:  # type: ignore[no-untyped-def]
        asyncio.ensure_future(
            agent.publish_transcript(ev.transcript, partial=not ev.is_final)
        )

    await session.start(agent=agent, room=ctx.room)

    # Bind the Stimm protocol after session.start() so the room is fully
    # initialised before we open the data channel.
    agent.protocol.bind(ctx.room)

    # Keep the entrypoint alive until the room disconnects.
    disconnect = asyncio.Event()

    async def _on_shutdown() -> None:
        disconnect.set()

    ctx.add_shutdown_callback(_on_shutdown)
    await disconnect.wait()


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
