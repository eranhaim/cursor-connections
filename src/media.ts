import { createHash } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import { config } from './config.js';

const extensions: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'audio/ogg; codecs=opus': 'ogg',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'application/pdf': 'pdf'
};

function extensionFor(mimeType: string | null): string {
  if (!mimeType) return 'bin';
  return extensions[mimeType.toLowerCase()] ?? 'bin';
}

export async function downloadMedia(
  socket: WASocket,
  message: WAMessage,
  mimeType: string | null
): Promise<{ path: string; sha256: string; bytes: number }> {
  await mkdir(config.mediaDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    config.mediaDirectory,
    `.download-${message.key.id ?? 'unknown'}-${Date.now()}.part`
  );
  const file = await open(temporaryPath, 'wx', 0o600);
  const hash = createHash('sha256');
  let bytes = 0;

  try {
    const stream = await downloadMediaMessage(message, 'stream', {}, {
      reuploadRequest: socket.updateMediaMessage,
      logger: pino({ level: 'silent' })
    });
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      bytes += chunk.length;
      if (bytes > config.maxMediaBytes) {
        throw new Error(`Media exceeds configured ${config.maxMediaBytes} byte limit`);
      }
      hash.update(chunk);
      await file.write(chunk);
    }
  } catch (error) {
    await file.close();
    await rm(temporaryPath, { force: true });
    throw error;
  }

  await file.close();
  const sha256 = hash.digest('hex');
  const relativePath = path.join('media', `${sha256}.${extensionFor(mimeType)}`);
  const targetPath = path.join(config.archiveDirectory, relativePath);
  try {
    await rename(temporaryPath, targetPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    await rm(temporaryPath, { force: true });
  }

  return { path: relativePath, sha256, bytes };
}
