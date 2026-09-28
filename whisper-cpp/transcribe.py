"""Transcribe one audio or video file with whisper.cpp."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def executable(value: str, label: str) -> str:
    """Resolve an executable name or path and fail with a useful message."""
    candidate = Path(value).expanduser()
    if candidate.is_file():
        return str(candidate.resolve())
    resolved = shutil.which(value)
    if resolved:
        return resolved
    raise FileNotFoundError(
        f"找不到 {label}: {value}\n"
        f"请安装 {label}，或使用对应的命令行参数指定可执行文件路径。"
    )


def run(command: list[str], description: str) -> None:
    print(f"{description}...", flush=True)
    try:
        subprocess.run(command, check=True)
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(f"{description}失败，退出码: {exc.returncode}") from exc


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="使用 whisper.cpp 将一个音频或视频文件转写为纯文本。"
    )
    parser.add_argument("input", type=Path, help="输入音频或视频文件")
    parser.add_argument("--model", required=True, type=Path, help="GGML/GGUF Whisper 模型文件")
    parser.add_argument("--output", type=Path, help="输出文本路径，默认与输入文件同名")
    parser.add_argument(
        "--language",
        default="auto",
        help="音频语言，例如 zh、en 或 auto（默认: auto）",
    )
    parser.add_argument("--threads", type=int, help="whisper.cpp 使用的 CPU 线程数")
    parser.add_argument(
        "--whisper-cli",
        default=os.getenv("WHISPER_CLI", "whisper-cli"),
        help="whisper-cli 可执行文件路径（也可设置 WHISPER_CLI）",
    )
    parser.add_argument(
        "--ffmpeg",
        default=os.getenv("FFMPEG", "ffmpeg"),
        help="ffmpeg 可执行文件路径（也可设置 FFMPEG）",
    )
    parser.add_argument("--no-gpu", action="store_true", help="强制 whisper.cpp 使用 CPU")
    parser.add_argument("--keep-wav", type=Path, help="保留转换后的 16 kHz 单声道 WAV")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    input_path = args.input.expanduser().resolve()
    model_path = args.model.expanduser().resolve()
    output_path = (
        args.output.expanduser().resolve()
        if args.output
        else input_path.with_suffix(".txt")
    )

    if not input_path.is_file():
        raise FileNotFoundError(f"输入文件不存在: {input_path}")
    if not model_path.is_file():
        raise FileNotFoundError(f"模型文件不存在: {model_path}")
    if args.threads is not None and args.threads < 1:
        raise ValueError("--threads 必须大于 0")

    ffmpeg = executable(args.ffmpeg, "ffmpeg")
    whisper_cli = executable(args.whisper_cli, "whisper-cli")
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="whisper-cpp-") as temp_dir:
        wav_path = Path(temp_dir) / "input.wav"
        run(
            [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(input_path),
                "-vn",
                "-ar",
                "16000",
                "-ac",
                "1",
                "-c:a",
                "pcm_s16le",
                str(wav_path),
            ],
            "提取并转换音频",
        )

        # whisper-cli appends '.txt' to the value supplied via --output-file.
        native_output_base = Path(temp_dir) / "transcript"
        command = [
            whisper_cli,
            "--model",
            str(model_path),
            "--file",
            str(wav_path),
            "--language",
            args.language,
            "--output-txt",
            "--output-file",
            str(native_output_base),
            "--no-timestamps",
        ]
        if args.threads is not None:
            command.extend(["--threads", str(args.threads)])
        if args.no_gpu:
            command.append("--no-gpu")

        run(command, "执行 Whisper 转写")
        generated_output = native_output_base.with_suffix(".txt")
        if not generated_output.is_file():
            raise RuntimeError(f"whisper-cli 未生成预期的文本文件: {generated_output}")
        shutil.copyfile(generated_output, output_path)

        if args.keep_wav:
            kept_wav = args.keep_wav.expanduser().resolve()
            kept_wav.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(wav_path, kept_wav)

    print(f"转写完成: {output_path}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (FileNotFoundError, RuntimeError, ValueError) as exc:
        print(f"错误: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
