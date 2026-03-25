import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PythonTranscriber } from '../src/python-transcriber.js';

const workerPath = fileURLToPath(new URL('./fixtures/fake_transcriber_worker.py', import.meta.url));

test('PythonTranscriber retries after a worker crash', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gijirokun-transcriber-'));
  const previousMode = process.env.FAKE_TRANSCRIBER_MODE;
  const previousStateFile = process.env.FAKE_TRANSCRIBER_STATE_FILE;
  process.env.FAKE_TRANSCRIBER_MODE = 'crash_once';
  process.env.FAKE_TRANSCRIBER_STATE_FILE = path.join(tempDir, 'crash_once.state');

  const transcriber = new PythonTranscriber({
    pythonExecutable: 'python3',
    scriptPath: workerPath,
    modelPath: tempDir,
    ffmpegBinary: 'ffmpeg',
    requestTimeoutMs: 500,
    logger: createLogger(),
  });

  t.after(async () => {
    await transcriber.close().catch(() => {});
    restoreEnv(previousMode, previousStateFile);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  assert.equal(await transcriber.transcribe('/tmp/first.wav'), 'fixture:first.wav');
  assert.equal(await transcriber.transcribe('/tmp/second.wav'), 'fixture:second.wav');
});

test('PythonTranscriber retries after a worker timeout', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gijirokun-transcriber-'));
  const previousMode = process.env.FAKE_TRANSCRIBER_MODE;
  const previousStateFile = process.env.FAKE_TRANSCRIBER_STATE_FILE;
  process.env.FAKE_TRANSCRIBER_MODE = 'hang_once';
  process.env.FAKE_TRANSCRIBER_STATE_FILE = path.join(tempDir, 'hang_once.state');

  const transcriber = new PythonTranscriber({
    pythonExecutable: 'python3',
    scriptPath: workerPath,
    modelPath: tempDir,
    ffmpegBinary: 'ffmpeg',
    requestTimeoutMs: 200,
    logger: createLogger(),
  });

  t.after(async () => {
    await transcriber.close().catch(() => {});
    restoreEnv(previousMode, previousStateFile);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  assert.equal(await transcriber.transcribe('/tmp/slow.wav'), 'fixture:slow.wav');
  assert.equal(await transcriber.transcribe('/tmp/next.wav'), 'fixture:next.wav');
});

function createLogger() {
  return {
    warn() {},
    info() {},
    error() {},
  };
}

function restoreEnv(previousMode, previousStateFile) {
  if (previousMode === undefined) {
    delete process.env.FAKE_TRANSCRIBER_MODE;
  } else {
    process.env.FAKE_TRANSCRIBER_MODE = previousMode;
  }

  if (previousStateFile === undefined) {
    delete process.env.FAKE_TRANSCRIBER_STATE_FILE;
  } else {
    process.env.FAKE_TRANSCRIBER_STATE_FILE = previousStateFile;
  }
}
