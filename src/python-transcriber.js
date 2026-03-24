import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import readline from 'node:readline';

export class PythonTranscriber {
  constructor({ pythonExecutable, scriptPath, modelPath, ffmpegBinary, logger }) {
    this.pythonExecutable = pythonExecutable;
    this.scriptPath = scriptPath;
    this.modelPath = modelPath;
    this.ffmpegBinary = ffmpegBinary;
    this.logger = logger;
    this.pending = new Map();
    this.process = null;
    this.readyPromise = null;
    this.exitPromise = null;
  }

  async transcribe(segmentPath) {
    await this.ensureStarted();

    return await new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      this.pending.set(requestId, { resolve, reject });
      this.process.stdin.write(
        `${JSON.stringify({ type: 'transcribe', id: requestId, segmentPath })}\n`,
        'utf8',
      );
    });
  }

  async close() {
    if (!this.process) {
      return;
    }

    try {
      this.process.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`, 'utf8');
      this.process.stdin.end();
    } catch {
      // Ignore shutdown write failures.
    }

    await this.exitPromise;
  }

  async ensureStarted() {
    if (this.readyPromise) {
      await this.readyPromise;
      return;
    }

    this.process = spawn(
      this.pythonExecutable,
      [
        '-u',
        this.scriptPath,
        '--model-path',
        this.modelPath,
        '--ffmpeg-binary',
        this.ffmpegBinary,
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
        },
      },
    );

    this.exitPromise = new Promise((resolve) => {
      this.process.once('close', (code, signal) => {
        const error = new Error(
          `Python transcription worker exited unexpectedly (code=${code}, signal=${signal}).`,
        );

        for (const { reject } of this.pending.values()) {
          reject(error);
        }
        this.pending.clear();
        resolve();
      });
    });

    this.readyPromise = new Promise((resolve, reject) => {
      const stdoutReader = readline.createInterface({ input: this.process.stdout });
      const stderrReader = readline.createInterface({ input: this.process.stderr });

      stdoutReader.on('line', (line) => {
        if (!line.trim()) {
          return;
        }

        let payload;
        try {
          payload = JSON.parse(line);
        } catch {
          this.logger.warn(`Invalid JSON from Python transcriber: ${line}`);
          return;
        }

        if (payload.type === 'ready') {
          resolve();
          return;
        }

        if (payload.type === 'result' && payload.id) {
          const deferred = this.pending.get(payload.id);
          if (!deferred) {
            return;
          }

          this.pending.delete(payload.id);
          if (payload.error) {
            deferred.reject(new Error(payload.error));
          } else {
            deferred.resolve(payload.text || '');
          }
        }
      });

      stderrReader.on('line', (line) => {
        if (line.trim()) {
          this.logger.warn(`[python-transcriber] ${line}`);
        }
      });

      this.process.once('error', reject);
      this.process.once('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Python transcription worker failed to start (exit code ${code}).`));
        }
      });
    });

    await this.readyPromise;
  }
}
