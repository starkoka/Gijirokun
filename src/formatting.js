export function formatParticipant(participant) {
  return `- ${participant.displayName} (@${participant.username})`;
}

export function formatParticipants(participants) {
  if (!participants.length) {
    return '- 参加者情報なし';
  }

  return participants.map(formatParticipant).join('\n');
}

export function formatMarkdownMinutes(metadata, sections, timezone) {
  const startedAt = formatJapaneseDateTime(metadata.startedAt, timezone);
  const endedAt = formatTime(metadata.endedAt, timezone);

  return (
    `# 議事録: ${metadata.voiceChannelName}\n\n` +
    `**日時:** ${startedAt} - ${endedAt}\n\n` +
    `**参加者:**\n${formatParticipants(metadata.participants)}\n\n` +
    `## 📝 要約\n\n${coerceParagraph(sections.summary, '要約は生成されませんでした。')}\n\n` +
    `## ✅ 決定事項\n\n${coerceList(sections.decisions)}\n\n` +
    `## 🏃 次のアクション (TODO)\n\n${coerceList(sections.todos)}\n`
  );
}

export function formatTranscriptEntry(entry, timezone) {
  const timestamp = formatTimestamp(entry.startedAt, timezone);
  return `[${timestamp}] ${entry.speakerName}\n\n${entry.text.trim()}\n\n`;
}

export function formatJapaneseDateTime(date, timezone) {
  const parts = getDateTimeParts(date, timezone, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  return `${parts.year}年${parts.month}月${parts.day}日 ${parts.hour}:${parts.minute}`;
}

export function formatTime(date, timezone) {
  const parts = getDateTimeParts(date, timezone, {
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${parts.hour}:${parts.minute}`;
}

export function formatTimestamp(date, timezone) {
  const parts = getDateTimeParts(date, timezone, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  return `${parts.hour}:${parts.minute}:${parts.second}`;
}

function getDateTimeParts(date, timezone, options) {
  const formatter = new Intl.DateTimeFormat('ja-JP', {
    timeZone: timezone,
    hour12: false,
    ...options,
  });

  const entries = Object.create(null);
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') {
      entries[part.type] = part.value;
    }
  }
  return entries;
}

function coerceParagraph(text, fallback) {
  const normalized = `${text || ''}`.trim();
  return normalized || fallback;
}

function coerceList(items) {
  const normalized = items.map((item) => `${item}`.trim()).filter(Boolean);
  if (!normalized.length) {
    return '- なし';
  }

  return normalized.map((item) => `- ${item}`).join('\n');
}
