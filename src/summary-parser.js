export function parseSummaryResponse(responseText) {
  const cleaned = `${responseText || ''}`.trim();
  if (!cleaned) {
    return {
      summary: '要約テキストを取得できませんでした。',
      decisions: [],
      todos: [],
    };
  }

  const jsonCandidate = extractJsonCandidate(cleaned);
  if (jsonCandidate) {
    try {
      const payload = JSON.parse(jsonCandidate);
      return {
        summary: stringify(payload.summary, '要約なし'),
        decisions: listify(payload.decisions),
        todos: listify(payload.todos),
      };
    } catch {
      // Fall through to markdown parsing.
    }
  }

  const markdownSections = parseMarkdownSections(cleaned);
  if (markdownSections) {
    return markdownSections;
  }

  return {
    summary: cleaned,
    decisions: [],
    todos: [],
  };
}

function extractJsonCandidate(text) {
  let stripped = text.trim();
  const fencedMatch = stripped.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fencedMatch) {
    stripped = fencedMatch[1].trim();
  }

  if (stripped.startsWith('{') && stripped.endsWith('}')) {
    return stripped;
  }

  const blockMatch = stripped.match(/\{[\s\S]*\}/);
  return blockMatch?.[0] || null;
}

function parseMarkdownSections(text) {
  const buckets = {
    summary: [],
    decisions: [],
    todos: [],
  };

  let currentSection = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const matched = matchHeading(line);
    if (matched) {
      currentSection = matched;
      continue;
    }

    if (currentSection) {
      buckets[currentSection].push(line);
    }
  }

  if (!Object.values(buckets).some((lines) => lines.length)) {
    return null;
  }

  return {
    summary: buckets.summary.filter(hasContent).join('\n').trim() || '要約なし',
    decisions: splitListText(buckets.decisions.filter(hasContent).join('\n').trim()),
    todos: splitListText(buckets.todos.filter(hasContent).join('\n').trim()),
  };
}

function matchHeading(line) {
  const normalized = line.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  if (normalized.includes('要約') || normalized.includes('summary')) {
    return 'summary';
  }
  if (normalized.includes('決定事項') || normalized.includes('decision')) {
    return 'decisions';
  }
  if (
    normalized.includes('todo') ||
    normalized.includes('次のアクション') ||
    normalized.includes('task')
  ) {
    return 'todos';
  }
  return null;
}

function splitListText(text) {
  if (!text) {
    return [];
  }

  const items = text
    .split('\n')
    .map((line) => line.replace(/^\s*[-*・]\s*/, '').trim())
    .filter(Boolean);

  if (items.length) {
    return items;
  }

  return [text.trim()].filter(Boolean);
}

function listify(value) {
  if (value == null) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.map((item) => stringify(item, '')).filter(Boolean);
  }

  return [stringify(value, '')].filter(Boolean);
}

function stringify(value, fallback) {
  if (value == null) {
    return fallback;
  }

  const normalized = `${value}`.trim();
  return normalized || fallback;
}

function hasContent(value) {
  return Boolean(value.trim());
}
