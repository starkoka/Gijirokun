import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirPath = path.dirname(currentFilePath);
const projectRoot = path.resolve(currentDirPath, '..');

export function loadConfig() {
  return {
    projectRoot,
    discordBotToken: requireEnv('DISCORD_BOT_TOKEN'),
    geminiApiKey: requireEnv('GEMINI_API_KEY'),
    geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    voskModelPath: path.resolve(projectRoot, process.env.VOSK_MODEL_PATH || './models/vosk-model-small-ja-0.22'),
    ffmpegBinary: process.env.FFMPEG_BINARY || 'ffmpeg',
    dataRoot: path.resolve(projectRoot, process.env.DATA_ROOT || './data'),
    timezone: process.env.BOT_TIMEZONE || 'Asia/Tokyo',
    silenceTimeoutMs: Math.max(
      100,
      Math.round(Number.parseFloat(process.env.SILENCE_TIMEOUT_SECONDS || '1.5') * 1000),
    ),
    commandGuildIds: parseGuildIds(process.env.DISCORD_GUILD_IDS || ''),
    pythonExecutable: process.env.PYTHON_EXECUTABLE || 'python3',
    transcriberScriptPath: path.resolve(projectRoot, 'scripts', 'transcribe_worker.py'),
  };
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Environment variable '${name}' is required.`);
  }
  return value;
}

function parseGuildIds(rawValue) {
  return rawValue
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}
