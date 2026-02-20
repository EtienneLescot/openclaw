"""OpenClaw voice agent — thin wrapper around Stimm VoiceAgent.

This is the entire Python side needed for OpenClaw. The VoiceAgent
handles the audio pipeline (VAD → STT → fast LLM → TTS) and
communicates with the OpenClaw supervisor via the Stimm protocol.

Run with:
    python agent.py dev
"""

import os

from livekit.agents import WorkerOptions, cli
from livekit.plugins import deepgram, openai, silero

from stimm import VoiceAgent

agent = VoiceAgent(
    stt=deepgram.STT(),
    tts=openai.TTS(),
    vad=silero.VAD.load(),
    fast_llm=openai.LLM(model=os.environ.get("STIMM_LLM_MODEL", "gpt-4o-mini")),
    buffering_level=os.environ.get("STIMM_BUFFERING", "MEDIUM"),  # type: ignore[arg-type]
    mode=os.environ.get("STIMM_MODE", "hybrid"),  # type: ignore[arg-type]
    instructions=(
        "You are a friendly and helpful voice assistant for OpenClaw. "
        "Keep responses concise and conversational. "
        "When the supervisor sends you instructions, incorporate them naturally. "
        "If you don't have enough information, ask clarifying questions."
    ),
)

if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=agent.entrypoint))
