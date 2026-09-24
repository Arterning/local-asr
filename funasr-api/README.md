# FunASR 两遍识别后端

该后端使用以下四个 FunASR 模型，并保持现有浏览器插件接口不变：

- `paraformer-zh-streaming`：实时产生 `partial`。
- `paraformer-zh`：VAD 断句后重新识别并产生 `final`。
- `fsmn-vad`：实时检测语音端点。
- `ct-punc`：为最终结果恢复标点。

## 模型下载地址

- [funasr/paraformer-zh-streaming](https://huggingface.co/funasr/paraformer-zh-streaming)
- [funasr/paraformer-zh](https://huggingface.co/funasr/paraformer-zh)
- [funasr/fsmn-vad](https://huggingface.co/funasr/fsmn-vad)
- [funasr/ct-punc](https://huggingface.co/funasr/ct-punc)

下载脚本默认将模型保存到项目根目录的 `model/funasr`：

```text
model/funasr/
├── paraformer-zh-streaming/
├── paraformer-zh/
├── fsmn-vad/
└── ct-punc/
```

在能够访问 Hugging Face 的电脑上执行：

```bash
cd funasr-api
uv run --no-project --with huggingface-hub python scripts/download_models.py
```

也可以指定下载位置：

```bash
uv run --no-project --with huggingface-hub python scripts/download_models.py --output-dir /data/models/funasr
```

这里使用 `--no-project`，因此只会临时安装下载脚本需要的
`huggingface-hub`，不会安装 FunASR、PyTorch 或执行项目环境同步。

如果在本机下载后上传服务器，应完整上传四个模型目录，而不只是其中的 `model.pt`。

## GPU 服务器安装

本目录使用 Python 3.11 和 uv 管理。先确认服务器的 NVIDIA 驱动、CUDA 与计划安装的 PyTorch 版本兼容，再创建环境：

```bash
cd funasr-api
uv sync
```

项目固定使用 `funasr==1.4.16`，避免不同服务器自动安装到不同版本。模型文件也建议在测试通过后记录 Hugging Face commit SHA 和文件校验值。

`torch` 是项目的直接依赖。默认情况下，`uv sync` 会从 PyPI 安装符合当前 Linux/Python 环境的 PyTorch。安装后务必检查：

```bash
uv run python -c "import torch; print(torch.__version__, torch.version.cuda, torch.cuda.is_available())"
```

最后一项必须为 `True`。如果不是，需要按照服务器 CUDA 环境重新安装对应的 PyTorch GPU wheel，然后再启动服务。

如果默认 PyTorch wheel 与服务器驱动不兼容，先通过 `nvidia-smi` 查看驱动支持的 CUDA 版本，再选择 PyTorch 官方提供的后端。例如 uv 支持自动选择当前驱动兼容的后端：

```bash
uv pip install --reinstall torch --torch-backend=auto
```

也可以明确指定后端，例如：

```bash
uv pip install --reinstall torch --torch-backend=cu128
```

指定版本前应确认服务器驱动兼容该 CUDA runtime。不要根据服务器是否安装 CUDA Toolkit 来判断，应优先查看 `nvidia-smi` 显示的驱动及其支持版本。

## 启动

模型放在默认目录后：

```bash
cd funasr-api
ASR_DEVICE=cuda:0 uv run python main.py
```

默认监听 `0.0.0.0:8000`：

- 健康检查：`GET /health`
- WebSocket：`/ws/asr`

生产环境应使用 Nginx/Caddy 提供 HTTPS/WSS，并增加鉴权，不要直接把无鉴权端口暴露到公网。

## 前后端协议

前端继续发送 16 kHz、单声道、PCM S16LE WebSocket 二进制帧。结束时发送：

```json
{"type": "finish"}
```

后端返回的消息类型保持为：

```text
ready / partial / final / finished / error
```

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ASR_DEVICE` | `cuda:0` | 推理设备 |
| `ASR_HOST` | `0.0.0.0` | 监听地址 |
| `ASR_PORT` | `8000` | 监听端口 |
| `ASR_NUM_THREADS` | `4` | FunASR CPU 线程数 |
| `ASR_CHUNK_SIZE` | `0,10,5` | Paraformer 流式分块配置，默认每 600ms 推理一次 |
| `ASR_ENCODER_LOOK_BACK` | `4` | 编码器回看块数 |
| `ASR_DECODER_LOOK_BACK` | `1` | 解码器回看块数 |
| `ASR_MAX_SEGMENT_SECONDS` | `30` | 单段音频最大时长，防止缓存无限增长 |
| `VAD_CHUNK_SIZE_MS` | `200` | FSMN-VAD 分块参数 |
| `FUNASR_STREAMING_MODEL` | `../model/funasr/paraformer-zh-streaming` | 流式模型目录 |
| `FUNASR_OFFLINE_MODEL` | `../model/funasr/paraformer-zh` | 离线模型目录 |
| `FUNASR_VAD_MODEL` | `../model/funasr/fsmn-vad` | VAD 模型目录 |
| `FUNASR_PUNCTUATION_MODEL` | `../model/funasr/ct-punc` | 标点模型目录 |

如果服务器上的模型位于 `/data/models/funasr`，可分别设置四个模型路径环境变量。

## 说明

- 每条 WebSocket 连接拥有独立的 Paraformer 和 VAD cache，不能跨连接共享。
- GPU 模型实例在所有连接之间共享，并按推理阶段加锁。
- 音频接收与推理解耦，离线识别期间仍可接收后续音频，队列满时自动产生背压。
- `partial` 是当前语句的累计临时文本；每个 VAD 分段只发送一次离线 `final`。
- 服务启动时会检查四个模型目录；模型缺失会直接启动失败并显示缺少的路径。
