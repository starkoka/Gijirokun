from __future__ import annotations

import json
import logging
import queue
import re
import subprocess
import threading
import wave
from pathlib import Path

from vosk import KaldiRecognizer, Model, SetLogLevel

from .formatting import format_transcript_entry
from .models import TranscriptEntry, TranscriptionJob

LOGGER = logging.getLogger(__name__)

PCM_SAMPLE_RATE = 48_000
PCM_CHANNELS = 2
PCM_SAMPLE_WIDTH_BYTES = 2
NORMALIZED_SAMPLE_RATE = 16_000


class TranscriptCache:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.touch(exist_ok=True)
        self._lock = threading.Lock()

    def append(self, entry: TranscriptEntry) -> None:
        with self._lock:
            with self.path.open("a", encoding="utf-8") as handle:
                handle.write(format_transcript_entry(entry))

    def read_text(self) -> str:
        return self.path.read_text(encoding="utf-8")


class VoskTranscriber:
    def __init__(self, *, model_path: Path, ffmpeg_binary: str) -> None:
        if not model_path.exists():
            raise FileNotFoundError(
                f"Vosk model not found: {model_path}. Set VOSK_MODEL_PATH to a valid directory."
            )
        SetLogLevel(-1)
        self._model = Model(str(model_path))
        self._ffmpeg_binary = ffmpeg_binary

    def transcribe(self, segment_path: Path) -> str:
        normalized_path = segment_path.with_name(f"{segment_path.stem}_mono16k.wav")
        self._normalize_audio(segment_path=segment_path, normalized_path=normalized_path)
        try:
            return self._transcribe_normalized_wav(normalized_path)
        finally:
            normalized_path.unlink(missing_ok=True)

    def _normalize_audio(self, *, segment_path: Path, normalized_path: Path) -> None:
        command = [
            self._ffmpeg_binary,
            "-y",
            "-i",
            str(segment_path),
            "-ac",
            "1",
            "-ar",
            str(NORMALIZED_SAMPLE_RATE),
            str(normalized_path),
        ]
        try:
            subprocess.run(command, check=True, capture_output=True, text=True)
        except FileNotFoundError as exc:
            raise RuntimeError(
                f"FFmpeg が見つかりませんでした。'{self._ffmpeg_binary}' を確認してください。"
            ) from exc
        except subprocess.CalledProcessError as exc:
            stderr = exc.stderr.strip() if exc.stderr else "unknown ffmpeg error"
            raise RuntimeError(f"FFmpeg の音声変換に失敗しました: {stderr}") from exc

    def _transcribe_normalized_wav(self, normalized_path: Path) -> str:
        parts: list[str] = []
        with wave.open(str(normalized_path), "rb") as wav_file:
            recognizer = KaldiRecognizer(self._model, wav_file.getframerate())
            recognizer.SetWords(False)

            while True:
                chunk = wav_file.readframes(4000)
                if not chunk:
                    break
                if recognizer.AcceptWaveform(chunk):
                    parts.append(_extract_text(recognizer.Result()))

            parts.append(_extract_text(recognizer.FinalResult()))

        merged = " ".join(part for part in parts if part)
        return re.sub(r"\s+", " ", merged).strip()


class TranscriptionPipeline:
    _SENTINEL = object()

    def __init__(self, *, transcriber: VoskTranscriber, cache: TranscriptCache) -> None:
        self._transcriber = transcriber
        self._cache = cache
        self._jobs: queue.Queue[TranscriptionJob | TranscriptEntry | object] = queue.Queue()
        self._buffered_results: dict[int, TranscriptEntry | None] = {}
        self._next_write_order = 1
        self._error: Exception | None = None
        self._closed = False
        self._warnings: list[str] = []
        self._worker = threading.Thread(
            target=self._run,
            name="transcription-worker",
            daemon=True,
        )
        self._worker.start()

    @property
    def warnings(self) -> list[str]:
        return list(self._warnings)

    def submit(self, job: TranscriptionJob) -> None:
        if self._closed:
            raise RuntimeError("Transcription pipeline is already closed.")
        self._jobs.put(job)

    def submit_entry(self, entry: TranscriptEntry) -> None:
        if self._closed:
            raise RuntimeError("Transcription pipeline is already closed.")
        self._jobs.put(entry)

    def close_and_wait(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._jobs.put(self._SENTINEL)
        self._jobs.join()
        self._worker.join()

    def _run(self) -> None:
        while True:
            item = self._jobs.get()
            try:
                if item is self._SENTINEL:
                    return
                if isinstance(item, TranscriptionJob):
                    self._process_job(item)
                else:
                    assert isinstance(item, TranscriptEntry)
                    self._buffered_results[item.order] = item
                    self._flush_ready_entries()
            except Exception as exc:
                if self._error is None:
                    self._error = exc
                if isinstance(item, (TranscriptionJob, TranscriptEntry)):
                    self._buffered_results[item.order] = None
                self._warnings.append(str(exc))
                LOGGER.exception("Transcription job failed: %s", exc)
                self._flush_ready_entries()
            finally:
                self._jobs.task_done()

    def _process_job(self, job: TranscriptionJob) -> None:
        try:
            text = self._transcriber.transcribe(job.segment_path)
        finally:
            job.segment_path.unlink(missing_ok=True)

        entry = None
        if text:
            entry = TranscriptEntry(
                order=job.order,
                speaker_name=job.speaker_name,
                started_at=job.started_at,
                text=text,
            )
        self._buffered_results[job.order] = entry
        self._flush_ready_entries()

    def _flush_ready_entries(self) -> None:
        while self._next_write_order in self._buffered_results:
            entry = self._buffered_results.pop(self._next_write_order)
            if entry is not None:
                self._cache.append(entry)
            self._next_write_order += 1


def write_pcm_wav(path: Path, pcm_data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(PCM_CHANNELS)
        wav_file.setsampwidth(PCM_SAMPLE_WIDTH_BYTES)
        wav_file.setframerate(PCM_SAMPLE_RATE)
        wav_file.writeframes(pcm_data)


def _extract_text(result_json: str) -> str:
    try:
        payload = json.loads(result_json)
    except json.JSONDecodeError:
        return ""
    return str(payload.get("text", "")).strip()
