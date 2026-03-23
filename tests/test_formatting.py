from __future__ import annotations

import unittest
from datetime import datetime

from gijirokun.formatting import format_markdown_minutes, format_transcript_entry
from gijirokun.models import MeetingMetadata, Participant, SummarySections, TranscriptEntry


class FormattingTests(unittest.TestCase):
    def test_format_markdown_minutes_includes_required_sections(self) -> None:
        metadata = MeetingMetadata(
            voice_channel_name="開発定例",
            started_at=datetime(2026, 3, 24, 10, 0),
            ended_at=datetime(2026, 3, 24, 11, 30),
            participants=[
                Participant(display_name="山田", username="yamada"),
                Participant(display_name="鈴木", username="suzuki"),
            ],
        )
        sections = SummarySections(
            summary="進捗確認とリリース方針を議論した。",
            decisions=["今週金曜にリリースする"],
            todos=["山田が changelog を更新する"],
        )

        actual = format_markdown_minutes(metadata, sections)

        self.assertIn("# 議事録: 開発定例", actual)
        self.assertIn("**日時:** 2026年03月24日 10:00 - 11:30", actual)
        self.assertIn("- 山田 (@yamada)", actual)
        self.assertIn("## ✅ 決定事項", actual)
        self.assertIn("- 今週金曜にリリースする", actual)
        self.assertIn("## 🏃 次のアクション (TODO)", actual)

    def test_format_transcript_entry_matches_cache_layout(self) -> None:
        entry = TranscriptEntry(
            order=1,
            speaker_name="山田",
            started_at=datetime(2026, 3, 24, 10, 15, 30),
            text="では次の議題に入ります。",
        )

        actual = format_transcript_entry(entry)

        self.assertEqual(actual, "[10:15:30] 山田\n\nでは次の議題に入ります。\n\n")


if __name__ == "__main__":
    unittest.main()
