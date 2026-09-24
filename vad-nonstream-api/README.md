# VAD + SenseVoice Non-streaming API

这是原 `api` 的独立对照实现。它保持浏览器扩展使用的接口不变，但识别流程改为：

```text
PCM16 音频流 → Silero VAD 切句 → SenseVoice 非流式识别 → partial/final
```

## 模型文件

```text
vad-nonstream-api/
└── sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09/
    ├── model.int8.onnx
    ├── silero_vad.onnx
    └── tokens.txt
```

## 启动

先停止占用 8000 端口的原后端，然后运行：

```powershell
cd vad-nonstream-api
uv sync
uv run uvicorn main:app --host 127.0.0.1 --port 8000
```

浏览器扩展继续使用：

```text
ws://127.0.0.1:8000/ws/asr
```

无需修改或重新构建前端。

## 接口兼容性

- `GET /health`
- `WS /ws/asr`
- 输入仍是 16 kHz、单声道、PCM signed 16-bit little-endian
- 输出仍为 `ready`、`partial`、`final`、`finished` 和 `error`

SenseVoice 是非流式模型。本服务会每隔约 1.5 秒对当前语音段重新识别并发送
partial；当 VAD 检测到静音或达到最长语音长度时发送 final。相比原 Zipformer，
延迟更高，但完整句子的上下文更充分。

## 环境变量

| 变量 | 默认值/用途 |
| --- | --- |
| `SENSE_VOICE_MODEL` | SenseVoice ONNX 路径 |
| `SENSE_VOICE_TOKENS` | tokens.txt 路径 |
| `ASR_LANGUAGE` | `auto`，也可设为 `zh`、`en`、`ja`、`ko`、`yue` |
| `ASR_USE_ITN` | `true`，启用逆文本规范化 |
| `ASR_NUM_THREADS` | `2` |
| `ASR_PROVIDER` | `cpu` |
| `VAD_MODEL` | Silero VAD ONNX 路径 |
| `VAD_THRESHOLD` | `0.5` |
| `VAD_MIN_SILENCE` | `0.6` 秒 |
| `VAD_MIN_SPEECH` | `0.25` 秒 |
| `VAD_MAX_SPEECH` | `20` 秒 |
| `PARTIAL_INTERVAL_SECONDS` | `1.5` 秒 |

如果只想在一句结束后返回结果，可以把 `PARTIAL_INTERVAL_SECONDS` 设置得很大。
