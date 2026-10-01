import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

export type ConnectionState = 'starting' | 'qr_required' | 'connecting' | 'connected' | 'syncing' | 'disconnected';

export interface ConnectorStatus {
  state: ConnectionState;
  updatedAt: string;
  connectedAt?: string;
  lastDisconnectedAt?: string;
  lastSyncStartedAt?: string;
  lastSyncCompletedAt?: string;
  lastError?: string;
}

export async function writeStatus(update: Omit<ConnectorStatus, 'updatedAt'>): Promise<ConnectorStatus> {
  await mkdir(path.dirname(config.statusPath), { recursive: true, mode: 0o700 });
  const status: ConnectorStatus = {
    ...update,
    updatedAt: new Date().toISOString()
  };
  const temporaryPath = `${config.statusPath}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(status, null, 2), { mode: 0o600 });
  await rename(temporaryPath, config.statusPath);
  return status;
}

export async function readStatus(): Promise<ConnectorStatus | null> {
  try {
    return JSON.parse(await readFile(config.statusPath, 'utf8')) as ConnectorStatus;
  } catch {
    return null;
  }
}
