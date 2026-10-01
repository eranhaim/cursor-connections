import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

export interface ArchiveMessage {
  chatId: string;
  chatName: string;
  messageId: string;
  sender: string | null;
  senderName: string | null;
  fromMe: boolean;
  timestamp: number;
  messageType: string | null;
  text: string | null;
  mimeType: string | null;
  mediaStatus: string | null;
  mediaPath: string | null;
  mediaSha256: string | null;
  mediaBytes: number | null;
}

export interface NewMessage extends ArchiveMessage {}

export class Archive {
  private readonly database: Database.Database;

  constructor(databasePath = config.databasePath) {
    mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new Database(databasePath);
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('foreign_keys = ON');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        archive_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        chat_id TEXT NOT NULL REFERENCES chats(id),
        sender TEXT,
        sender_name TEXT,
        from_me INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        message_type TEXT,
        text TEXT,
        mime_type TEXT,
        media_status TEXT,
        media_path TEXT,
        media_sha256 TEXT,
        media_bytes INTEGER,
        created_at TEXT NOT NULL,
        UNIQUE(chat_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS messages_by_chat_time ON messages(chat_id, timestamp);
      CREATE INDEX IF NOT EXISTS chats_by_name ON chats(name);
      CREATE TABLE IF NOT EXISTS sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        source TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        media_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.database.close();
  }

  upsertChat(id: string, name: string): void {
    this.database.prepare(`
      INSERT INTO chats (id, name, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = CASE WHEN excluded.name != excluded.id THEN excluded.name ELSE chats.name END,
        updated_at = excluded.updated_at
    `).run(id, name, new Date().toISOString());
  }

  saveMessage(message: NewMessage): { inserted: boolean; mediaStatus: string | null } {
    this.upsertChat(message.chatId, message.chatName);
    const result = this.database.prepare(`
      INSERT INTO messages (
        archive_id, message_id, chat_id, sender, sender_name, from_me, timestamp,
        message_type, text, mime_type, media_status, media_path, media_sha256,
        media_bytes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id, message_id) DO NOTHING
    `).run(
      `${message.chatId}:${message.messageId}`,
      message.messageId,
      message.chatId,
      message.sender,
      message.senderName,
      message.fromMe ? 1 : 0,
      message.timestamp,
      message.messageType,
      message.text,
      message.mimeType,
      message.mediaStatus,
      message.mediaPath,
      message.mediaSha256,
      message.mediaBytes,
      new Date().toISOString()
    );

    const stored = this.database.prepare(
      'SELECT media_status AS mediaStatus FROM messages WHERE chat_id = ? AND message_id = ?'
    ).get(message.chatId, message.messageId) as { mediaStatus: string | null };
    return { inserted: result.changes === 1, mediaStatus: stored.mediaStatus };
  }

  saveMedia(
    chatId: string,
    messageId: string,
    media: { status: string; path?: string; sha256?: string; bytes?: number }
  ): void {
    this.database.prepare(`
      UPDATE messages
      SET media_status = ?, media_path = ?, media_sha256 = ?, media_bytes = ?
      WHERE chat_id = ? AND message_id = ?
    `).run(media.status, media.path ?? null, media.sha256 ?? null, media.bytes ?? null, chatId, messageId);
  }

  beginSync(source: string): number {
    const result = this.database.prepare(`
      INSERT INTO sync_runs (started_at, source, status) VALUES (?, ?, 'running')
    `).run(new Date().toISOString(), source);
    return Number(result.lastInsertRowid);
  }

  finishSync(id: number, status: 'completed' | 'failed'): void {
    this.database.prepare(`
      UPDATE sync_runs SET completed_at = ?, status = ? WHERE id = ?
    `).run(new Date().toISOString(), status, id);
  }

  incrementSync(id: number, mediaDownloaded: boolean): void {
    this.database.prepare(`
      UPDATE sync_runs
      SET message_count = message_count + 1, media_count = media_count + ?
      WHERE id = ?
    `).run(mediaDownloaded ? 1 : 0, id);
  }

  listChats(search?: string): Array<Record<string, unknown>> {
    const query = `
      SELECT c.id, c.name, COUNT(m.message_id) AS messageCount,
        SUM(CASE WHEN m.media_path IS NOT NULL THEN 1 ELSE 0 END) AS mediaCount,
        MIN(m.timestamp) AS oldestTimestamp, MAX(m.timestamp) AS newestTimestamp
      FROM chats c
      LEFT JOIN messages m ON m.chat_id = c.id
      ${search ? 'WHERE c.name LIKE ? OR c.id LIKE ?' : ''}
      GROUP BY c.id, c.name
      ORDER BY newestTimestamp DESC NULLS LAST, c.name COLLATE NOCASE
    `;
    const parameters = search ? [`%${search}%`, `%${search}%`] : [];
    return this.database.prepare(query).all(...parameters) as Array<Record<string, unknown>>;
  }

  resolveChat(selector: string): { id: string; name: string } {
    const exact = this.database.prepare('SELECT id, name FROM chats WHERE id = ? OR name = ?').all(selector, selector) as Array<{
      id: string;
      name: string;
    }>;
    const matches = exact.length > 0
      ? exact
      : this.database.prepare('SELECT id, name FROM chats WHERE name LIKE ? OR id LIKE ?').all(`%${selector}%`, `%${selector}%`) as Array<{
        id: string;
        name: string;
      }>;
    if (matches.length === 0) {
      throw new Error(`No chat matches "${selector}". Run "chats <search>" first.`);
    }
    if (matches.length > 1) {
      throw new Error(`More than one chat matches "${selector}". Use its exact chat ID.`);
    }
    return matches[0];
  }

  messagesForChat(chatId: string): ArchiveMessage[] {
    return this.database.prepare(`
      SELECT m.chat_id AS chatId, c.name AS chatName, m.message_id AS messageId, m.sender,
        m.sender_name AS senderName, m.from_me AS fromMe, m.timestamp,
        m.message_type AS messageType, m.text, m.mime_type AS mimeType,
        m.media_status AS mediaStatus, m.media_path AS mediaPath,
        m.media_sha256 AS mediaSha256, m.media_bytes AS mediaBytes
      FROM messages m
      JOIN chats c ON c.id = m.chat_id
      WHERE m.chat_id = ?
      ORDER BY m.timestamp, m.message_id
    `).all(chatId) as ArchiveMessage[];
  }

  listMedia(selector?: string): Array<Record<string, unknown>> {
    const clause = selector ? 'AND (c.name LIKE ? OR m.chat_id LIKE ?)' : '';
    const parameters = selector ? [`%${selector}%`, `%${selector}%`] : [];
    return this.database.prepare(`
      SELECT c.name AS chatName, m.chat_id AS chatId, m.message_id AS messageId,
        m.timestamp, m.mime_type AS mimeType, m.media_path AS mediaPath,
        m.media_sha256 AS sha256, m.media_bytes AS bytes
      FROM messages m
      JOIN chats c ON c.id = m.chat_id
      WHERE m.media_path IS NOT NULL ${clause}
      ORDER BY m.timestamp DESC
    `).all(...parameters) as Array<Record<string, unknown>>;
  }

  coverage(): Array<Record<string, unknown>> {
    return this.database.prepare(`
      SELECT c.id AS chatId, c.name AS chatName, COUNT(m.message_id) AS messageCount,
        SUM(CASE WHEN m.media_path IS NOT NULL THEN 1 ELSE 0 END) AS mediaCount,
        MIN(m.timestamp) AS oldestTimestamp, MAX(m.timestamp) AS newestTimestamp
      FROM chats c LEFT JOIN messages m ON m.chat_id = c.id
      GROUP BY c.id, c.name
      ORDER BY newestTimestamp DESC NULLS LAST
    `).all() as Array<Record<string, unknown>>;
  }

  latestSync(): Record<string, unknown> | undefined {
    return this.database.prepare(`
      SELECT started_at AS startedAt, completed_at AS completedAt, source,
        message_count AS messageCount, media_count AS mediaCount, status
      FROM sync_runs ORDER BY id DESC LIMIT 1
    `).get() as Record<string, unknown> | undefined;
  }
}
