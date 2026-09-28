# whisper.cpp 文件转写

这是一个独立的本地实验工具，不启动 API，也不对接浏览器插件。它接收一个音频或
视频文件，通过 `ffmpeg` 转成 16 kHz、单声道、PCM S16LE WAV，再调用
`whisper-cli` 输出纯文本。

## 1. 准备 whisper.cpp

克隆并编译官方项目：

```powershell
git clone https://github.com/ggml-org/whisper.cpp.git
cd whisper.cpp
cmake -B build
cmake --build build --config Release -j
```

Windows 编译结果通常位于：

```text
build/bin/Release/whisper-cli.exe
```

如果使用支持 CUDA 的本机环境，可以改为：

```powershell
cmake -B build -DGGML_CUDA=ON
cmake --build build --config Release -j
```

另外需要安装 `ffmpeg`，并确保 `ffmpeg` 和 `whisper-cli` 命令都位于 `PATH`。

## 2. 下载模型

默认模型路径为项目根目录的 `model/ggml-small.bin`。在 whisper.cpp 仓库中下载
多语言模型，例如：

```powershell
./models/download-ggml-model.cmd small
```

中文不要选择带 `.en` 的英文专用模型。初次测试建议使用 `small`；速度优先可使用
`base`，效果优先且设备资源充足时可尝试更大的模型或量化模型。

## 3. 转写文件

在本项目根目录运行：

```powershell
python whisper-cpp/transcribe.py "D:/video/test.mp4" `
  --language zh `
  --output "D:/video/test.txt"
```

不指定 `--output` 时，文本默认保存在输入文件旁边，例如 `test.mp4` 会生成
`test.txt`。需要使用其他模型时，可以覆盖默认路径：

```powershell
python whisper-cpp/transcribe.py "D:/video/test.mp4" `
  --model "D:/models/ggml-large-v3-q5_0.bin" `
  --language zh
```

常用选项：

```text
--language auto       自动检测语言
--threads 8           设置 CPU 推理线程数
--no-gpu              强制只使用 CPU
--keep-wav path.wav   保留转换后的临时 WAV
```

查看完整帮助：

```powershell
python whisper-cpp/transcribe.py --help
```

## 4. VAD 准实时 WebSocket 服务

`api.py` 与现有浏览器插件使用相同协议：接收 16 kHz、单声道 PCM16 二进制帧，
通过 WebRTC VAD 检测停顿，然后将短语音段交给 `whisper-cli` 转写。这个模式只在
句末发送 `final`，不发送逐字 `partial`。

安装依赖并启动：

```powershell
cd whisper-cpp
uv sync
uv run python api.py
```

默认地址：

```text
HTTP health: http://127.0.0.1:8000/health
WebSocket:    ws://127.0.0.1:8000/ws/asr
```

默认读取项目根目录的 `model/ggml-small.bin`，并从 `PATH` 查找 `whisper-cli`。
可使用环境变量调整：

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WHISPER_MODEL` | `../model/ggml-small.bin` | 模型路径 |
| `WHISPER_LANGUAGE` | `zh` | 识别语言，设为 `auto` 可自动检测 |
| `WHISPER_THREADS` | `0` | CPU 线程数，0 表示使用 whisper.cpp 默认值 |
| `WHISPER_NO_GPU` | `false` | 是否强制 CPU 推理 |
| `VAD_MODE` | `2` | WebRTC VAD 激进程度，范围 0～3 |
| `VAD_END_SILENCE_MS` | `600` | 连续静音多久后提交一句 |
| `VAD_MAX_SEGMENT_MS` | `20000` | 单个语音段的最大长度 |
| `WHISPER_MAX_CONCURRENCY` | `1` | 同时运行的 whisper-cli 进程数 |

PowerShell 示例：

```powershell
$env:WHISPER_LANGUAGE = "zh"
$env:VAD_END_SILENCE_MS = "500"
uv run python api.py
```
