import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSummaryResponse } from '../src/summary-parser.js';

test('parseSummaryResponse reads JSON payload', () => {
  const response = `
\`\`\`json
{
  "summary": "会議全体の要約",
  "decisions": ["実装方針を確定する"],
  "todos": ["README を更新する"]
}
\`\`\`
`.trim();

  const parsed = parseSummaryResponse(response);

  assert.equal(parsed.summary, '会議全体の要約');
  assert.deepEqual(parsed.decisions, ['実装方針を確定する']);
  assert.deepEqual(parsed.todos, ['README を更新する']);
});

test('parseSummaryResponse falls back to markdown sections', () => {
  const response = `
## 📝 要約
ボット移行の方針を確認した。
## ✅ 決定事項
- discord.js を採用する
## 🏃 次のアクション (TODO)

- README を整備する
`.trim();

  const parsed = parseSummaryResponse(response);

  assert.equal(parsed.summary, 'ボット移行の方針を確認した。');
  assert.deepEqual(parsed.decisions, ['discord.js を採用する']);
  assert.deepEqual(parsed.todos, ['README を整備する']);
});
