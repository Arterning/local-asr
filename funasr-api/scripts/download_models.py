"""Download all FunASR model snapshots from Hugging Face."""

from __future__ import annotations

import argparse
from pathlib import Path

from huggingface_hub import snapshot_download


MODEL_REPOSITORIES = (
    "funasr/paraformer-zh-streaming",
    "funasr/paraformer-zh",
    "funasr/fsmn-vad",
    "funasr/ct-punc",
)

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUTPUT_DIR = PROJECT_ROOT / "model" / "funasr"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help=f"Model root directory (default: {DEFAULT_OUTPUT_DIR})",
    )
    parser.add_argument(
        "--revision",
        default=None,
        help="Optional revision applied to all repositories (normally leave unset)",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    output_dir = args.output_dir.expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    for repo_id in MODEL_REPOSITORIES:
        destination = output_dir / repo_id.rsplit("/", 1)[-1]
        print(f"Downloading {repo_id} -> {destination}", flush=True)
        snapshot_download(
            repo_id=repo_id,
            revision=args.revision,
            local_dir=destination,
        )

    print(f"All models downloaded to {output_dir}", flush=True)


if __name__ == "__main__":
    main()

