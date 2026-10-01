import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Archive } from './archive.js';

test('stores a message once across repeated syncs', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'whatsapp-archive-'));
  const archive = new Archive(path.join(directory, 'archive.sqlite'));
  try {
    const message = {
      chatId: '123@s.whatsapp.net',
      chatName: 'פרוייקט AI פרופלר דרונס',
      messageId: 'message-1',
      sender: '123@s.whatsapp.net',
      senderName: 'Eran',
      fromMe: false,
      timestamp: 1_700_000_000,
      messageType: 'conversation',
      text: 'hello',
      mimeType: null,
      mediaStatus: null,
      mediaPath: null,
      mediaSha256: null,
      mediaBytes: null
    };
    assert.equal(archive.saveMessage(message).inserted, true);
    assert.equal(archive.saveMessage(message).inserted, false);
    assert.equal(archive.messagesForChat(message.chatId).length, 1);
    assert.equal(archive.resolveChat('פרופלר').id, message.chatId);
  } finally {
    archive.close();
    await rm(directory, { recursive: true, force: true });
  }
});
