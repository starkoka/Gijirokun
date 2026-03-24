import fs from 'node:fs/promises';
import path from 'node:path';
import prism from 'prism-media';
import { EndBehaviorType } from '@discordjs/voice';
import { formatMarkdownMinutes } from './formatting.js';
import { TranscriptPipeline } from './transcript-pipeline.js';
import { writePcmWavFile } from './audio-utils.js';

const FRAME_SIZE = 960;

export class MeetingSession {
  constructor({
    client,
    config,
    guild,
    voiceChannel,
    textChannel,
    connection,
    summarizer,
    transcriber,
    logger,
  }) {
    this.client = client;
    this.config = config;
    this.guild = guild;
    this.voiceChannel = voiceChannel;
    this.textChannel = textChannel;
    this.connection = connection;
    this.summarizer = summarizer;
    this.transcriber = transcriber;
    this.logger = logger;
    this.startedAt = new Date();
    this.endedAt = this.startedAt;
    this.stopRequested = false;
    this.stopPromise = null;
    this.nextOrder = 1;
    this.activeCollectors = new Map();
    this.pendingSpeakerIds = new Set();
    this.participants = collectParticipants(voiceChannel.members);

    const sessionKey = `${guild.id}_${formatFileTimestamp(this.startedAt, config.timezone)}`;
    this.sessionDir = path.join(config.dataRoot, 'sessions', sessionKey);
    this.chunksDir = path.join(this.sessionDir, 'chunks');
    this.transcriptPath = path.join(this.sessionDir, 'transcript_cache.txt');
    this.minutesPath = path.join(this.sessionDir, 'minutes.md');
    this.pipeline = new TranscriptPipeline({
      transcriptPath: this.transcriptPath,
      transcriber,
      timezone: config.timezone,
    });
  }

  async initialize() {
    await fs.mkdir(this.chunksDir, { recursive: true });
    await this.pipeline.initialize();
    this.installReceiver();
  }

  installReceiver() {
    this.connection.receiver.speaking.on('start', (userId) => {
      void this.handleSpeakerStart(userId);
    });
  }

  async handleSpeakerStart(userId) {
    if (this.stopRequested || this.pendingSpeakerIds.has(userId) || this.activeCollectors.has(userId)) {
      return;
    }

    this.pendingSpeakerIds.add(userId);

    try {
      const member = resolveMember(this.voiceChannel, this.guild, userId);
      if (!member || member.user.bot) {
        return;
      }

      const order = this.reserveOrder();
      const startedAt = new Date();
      const receiveStream = this.connection.receiver.subscribe(userId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: this.config.silenceTimeoutMs,
        },
      });

      const decoder = new prism.opus.Decoder({
        rate: 48_000,
        channels: 2,
        frameSize: FRAME_SIZE,
      });

      const collector = new SpeakerCollector({
        userId,
        speakerName: member.displayName,
        order,
        startedAt,
        receiveStream,
        decoder,
        chunksDir: this.chunksDir,
        onComplete: async (result) => {
          this.activeCollectors.delete(userId);
          this.pendingSpeakerIds.delete(userId);

          if (!result || !result.segmentPath) {
            return;
          }

          this.pipeline.submitAudio({
            order: result.order,
            speakerName: result.speakerName,
            startedAt: result.startedAt,
            segmentPath: result.segmentPath,
          });
        },
      });

      this.activeCollectors.set(userId, collector);
      collector.start();
    } catch (error) {
      this.pendingSpeakerIds.delete(userId);
      this.activeCollectors.delete(userId);
      this.logger.warn(`Failed to start audio capture for user ${userId}: ${error.message}`);
    }
  }

  addTextMessage(message) {
    if (this.stopRequested) {
      return;
    }

    const content = buildMessageContent(message);
    if (!content) {
      return;
    }

    this.pipeline.submitText({
      order: this.reserveOrder(),
      speakerName: `${message.member?.displayName || message.author.username} [text]`,
      startedAt: message.createdAt,
      text: content,
    });
  }

  async stop({ reason }) {
    if (this.stopPromise) {
      return await this.stopPromise;
    }

    this.stopPromise = this.performStop({ reason });
    return await this.stopPromise;
  }

  async performStop({ reason }) {
    this.stopRequested = true;
    this.endedAt = new Date();

    const activeCollectors = [...this.activeCollectors.values()];
    this.activeCollectors.clear();
    this.pendingSpeakerIds.clear();
    await Promise.allSettled(activeCollectors.map((collector) => collector.forceFinalize()));

    try {
      this.connection.destroy();
    } catch (error) {
      this.logger.warn(`Failed to destroy voice connection: ${error.message}`);
    }

    await this.pipeline.closeAndWait();
    const transcriptText = await this.pipeline.readText();
    const metadata = {
      voiceChannelName: this.voiceChannel.name,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      participants: this.participants,
    };

    const sections = await this.summarizer.summarize({
      metadata,
      transcriptText,
    });
    const markdownText = formatMarkdownMinutes(metadata, sections, this.config.timezone);
    await fs.writeFile(this.minutesPath, markdownText, 'utf8');

    return {
      metadata,
      sections,
      markdownText,
      minutesPath: this.minutesPath,
      transcriptPath: this.transcriptPath,
      warnings: this.pipeline.warnings,
      autoStopped: Boolean(reason),
      stopReason: reason || null,
    };
  }

  reserveOrder() {
    const order = this.nextOrder;
    this.nextOrder += 1;
    return order;
  }
}

class SpeakerCollector {
  constructor({
    userId,
    speakerName,
    order,
    startedAt,
    receiveStream,
    decoder,
    chunksDir,
    onComplete,
  }) {
    this.userId = userId;
    this.speakerName = speakerName;
    this.order = order;
    this.startedAt = startedAt;
    this.receiveStream = receiveStream;
    this.decoder = decoder;
    this.chunksDir = chunksDir;
    this.onComplete = onComplete;
    this.chunks = [];
    this.finished = false;
  }

  start() {
    this.decoder.on('data', (chunk) => {
      this.chunks.push(chunk);
    });

    this.decoder.once('end', () => {
      void this.finish();
    });

    this.decoder.once('error', () => {
      void this.finish();
    });

    this.receiveStream.once('end', () => {
      void this.finish();
    });

    this.receiveStream.once('error', () => {
      void this.finish();
    });

    this.receiveStream.pipe(this.decoder);
  }

  async forceFinalize() {
    try {
      this.receiveStream.unpipe(this.decoder);
    } catch {
      // Ignore unpipe issues during forced finalization.
    }

    try {
      this.receiveStream.destroy();
    } catch {
      // Ignore destroy issues.
    }

    try {
      this.decoder.destroy();
    } catch {
      // Ignore destroy issues.
    }

    await this.finish();
  }

  async finish() {
    if (this.finished) {
      return;
    }
    this.finished = true;

    const pcmBuffer = Buffer.concat(this.chunks);
    this.chunks = [];

    if (!pcmBuffer.length) {
      await this.onComplete(null);
      return;
    }

    const segmentPath = path.join(
      this.chunksDir,
      `${String(this.order).padStart(5, '0')}_${this.userId}.wav`,
    );
    await writePcmWavFile(segmentPath, pcmBuffer);
    await this.onComplete({
      order: this.order,
      speakerName: this.speakerName,
      startedAt: this.startedAt,
      segmentPath,
    });
  }
}

function resolveMember(voiceChannel, guild, userId) {
  return (
    voiceChannel.members.get(userId) ||
    guild.voiceStates.cache.get(userId)?.member ||
    guild.members.cache.get(userId) ||
    null
  );
}

function collectParticipants(members) {
  return [...members.values()]
    .filter((member) => !member.user.bot)
    .map((member) => ({
      displayName: member.displayName,
      username: member.user.username,
    }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName, 'ja'));
}

function buildMessageContent(message) {
  const chunks = [];

  if (message.content?.trim()) {
    chunks.push(message.content.trim());
  }

  if (message.attachments.size) {
    for (const attachment of message.attachments.values()) {
      chunks.push(`[添付] ${attachment.name || attachment.url}`);
    }
  }

  return chunks.join('\n').trim();
}

function formatFileTimestamp(date, timezone) {
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  return formatter.format(date).replaceAll('-', '').replace(' ', '_').replaceAll(':', '');
}
