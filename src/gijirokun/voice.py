from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Callable
from zoneinfo import ZoneInfo

import discord

PCM_FRAME_BYTES = 4
EXPECTED_PACKET_SECONDS = 0.02


@dataclass(slots=True)
class SpeakerState:
    order: int | None = None
    started_at: datetime | None = None
    last_packet_monotonic: float = 0.0
    buffer: bytearray = field(default_factory=bytearray)


class StreamingTranscriptSink(discord.sinks.Sink):
    def __init__(
        self,
        *,
        silence_timeout_seconds: float,
        timezone: ZoneInfo,
        segment_order_factory: Callable[[], int],
        segment_handler: Callable[[int, int, datetime, bytes], None],
        should_record_user: Callable[[int], bool],
    ) -> None:
        super().__init__()
        self._silence_timeout_seconds = silence_timeout_seconds
        self._timezone = timezone
        self._segment_order_factory = segment_order_factory
        self._segment_handler = segment_handler
        self._should_record_user = should_record_user
        self._states: dict[int, SpeakerState] = {}
        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._monitor_thread = threading.Thread(
            target=self._monitor_silence,
            name="sink-silence-monitor",
            daemon=True,
        )
        self._monitor_thread.start()

    def write(self, data: bytes, user: int) -> None:
        if not data or not self._should_record_user(user):
            return

        now_mono = time.monotonic()
        now_wall = datetime.now(self._timezone)
        emitted_segments: list[tuple[int, int, datetime, bytes]] = []

        with self._lock:
            emitted_segments.extend(self._pop_stale_segments(now_mono, excluded_user=user))
            state = self._states.setdefault(user, SpeakerState())

            gap_seconds = 0.0
            if state.last_packet_monotonic:
                gap_seconds = now_mono - state.last_packet_monotonic

            if state.buffer and gap_seconds >= self._silence_timeout_seconds:
                emitted_segments.append(self._materialize_segment(user, state))

            if state.started_at is None:
                state.order = self._segment_order_factory()
                state.started_at = now_wall
                if gap_seconds >= self._silence_timeout_seconds:
                    data = _trim_gap_silence(data, gap_seconds)

            state.last_packet_monotonic = now_mono
            if data:
                state.buffer.extend(data)

        for segment in emitted_segments:
            self._dispatch_segment(segment)

    def cleanup(self) -> None:
        self.finished = True
        self._stop_event.set()
        self._monitor_thread.join(timeout=1.0)

        emitted_segments: list[tuple[int, int, datetime, bytes]] = []
        with self._lock:
            for user_id, state in self._states.items():
                if state.buffer and state.started_at is not None and state.order is not None:
                    emitted_segments.append(self._materialize_segment(user_id, state))

        for segment in emitted_segments:
            self._dispatch_segment(segment)

    def _monitor_silence(self) -> None:
        while not self._stop_event.wait(0.2):
            now_mono = time.monotonic()
            emitted_segments: list[tuple[int, int, datetime, bytes]] = []
            with self._lock:
                emitted_segments.extend(self._pop_stale_segments(now_mono, excluded_user=None))
            for segment in emitted_segments:
                self._dispatch_segment(segment)

    def _pop_stale_segments(
        self,
        now_mono: float,
        *,
        excluded_user: int | None,
    ) -> list[tuple[int, int, datetime, bytes]]:
        emitted_segments: list[tuple[int, int, datetime, bytes]] = []
        for user_id, state in self._states.items():
            if excluded_user is not None and user_id == excluded_user:
                continue
            if not state.buffer or state.started_at is None or state.order is None:
                continue
            if now_mono - state.last_packet_monotonic >= self._silence_timeout_seconds:
                emitted_segments.append(self._materialize_segment(user_id, state))
        return emitted_segments

    def _materialize_segment(
        self,
        user_id: int,
        state: SpeakerState,
    ) -> tuple[int, int, datetime, bytes]:
        assert state.order is not None
        assert state.started_at is not None
        payload = bytes(state.buffer)
        order = state.order
        started_at = state.started_at
        state.order = None
        state.started_at = None
        state.buffer.clear()
        return (order, user_id, started_at, payload)

    def _dispatch_segment(self, segment: tuple[int, int, datetime, bytes]) -> None:
        order, user_id, started_at, payload = segment
        if payload:
            self._segment_handler(order, user_id, started_at, payload)


def _trim_gap_silence(data: bytes, gap_seconds: float) -> bytes:
    estimated_silence_seconds = max(0.0, gap_seconds - EXPECTED_PACKET_SECONDS)
    estimated_silence_bytes = int(estimated_silence_seconds * 48_000) * PCM_FRAME_BYTES
    leading_silence_bytes = _count_leading_silence_bytes(data)
    trim_bytes = min(estimated_silence_bytes, leading_silence_bytes)
    trim_bytes -= trim_bytes % PCM_FRAME_BYTES
    return data[trim_bytes:]


def _count_leading_silence_bytes(data: bytes) -> int:
    silence_frame = b"\x00" * PCM_FRAME_BYTES
    for offset in range(0, len(data), PCM_FRAME_BYTES):
        if data[offset : offset + PCM_FRAME_BYTES] != silence_frame:
            return offset
    return len(data)
