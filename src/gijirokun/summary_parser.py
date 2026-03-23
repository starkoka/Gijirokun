from __future__ import annotations

import json
import re

from .models import SummarySections


def parse_summary_response(response_text: str) -> SummarySections:
    cleaned = response_text.strip()
    if not cleaned:
        return SummarySections(summary="要約テキストを取得できませんでした。")

    json_candidate = _extract_json_candidate(cleaned)
    if json_candidate is not None:
        try:
            payload = json.loads(json_candidate)
        except json.JSONDecodeError:
            pass
        else:
            return SummarySections(
                summary=_stringify(payload.get("summary"), "要約なし"),
                decisions=_listify(payload.get("decisions")),
                todos=_listify(payload.get("todos")),
            )

    sectioned = _parse_markdown_sections(cleaned)
    if sectioned is not None:
        return sectioned

    return SummarySections(summary=cleaned)


def _extract_json_candidate(text: str) -> str | None:
    stripped = text.strip()
    if stripped.startswith("```"):
        fence_match = re.match(r"^```(?:json)?\s*(.*?)\s*```$", stripped, flags=re.DOTALL)
        if fence_match:
            stripped = fence_match.group(1).strip()

    if stripped.startswith("{") and stripped.endswith("}"):
        return stripped

    block_match = re.search(r"\{.*\}", stripped, flags=re.DOTALL)
    if block_match:
        return block_match.group(0)
    return None


def _parse_markdown_sections(text: str) -> SummarySections | None:
    buckets: dict[str, list[str]] = {"summary": [], "decisions": [], "todos": []}
    current_section: str | None = None

    for raw_line in text.splitlines():
        line = raw_line.rstrip()
        normalized_heading = _match_heading(line)
        if normalized_heading is not None:
            current_section = normalized_heading
            continue
        if current_section is not None:
            buckets[current_section].append(line)

    if not any(buckets.values()):
        return None

    summary_text = "\n".join(line for line in buckets["summary"] if line.strip()).strip()
    decisions_text = "\n".join(line for line in buckets["decisions"] if line.strip()).strip()
    todos_text = "\n".join(line for line in buckets["todos"] if line.strip()).strip()

    return SummarySections(
        summary=summary_text or "要約なし",
        decisions=_split_list_text(decisions_text),
        todos=_split_list_text(todos_text),
    )


def _match_heading(line: str) -> str | None:
    normalized = re.sub(r"[\s#*:`\-_\[\]()!！?？✅🏃📝]", "", line.lower())
    if "要約" in normalized or "summary" in normalized:
        return "summary"
    if "決定事項" in normalized or "decision" in normalized:
        return "decisions"
    if "todo" in normalized or "次のアクション" in normalized or "task" in normalized:
        return "todos"
    return None


def _split_list_text(text: str) -> list[str]:
    if not text:
        return []

    items: list[str] = []
    for line in text.splitlines():
        stripped = re.sub(r"^\s*[-*・]\s*", "", line).strip()
        if stripped:
            items.append(stripped)
    if items:
        return items

    paragraph = text.strip()
    return [paragraph] if paragraph else []


def _listify(value: object) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [_stringify(item, "").strip() for item in value if _stringify(item, "").strip()]
    single = _stringify(value, "").strip()
    return [single] if single else []


def _stringify(value: object, fallback: str) -> str:
    if value is None:
        return fallback
    if isinstance(value, str):
        return value.strip() or fallback
    return str(value).strip() or fallback
