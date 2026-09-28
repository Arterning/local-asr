"""VAD-segmented whisper.cpp WebSocket API compatible with the web extension."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import tempfile
import time
import wave
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import AsyncIterator

import uvicorn
import webrtcvad
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

LOGGER = logging.getLogger("uvicorn.error")
PROJECT_ROOT = Path(__file__).resolve().parent.parent
SAMPLE_RATE = 16_000
SAMPLE_WIDTH = 2
FRAME_MS = 30
FRAME_BYTES = SAMPLE_RATE * SAMPLE_WIDTH * FRAME_MS // 1000

MODEL_PATH = Path(
    os.getenv("WHISPER_MODEL", str(PROJECT_ROOT / "model" / "ggml-small.bin"))
).expanduser().resolve()
WHISPER_CLI = os.getenv("WHISPER_CLI", "whisper-cli")
LANGUAGE = os.getenv("WHISPER_LANGUAGE", "zh")
THREADS = int(os.getenv("WHISPER_THREADS", "0"))
NO_GPU = os.getenv("WHISPER_NO_GPU", "false").lower() in {"1", "true", "yes"}

VAD_MODE = int(os.getenv("VAD_MODE", "2"))
VAD_START_MS = int(os.getenv("VAD_START_MS", "90"))
VAD_END_SILENCE_MS = int(os.getenv("VAD_END_SILENCE_MS", "600"))
VAD_PREROLL_MS = int(os.getenv("VAD_PREROLL_MS", "300"))
MIN_SEGMENT_MS = int(os.getenv("VAD_MIN_SEGMENT_MS", "250"))
MAX_SEGMENT_MS = int(os.getenv("VAD_MAX_SEGMENT_MS", "20000"))
QUEUE_MAX_CHUNKS = int(os.getenv("ASR_QUEUE_MAX_CHUNKS", "256"))
MAX_CONCURRENT_TRANSCRIPTIONS = int(os.getenv("WHISPER_MAX_CONCURRENCY", "1"))


def _frame_count(milliseconds: int) -> int:
    return max(1, (milliseconds + FRAME_MS - 1) // FRAME_MS)


@dataclass
class VadSegmenter:
    vad: webrtcvad.Vad = field(default_factory=lambda: webrtcvad.Vad(VAD_MODE))
    pending: bytearray = field(default_factory=bytearray)
    preroll: deque[bytes] = field(
        default_factory=lambda: deque(maxlen=_frame_count(VAD_PREROLL_MS))
    )
    segment: bytearray = field(default_factory=bytearray)
    active: bool = False
    consecutive_speech: int = 0
    silence_frames: int = 0

    def accept(self, chunk: bytes) -> list[bytes]:
        self.pending.extend(chunk)
        completed: list[bytes] = []
        while len(self.pending) >= FRAME_BYTES:
            frame = bytes(self.pending[:FRAME_BYTES])
            del self.pending[:FRAME_BYTES]
            segment = self._accept_frame(frame)
            if segment:
                completed.append(segment)
        return completed

    def _accept_frame(self, frame: bytes) -> bytes | None:
        is_speech = self.vad.is_speech(frame, SAMPLE_RATE)
        if not self.active:
            self.preroll.append(frame)
            self.consecutive_speech = self.consecutive_speech + 1 if is_speech else 0
            if self.consecutive_speech >= _frame_count(VAD_START_MS):
                self.active = True
                self.segment.extend(b"".join(self.preroll))
                self.preroll.clear()
                self.silence_frames = 0
            return None

        self.segment.extend(frame)
        self.silence_frames = 0 if is_speech else self.silence_frames + 1
        reached_endpoint = self.silence_frames >= _frame_count(VAD_END_SILENCE_MS)
        reached_limit = len(self.segment) >= SAMPLE_RATE * SAMPLE_WIDTH * MAX_SEGMENT_MS // 1000
        if reached_endpoint or reached_limit:
            return self._finish_segment()
        return None

    def flush(self) -> bytes | None:
        if self.active:
            self.segment.extend(self.pending)
            self.pending.clear()
            return self._finish_segment()
        self.pending.clear()
        self.preroll.clear()
        self.consecutive_speech = 0
        return None

    def _finish_segment(self) -> bytes | None:
        audio = bytes(self.segment)
        self.segment.clear()
        self.active = False
        self.consecutive_speech = 0
        self.silence_frames = 0
        self.preroll.clear()
        minimum_bytes = SAMPLE_RATE * SAMPLE_WIDTH * MIN_SEGMENT_MS // 1000
        return audio if len(audio) >= minimum_bytes else None


def _write_wav(path: Path, pcm: bytes) -> None:
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(SAMPLE_WIDTH)
        output.setframerate(SAMPLE_RATE)
        output.writeframes(pcm)


async def _transcribe(pcm: bytes) -> str:
    async with app.state.transcription_semaphore:
        with tempfile.TemporaryDirectory(prefix="whisper-cpp-api-") as temp_dir:
            temp_path = Path(temp_dir)
            wav_path = temp_path / "segment.wav"
            output_base = temp_path / "transcript"
            await asyncio.to_thread(_write_wav, wav_path, pcm)

            command = [
                app.state.whisper_cli,
                "--model",
                str(MODEL_PATH),
                "--file",
                str(wav_path),
                "--language",
                LANGUAGE,
                "--output-txt",
                "--output-file",
                str(output_base),
                "--no-timestamps",
                "--no-prints",
            ]
            if THREADS > 0:
                command.extend(["--threads", str(THREADS)])
            if NO_GPU:
                command.append("--no-gpu")

            process = await asyncio.create_subprocess_exec(
                *command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                _, stderr = await process.communicate()
            except asyncio.CancelledError:
                if process.returncode is None:
                    process.terminate()
                    await process.wait()
                raise
            if process.returncode:
                detail = stderr.decode("utf-8", errors="replace").strip()
                raise RuntimeError(
                    f"whisper-cli exited with code {process.returncode}: {detail[-1000:]}"
                )

            output_path = output_base.with_suffix(".txt")
            if not output_path.is_file():
                raise RuntimeError("whisper-cli did not create the expected transcript")
            return output_path.read_text(encoding="utf-8").strip()


async def _emit_segment(websocket: WebSocket, pcm: bytes) -> None:
    started_at = time.monotonic()
    text = await _transcribe(pcm)
    LOGGER.info(
        "Whisper segment processed: audio=%.1fs inference=%.1fs text_length=%d",
        len(pcm) / SAMPLE_WIDTH / SAMPLE_RATE,
        time.monotonic() - started_at,
        len(text),
    )
    if text:
        await websocket.send_json({"type": "final", "text": text})


async def _process_session(
    websocket: WebSocket, queue: asyncio.Queue[bytes | None]
) -> None:
    segmenter = VadSegmenter()
    while True:
        chunk = await queue.get()
        if chunk is None:
            final_segment = segmenter.flush()
            if final_segment:
                await _emit_segment(websocket, final_segment)
            await websocket.send_json({"type": "finished"})
            return
        for segment in segmenter.accept(chunk):
            await _emit_segment(websocket, segment)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    if not MODEL_PATH.is_file():
        raise FileNotFoundError(f"Whisper model not found: {MODEL_PATH}")
    whisper_cli = shutil.which(WHISPER_CLI)
    if not whisper_cli:
        raise FileNotFoundError(f"whisper-cli not found in PATH: {WHISPER_CLI}")
    if not 0 <= VAD_MODE <= 3:
        raise ValueError("VAD_MODE must be between 0 and 3")
    if MAX_CONCURRENT_TRANSCRIPTIONS < 1:
        raise ValueError("WHISPER_MAX_CONCURRENCY must be at least 1")
    if VAD_START_MS < FRAME_MS or VAD_END_SILENCE_MS < FRAME_MS:
        raise ValueError("VAD start and end durations must be at least one frame")
    if MIN_SEGMENT_MS < 1 or MAX_SEGMENT_MS < MIN_SEGMENT_MS:
        raise ValueError("VAD segment duration limits are invalid")
    app.state.whisper_cli = whisper_cli
    app.state.transcription_semaphore = asyncio.Semaphore(MAX_CONCURRENT_TRANSCRIPTIONS)
    LOGGER.info("Whisper model: %s", MODEL_PATH)
    yield


app = FastAPI(title="VAD + whisper.cpp ASR API", version="0.1.0", lifespan=lifespan)


@app.get("/health")
async def health() -> dict[str, object]:
    return {
        "status": "ok",
        "engine": "whisper.cpp",
        "mode": "vad-segmented",
        "device": "cpu" if NO_GPU else "auto",
        "sample_rate": SAMPLE_RATE,
        "language": LANGUAGE,
        "model": str(MODEL_PATH),
    }


@app.websocket("/ws/asr")
async def vad_whisper_asr(websocket: WebSocket) -> None:
    await websocket.accept()
    connection_id = f"{id(websocket):x}"
    connected_at = time.monotonic()
    received_samples = 0
    queue: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=QUEUE_MAX_CHUNKS)
    processor = asyncio.create_task(_process_session(websocket, queue))
    LOGGER.info("Whisper WebSocket connected: id=%s client=%s", connection_id, websocket.client)
    await websocket.send_json(
        {
            "type": "ready",
            "sample_rate": SAMPLE_RATE,
            "format": "pcm_s16le",
            "mode": "vad-segmented",
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
                if len(chunk) % SAMPLE_WIDTH:
                    await websocket.send_json(
                        {"type": "error", "message": "PCM16 chunk has an odd byte length"}
                    )
                    continue
                received_samples += len(chunk) // SAMPLE_WIDTH
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
        LOGGER.warning("Whisper WebSocket disconnected: id=%s code=%s", connection_id, exc.code)
    except Exception as exc:
        processor.cancel()
        LOGGER.exception("Whisper WebSocket failed: id=%s", connection_id)
        try:
            await websocket.send_json({"type": "error", "message": str(exc)})
        except Exception:
            pass
    finally:
        if not processor.done():
            processor.cancel()
        await asyncio.gather(processor, return_exceptions=True)
        LOGGER.info(
            "Whisper WebSocket closed: id=%s duration=%.1fs audio=%.1fs",
            connection_id,
            time.monotonic() - connected_at,
            received_samples / SAMPLE_RATE,
        )


def run() -> None:
    uvicorn.run(
        "api:app",
        host=os.getenv("ASR_HOST", "0.0.0.0"),
        port=int(os.getenv("ASR_PORT", "8000")),
        reload=False,
        ws_ping_interval=float(os.getenv("ASR_WS_PING_INTERVAL", "20")),
        ws_ping_timeout=float(os.getenv("ASR_WS_PING_TIMEOUT", "20")),
    )


if __name__ == "__main__":
    run()
