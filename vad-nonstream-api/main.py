"""VAD-segmented SenseVoice API compatible with the existing browser extension."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import logging
import os
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator

import numpy as np


def _prepare_windows_onnxruntime() -> None:
    """Prefer the virtual environment's ORT DLL over the System32 copy."""
    if sys.platform != "win32":
        return
    spec = importlib.util.find_spec("onnxruntime")
    if spec is None or spec.origin is None:
        return
    capi_dir = Path(spec.origin).parent / "capi"
    if not capi_dir.is_dir():
        return

    global _ORT_DLL_DIRECTORY
    _ORT_DLL_DIRECTORY = os.add_dll_directory(str(capi_dir))
    os.environ["PATH"] = f"{capi_dir}{os.pathsep}{os.environ.get('PATH', '')}"

    import ctypes

    ctypes.WinDLL(str(capi_dir / "onnxruntime.dll"))


_prepare_windows_onnxruntime()
import sherpa_onnx
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

LOGGER = logging.getLogger("uvicorn.error")
API_DIR = Path(__file__).resolve().parent
MODEL_DIR = API_DIR / "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09"
DEFAULT_ASR_MODEL = MODEL_DIR / "model.int8.onnx"
DEFAULT_TOKENS = MODEL_DIR / "tokens.txt"
DEFAULT_VAD_MODEL = MODEL_DIR / "silero_vad.onnx"
DEFAULT_PUNCT_MODEL = (
    API_DIR.parent
    / "api"
    / "model"
    / "sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8"
    / "model.int8.onnx"
)
SAMPLE_RATE = 16_000


def _path_from_env(name: str, default: Path) -> str:
    return os.getenv(name, str(default))


def create_recognizer() -> sherpa_onnx.OfflineRecognizer:
    model = _path_from_env("SENSE_VOICE_MODEL", DEFAULT_ASR_MODEL)
    tokens = _path_from_env("SENSE_VOICE_TOKENS", DEFAULT_TOKENS)
    missing = [path for path in (model, tokens) if not Path(path).is_file()]
    if missing:
        raise FileNotFoundError(f"SenseVoice model file(s) not found: {', '.join(missing)}")

    return sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=model,
        tokens=tokens,
        num_threads=int(os.getenv("ASR_NUM_THREADS", "2")),
        sample_rate=SAMPLE_RATE,
        feature_dim=80,
        provider=os.getenv("ASR_PROVIDER", "cpu"),
        language=os.getenv("ASR_LANGUAGE", "auto"),
        use_itn=os.getenv("ASR_USE_ITN", "true").lower() in {"1", "true", "yes"},
    )


def create_vad_config() -> sherpa_onnx.VadModelConfig:
    model = _path_from_env("VAD_MODEL", DEFAULT_VAD_MODEL)
    if not Path(model).is_file():
        raise FileNotFoundError(f"Silero VAD model not found: {model}")

    silero = sherpa_onnx.SileroVadModelConfig(
        model=model,
        threshold=float(os.getenv("VAD_THRESHOLD", "0.5")),
        min_silence_duration=float(os.getenv("VAD_MIN_SILENCE", "0.6")),
        min_speech_duration=float(os.getenv("VAD_MIN_SPEECH", "0.25")),
        window_size=512,
        max_speech_duration=float(os.getenv("VAD_MAX_SPEECH", "20")),
    )
    return sherpa_onnx.VadModelConfig(
        silero_vad=silero,
        sample_rate=SAMPLE_RATE,
        num_threads=int(os.getenv("VAD_NUM_THREADS", "1")),
        provider=os.getenv("VAD_PROVIDER", "cpu"),
    )


def create_punctuation() -> sherpa_onnx.OfflinePunctuation:
    model = _path_from_env("PUNCT_MODEL", DEFAULT_PUNCT_MODEL)
    if not Path(model).is_file():
        raise FileNotFoundError(f"Punctuation model not found: {model}")
    config = sherpa_onnx.OfflinePunctuationConfig(
        model=sherpa_onnx.OfflinePunctuationModelConfig(
            ct_transformer=model,
            num_threads=int(os.getenv("PUNCT_NUM_THREADS", "1")),
            provider=os.getenv("PUNCT_PROVIDER", "cpu"),
        )
    )
    return sherpa_onnx.OfflinePunctuation(config)


def decode_samples(
    recognizer: sherpa_onnx.OfflineRecognizer,
    punctuation: sherpa_onnx.OfflinePunctuation,
    samples: np.ndarray,
) -> str:
    stream = recognizer.create_stream()
    stream.accept_waveform(SAMPLE_RATE, samples)
    recognizer.decode_stream(stream)
    text = stream.result.text.strip()
    return punctuation.add_punctuation(text).strip() if text else ""


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    LOGGER.info("Loading SenseVoice model from %s", _path_from_env("SENSE_VOICE_MODEL", DEFAULT_ASR_MODEL))
    app.state.recognizer = await asyncio.to_thread(create_recognizer)
    app.state.vad_config = await asyncio.to_thread(create_vad_config)
    app.state.punctuation = await asyncio.to_thread(create_punctuation)
    app.state.decode_lock = asyncio.Lock()
    LOGGER.info("SenseVoice, Silero VAD, and punctuation model loaded")
    yield


app = FastAPI(
    title="VAD + SenseVoice ASR API",
    version="0.1.0",
    lifespan=lifespan,
)


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "engine": "sherpa-onnx-sense-voice",
        "mode": "vad-nonstreaming",
        "sample_rate": SAMPLE_RATE,
        "model_loaded": hasattr(app.state, "recognizer"),
        "vad_loaded": hasattr(app.state, "vad_config"),
        "punctuation_loaded": hasattr(app.state, "punctuation"),
    }


async def recognize(app: FastAPI, samples: np.ndarray) -> str:
    async with app.state.decode_lock:
        return await asyncio.to_thread(
            decode_samples, app.state.recognizer, app.state.punctuation, samples
        )


async def emit_final_segments(websocket: WebSocket, vad: sherpa_onnx.VoiceActivityDetector) -> bool:
    emitted = False
    while not vad.empty():
        segment = vad.front
        samples = np.asarray(segment.samples, dtype=np.float32).copy()
        vad.pop()
        if samples.size:
            text = await recognize(app, samples)
            if text:
                await websocket.send_json({"type": "final", "text": text})
                emitted = True
    return emitted


@app.websocket("/ws/asr")
async def vad_nonstreaming_asr(websocket: WebSocket) -> None:
    """Receive PCM16 chunks and return sentence-level SenseVoice results."""
    await websocket.accept()
    connection_id = f"{id(websocket):x}"
    connected_at = time.monotonic()
    received_samples = 0
    LOGGER.info("ASR WebSocket connected: id=%s client=%s", connection_id, websocket.client)
    vad = sherpa_onnx.VoiceActivityDetector(
        app.state.vad_config,
        buffer_size_in_seconds=float(os.getenv("VAD_BUFFER_SECONDS", "120")),
    )
    partial_interval = int(float(os.getenv("PARTIAL_INTERVAL_SECONDS", "0")) * SAMPLE_RATE)
    last_partial_samples = 0
    last_partial_text = ""

    await websocket.send_json({
        "type": "ready",
        "sample_rate": SAMPLE_RATE,
        "format": "pcm_s16le",
        "mode": "vad-nonstreaming",
    })

    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                LOGGER.warning(
                    "ASR WebSocket disconnect message: id=%s code=%s reason=%s",
                    connection_id,
                    message.get("code"),
                    message.get("reason", ""),
                )
                break

            chunk = message.get("bytes")
            finishing = False
            if chunk is None:
                text_message = message.get("text")
                if not text_message:
                    continue
                control = json.loads(text_message)
                if control.get("type") != "finish":
                    continue
                finishing = True
                vad.flush()
            else:
                if len(chunk) % 2:
                    await websocket.send_json({"type": "error", "message": "PCM16 chunk has an odd byte length"})
                    continue
                samples = np.frombuffer(chunk, dtype="<i2").astype(np.float32) / 32768.0
                received_samples += samples.size
                vad.accept_waveform(samples)

            had_final = await emit_final_segments(websocket, vad)
            if had_final:
                last_partial_samples = 0
                last_partial_text = ""

            if partial_interval > 0 and not finishing and vad.is_speech_detected():
                current = vad.current_segment
                current_samples = np.asarray(current.samples, dtype=np.float32).copy()
                if current_samples.size - last_partial_samples >= partial_interval:
                    partial_text = await recognize(app, current_samples)
                    last_partial_samples = current_samples.size
                    if partial_text and partial_text != last_partial_text:
                        last_partial_text = partial_text
                        await websocket.send_json({"type": "partial", "text": partial_text})

            if finishing:
                await websocket.send_json({"type": "finished"})
                break
    except WebSocketDisconnect as exc:
        LOGGER.warning(
            "ASR WebSocket disconnected: id=%s code=%s reason=%s",
            connection_id,
            exc.code,
            getattr(exc, "reason", ""),
        )
    except Exception as exc:
        LOGGER.exception("VAD + SenseVoice WebSocket failed")
        try:
            await websocket.send_json({"type": "error", "message": str(exc)})
        except Exception:
            pass
    finally:
        LOGGER.info(
            "ASR WebSocket closed: id=%s duration=%.1fs audio=%.1fs",
            connection_id,
            time.monotonic() - connected_at,
            received_samples / SAMPLE_RATE,
        )


def run() -> None:
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=False)


if __name__ == "__main__":
    run()
