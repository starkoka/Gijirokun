import fs from 'node:fs/promises';
import path from 'node:path';

export const PCM_SAMPLE_RATE = 48_000;
export const PCM_CHANNELS = 2;
export const PCM_BIT_DEPTH = 16;

export async function writePcmWavFile(filePath, pcmBuffer) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const header = createWavHeader({
    dataLength: pcmBuffer.length,
    sampleRate: PCM_SAMPLE_RATE,
    channels: PCM_CHANNELS,
    bitDepth: PCM_BIT_DEPTH,
  });

  await fs.writeFile(filePath, Buffer.concat([header, pcmBuffer]));
}

function createWavHeader({ dataLength, sampleRate, channels, bitDepth }) {
  const blockAlign = (channels * bitDepth) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);

  return header;
}
