import fs from 'node:fs/promises';
import path from 'node:path';
import { formatTranscriptEntry } from './formatting.js';

export class TranscriptPipeline {
  constructor({ transcriptPath, transcriber, timezone, logger }) {
    this.transcriptPath = transcriptPath;
    this.transcriber = transcriber;
    this.timezone = timezone;
    this.logger = logger;
    this.completedEntries = new Map();
    this.pendingTasks = new Set();
    this.nextWriteOrder = 1;
    this.flushChain = Promise.resolve();
    this.closed = false;
    this.warnings = [];
  }

  async initialize() {
    await fs.mkdir(path.dirname(this.transcriptPath), { recursive: true });
    await fs.writeFile(this.transcriptPath, '', 'utf8');
  }

  submitText(entry) {
    this.ensureOpen();
    this.completedEntries.set(entry.order, entry);
    this.scheduleFlush();
  }

  submitAudio(job) {
    this.ensureOpen();
    const task = this.processAudioJob(job)
      .catch((error) => {
        const warning = `音声チャンク ${path.basename(job.segmentPath)} の文字起こしをスキップしました: ${error.message}`;
        this.warnings.push(warning);
        this.logger?.warn(warning);
        this.completedEntries.set(job.order, null);
      })
      .finally(async () => {
        await fs.rm(job.segmentPath, { force: true });
        this.pendingTasks.delete(task);
        this.scheduleFlush();
      });

    this.pendingTasks.add(task);
  }

  async closeAndWait() {
    this.closed = true;
    await Promise.allSettled([...this.pendingTasks]);
    await this.flushChain;
  }

  async readText() {
    try {
      return await fs.readFile(this.transcriptPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        return '';
      }
      throw error;
    }
  }

  async processAudioJob(job) {
    const text = await this.transcriber.transcribe(job.segmentPath);
    if (!text.trim()) {
      this.completedEntries.set(job.order, null);
      return;
    }

    this.completedEntries.set(job.order, {
      order: job.order,
      speakerName: job.speakerName,
      startedAt: job.startedAt,
      text: text.trim(),
    });
  }

  scheduleFlush() {
    this.flushChain = this.flushChain.then(() => this.flushReadyEntries());
  }

  async flushReadyEntries() {
    while (this.completedEntries.has(this.nextWriteOrder)) {
      const entry = this.completedEntries.get(this.nextWriteOrder);
      this.completedEntries.delete(this.nextWriteOrder);
      this.nextWriteOrder += 1;

      if (!entry) {
        continue;
      }

      await fs.appendFile(
        this.transcriptPath,
        formatTranscriptEntry(entry, this.timezone),
        'utf8',
      );
    }
  }

  ensureOpen() {
    if (this.closed) {
      throw new Error('Transcript pipeline is already closed.');
    }
  }
}
