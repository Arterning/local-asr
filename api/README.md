# Streaming ASR API

FastAPI WebSocket service using the sherpa-onnx streaming transducer files in
`../model/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20`.

## Run

```powershell
cd api
uv sync
uv run uvicorn main:app --host 127.0.0.1 --port 8000
```

Open `http://127.0.0.1:8000/health` to verify the service. The model is loaded
at startup, so the first start can take a few seconds.

## WebSocket protocol

Connect to `ws://127.0.0.1:8000/ws/asr`, then send binary chunks containing:

- mono audio
- 16,000 Hz sample rate
- signed 16-bit little-endian PCM (`pcm_s16le`)

The server runs recognized text through the bundled Chinese-English
CT-Transformer punctuation model before emitting JSON messages:

```json
{"type":"ready","sample_rate":16000,"format":"pcm_s16le"}
{"type":"partial","text":"正在识别的内容"}
{"type":"final","text":"已经结束的一句话"}
```

Send `{"type":"finish"}` as a text WebSocket message to flush the last audio
and receive `{"type":"finished"}`.

## Configuration

The ASR model defaults to `model/sherpa-onnx-streaming-zipformer-bilingual-
zh-en-2023-02-20`. Override these environment variables if needed:
`ASR_MODEL_DIR`, `ASR_TOKENS`, `ASR_ENCODER`, `ASR_DECODER`,
`ASR_JOINER`, `ASR_NUM_THREADS`, `ASR_PROVIDER`, and `ASR_DECODING_METHOD`.
The punctuation model defaults to `model/sherpa-onnx-punct-ct-transformer-
zh-en-vocab272727-2024-04-12-int8/model.int8.onnx`; override it with
`PUNCT_MODEL` and tune its CPU threads with `PUNCT_NUM_THREADS`.

On Windows the project also installs a matching `onnxruntime` and explicitly
loads its DLL before sherpa-onnx. This avoids accidentally loading the older
`C:\Windows\System32\onnxruntime.dll` shipped with some Windows versions.
