"""FunASR two-pass ASR service compatible with the existing extension."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator

import numpy as np
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from funasr import AutoModel

LOGGER = logging.getLogger("uvicorn.error")
API_DIR = Path(__file__).resolve().parent
MODEL_ROOT = API_DIR.parent / "model" / "funasr"
SAMPLE_RATE = 16_000

DEFAULT_STREAMING_MODEL = MODEL_ROOT / "paraformer-zh-streaming"
DEFAULT_OFFLINE_MODEL = MODEL_ROOT / "paraformer-zh"
DEFAULT_VAD_MODEL = MODEL_ROOT / "fsmn-vad"
DEFAULT_PUNCTUATION_MODEL = MODEL_ROOT / "ct-punc"

CHUNK_SIZE = [
    int(value.strip())
    for value in os.getenv("ASR_CHUNK_SIZE", "0,10,5").split(",")
]
if len(CHUNK_SIZE) != 3 or CHUNK_SIZE[1] <= 0:
    raise ValueError("ASR_CHUNK_SIZE must contain 3 integers and a positive middle value")

# In FunASR's Paraformer streaming API, one middle chunk unit equals 960 samples.
STREAMING_STRIDE_SAMPLES = CHUNK_SIZE[1] * 960
ENCODER_LOOK_BACK = int(os.getenv("ASR_ENCODER_LOOK_BACK", "4"))
DECODER_LOOK_BACK = int(os.getenv("ASR_DECODER_LOOK_BACK", "1"))
MAX_SEGMENT_SAMPLES = int(float(os.getenv("ASR_MAX_SEGMENT_SECONDS", "30")) * SAMPLE_RATE)
MIN_FINAL_SAMPLES = int(float(os.getenv("ASR_MIN_FINAL_SECONDS", "0.2")) * SAMPLE_RATE)
QUEUE_MAX_CHUNKS = int(os.getenv("ASR_QUEUE_MAX_CHUNKS", "256"))


def _env_path(name: str, default: Path) -> Path:
    return Path(os.getenv(name, str(default))).expanduser().resolve()


def _model_options() -> dict[str, Any]:
    device = os.getenv("ASR_DEVICE", "cuda:0")
    return {
        "device": device,
        "ngpu": 0 if device == "cpu" else 1,
        "ncpu": int(os.getenv("ASR_NUM_THREADS", "4")),
        "disable_update": True,
        "disable_pbar": True,
        "disable_log": True,
    }


def _load_model(path: Path) -> AutoModel:
    if not path.is_dir():
        raise FileNotFoundError(f"FunASR model directory not found: {path}")
    return AutoModel(model=str(path), **_model_options())


def load_models() -> dict[str, AutoModel]:
    paths = {
        "streaming": _env_path("FUNASR_STREAMING_MODEL", DEFAULT_STREAMING_MODEL),
        "offline": _env_path("FUNASR_OFFLINE_MODEL", DEFAULT_OFFLINE_MODEL),
        "vad": _env_path("FUNASR_VAD_MODEL", DEFAULT_VAD_MODEL),
        "punctuation": _env_path("FUNASR_PUNCTUATION_MODEL", DEFAULT_PUNCTUATION_MODEL),
    }
    models: dict[str, AutoModel] = {}
    for name, path in paths.items():
        LOGGER.info("Loading FunASR %s model from %s", name, path)
        models[name] = _load_model(path)
    return models


def _first_result(result: Any) -> dict[str, Any]:
    if isinstance(result, tuple):
        result = result[0]
    if isinstance(result, list) and result and isinstance(result[0], dict):
        return result[0]
    if isinstance(result, dict):
        return result
    return {}


def _result_text(result: Any) -> str:
    return str(_first_result(result).get("text", "")).strip()


def _vad_has_endpoint(result: Any) -> bool:
    value = _first_result(result).get("value", [])
    for segment in value or []:
        if isinstance(segment, (list, tuple)) and len(segment) >= 2:
            try:
                if int(segment[1]) >= 0:
                    return True
            except (TypeError, ValueError):
                continue
    return False


def _append_text(current: str, piece: str) -> str:
    piece = piece.strip()
    if not piece:
        return current
    if not current:
        return piece
    # Preserve word boundaries for English while keeping Chinese output compact.
    if re.search(r"[A-Za-z0-9]$", current) and re.match(r"^[A-Za-z0-9]", piece):
        return f"{current} {piece}"
    return current + piece


@dataclass
class SessionState:
    online_cache: dict[str, Any] = field(default_factory=dict)
    vad_cache: dict[str, Any] = field(default_factory=dict)
    pending_samples: np.ndarray = field(
        default_factory=lambda: np.empty(0, dtype=np.float32)
    )
    segment_parts: list[np.ndarray] = field(default_factory=list)
    segment_sample_count: int = 0
    partial_text: str = ""

    def reset_segment(self) -> None:
        self.online_cache = {}
        self.vad_cache = {}
        self.segment_parts.clear()
        self.segment_sample_count = 0
        self.partial_text = ""


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    app.state.models = await asyncio.to_thread(load_models)
    # Shared PyTorch model instances are serialized per stage. WebSocket input is
    # still received concurrently and buffered by each session's bounded queue.
    app.state.locks = {name: asyncio.Lock() for name in app.state.models}
    LOGGER.info("All FunASR models loaded on %s", os.getenv("ASR_DEVICE", "cuda:0"))
    yield


app = FastAPI(
    title="FunASR Two-Pass ASR API",
    version="0.1.0",
    lifespan=lifespan,
)


@app.get("/health")
async def health() -> dict[str, Any]:
    models = getattr(app.state, "models", {})
    return {
        "status": "ok" if len(models) == 4 else "starting",
        "engine": "funasr",
        "mode": "two-pass",
        "device": os.getenv("ASR_DEVICE", "cuda:0"),
        "sample_rate": SAMPLE_RATE,
        "models_loaded": sorted(models.keys()),
    }


async def _generate(stage: str, **kwargs: Any) -> Any:
    async with app.state.locks[stage]:
        model = app.state.models[stage]
        return await asyncio.to_thread(model.generate, **kwargs)


async def _streaming_decode(samples: np.ndarray, state: SessionState, is_final: bool) -> str:
    result = await _generate(
        "streaming",
        input=samples,
        cache=state.online_cache,
        is_final=is_final,
        chunk_size=CHUNK_SIZE,
        encoder_chunk_look_back=ENCODER_LOOK_BACK,
        decoder_chunk_look_back=DECODER_LOOK_BACK,
        batch_size=1,
    )
    return _result_text(result)


async def _detect_endpoint(samples: np.ndarray, state: SessionState, is_final: bool) -> bool:
    result = await _generate(
        "vad",
        input=samples,
        cache=state.vad_cache,
        is_final=is_final,
        chunk_size=int(os.getenv("VAD_CHUNK_SIZE_MS", "200")),
    )
    return _vad_has_endpoint(result)


async def _offline_decode(samples: np.ndarray) -> str:
    result = await _generate("offline", input=samples, batch_size=1)
    text = _result_text(result)
    if not text:
        return ""
    punctuation_result = await _generate("punctuation", input=text)
    return _result_text(punctuation_result) or text


async def _emit_final(websocket: WebSocket, state: SessionState) -> bool:
    if state.segment_sample_count < MIN_FINAL_SAMPLES:
        state.reset_segment()
        return False
    samples = np.concatenate(state.segment_parts)
    text = await _offline_decode(samples)
    state.reset_segment()
    if text:
        await websocket.send_json({"type": "final", "text": text})
        return True
    return False


async def _process_stride(
    websocket: WebSocket,
    state: SessionState,
    samples: np.ndarray,
    *,
    is_final: bool,
) -> None:
    if samples.size:
        state.segment_parts.append(samples.copy())
        state.segment_sample_count += samples.size

    piece = await _streaming_decode(samples, state, is_final=is_final)
    if piece:
        state.partial_text = _append_text(state.partial_text, piece)
        await websocket.send_json({"type": "partial", "text": state.partial_text})

    endpoint = await _detect_endpoint(samples, state, is_final=is_final)
    forced_endpoint = state.segment_sample_count >= MAX_SEGMENT_SAMPLES
    if endpoint or forced_endpoint or is_final:
        await _emit_final(websocket, state)


async def _process_session(websocket: WebSocket, queue: asyncio.Queue[bytes | None]) -> None:
    state = SessionState()
    while True:
        item = await queue.get()
        if item is None:
            if state.pending_samples.size:
                tail = state.pending_samples
                state.pending_samples = np.empty(0, dtype=np.float32)
                await _process_stride(websocket, state, tail, is_final=True)
            elif state.segment_sample_count:
                # Flush both streaming/VAD caches even when the previous frame
                # ended exactly at the configured stride.
                await _process_stride(
                    websocket,
                    state,
                    np.empty(0, dtype=np.float32),
                    is_final=True,
                )
            await websocket.send_json({"type": "finished"})
            return

        samples = np.frombuffer(item, dtype="<i2").astype(np.float32) / 32768.0
        state.pending_samples = np.concatenate((state.pending_samples, samples))
        while state.pending_samples.size >= STREAMING_STRIDE_SAMPLES:
            stride = state.pending_samples[:STREAMING_STRIDE_SAMPLES].copy()
            state.pending_samples = state.pending_samples[STREAMING_STRIDE_SAMPLES:]
            await _process_stride(websocket, state, stride, is_final=False)


@app.websocket("/ws/asr")
async def two_pass_asr(websocket: WebSocket) -> None:
    """Receive mono PCM16 and emit extension-compatible ASR messages."""
    await websocket.accept()
    connection_id = f"{id(websocket):x}"
    connected_at = time.monotonic()
    received_samples = 0
    queue: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=QUEUE_MAX_CHUNKS)
    processor = asyncio.create_task(_process_session(websocket, queue))

    LOGGER.info("FunASR WebSocket connected: id=%s client=%s", connection_id, websocket.client)
    await websocket.send_json(
        {
            "type": "ready",
            "sample_rate": SAMPLE_RATE,
            "format": "pcm_s16le",
            "mode": "two-pass",
        }
    )

    try:
        while True:
            receive_task = asyncio.create_task(websocket.receive())
            done, _ = await asyncio.wait(
                {receive_task, processor}, return_when=asyncio.FIRST_COMPLETED
            )
            if processor in done:
                receive_task.cancel()
                await processor
                break

            message = receive_task.result()
            if message["type"] == "websocket.disconnect":
                processor.cancel()
                break

            chunk = message.get("bytes")
            if chunk is not None:
                if len(chunk) % 2:
                    await websocket.send_json(
                        {"type": "error", "message": "PCM16 chunk has an odd byte length"}
                    )
                    continue
                received_samples += len(chunk) // 2
                await queue.put(chunk)
                continue

            text_message = message.get("text")
            if not text_message:
                continue
            control = json.loads(text_message)
            if control.get("type") == "finish":
                await queue.put(None)
                await processor
                break
    except WebSocketDisconnect as exc:
        processor.cancel()
        LOGGER.warning(
            "FunASR WebSocket disconnected: id=%s code=%s", connection_id, exc.code
        )
    except Exception as exc:
        processor.cancel()
        LOGGER.exception("FunASR WebSocket failed: id=%s", connection_id)
        try:
            await websocket.send_json({"type": "error", "message": str(exc)})
        except Exception:
            pass
    finally:
        if not processor.done():
            processor.cancel()
        await asyncio.gather(processor, return_exceptions=True)
        LOGGER.info(
            "FunASR WebSocket closed: id=%s duration=%.1fs audio=%.1fs",
            connection_id,
            time.monotonic() - connected_at,
            received_samples / SAMPLE_RATE,
        )


def run() -> None:
    uvicorn.run(
        "main:app",
        host=os.getenv("ASR_HOST", "0.0.0.0"),
        port=int(os.getenv("ASR_PORT", "8000")),
        reload=False,
        ws_ping_interval=float(os.getenv("ASR_WS_PING_INTERVAL", "20")),
        ws_ping_timeout=float(os.getenv("ASR_WS_PING_TIMEOUT", "20")),
    )


if __name__ == "__main__":
    run()

