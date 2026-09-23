# Live Video Subtitle

一个本地运行的浏览器实时字幕工具。Chrome/Edge 扩展捕获 B 站或
YouTube 当前标签页的音频，将其转换为 16 kHz PCM 并通过 WebSocket
发送给 FastAPI；后端使用 sherpa-onnx 完成中英文流式语音识别和标点恢复。

所有音频、识别结果和历史记录都保留在本机。

## 功能

- 捕获当前 B 站或 YouTube 标签页音频
- 实时显示 partial 和 final 识别结果
- 中英文标点恢复
- 全屏模式悬浮字幕
- 自定义字幕字号、位置和背景透明度
- 保持原视频声音正常播放
- 自动保存每次视频的完整识别记录
- 搜索、复制和删除历史记录
- 导出 TXT、SRT、WebVTT 和 JSON

## 项目结构

```text
.
├── api/
│   ├── main.py
│   ├── pyproject.toml
│   ├── uv.lock
│   └── model/
│       ├── sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20/
│       │   ├── encoder.onnx
│       │   ├── decoder.onnx
│       │   ├── joiner.onnx
│       │   └── tokens.txt
│       └── sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8/
│           └── model.int8.onnx
└── web/
    ├── manifest.json
    ├── background.js
    ├── offscreen/
    ├── content/
    ├── popup/
    ├── storage/
    └── history/
```

## 环境要求

- Windows x64
- Python 3.11
- [uv](https://docs.astral.sh/uv/)
- Chrome 或 Edge 116+

后端主要依赖：

- FastAPI
- Uvicorn
- sherpa-onnx 1.13.8
- ONNX Runtime 1.29.x

## 启动后端

进入后端目录并同步依赖：

```powershell
cd C:\Users\ningh\Desktop\model\api
uv sync
```

启动服务：

```powershell
uv run uvicorn main:app --host 127.0.0.1 --port 8000
```

检查服务状态：

```text
http://127.0.0.1:8000/health
```

正常响应示例：

```json
{
  "status": "ok",
  "engine": "sherpa-onnx",
  "sample_rate": 16000,
  "model_loaded": true,
  "punctuation_loaded": true
}
```

WebSocket 地址：

```text
ws://127.0.0.1:8000/ws/asr
```

## 安装浏览器扩展

1. 启动后端。
2. 打开 `chrome://extensions` 或 `edge://extensions`。
3. 开启“开发者模式”。
4. 点击“加载已解压的扩展程序”。
5. 选择本项目的 `web` 目录。
6. 打开 B 站或 YouTube 视频并刷新页面。
7. 点击扩展图标，然后点击“开始识别”。

修改扩展代码后，需要在扩展管理页面点击“重新加载”，并刷新视频页面。

## 完整识别记录

每次点击“开始识别”都会创建一个独立会话。后端返回的每条 final 文本会立即
写入扩展的 IndexedDB；partial 文本只用于实时显示，不会保存，因此历史记录
不会包含重复的中间结果。

在 popup 中点击“查看完整识别记录”可以：

- 查看当前和过去的视频识别记录
- 搜索视频标题及当前记录文字
- 修改记录标题
- 返回原视频
- 复制完整文本
- 删除单条记录或清空历史
- 导出 TXT、SRT、VTT 或 JSON

SRT/VTT 时间来自识别结果返回时的视频播放位置，可能包含少量推理延迟，适合
作为字幕初稿。

## WebSocket 音频协议

扩展发送二进制 WebSocket 消息，格式为：

- 单声道
- 16,000 Hz
- signed 16-bit little-endian PCM
- 每个数据块约 100 ms

后端返回：

```json
{"type":"ready","sample_rate":16000,"format":"pcm_s16le"}
{"type":"partial","text":"正在变化的识别内容，可能调整。"}
{"type":"final","text":"已经确认的一句话。"}
```

## 配置

默认模型路径已经写入 `api/main.py`。也可以通过环境变量覆盖：

| 环境变量 | 用途 |
| --- | --- |
| `ASR_MODEL_DIR` | ASR 模型目录 |
| `ASR_TOKENS` | tokens.txt 路径 |
| `ASR_ENCODER` | encoder.onnx 路径 |
| `ASR_DECODER` | decoder.onnx 路径 |
| `ASR_JOINER` | joiner.onnx 路径 |
| `ASR_NUM_THREADS` | ASR CPU 线程数，默认 2 |
| `ASR_PROVIDER` | 推理提供程序，默认 cpu |
| `PUNCT_MODEL` | 标点恢复 ONNX 模型路径 |
| `PUNCT_NUM_THREADS` | 标点模型 CPU 线程数，默认 1 |

浏览器扩展默认连接 `ws://127.0.0.1:8000/ws/asr`，可以在 popup 中修改。

## 常见问题

### 点击开始后提示无法连接

确认后端正在监听 8000 端口，并访问 `/health` 检查两个模型是否加载成功。

### 没有捕获到声音

只能在 B 站或 YouTube 的普通网页标签页中启动捕获。安装或重新加载扩展后，
需要刷新原来已经打开的视频页面。

### 识别文字没有标点

检查 `/health` 中的 `punctuation_loaded` 是否为 `true`，并确认
`model.int8.onnx` 位于上述标点模型目录。

### Windows 报 ONNX Runtime API 版本不匹配

项目会优先加载虚拟环境内的 ONNX Runtime DLL，避免错误使用
`C:\Windows\System32\onnxruntime.dll`。请使用项目锁定的 Python 3.11 环境并
通过 `uv run` 启动服务。

## 模块文档

- 后端说明：[api/README.md](api/README.md)
- 浏览器扩展说明：[web/README.md](web/README.md)
