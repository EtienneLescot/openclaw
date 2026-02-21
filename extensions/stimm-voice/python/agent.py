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
    "cerebras": "livekit.plugins.cerebras",
    "fireworks": "livekit.plugins.fireworks",
    "together": "livekit.plugins.together",
    "sambanova": "livekit.plugins.sambanova",
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
    return mod.STT(**kwargs)


def _make_tts() -> Any:
    """Build the TTS instance from env config."""
    provider = os.environ.get("STIMM_TTS_PROVIDER", "openai")
    model = os.environ.get("STIMM_TTS_MODEL", "gpt-4o-mini-tts")
    voice = os.environ.get("STIMM_TTS_VOICE", "ash")
    api_key = os.environ.get("STIMM_TTS_API_KEY")

    mod = _load_plugin(TTS_PROVIDERS, provider)
    kwargs: dict[str, Any] = {"model": model, "voice": voice}
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
            "You are a friendly and helpful voice assistant for OpenClaw. "
            "Keep responses concise and conversational. "
            "When the supervisor sends you instructions, incorporate them naturally. "
            "If you don't have enough information, ask clarifying questions."
        ),
    )


async def entrypoint(ctx: JobContext) -> None:
    # Use TRANSPORT_NOHOST to skip host ICE candidates — they cause failures
    # in WSL2/Docker because the container's internal IPs aren't reachable.
    # Server-reflexive and relay (TURN) candidates still work via mapped ports.
    from livekit.rtc import RtcConfiguration, IceTransportType

    rtc_config = RtcConfiguration(
        ice_transport_type=IceTransportType.TRANSPORT_NOHOST,
    )

    await ctx.connect(rtc_config=rtc_config)
    session = AgentSession()
    await session.start(agent=make_agent(), room=ctx.room)
    # Keep the entrypoint alive until the room disconnects.
    disconnect = asyncio.Event()
    ctx.add_shutdown_callback(lambda: disconnect.set())
    await disconnect.wait()


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
