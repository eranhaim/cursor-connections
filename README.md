# Personal WhatsApp archive connector

Read-only archive service for one personally authorized WhatsApp account. It pairs as a WhatsApp linked device, stores the messages WhatsApp Web makes available, and downloads accessible image, video, audio, and document attachments.

It does not send messages, update chat state, add contacts, or expose a web endpoint.

## Library choice

This connector uses `@whiskeysockets/baileys` `7.0.0-rc14`.

At implementation time, its npm package was published on 2026-07-29, the official WhiskeySockets repository documented full-history sync through `syncFullHistory: true` and `messaging-history.set`, and it directly supports streamed media downloads. It does not need Chromium.

`whatsapp-web.js` is also maintained (its `1.34.7` release was published 2026-04-24), but it depends on Puppeteer/Chromium. That adds browser dependencies, sandbox flags, and a frequent Docker failure surface without improving this archive use case. Baileys is therefore the more reliable headless VPS choice, though it is an unofficial WhatsApp Web protocol library and can break when WhatsApp changes the protocol.

## Critical history limitation

This cannot guarantee recovery of all past WhatsApp history or media. WhatsApp decides what a newly linked multi-device client receives. The available range varies by account, chat, retention, device state, and media availability. The archive's `coverage` command reports what actually arrived. A message can arrive while its old media has expired or cannot be re-uploaded; that record is retained with media status `unavailable`.

## Data and security

Only two writable directories exist:

```text
data/auth/                 Linked-device credentials
data/archive/archive.sqlite  Message metadata and text
data/archive/media/        Original downloaded media, content-addressed by SHA-256
```

They are gitignored. The container runs with a read-only root filesystem; only these bind mounts and a private temporary filesystem are writable. No port is published. Logs never include message text, captions, media contents, session keys, or raw QR values. The terminal QR visual is intentionally shown only while pairing.

Set a per-file limit before first run:

```sh
cp .env.example .env
# Edit MAX_MEDIA_MB if 100 MB is not appropriate.
```

## Deploy and pair

```sh
docker compose up -d --build
docker compose logs -f connector
```

When the QR visual appears, scan it in WhatsApp: **Settings → Linked devices → Link a device**. The link persists in `data/auth/`, so normal restarts do not require scanning again.

If WhatsApp logs the device out, stop the stack, remove `data/auth/`, then start it and scan a new QR:

```sh
docker compose down
rm -rf data/auth
docker compose up -d
docker compose logs -f connector
```

Do not delete `data/archive/` unless you deliberately want to erase the archive.

## Read-only archive commands

Run commands from this project directory. Results are emitted as JSON except exports.

```sh
# Connection state. `containerHealthy` only means the service started.
# Check `accountConnected` to confirm the WhatsApp account is linked.
docker compose exec -T connector node dist/cli.js status

# Every stored chat, including oldest/newest accessible message and counts.
docker compose exec -T connector node dist/cli.js coverage

# Search chat names or chat IDs. Hebrew Unicode is supported.
docker compose exec -T connector node dist/cli.js chats "פרוייקט AI פרופלר דרונס"

# Export one unambiguous chat. If search returns several rows, use its exact id.
docker compose exec -T connector node dist/cli.js export "פרוייקט AI פרופלר דרונס" --format markdown > data/archive/propeller.md
docker compose exec -T connector node dist/cli.js export "פרוייקט AI פרופלר דרונס" --format jsonl > data/archive/propeller.jsonl

# List archived media records and their paths relative to data/archive/.
docker compose exec -T connector node dist/cli.js media "פרוייקט AI פרופלר דרונס"
```

Media files are directly available on the VPS under `data/archive/media/`. The media listing includes their SHA-256 content hash, MIME type, size, linked chat/message, and relative path. Markdown and JSONL exports preserve that local media reference.

## Status meanings

* `qr_required` — container is working but needs a linked-device scan.
* `connecting` — establishing the WhatsApp Web session.
* `connected` — paired; waits for live messages and history events.
* `syncing` — processing an accessible history batch.
* `disconnected` — reconnect is pending or WhatsApp logged out.

Docker health is deliberately separate from account state: the health command succeeds only after the service creates a status file, but its output exposes `accountConnected: false` until pairing completes.

## Local verification

```sh
npm ci
npm run check
npm test
docker compose config
```

The test confirms idempotent message storage. Actual WhatsApp history and media retrieval can only be verified after the account owner scans the QR.
