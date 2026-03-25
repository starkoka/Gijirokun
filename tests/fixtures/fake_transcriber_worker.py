from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--ffmpeg-binary", required=True)
    parser.parse_args()

    mode = os.environ.get("FAKE_TRANSCRIBER_MODE", "echo")
    state_file = os.environ.get("FAKE_TRANSCRIBER_STATE_FILE")

    emit({"type": "ready"})

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        payload = json.loads(line)
        if payload.get("type") == "shutdown":
            return 0

        if payload.get("type") != "transcribe":
            continue

        if mode == "crash_once" and should_trigger_once(state_file):
            return 1

        if mode == "hang_once" and should_trigger_once(state_file):
            while True:
                time.sleep(1)

        segment_name = Path(payload["segmentPath"]).name
        emit({"type": "result", "id": payload["id"], "text": f"fixture:{segment_name}"})

    return 0


def should_trigger_once(state_file: str | None) -> bool:
    if not state_file:
        return False

    marker_path = Path(state_file)
    if marker_path.exists():
        return False

    marker_path.parent.mkdir(parents=True, exist_ok=True)
    marker_path.write_text("triggered", encoding="utf-8")
    return True


def emit(payload: dict[str, object]) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    raise SystemExit(main())
