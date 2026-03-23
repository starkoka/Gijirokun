from __future__ import annotations

import unittest

from gijirokun.summary_parser import parse_summary_response


class SummaryParserTests(unittest.TestCase):
    def test_parse_summary_response_reads_json_payload(self) -> None:
        response = """
```json
{
  "summary": "会議全体の要約",
  "decisions": ["仕様を確定する"],
  "todos": ["README を整備する"]
}
```
""".strip()

        parsed = parse_summary_response(response)

        self.assertEqual(parsed.summary, "会議全体の要約")
        self.assertEqual(parsed.decisions, ["仕様を確定する"])
        self.assertEqual(parsed.todos, ["README を整備する"])

    def test_parse_summary_response_falls_back_to_markdown_sections(self) -> None:
        response = """
## 📝 要約

ボット構成を確認した。

## ✅ 決定事項

- Pycord を使う

## 🏃 次のアクション (TODO)

- README を作る
""".strip()

        parsed = parse_summary_response(response)

        self.assertEqual(parsed.summary, "ボット構成を確認した。")
        self.assertEqual(parsed.decisions, ["Pycord を使う"])
        self.assertEqual(parsed.todos, ["README を作る"])


if __name__ == "__main__":
    unittest.main()
