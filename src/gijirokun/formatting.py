from __future__ import annotations

from .models import MeetingMetadata, Participant, SummarySections, TranscriptEntry


def format_participant(participant: Participant) -> str:
    return f"- {participant.display_name} (@{participant.username})"


def format_participants(participants: list[Participant]) -> str:
    if not participants:
        return "- 参加者情報なし"
    return "\n".join(format_participant(participant) for participant in participants)


def format_markdown_minutes(metadata: MeetingMetadata, sections: SummarySections) -> str:
    started_at = metadata.started_at.strftime("%Y年%m月%d日 %H:%M")
    ended_at = metadata.ended_at.strftime("%H:%M")

    return (
        f"# 議事録: {metadata.voice_channel_name}\n\n"
        f"**日時:** {started_at} - {ended_at}\n\n"
        f"**参加者:**\n{format_participants(metadata.participants)}\n\n"
        "## 📝 要約\n\n"
        f"{_coerce_paragraph(sections.summary, '要約なし')}\n\n"
        "## ✅ 決定事項\n\n"
        f"{_coerce_list(sections.decisions)}\n\n"
        "## 🏃 次のアクション (TODO)\n\n"
        f"{_coerce_list(sections.todos)}\n"
    )


def format_transcript_entry(entry: TranscriptEntry) -> str:
    text = entry.text.strip()
    return f"[{entry.started_at.strftime('%H:%M:%S')}] {entry.speaker_name}\n\n{text}\n\n"


def _coerce_paragraph(text: str, fallback: str) -> str:
    cleaned = text.strip()
    return cleaned or fallback


def _coerce_list(items: list[str]) -> str:
    normalized = [item.strip() for item in items if item.strip()]
    if not normalized:
        return "- なし"
    return "\n".join(f"- {item}" for item in normalized)
