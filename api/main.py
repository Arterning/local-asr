"""FastAPI service for streaming speech recognition with sherpa-onnx."""

from __future__ import annotations

import asyncio
import importlib.util
import logging
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator

import numpy as np


def _prepare_windows_onnxruntime() -> None:
    """Prefer the venv's ORT DLL over Windows' older System32 copy."""
    if sys.platform != "win32":
        return

    spec = importlib.util.find_spec("onnxruntime")
    if spec is None or spec.origin is None:
        return

    capi_dir = Path(spec.origin).parent / "capi"
    if not capi_dir.is_dir():
        return

    # Keep the handle alive for the lifetime of the process.
    global _ORT_DLL_DIRECTORY
    _ORT_DLL_DIRECTORY = os.add_dll_directory(str(capi_dir))
    os.environ["PATH"] = f"{capi_dir}{os.pathsep}{os.environ.get('PATH', '')}"

    # Windows normally searches System32 before package directories. Explicitly
    # loading this file ensures sherpa-onnx reuses the compatible DLL.
    import ctypes

    ctypes.WinDLL(str(capi_dir / "onnxruntime.dll"))


_prepare_windows_onnxruntime()
import sherpa_onnx
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

LOGGER = logging.getLogger("asr-api")
API_DIR = Path(__file__).resolve().parent
DEFAULT_MODEL_DIR = (
    API_DIR.parent
    / "model"
    / "sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20"
)
DEFAULT_PUNCTUATION_MODEL = (
    API_DIR.parent
    / "model"
    / "sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8"
    / "model.int8.onnx"
)
SAMPLE_RATE = 16_000


def _env_path(name: str, default_name: str) -> str:
    model_dir = Path(os.getenv("ASR_MODEL_DIR", str(DEFAULT_MODEL_DIR)))
    return os.getenv(name, str(model_dir / default_name))


def create_recognizer() -> sherpa_onnx.OnlineRecognizer:
    """Create one recognizer; each WebSocket connection gets its own stream."""
    paths = {
        "tokens": _env_path("ASR_TOKENS", "tokens.txt"),
        "encoder": _env_path("ASR_ENCODER", "encoder.onnx"),
        "decoder": _env_path("ASR_DECODER", "decoder.onnx"),
        "joiner": _env_path("ASR_JOINER", "joiner.onnx"),
    }
    missing = [path for path in paths.values() if not Path(path).is_file()]
    if missing:
        raise FileNotFoundError(f"ASR model file(s) not found: {', '.join(missing)}")

    return sherpa_onnx.OnlineRecognizer.from_transducer(
        tokens=paths["tokens"],
        encoder=paths["encoder"],
        decoder=paths["decoder"],
        joiner=paths["joiner"],
        num_threads=int(os.getenv("ASR_NUM_THREADS", "2")),
        sample_rate=SAMPLE_RATE,
        feature_dim=80,
        decoding_method=os.getenv("ASR_DECODING_METHOD", "greedy_search"),
        provider=os.getenv("ASR_PROVIDER", "cpu"),
        enable_endpoint_detection=True,
        rule1_min_trailing_silence=float(os.getenv("ASR_RULE1_SILENCE", "2.4")),
        rule2_min_trailing_silence=float(os.getenv("ASR_RULE2_SILENCE", "1.2")),
        rule3_min_utterance_length=float(os.getenv("ASR_RULE3_LENGTH", "20")),
    )


def create_punctuation() -> sherpa_onnx.OfflinePunctuation:
    """Load the Chinese-English CT-Transformer punctuation model."""
    model = Path(os.getenv("PUNCT_MODEL", str(DEFAULT_PUNCTUATION_MODEL)))
    if not model.is_file():
        raise FileNotFoundError(f"Punctuation model not found: {model}")

    config = sherpa_onnx.OfflinePunctuationConfig(
        model=sherpa_onnx.OfflinePunctuationModelConfig(
            ct_transformer=str(model),
            num_threads=int(os.getenv("PUNCT_NUM_THREADS", "1")),
            provider=os.getenv("ASR_PROVIDER", "cpu"),
        )
    )
    return sherpa_onnx.OfflinePunctuation(config)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    LOGGER.info("Loading sherpa-onnx model from %s", os.getenv("ASR_MODEL_DIR", DEFAULT_MODEL_DIR))
    app.state.recognizer = await asyncio.to_thread(create_recognizer)
    LOGGER.info("ASR model loaded")
    LOGGER.info("Loading punctuation model from %s", os.getenv("PUNCT_MODEL", DEFAULT_PUNCTUATION_MODEL))
    app.state.punctuation = await asyncio.to_thread(create_punctuation)
    LOGGER.info("Punctuation model loaded")
    yield


app = FastAPI(
    title="Streaming ASR API",
    version="0.1.0",
    lifespan=lifespan,
)


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "engine": "sherpa-onnx",
        "sample_rate": SAMPLE_RATE,
        "model_loaded": hasattr(app.state, "recognizer"),
        "punctuation_loaded": hasattr(app.state, "punctuation"),
    }


@app.websocket("/ws/asr")
async def streaming_asr(websocket: WebSocket) -> None:
    """Receive little-endian mono PCM16 chunks and emit partial/final results."""
    await websocket.accept()
    recognizer: sherpa_onnx.OnlineRecognizer = app.state.recognizer
    punctuation: sherpa_onnx.OfflinePunctuation = app.state.punctuation
    stream = recognizer.create_stream()
    last_partial = ""

    await websocket.send_json(
        {"type": "ready", "sample_rate": SAMPLE_RATE, "format": "pcm_s16le"}
    )

    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break

            chunk = message.get("bytes")
            if chunk is None:
                # Optional client control message. {"type":"finish"} flushes audio.
                if message.get("text"):
                    import json

                    control = json.loads(message["text"])
                    if control.get("type") == "finish":
                        stream.input_finished()
                    else:
                        continue
                else:
                    continue
            else:
                if len(chunk) % 2:
                    await websocket.send_json(
                        {"type": "error", "message": "PCM16 chunk has an odd byte length"}
                    )
                    continue
                samples = np.frombuffer(chunk, dtype="<i2").astype(np.float32) / 32768.0
                stream.accept_waveform(SAMPLE_RATE, samples)

            while recognizer.is_ready(stream):
                recognizer.decode_stream(stream)

            text = recognizer.get_result(stream).strip()
            if text and text != last_partial:
                last_partial = text
                punctuated = punctuation.add_punctuation(text).strip()
                await websocket.send_json({"type": "partial", "text": punctuated})

            if recognizer.is_endpoint(stream):
                if text:
                    punctuated = punctuation.add_punctuation(text).strip()
                    await websocket.send_json({"type": "final", "text": punctuated})
                recognizer.reset(stream)
                last_partial = ""

            if chunk is None:
                final_text = recognizer.get_result(stream).strip()
                if final_text:
                    punctuated = punctuation.add_punctuation(final_text).strip()
                    await websocket.send_json({"type": "final", "text": punctuated})
                await websocket.send_json({"type": "finished"})
                break
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        LOGGER.exception("ASR WebSocket failed")
        try:
            await websocket.send_json({"type": "error", "message": str(exc)})
        except Exception:
            pass


def run() -> None:
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=False)


if __name__ == "__main__":
    run()
