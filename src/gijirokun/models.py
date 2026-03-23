from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path


@dataclass(frozen=True, slots=True)
class Participant:
    display_name: str
    username: str


@dataclass(frozen=True, slots=True)
class MeetingMetadata:
    voice_channel_name: str
    started_at: datetime
    ended_at: datetime
    participants: list[Participant] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class SummarySections:
    summary: str
    decisions: list[str] = field(default_factory=list)
    todos: list[str] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class TranscriptionJob:
    order: int
    speaker_id: int
    speaker_name: str
    started_at: datetime
    segment_path: Path


@dataclass(frozen=True, slots=True)
class TranscriptEntry:
    order: int
    speaker_name: str
    started_at: datetime
    text: str


@dataclass(frozen=True, slots=True)
class MeetingArtifacts:
    metadata: MeetingMetadata
    sections: SummarySections
    markdown_text: str
    minutes_path: Path
    transcript_path: Path
    warnings: list[str] = field(default_factory=list)
