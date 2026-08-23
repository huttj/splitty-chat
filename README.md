# splitty

Experimental async video messaging where replies interject *in the moment*.

Record a video note. Friends open a secret chat URL, watch it with a live word-highlighted
transcript, and can hit record at any point — playback pauses, they record their reply,
and playback resumes. Replies are anchored to the exact word they interrupted at, so the
transcript splits and the conversation reads (and plays back) like it happened live.

**Live at [splitty.chat](https://splitty.chat)** · runs entirely on Cloudflare.

## Stack

| Piece | Service |
|---|---|
| App + API | Cloudflare Worker (`src/worker.js`) + static assets (`public/`) |
| Video storage | R2 (`splitty-media`) |
| Chats + messages | D1 (`splitty`, schema in `schema.sql`) |
| Transcription | Workers AI `@cf/openai/whisper-large-v3-turbo` (word-level timestamps) |

The client records two tracks per note: the full video (stored in R2, served with Range
support for seeking) and a small audio-only track that gets sent to Workers AI for
transcription. With the camera off (header toggle), a note is a single audio file — the
same pipeline, the stored file is just audio and the server transcribes it in place; the
stage shows a sound-driven visualizer instead of a picture. Uploaded video *and* audio
files post the same way.

## Develop

```sh
npm install
npm run db:migrate:local   # once, sets up the local D1 simulator
npm run dev                # http://localhost:8787 (AI calls hit Cloudflare for real)
```

## Deploy

Merging to `main` deploys automatically via GitHub Actions
(`.github/workflows/deploy.yml`). It needs two repo secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN` — create at dash.cloudflare.com → My Profile → API Tokens →
  "Edit Cloudflare Workers" template, plus **D1: Edit** (for schema migrations)

Manual deploy: `npm run deploy`. Schema changes: edit `schema.sql`
(keep statements idempotent — `IF NOT EXISTS` / additive) and run `npm run db:migrate`.

## How it works

- **Chats** are unguessable slugs (`/c/abc123…`). Anyone with the link joins by typing a name.
- **Messages** are video files + a word-timestamped transcript. An interjection stores
  `parentId` + `anchorMs` (where in the parent it interrupted).
- **Playback** flattens the message tree into segments: parent up to the anchor → the
  interjection (recursively) → parent resumes. Tap any word to start there.
- **"New" highlighting** is per-browser: localStorage tracks how far into each message
  you've listened; words beyond that glow until you play them.

## Not built yet (on purpose)

- Dragging interjections to fine-tune anchor timing
- Real auth (SMS / Google) — name-only is deliberate for now
- Push/live updates (currently polls every 2.5s)
