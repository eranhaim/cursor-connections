import {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  getContentType,
  makeCacheableSignalKeyStore,
  makeWASocket,
  useMultiFileAuthState,
  type proto,
  type WAMessage,
  type WASocket
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { Archive, type NewMessage } from './archive.js';
import { config } from './config.js';
import { downloadMedia } from './media.js';
import { writeStatus, type ConnectorStatus } from './status.js';

type ChatLike = { id?: string | null; name?: string | null; subject?: string | null; notify?: string | null };
type MessageContent = Record<string, unknown>;

const mediaTypes = new Set(['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage']);

function unwrapMessage(message: proto.IMessage | null | undefined): MessageContent {
  let content = (message ?? {}) as MessageContent;
  while (true) {
    const type = getContentType(content as proto.IMessage);
    const wrapper = type && content[type] as { message?: proto.IMessage } | undefined;
    if (!type || !wrapper?.message || !['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage'].includes(type)) {
      return content;
    }
    content = wrapper.message as MessageContent;
  }
}

function textFrom(content: MessageContent, type: string | undefined): string | null {
  if (typeof content.conversation === 'string') return content.conversation;
  if (!type) return null;
  const payload = content[type] as { text?: unknown; caption?: unknown } | undefined;
  if (typeof payload?.text === 'string') return payload.text;
  if (typeof payload?.caption === 'string') return payload.caption;
  return null;
}

function mediaMimeType(content: MessageContent, type: string | undefined): string | null {
  if (!type || !mediaTypes.has(type)) return null;
  const payload = content[type] as { mimetype?: unknown } | undefined;
  return typeof payload?.mimetype === 'string' ? payload.mimetype : null;
}

function timestampFrom(message: WAMessage): number {
  const timestamp = Number(message.messageTimestamp ?? 0);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Math.floor(Date.now() / 1000);
}

export class Connector {
  private readonly archive = new Archive();
  private readonly logger = pino({ level: config.logLevel });
  private readonly quietLogger = pino({ level: 'silent' });
  private readonly chatNames = new Map<string, string>();
  private socket: WASocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private processing = Promise.resolve();
  private status: ConnectorStatus = { state: 'starting', updatedAt: new Date().toISOString() };

  async start(): Promise<void> {
    await this.setStatus({ state: 'starting' });
    await this.connect();
  }

  private async setStatus(update: Partial<Omit<ConnectorStatus, 'updatedAt'>>): Promise<void> {
    this.status = await writeStatus({ ...this.status, ...update });
  }

  private rememberChats(chats: readonly ChatLike[]): void {
    for (const chat of chats) {
      if (!chat.id) continue;
      const name = chat.name || chat.subject || chat.notify || chat.id;
      this.chatNames.set(chat.id, name);
      this.archive.upsertChat(chat.id, name);
    }
  }

  private async connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(config.authDirectory);
    const { version } = await fetchLatestBaileysVersion();
    this.socket = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, this.quietLogger)
      },
      // WhatsApp currently rejects the legacy Desktop fingerprint before QR
      // pairing with status 428; Chrome still receives full-history sync.
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: true,
      markOnlineOnConnect: false,
      version,
      logger: this.quietLogger
    });
    const socket = this.socket;

    socket.ev.on('creds.update', saveCreds);
    socket.ev.on('chats.upsert', chats => this.rememberChats(chats as ChatLike[]));
    socket.ev.on('contacts.upsert', contacts => this.rememberChats(contacts as ChatLike[]));
    socket.ev.on('messaging-history.set', event => {
      this.rememberChats(event.chats as ChatLike[]);
      this.rememberChats(event.contacts as ChatLike[]);
      this.enqueue(() => this.processMessages('history', event.messages));
    });
    socket.ev.on('messages.upsert', event => {
      this.enqueue(() => this.processMessages('live', event.messages));
    });
    socket.ev.on('connection.update', update => {
      void this.handleConnectionUpdate(update);
    });
  }

  private enqueue(work: () => Promise<void>): void {
    this.processing = this.processing.then(work).catch(error => {
      this.logger.error({ err: error instanceof Error ? error.message : 'unknown' }, 'Archive processing failed');
    });
  }

  private async handleConnectionUpdate(update: { connection?: string; lastDisconnect?: { error?: Error }; qr?: string }): Promise<void> {
    if (update.qr) {
      await this.setStatus({ state: 'qr_required', lastError: undefined });
      this.logger.info('QR pairing required. Scan the QR shown below in WhatsApp Linked devices.');
      qrcode.generate(update.qr, { small: true });
    }
    if (update.connection === 'connecting') {
      await this.setStatus({ state: 'connecting' });
      this.logger.info('Connecting to WhatsApp');
    }
    if (update.connection === 'open') {
      await this.setStatus({ state: 'connected', connectedAt: new Date().toISOString(), lastError: undefined });
      this.logger.info('WhatsApp connected; requesting accessible multi-device history');
    }
    if (update.connection === 'close') {
      const code = (update.lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      await this.setStatus({
        state: 'disconnected',
        lastDisconnectedAt: new Date().toISOString(),
        lastError: code ? `WhatsApp disconnected (${code})` : 'WhatsApp disconnected'
      });
      if (code === DisconnectReason.loggedOut) {
        this.logger.warn('WhatsApp logged out. Remove data/auth only if you need to pair a new account.');
        return;
      }
      this.logger.warn({ code }, 'WhatsApp disconnected; retrying in five seconds');
      this.reconnectTimer = setTimeout(() => void this.connect(), 5_000);
    }
  }

  private async processMessages(source: 'history' | 'live', messages: readonly WAMessage[]): Promise<void> {
    const syncRun = source === 'history' ? this.archive.beginSync(source) : null;
    if (syncRun) {
      await this.setStatus({ state: 'syncing', lastSyncStartedAt: new Date().toISOString() });
    }

    try {
      for (const message of messages) {
        const downloaded = await this.processMessage(message);
        if (syncRun) this.archive.incrementSync(syncRun, downloaded);
      }
      if (syncRun) {
        this.archive.finishSync(syncRun, 'completed');
        await this.setStatus({ state: 'connected', lastSyncCompletedAt: new Date().toISOString() });
      }
    } catch (error) {
      if (syncRun) this.archive.finishSync(syncRun, 'failed');
      throw error;
    }
  }

  private async processMessage(message: WAMessage): Promise<boolean> {
    const chatId = message.key.remoteJid;
    const messageId = message.key.id;
    if (!chatId || !messageId || !message.message) return false;

    const content = unwrapMessage(message.message);
    const type = getContentType(content as proto.IMessage);
    const mimeType = mediaMimeType(content, type);
    const hasMedia = Boolean(type && mediaTypes.has(type));
    const archiveMessage: NewMessage = {
      chatId,
      chatName: this.chatNames.get(chatId) ?? chatId,
      messageId,
      sender: message.key.participant ?? chatId,
      senderName: message.pushName ?? null,
      fromMe: Boolean(message.key.fromMe),
      timestamp: timestampFrom(message),
      messageType: type ?? null,
      text: textFrom(content, type),
      mimeType,
      mediaStatus: hasMedia ? (config.downloadMedia ? 'pending' : 'disabled') : null,
      mediaPath: null,
      mediaSha256: null,
      mediaBytes: null
    };
    const saved = this.archive.saveMessage(archiveMessage);
    if (!hasMedia || !config.downloadMedia || !this.socket || ['stored', 'disabled', 'too_large'].includes(saved.mediaStatus ?? '')) {
      return false;
    }

    try {
      const media = await downloadMedia(this.socket, message, mimeType);
      this.archive.saveMedia(chatId, messageId, { status: 'stored', ...media });
      return true;
    } catch (error) {
      const tooLarge = error instanceof Error && error.message.includes('configured');
      this.archive.saveMedia(chatId, messageId, { status: tooLarge ? 'too_large' : 'unavailable' });
      this.logger.warn({ messageId, chatId, reason: tooLarge ? 'too_large' : 'unavailable' }, 'Media was not archived');
      return false;
    }
  }

  async stop(): Promise<void> {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    await this.processing;
    this.archive.close();
  }
}
