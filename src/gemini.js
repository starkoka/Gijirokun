import { GoogleGenAI } from '@google/genai';
import { parseSummaryResponse } from './summary-parser.js';

const SYSTEM_PROMPT = [
  '入力されるテキストは会議の文字起こしデータです。決定事項とタスク（TODO）を含めて要約してください。',
  '各ユーザーの発言をリアルタイムで個別に処理し、発言開始の順番に単純連結しているため、相槌などによって一部応答の文脈が前後している可能性があります。その点を含み置き、前後の文脈から適切に会話の流れを推論して要約を生成してください。',
  '出力は JSON のみとし、次の形式に厳密に従ってください。',
  '{',
  '  "summary": "会議全体の要約",',
  '  "decisions": ["決定事項1", "決定事項2"],',
  '  "todos": ["TODO1", "TODO2"]',
  '}',
  'JSON 以外の説明文、コードブロック、前置き、後書きは出力しないでください。',
].join('\n');

export class GeminiSummarizer {
  constructor({ apiKey, modelName }) {
    this.client = new GoogleGenAI({ apiKey });
    this.modelName = modelName;
  }

  async summarize({ metadata, transcriptText }) {
    if (!transcriptText.trim()) {
      return {
        summary: '文字起こし結果が空だったため、要約は生成されませんでした。',
        decisions: [],
        todos: [],
      };
    }

    const prompt = buildPrompt(metadata, transcriptText);

    try {
      const response = await this.client.models.generateContent({
        model: this.modelName,
        contents: prompt,
        config: {
          systemInstruction: SYSTEM_PROMPT,
          temperature: 0.2,
          responseMimeType: 'application/json',
        },
      });

      return parseSummaryResponse(extractResponseText(response));
    } catch (error) {
      return {
        summary: `Gemini API の要約生成に失敗しました: ${error.message}`,
        decisions: [],
        todos: [],
      };
    }
  }
}

function buildPrompt(metadata, transcriptText) {
  const participants = metadata.participants.length
    ? metadata.participants
        .map((participant) => `${participant.displayName} (@${participant.username})`)
        .join(', ')
    : '参加者情報なし';

  return [
    `会議名: ${metadata.voiceChannelName}`,
    `開始時刻: ${metadata.startedAt.toISOString()}`,
    `終了時刻: ${metadata.endedAt.toISOString()}`,
    `参加者: ${participants}`,
    '',
    '文字起こし:',
    transcriptText,
  ].join('\n');
}

function extractResponseText(response) {
  if (typeof response?.text === 'function') {
    return response.text();
  }

  if (typeof response?.text === 'string') {
    return response.text;
  }

  const candidateText =
    response?.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || '')
      .join('\n')
      .trim() || '';

  return candidateText;
}
