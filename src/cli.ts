import { access } from 'node:fs/promises';
import path from 'node:path';
import { Archive, type ArchiveMessage } from './archive.js';
import { config } from './config.js';
import { readStatus } from './status.js';

function usage(): never {
  console.error(`Usage:
  cli status
  cli chats [search]
  cli coverage
  cli export <chat-name-or-id> --format jsonl|markdown
  cli media [chat-name-or-id]`);
  process.exit(2);
}

function iso(timestamp: unknown): string | null {
  const value = Number(timestamp);
  return Number.isFinite(value) && value > 0 ? new Date(value * 1000).toISOString() : null;
}

function displayRows(rows: Array<Record<string, unknown>>): void {
  for (const row of rows) {
    if ('oldestTimestamp' in row) row.oldestAt = iso(row.oldestTimestamp);
    if ('newestTimestamp' in row) row.newestAt = iso(row.newestTimestamp);
    if ('timestamp' in row) row.at = iso(row.timestamp);
    delete row.oldestTimestamp;
    delete row.newestTimestamp;
    delete row.timestamp;
  }
  console.log(JSON.stringify(rows, null, 2));
}

function asJsonLine(message: ArchiveMessage): string {
  return JSON.stringify({
    ...message,
    fromMe: Boolean(message.fromMe),
    timestamp: new Date(message.timestamp * 1000).toISOString()
  });
}

function markdown(messages: ArchiveMessage[], chatName: string): string {
  const lines = [`# ${chatName}`, ''];
  for (const message of messages) {
    const timestamp = new Date(message.timestamp * 1000).toISOString();
    const sender = message.fromMe ? 'Me' : (message.senderName || message.sender || 'Unknown');
    lines.push(`## ${timestamp} — ${sender}`);
    if (message.text) lines.push(message.text);
    if (message.mediaPath) {
      lines.push(`Media: ${message.mediaPath}${message.mimeType ? ` (${message.mimeType})` : ''}`);
    } else if (message.mediaStatus && message.mediaStatus !== 'pending') {
      lines.push(`Media status: ${message.mediaStatus}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const [command, ...arguments_] = process.argv.slice(2);
  if (!command) usage();

  if (command === 'status' || command === 'health') {
    const status = await readStatus();
    const accountConnected = status?.state === 'connected' || status?.state === 'syncing';
    const output = { containerHealthy: Boolean(status), accountConnected, status };
    console.log(JSON.stringify(output, null, 2));
    if (command === 'health' && !status) process.exitCode = 1;
    return;
  }

  const archive = new Archive();
  try {
    if (command === 'chats') {
      displayRows(archive.listChats(arguments_.join(' ') || undefined));
      return;
    }
    if (command === 'coverage') {
      console.log(JSON.stringify({
        lastSync: archive.latestSync(),
        chats: archive.coverage().map(row => ({
          ...row,
          oldestAt: iso(row.oldestTimestamp),
          newestAt: iso(row.newestTimestamp)
        }))
      }, null, 2));
      return;
    }
    if (command === 'media') {
      displayRows(archive.listMedia(arguments_.join(' ') || undefined));
      return;
    }
    if (command === 'export') {
      const formatFlag = arguments_.indexOf('--format');
      if (formatFlag < 1 || !arguments_[formatFlag + 1]) usage();
      const selector = arguments_.slice(0, formatFlag).join(' ');
      const format = arguments_[formatFlag + 1];
      const chat = archive.resolveChat(selector);
      const messages = archive.messagesForChat(chat.id);
      if (format === 'jsonl') {
        process.stdout.write(messages.map(asJsonLine).join('\n') + (messages.length ? '\n' : ''));
        return;
      }
      if (format === 'markdown') {
        process.stdout.write(markdown(messages, chat.name));
        return;
      }
      usage();
    }
    usage();
  } finally {
    archive.close();
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Command failed');
  process.exitCode = 1;
});
