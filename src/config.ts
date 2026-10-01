import 'dotenv/config';
import path from 'node:path';

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const dataDirectory = path.resolve(process.env.DATA_DIR ?? 'data');

export const config = {
  archiveDirectory: path.join(dataDirectory, 'archive'),
  authDirectory: path.join(dataDirectory, 'auth'),
  databasePath: path.join(dataDirectory, 'archive', 'archive.sqlite'),
  mediaDirectory: path.join(dataDirectory, 'archive', 'media'),
  statusPath: path.join(dataDirectory, 'archive', 'status.json'),
  maxMediaBytes: positiveNumber(process.env.MAX_MEDIA_MB, 100) * 1024 * 1024,
  downloadMedia: process.env.DOWNLOAD_MEDIA !== 'false',
  logLevel: process.env.LOG_LEVEL ?? 'info'
};
