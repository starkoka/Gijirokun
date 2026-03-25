import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import readline from 'node:readline';

export class PythonTranscriber {
  constructor({
    pythonExecutable,
    scriptPath,
    modelPath,
    ffmpegBinary,
    requestTimeoutMs = 30_000,
    logger,
  }) {
    this.pythonExecutable = pythonExecutable;
    this.scriptPath = scriptPath;
    this.modelPath = modelPath;
    this.ffmpegBinary = ffmpegBinary;
    this.requestTimeoutMs = requestTimeoutMs;
    this.logger = logger;
    this.pending = new Map();
    this.process = null;
    this.readyPromise = null;
    this.exitPromise = null;
    this.startPromise = null;
    this.restartPromise = null;
    this.closing = false;
  }

  async transcribe(segmentPath) {
    const maxAttempts = 2;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.ensureStarted();
        return await this.sendTranscribeRequest(segmentPath);
      } catch (error) {
        if (!isRetryableTranscriberError(error) || attempt === maxAttempts || this.closing) {
          throw error;
        }

        this.logger.warn(
          `Retrying transcription after worker failure (${attempt}/${maxAttempts - 1}): ${error.message}`,
        );
      }
    }

    throw createTranscriberError(
      'Python transcription worker could not process the request.',
      'WORKER_RETRY_EXHAUSTED',
    );
  }

  async close() {
    this.closing = true;

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
    if (this.closing) {
      throw createTranscriberError('Python transcription worker is closing.', 'WORKER_CLOSED');
    }

    if (this.process && !isUsableProcess(this.process)) {
      await this.exitPromise;
    }

    if (this.restartPromise) {
      await this.restartPromise;
    }

    if (this.readyPromise) {
      await this.readyPromise;
      return;
    }

    if (this.startPromise) {
      await this.startPromise;
      return;
    }

    this.startPromise = this.startWorker();

    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async startWorker() {
    const workerProcess = spawn(
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

    this.process = workerProcess;
    this.exitPromise = new Promise((resolve) => {
      workerProcess.once('close', (code, signal) => {
        const error = this.closing
          ? createTranscriberError(
              'Python transcription worker closed before the request completed.',
              'WORKER_CLOSED',
            )
          : createTranscriberError(
              `Python transcription worker exited unexpectedly (code=${code}, signal=${signal}).`,
              'WORKER_EXITED',
            );

        for (const [requestId, deferred] of this.pending.entries()) {
          if (deferred.workerProcess !== workerProcess) {
            continue;
          }

          deferred.reject(error);
          this.pending.delete(requestId);
        }

        if (!this.closing && code !== 0) {
          this.logger.warn(error.message);
        }

        if (this.process === workerProcess) {
          this.process = null;
          this.readyPromise = null;
          this.exitPromise = null;
        }

        resolve();
      });
    });

    this.readyPromise = new Promise((resolve, reject) => {
      let resolved = false;
      const stdoutReader = readline.createInterface({ input: workerProcess.stdout });
      const stderrReader = readline.createInterface({ input: workerProcess.stderr });

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
          resolved = true;
          resolve();
          return;
        }

        if (payload.type === 'result' && payload.id) {
          const deferred = this.pending.get(payload.id);
          if (!deferred || deferred.workerProcess !== workerProcess) {
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

      workerProcess.once('error', (error) => {
        reject(
          createTranscriberError(
            `Failed to start Python transcription worker: ${error.message}`,
            'WORKER_START_FAILED',
            error,
          ),
        );
      });

      workerProcess.once('close', (code) => {
        if (!resolved) {
          reject(
            createTranscriberError(
              `Python transcription worker failed to start (exit code ${code}).`,
              'WORKER_START_FAILED',
            ),
          );
        }
      });
    });

    await this.readyPromise;
  }

  async sendTranscribeRequest(segmentPath) {
    const workerProcess = this.process;
    if (!workerProcess || !isUsableProcess(workerProcess)) {
      throw createTranscriberError(
        'Python transcription worker is not running.',
        'WORKER_NOT_RUNNING',
      );
    }

    return await new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      let settled = false;

      const finalize = (callback, value) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeoutId);
        this.pending.delete(requestId);
        callback(value);
      };

      const deferred = {
        workerProcess,
        resolve: (text) => {
          finalize(resolve, text);
        },
        reject: (error) => {
          finalize(reject, error);
        },
      };

      const timeoutId = setTimeout(() => {
        const timeoutError = createTranscriberError(
          `Transcription request timed out after ${this.requestTimeoutMs} ms.`,
          'WORKER_TIMEOUT',
        );
        deferred.reject(timeoutError);
        void this.restartWorker(timeoutError);
      }, this.requestTimeoutMs);

      this.pending.set(requestId, deferred);

      try {
        workerProcess.stdin.write(
          `${JSON.stringify({ type: 'transcribe', id: requestId, segmentPath })}\n`,
          'utf8',
          (error) => {
            if (!error) {
              return;
            }

            deferred.reject(
              createTranscriberError(
                `Failed to send transcription request to Python worker: ${error.message}`,
                'WORKER_WRITE_FAILED',
                error,
              ),
            );
            void this.restartWorker(error);
          },
        );
      } catch (error) {
        deferred.reject(
          createTranscriberError(
            `Failed to send transcription request to Python worker: ${error.message}`,
            'WORKER_WRITE_FAILED',
            error,
          ),
        );
        void this.restartWorker(error);
      }
    });
  }

  async restartWorker(reason) {
    if (this.restartPromise) {
      await this.restartPromise;
      return;
    }

    const workerProcess = this.process;
    if (!workerProcess || this.closing) {
      return;
    }
    const exitPromise = this.exitPromise;

    this.restartPromise = (async () => {
      this.logger.warn(`Restarting Python transcription worker: ${reason.message}`);

      try {
        workerProcess.kill('SIGTERM');
      } catch {
        // Ignore restart kill failures.
      }

      await exitPromise;
    })();

    try {
      await this.restartPromise;
    } finally {
      this.restartPromise = null;
    }
  }
}

function createTranscriberError(message, code, cause) {
  const error = cause ? new Error(message, { cause }) : new Error(message);
  error.code = code;
  return error;
}

function isRetryableTranscriberError(error) {
  return [
    'WORKER_EXITED',
    'WORKER_NOT_RUNNING',
    'WORKER_TIMEOUT',
    'WORKER_WRITE_FAILED',
  ].includes(error?.code);
}

function isUsableProcess(workerProcess) {
  return Boolean(
    workerProcess &&
      workerProcess.exitCode === null &&
      !workerProcess.killed &&
      !workerProcess.stdin.destroyed,
  );
}
