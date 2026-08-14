// splitty — Cloudflare Worker: D1 (messages) + R2 (video) + Workers AI (transcription)

const slug = (n = 12) => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return [...bytes].map(b => chars[b & 63]).join('');
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const rowToMessage = r => ({
  id: r.id,
  chatId: r.chat_id,
  author: r.author,
  file: r.video_key,
  mime: r.mime,
  parentId: r.parent_id,
  anchorMs: r.anchor_ms,
  durationMs: r.duration_ms,
  createdAt: r.created_at,
  text: r.text,
  words: JSON.parse(r.words || '[]'),
  transcriptStatus: r.transcript_status,
});

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname === '/api/chats' && request.method === 'POST') {
        const id = slug(12);
        await env.DB.prepare('INSERT INTO chats (id, created_at) VALUES (?, ?)')
          .bind(id, Date.now()).run();
        return json({ id });
      }

      let m;
      if ((m = pathname.match(/^\/api\/chats\/([A-Za-z0-9_-]+)$/)) && request.method === 'GET') {
        const chat = await env.DB.prepare('SELECT * FROM chats WHERE id = ?').bind(m[1]).first();
        if (!chat) return json({ error: 'not found' }, 404);
        const { results } = await env.DB
          .prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at')
          .bind(m[1]).all();
        return json({
          chat: { id: chat.id, createdAt: chat.created_at },
          messages: results.map(rowToMessage),
        });
      }

      if ((m = pathname.match(/^\/api\/chats\/([A-Za-z0-9_-]+)\/messages$/)) && request.method === 'POST') {
        return await createMessage(request, env, ctx, m[1]);
      }

      // re-anchor an interjection (drag-to-move the split point)
      if ((m = pathname.match(/^\/api\/chats\/([A-Za-z0-9_-]+)\/messages\/([A-Za-z0-9_-]+)$/)) && request.method === 'PATCH') {
        const row = await env.DB.prepare('SELECT parent_id FROM messages WHERE id = ? AND chat_id = ?')
          .bind(m[2], m[1]).first();
        if (!row) return json({ error: 'not found' }, 404);
        if (!row.parent_id) return json({ error: 'not an interjection' }, 400);
        const body = await request.json();
        const anchorMs = Math.max(0, Math.round(Number(body.anchorMs) || 0));
        await env.DB.prepare('UPDATE messages SET anchor_ms = ? WHERE id = ?').bind(anchorMs, m[2]).run();
        return json({ ok: true, anchorMs });
      }

      if ((m = pathname.match(/^\/media\/([A-Za-z0-9_.-]+)$/)) && (request.method === 'GET' || request.method === 'HEAD')) {
        return await serveMedia(request, env, m[1]);
      }

      return json({ error: 'not found' }, 404);
    } catch (err) {
      console.error(err.stack || String(err));
      return json({ error: 'server error' }, 500);
    }
  },
};

async function createMessage(request, env, ctx, chatId) {
  const chat = await env.DB.prepare('SELECT id FROM chats WHERE id = ?').bind(chatId).first();
  if (!chat) return json({ error: 'not found' }, 404);

  const form = await request.formData();
  const video = form.get('video');
  const audio = form.get('audio'); // small audio-only track for transcription
  if (!(video instanceof File)) return json({ error: 'missing video' }, 400);

  const mime = (video.type || 'video/webm').split(';')[0];
  const ext = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' }[mime] || 'webm';
  const videoKey = `${slug(16)}.${ext}`;

  await env.MEDIA.put(videoKey, video.stream(), { httpMetadata: { contentType: mime } });

  const parentId = form.get('parentId') || null;
  const msg = {
    id: slug(12),
    chatId,
    author: String(form.get('author') || 'anon').slice(0, 40),
    file: videoKey,
    mime,
    parentId,
    anchorMs: parentId ? Math.max(0, Number(form.get('anchorMs')) || 0) : null,
    durationMs: Number(form.get('durationMs')) || null,
    createdAt: Date.now(),
    text: '',
    words: [],
    transcriptStatus: 'pending',
  };

  await env.DB.prepare(
    `INSERT INTO messages (id, chat_id, author, video_key, mime, parent_id, anchor_ms, duration_ms, created_at, transcript_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
  ).bind(msg.id, msg.chatId, msg.author, msg.file, msg.mime, msg.parentId, msg.anchorMs, msg.durationMs, msg.createdAt).run();

  // transcribe after the response goes out; client polls for the result
  const transcriptSource = audio instanceof File && audio.size > 0 ? audio : video;
  const buf = await transcriptSource.arrayBuffer();
  ctx.waitUntil(transcribe(env, msg.id, buf));

  return json({ message: msg });
}

async function transcribe(env, messageId, audioBuf) {
  let status = 'failed', text = '', words = [];
  try {
    const out = await env.AI.run('@cf/openai/whisper-large-v3-turbo', { audio: toBase64(audioBuf) });
    text = (out.text || '').trim();
    const raw = out.words?.length
      ? out.words
      : (out.segments || []).flatMap(s => s.words || []);
    words = raw
      .filter(w => w.word != null && w.start != null && w.end != null)
      .map(w => ({ w: String(w.word).trim(), s: w.start, e: w.end }));
    status = 'done';
  } catch (err) {
    console.error(`transcription failed for ${messageId}:`, String(err));
  }
  await env.DB.prepare('UPDATE messages SET text = ?, words = ?, transcript_status = ? WHERE id = ?')
    .bind(text, JSON.stringify(words), status, messageId).run();
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

async function serveMedia(request, env, key) {
  const rangeHeader = request.headers.get('Range');
  let range = null;
  if (rangeHeader) {
    const rm = rangeHeader.match(/bytes=(\d*)-(\d*)/);
    if (rm && rm[1] !== '') {
      const offset = Number(rm[1]);
      range = rm[2] !== '' ? { offset, length: Number(rm[2]) - offset + 1 } : { offset };
    } else if (rm && rm[2] !== '') {
      range = { suffix: Number(rm[2]) };
    }
  }

  const obj = await env.MEDIA.get(key, range ? { range } : undefined);
  if (!obj) return new Response('not found', { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('ETag', obj.httpEtag);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'public, max-age=31536000, immutable'); // keys are content-unique

  if (range) {
    const offset = range.suffix != null ? obj.size - range.suffix : range.offset;
    const length = range.suffix != null ? range.suffix : (range.length ?? obj.size - range.offset);
    headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    headers.set('Content-Length', String(length));
    return new Response(request.method === 'HEAD' ? null : obj.body, { status: 206, headers });
  }
  headers.set('Content-Length', String(obj.size));
  return new Response(request.method === 'HEAD' ? null : obj.body, { status: 200, headers });
}
