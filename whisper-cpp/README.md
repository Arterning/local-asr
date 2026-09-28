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

另外需要安装 `ffmpeg`，并确保 `ffmpeg` 命令位于 `PATH`，或者运行脚本时通过
`--ffmpeg` 指定其路径。

## 2. 下载模型

在 whisper.cpp 仓库中下载多语言模型，例如：

```powershell
./models/download-ggml-model.cmd small
```

中文不要选择带 `.en` 的英文专用模型。初次测试建议使用 `small`；速度优先可使用
`base`，效果优先且设备资源充足时可尝试更大的模型或量化模型。

## 3. 转写文件

在本项目根目录运行：

```powershell
python whisper-cpp/transcribe.py "D:/video/test.mp4" `
  --model "D:/whisper.cpp/models/ggml-small.bin" `
  --whisper-cli "D:/whisper.cpp/build/bin/Release/whisper-cli.exe" `
  --language zh `
  --output "D:/video/test.txt"
```

如果 `whisper-cli` 已在 `PATH` 中，可以省略 `--whisper-cli`。不指定 `--output`
时，文本默认保存在输入文件旁边，例如 `test.mp4` 会生成 `test.txt`。

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
