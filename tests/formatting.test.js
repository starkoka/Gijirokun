import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMarkdownMinutes, formatTranscriptEntry } from '../src/formatting.js';

test('formatMarkdownMinutes includes required sections', () => {
  const metadata = {
    voiceChannelName: '開発定例',
    startedAt: new Date('2026-03-24T01:00:00.000Z'),
    endedAt: new Date('2026-03-24T02:30:00.000Z'),
    participants: [
      { displayName: '山田', username: 'yamada' },
      { displayName: '鈴木', username: 'suzuki' },
    ],
  };
  const sections = {
    summary: '進捗確認とリリース方針の整理を行った。',
    decisions: ['今週中にリリースする'],
    todos: ['山田が changelog を更新する'],
  };

  const actual = formatMarkdownMinutes(metadata, sections, 'Asia/Tokyo');

  assert.match(actual, /# 議事録: 開発定例/);
  assert.match(actual, /\*\*日時:\*\* 2026年03月24日 10:00 - 11:30/);
  assert.match(actual, /- 山田 \(@yamada\)/);
  assert.match(actual, /## ✅ 決定事項/);
  assert.match(actual, /- 今週中にリリースする/);
  assert.match(actual, /## 🏃 次のアクション \(TODO\)/);
});

test('formatTranscriptEntry matches cache layout', () => {
  const actual = formatTranscriptEntry(
    {
      order: 1,
      speakerName: '山田',
      startedAt: new Date('2026-03-24T01:15:30.000Z'),
      text: 'では次の議題に入ります。',
    },
    'Asia/Tokyo',
  );

  assert.equal(actual, '[10:15:30] 山田\n\nでは次の議題に入ります。\n\n');
});
