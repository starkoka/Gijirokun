from __future__ import annotations

import asyncio

from google import genai
from google.genai import types

from .models import MeetingMetadata, SummarySections
from .summary_parser import parse_summary_response

SYSTEM_PROMPT = """
入力されるテキストは会議の文字起こしデータです。決定事項とタスク（TODO）を含めて要約してください。
各ユーザーの発言をリアルタイムで個別に処理し、発言開始の順番に単純連結しているため、
相槌などによって一部応答の文脈が前後している可能性があります。その点を含み置き、
前後の文脈から適切に会話の流れを推論して要約を生成してください。

出力は必ず JSON のみで返してください。形式は次のとおりです。
{
  "summary": "会議全体の要約",
  "decisions": ["決定事項1", "決定事項2"],
  "todos": ["TODO1", "TODO2"]
}

JSON 以外の説明文やコードブロックは出力しないでください。
""".strip()


class GeminiSummarizer:
    def __init__(self, *, api_key: str, model_name: str) -> None:
        self._client = genai.Client(api_key=api_key)
        self._model_name = model_name

    async def summarize(
        self,
        *,
        metadata: MeetingMetadata,
        transcript_text: str,
    ) -> SummarySections:
        if not transcript_text.strip():
            return SummarySections(
                summary="文字起こし結果が空だったため、要約を生成できませんでした。",
            )

        prompt = self._build_prompt(metadata=metadata, transcript_text=transcript_text)
        try:
            response = await asyncio.to_thread(
                self._client.models.generate_content,
                model=self._model_name,
                contents=prompt,
                config=types.GenerateContentConfig(
                    system_instruction=SYSTEM_PROMPT,
                    temperature=0.2,
                ),
            )
        except Exception as exc:
            return SummarySections(
                summary=f"Gemini API の要約生成に失敗しました: {exc}",
            )

        response_text = _extract_response_text(response)
        return parse_summary_response(response_text)

    def _build_prompt(self, *, metadata: MeetingMetadata, transcript_text: str) -> str:
        participants = ", ".join(
            f"{participant.display_name} (@{participant.username})"
            for participant in metadata.participants
        )
        return (
            f"会議名: {metadata.voice_channel_name}\n"
            f"開始時刻: {metadata.started_at.isoformat()}\n"
            f"終了時刻: {metadata.ended_at.isoformat()}\n"
            f"参加者: {participants or '参加者不明'}\n\n"
            f"文字起こし:\n{transcript_text}"
        )


def _extract_response_text(response: object) -> str:
    text = getattr(response, "text", "")
    if isinstance(text, str) and text.strip():
        return text.strip()

    parts = getattr(response, "parts", None)
    if parts:
        collected: list[str] = []
        for part in parts:
            part_text = getattr(part, "text", "")
            if isinstance(part_text, str) and part_text.strip():
                collected.append(part_text.strip())
        if collected:
            return "\n".join(collected)

    return ""
