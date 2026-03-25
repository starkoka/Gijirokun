from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import wave
from pathlib import Path


def main() -> int:
    from vosk import Model, SetLogLevel

    parser = argparse.ArgumentParser()
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--ffmpeg-binary", default="ffmpeg")
    args = parser.parse_args()

    model_path = Path(args.model_path)
    if not model_path.exists():
        raise FileNotFoundError(f"Vosk model not found: {model_path}")

    SetLogLevel(-1)
    model = Model(str(model_path))
    emit({"type": "ready"})

    for raw_line in sys.stdin:
        try:
            payloads = list(parse_input_payloads(raw_line))
        except ValueError as exc:
            warn_stdin(str(exc))
            continue

        for payload in payloads:
            if payload.get("type") == "shutdown":
                return 0

            if payload.get("type") != "transcribe":
                continue

            request_id = payload["id"]
            segment_path = Path(payload["segmentPath"])

            try:
                text = transcribe_segment(
                    model=model,
                    segment_path=segment_path,
                    ffmpeg_binary=args.ffmpeg_binary,
                )
                emit({"type": "result", "id": request_id, "text": text})
            except Exception as exc:  # noqa: BLE001
                emit({"type": "result", "id": request_id, "error": str(exc)})

    return 0


def transcribe_segment(*, model: Model, segment_path: Path, ffmpeg_binary: str) -> str:
    normalized_fd, normalized_name = tempfile.mkstemp(suffix="_mono16k.wav")
    os.close(normalized_fd)
    Path(normalized_name).unlink(missing_ok=True)
    normalized_path = Path(normalized_name)

    try:
        normalize_audio(
            segment_path=segment_path,
            normalized_path=normalized_path,
            ffmpeg_binary=ffmpeg_binary,
        )
        return transcribe_normalized_wav(model=model, normalized_path=normalized_path)
    finally:
        normalized_path.unlink(missing_ok=True)


def normalize_audio(*, segment_path: Path, normalized_path: Path, ffmpeg_binary: str) -> None:
    command = [
        ffmpeg_binary,
        "-y",
        "-i",
        str(segment_path),
        "-ac",
        "1",
        "-ar",
        "16000",
        str(normalized_path),
    ]

    try:
        subprocess.run(command, check=True, capture_output=True, text=True)
    except FileNotFoundError as exc:
        raise RuntimeError(
            f"FFmpeg が見つかりませんでした。'{ffmpeg_binary}' を確認してください。"
        ) from exc
    except subprocess.CalledProcessError as exc:
        stderr = exc.stderr.strip() if exc.stderr else "unknown ffmpeg error"
        raise RuntimeError(f"FFmpeg による音声変換に失敗しました: {stderr}") from exc


def transcribe_normalized_wav(*, model: Model, normalized_path: Path) -> str:
    from vosk import KaldiRecognizer

    parts: list[str] = []
    with wave.open(str(normalized_path), "rb") as wav_file:
        recognizer = KaldiRecognizer(model, wav_file.getframerate())
        recognizer.SetWords(False)

        while True:
            chunk = wav_file.readframes(4000)
            if not chunk:
                break
            if recognizer.AcceptWaveform(chunk):
                parts.append(extract_text(recognizer.Result()))

        parts.append(extract_text(recognizer.FinalResult()))

    merged = " ".join(part for part in parts if part)
    return re.sub(r"\s+", " ", merged).strip()


def extract_text(result_json: str) -> str:
    try:
        payload = json.loads(result_json)
    except json.JSONDecodeError:
        return ""
    return str(payload.get("text", "")).strip()


def parse_input_payloads(raw_line: str) -> list[dict[str, object]]:
    line = raw_line.strip()
    if not line:
        return []

    decoder = json.JSONDecoder()
    payloads: list[dict[str, object]] = []
    index = 0

    while index < len(line):
        while index < len(line) and line[index].isspace():
            index += 1

        if index >= len(line):
            break

        try:
            payload, index = decoder.raw_decode(line, index)
        except json.JSONDecodeError as exc:
            raise ValueError(
                f"Invalid JSON command from stdin: {truncate_for_log(line)!r}"
            ) from exc

        if not isinstance(payload, dict):
            warn_stdin(f"Ignored non-object JSON command from stdin: {payload!r}")
            continue

        payloads.append(payload)

    return payloads


def truncate_for_log(text: str, max_length: int = 200) -> str:
    if len(text) <= max_length:
        return text
    return text[:max_length] + "..."


def emit(payload: dict[str, object]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def warn_stdin(message: str) -> None:
    sys.stderr.write(f"{message}\n")
    sys.stderr.flush()


if __name__ == "__main__":
    raise SystemExit(main())
