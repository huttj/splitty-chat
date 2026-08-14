// splitty — Cloudflare Worker: D1 (messages) + R2 (video) + Workers AI (transcription)

const slug = (n = 12) => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return [...bytes].map(b => chars[b & 63]).join('');
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const sameAuthor = (a, b) => (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();

// ---------- auth ----------
const getCookie = (request, name) => {
  const m = (request.headers.get('Cookie') || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
};
const SESSION_COOKIE = sid => `sid=${sid}; HttpOnly; Secure; Path=/; Max-Age=31536000; SameSite=Lax`;
const safePath = p => (p && p.startsWith('/') && !p.startsWith('//') ? p : '/');

const providers = env => ({
  google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
  email: !!(env.EMAIL && env.EMAIL_FROM),
});
// until at least one provider is configured, the app stays in legacy name-only mode
const authEnabled = env => Object.values(providers(env)).some(Boolean);

async function getUser(request, env) {
  const sid = getCookie(request, 'sid');
  if (!sid) return null;
  return await env.DB.prepare(
    'SELECT u.id, u.name, u.email, u.status, u.picture FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.sid = ?'
  ).bind(sid).first();
}

async function createSession(env, userId) {
  const sid = slug(24);
  await env.DB.prepare('INSERT INTO sessions (sid, user_id, created_at) VALUES (?, ?, ?)')
    .bind(sid, userId, Date.now()).run();
  return sid;
}

async function sendEmail(env, to, subject, html) {
  if (!env.EMAIL || !env.EMAIL_FROM) return false;
  try {
    await env.EMAIL.send({
      to,
      from: env.EMAIL_FROM,
      subject,
      html,
      text: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    });
    return true;
  } catch (err) {
    console.error('sendEmail failed:', String(err));
    return false;
  }
}

// login/link resolution: an existing identity wins; otherwise attach to the
// signed-in user (explicit account linking); otherwise to a user with the same
// verified email; otherwise create a fresh pending account and notify the admin
async function resolveUser(env, ctx, request, { provider, subject, email, name, picture, origin }) {
  const ident = await env.DB.prepare('SELECT user_id FROM identities WHERE provider = ? AND subject = ?')
    .bind(provider, subject).first();
  if (ident) {
    if (picture) {
      await env.DB.prepare('UPDATE users SET picture = ? WHERE id = ?').bind(picture, ident.user_id).run();
    }
    return await env.DB.prepare('SELECT id, name, email, status, picture FROM users WHERE id = ?')
      .bind(ident.user_id).first();
  }
  let user = await getUser(request, env);
  if (!user && email) {
    user = await env.DB.prepare('SELECT id, name, email, status, picture FROM users WHERE email IS NOT NULL AND lower(email) = lower(?)')
      .bind(email).first();
  }
  if (user && picture && !user.picture) {
    await env.DB.prepare('UPDATE users SET picture = ? WHERE id = ?').bind(picture, user.id).run();
  }
  if (!user) {
    user = {
      id: slug(12),
      name: String(name || (email || 'someone').split('@')[0]).slice(0, 40),
      email: email || null,
      status: 'pending',
      picture: picture || null,
    };
    await env.DB.prepare('INSERT INTO users (id, name, email, status, picture, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(user.id, user.name, user.email, user.status, user.picture, Date.now()).run();
    for (const admin of (env.ADMIN_EMAIL || '').split(',').map(s => s.trim()).filter(Boolean)) {
      ctx.waitUntil(sendEmail(env, admin, `${user.name} just joined splitty.chat`,
        `<p><b>${user.name}</b> (${user.email || provider}) just signed up. They can send one message until approved.</p>
         <p><a href="${origin}/admin">Approve or block them</a></p>`));
    }
  }
  await env.DB.prepare('INSERT OR IGNORE INTO identities (provider, subject, user_id, created_at) VALUES (?, ?, ?, ?)')
    .bind(provider, subject, user.id, Date.now()).run();
  return user;
}

const redirectWithSession = (sid, to) =>
  new Response(null, { status: 302, headers: { Location: to, 'Set-Cookie': SESSION_COOKIE(sid) } });

const blockedPage = () =>
  new Response('This account has been blocked.', { status: 403, headers: { 'Content-Type': 'text/plain' } });

// account-stamped messages belong to the account; legacy rows fall back to name match
async function ownsMessage(request, env, row, claimedAuthor) {
  if (row.user_id) {
    const user = await getUser(request, env);
    return !!user && user.id === row.user_id;
  }
  return sameAuthor(claimedAuthor, row.author);
}

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
  gain: r.gain ?? 1,
  picture: r.picture || null,
});

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    let m;

    try {
      // ---- auth routes ----
      if (pathname === '/api/me' && request.method === 'GET') {
        const user = await getUser(request, env);
        return json({ user, providers: providers(env), authEnabled: authEnabled(env) });
      }

      if (pathname === '/auth/logout' && request.method === 'POST') {
        const sid = getCookie(request, 'sid');
        if (sid) await env.DB.prepare('DELETE FROM sessions WHERE sid = ?').bind(sid).run();
        return new Response(null, {
          status: 302,
          headers: { Location: '/', 'Set-Cookie': 'sid=; HttpOnly; Secure; Path=/; Max-Age=0; SameSite=Lax' },
        });
      }

      if (pathname === '/auth/google' && request.method === 'GET') {
        if (!providers(env).google) return json({ error: 'google not configured' }, 503);
        const stateTok = slug(16);
        const next = safePath(url.searchParams.get('next'));
        const params = new URLSearchParams({
          client_id: env.GOOGLE_CLIENT_ID,
          redirect_uri: `${url.origin}/auth/google/callback`,
          response_type: 'code',
          scope: 'openid email profile',
          state: `${stateTok}:${next}`,
          prompt: 'select_account',
        });
        return new Response(null, {
          status: 302,
          headers: {
            Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
            'Set-Cookie': `oauth_state=${stateTok}; HttpOnly; Secure; Path=/; Max-Age=600; SameSite=Lax`,
          },
        });
      }

      if (pathname === '/auth/google/callback' && request.method === 'GET') {
        const [stateTok, ...nextParts] = (url.searchParams.get('state') || '').split(':');
        if (!stateTok || stateTok !== getCookie(request, 'oauth_state')) {
          return new Response('State mismatch — please try signing in again.', { status: 400 });
        }
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code: url.searchParams.get('code') || '',
            client_id: env.GOOGLE_CLIENT_ID,
            client_secret: env.GOOGLE_CLIENT_SECRET,
            redirect_uri: `${url.origin}/auth/google/callback`,
            grant_type: 'authorization_code',
          }),
        });
        if (!tokenRes.ok) return new Response('Google sign-in failed.', { status: 502 });
        const tokens = await tokenRes.json();
        // id_token payload (base64url JSON) — verified implicitly by the direct code exchange
        const claims = JSON.parse(atob(tokens.id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        const user = await resolveUser(env, ctx, request, {
          provider: 'google',
          subject: claims.sub,
          email: claims.email_verified ? claims.email : null,
          name: claims.name,
          picture: claims.picture || null,
          origin: url.origin,
        });
        if (user.status === 'blocked') return blockedPage();
        const sid = await createSession(env, user.id);
        return redirectWithSession(sid, safePath(nextParts.join(':')));
      }

      if (pathname === '/auth/email' && request.method === 'POST') {
        if (!providers(env).email) return json({ error: 'email not configured' }, 503);
        const { email, next } = await request.json();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'invalid email' }, 400);
        const token = slug(24);
        await env.DB.prepare('INSERT INTO login_tokens (token, email, created_at) VALUES (?, ?, ?)')
          .bind(token, email.trim(), Date.now()).run();
        const link = `${url.origin}/auth/email/verify?token=${token}&next=${encodeURIComponent(safePath(next))}`;
        const sent = await sendEmail(env, email.trim(), 'Sign in to splitty.chat',
          `<p>Tap to sign in — this link works once and expires in 15 minutes.</p>
           <p><a href="${link}">Sign in to splitty.chat</a></p>`);
        return json({ ok: sent });
      }

      if (pathname === '/auth/email/verify' && request.method === 'GET') {
        const token = url.searchParams.get('token') || '';
        const row = await env.DB.prepare('SELECT email, created_at FROM login_tokens WHERE token = ?')
          .bind(token).first();
        if (row) await env.DB.prepare('DELETE FROM login_tokens WHERE token = ?').bind(token).run(); // single use
        if (!row || Date.now() - row.created_at > 15 * 60 * 1000) {
          return new Response('That sign-in link is expired or already used. Request a new one.', { status: 400 });
        }
        const user = await resolveUser(env, ctx, request, {
          provider: 'email',
          subject: row.email.toLowerCase(),
          email: row.email,
          name: null,
          picture: null,
          origin: url.origin,
        });
        if (user.status === 'blocked') return blockedPage();
        const sid = await createSession(env, user.id);
        return redirectWithSession(sid, safePath(url.searchParams.get('next')));
      }

      if (pathname === '/api/chats' && request.method === 'POST') {
        if (authEnabled(env)) {
          const user = await getUser(request, env);
          if (!user) return json({ error: 'sign in to create a chat', code: 'auth' }, 401);
          if (user.status === 'blocked') return json({ error: 'your account is blocked', code: 'blocked' }, 403);
        }
        const id = slug(12);
        await env.DB.prepare('INSERT INTO chats (id, created_at) VALUES (?, ?)')
          .bind(id, Date.now()).run();
        return json({ id });
      }

      // participant info for the landing page's "your chats" list
      if (pathname === '/api/chats/lookup' && request.method === 'POST') {
        const { ids } = await request.json();
        if (!Array.isArray(ids)) return json({ error: 'bad request' }, 400);
        const out = [];
        for (const id of ids.slice(0, 30)) {
          if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) continue;
          const chat = await env.DB.prepare('SELECT id FROM chats WHERE id = ?').bind(id).first();
          if (!chat) { out.push({ id, exists: false }); continue; }
          const { results } = await env.DB
            .prepare('SELECT id, author, duration_ms, created_at FROM messages WHERE chat_id = ?')
            .bind(id).all();
          out.push({
            id,
            exists: true,
            participants: [...new Set(results.map(r => r.author))],
            count: results.length,
            lastActivity: results.reduce((a, r) => Math.max(a, r.created_at), 0) || null,
            messages: results.map(r => ({ id: r.id, author: r.author, durationMs: r.duration_ms })),
          });
        }
        return json({ chats: out });
      }

      // ---- admin (password-protected) ----
      if (pathname.startsWith('/api/admin/')) {
        if (!env.ADMIN_PASSWORD) return json({ error: 'admin not configured' }, 503);
        if (request.headers.get('Authorization') !== `Bearer ${env.ADMIN_PASSWORD}`) {
          return json({ error: 'unauthorized' }, 401);
        }
      }

      if (pathname === '/api/admin/chats' && request.method === 'GET') {
        const { results: chats } = await env.DB.prepare(
          `SELECT c.id, c.created_at, COUNT(m.id) AS n, MAX(m.created_at) AS last
           FROM chats c LEFT JOIN messages m ON m.chat_id = c.id
           GROUP BY c.id ORDER BY COALESCE(MAX(m.created_at), c.created_at) DESC`
        ).all();
        const { results: parts } = await env.DB
          .prepare('SELECT DISTINCT chat_id, author FROM messages').all();
        const byChat = {};
        for (const p of parts) (byChat[p.chat_id] ??= []).push(p.author);
        return json({
          chats: chats.map(c => ({
            id: c.id,
            createdAt: c.created_at,
            count: c.n,
            lastActivity: c.last,
            participants: byChat[c.id] || [],
          })),
        });
      }

      if (pathname === '/api/admin/users' && request.method === 'GET') {
        const { results } = await env.DB.prepare(
          `SELECT u.id, u.name, u.email, u.status, u.picture, u.created_at, COUNT(msg.id) AS n,
                  GROUP_CONCAT(DISTINCT i.provider) AS provs
           FROM users u
           LEFT JOIN messages msg ON msg.user_id = u.id
           LEFT JOIN identities i ON i.user_id = u.id
           GROUP BY u.id ORDER BY u.created_at DESC`
        ).all();
        return json({
          users: results.map(u => ({
            id: u.id, name: u.name, email: u.email, status: u.status, picture: u.picture,
            createdAt: u.created_at, messages: u.n, providers: (u.provs || '').split(',').filter(Boolean),
          })),
        });
      }

      if ((m = pathname.match(/^\/api\/admin\/users\/([A-Za-z0-9_-]+)$/)) && request.method === 'PATCH') {
        const { status } = await request.json();
        if (!['approved', 'pending', 'blocked'].includes(status)) return json({ error: 'bad status' }, 400);
        await env.DB.prepare('UPDATE users SET status = ? WHERE id = ?').bind(status, m[1]).run();
        if (status === 'blocked') {
          await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(m[1]).run(); // sign them out everywhere
        }
        return json({ ok: true });
      }

      if ((m = pathname.match(/^\/api\/admin\/chats\/([A-Za-z0-9_-]+)$/)) && request.method === 'DELETE') {
        const { results } = await env.DB
          .prepare('SELECT video_key FROM messages WHERE chat_id = ?').bind(m[1]).all();
        const keys = results.map(r => r.video_key);
        for (let i = 0; i < keys.length; i += 1000) {
          await env.MEDIA.delete(keys.slice(i, i + 1000));
        }
        await env.DB.prepare('DELETE FROM messages WHERE chat_id = ?').bind(m[1]).run();
        await env.DB.prepare('DELETE FROM chats WHERE id = ?').bind(m[1]).run();
        return json({ ok: true, deletedVideos: keys.length });
      }

      if ((m = pathname.match(/^\/api\/chats\/([A-Za-z0-9_-]+)$/)) && request.method === 'GET') {
        const chat = await env.DB.prepare('SELECT * FROM chats WHERE id = ?').bind(m[1]).first();
        if (!chat) return json({ error: 'not found' }, 404);
        const { results } = await env.DB
          .prepare(`SELECT msg.*, u.picture FROM messages msg
                    LEFT JOIN users u ON u.id = msg.user_id
                    WHERE msg.chat_id = ? ORDER BY msg.created_at`)
          .bind(m[1]).all();
        return json({
          chat: { id: chat.id, createdAt: chat.created_at },
          messages: results.map(rowToMessage),
        });
      }

      if ((m = pathname.match(/^\/api\/chats\/([A-Za-z0-9_-]+)\/messages$/)) && request.method === 'POST') {
        return await createMessage(request, env, ctx, m[1]);
      }

      // re-anchor an interjection (drag-to-move the split point) — author only
      if ((m = pathname.match(/^\/api\/chats\/([A-Za-z0-9_-]+)\/messages\/([A-Za-z0-9_-]+)$/)) && request.method === 'PATCH') {
        const row = await env.DB.prepare('SELECT parent_id, author, user_id FROM messages WHERE id = ? AND chat_id = ?')
          .bind(m[2], m[1]).first();
        if (!row) return json({ error: 'not found' }, 404);
        if (!row.parent_id) return json({ error: 'not an interjection' }, 400);
        const body = await request.json();
        if (!(await ownsMessage(request, env, row, body.author))) return json({ error: 'only the author can move this' }, 403);
        const anchorMs = Math.max(0, Math.round(Number(body.anchorMs) || 0));
        await env.DB.prepare('UPDATE messages SET anchor_ms = ? WHERE id = ?').bind(anchorMs, m[2]).run();
        return json({ ok: true, anchorMs });
      }

      // delete own message; its interjections fall onto its spot in the parent
      if ((m = pathname.match(/^\/api\/chats\/([A-Za-z0-9_-]+)\/messages\/([A-Za-z0-9_-]+)$/)) && request.method === 'DELETE') {
        const row = await env.DB
          .prepare('SELECT author, user_id, parent_id, anchor_ms, video_key FROM messages WHERE id = ? AND chat_id = ?')
          .bind(m[2], m[1]).first();
        if (!row) return json({ error: 'not found' }, 404);
        const body = await request.json();
        if (!(await ownsMessage(request, env, row, body.author))) return json({ error: 'only the author can delete this' }, 403);
        if (row.parent_id) {
          await env.DB.prepare('UPDATE messages SET parent_id = ?, anchor_ms = ? WHERE parent_id = ?')
            .bind(row.parent_id, row.anchor_ms, m[2]).run();
        } else {
          await env.DB.prepare('UPDATE messages SET parent_id = NULL, anchor_ms = NULL WHERE parent_id = ?')
            .bind(m[2]).run();
        }
        await env.MEDIA.delete(row.video_key);
        await env.DB.prepare('DELETE FROM messages WHERE id = ?').bind(m[2]).run();
        return json({ ok: true });
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

  // approvals only apply once auth is configured; name-only mode stays open
  let user = null;
  if (authEnabled(env)) {
    user = await getUser(request, env);
    if (!user) return json({ error: 'sign in to send messages', code: 'auth' }, 401);
    if (user.status === 'blocked') return json({ error: 'your account is blocked', code: 'blocked' }, 403);
    if (user.status === 'pending') {
      const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE user_id = ?')
        .bind(user.id).first();
      if (n >= 1) {
        return json({ error: 'you can send one message until an admin approves you — hang tight', code: 'pending' }, 403);
      }
    }
  }

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
    userId: user?.id || null,
    author: String((user?.name || form.get('author')) || 'anon').slice(0, 40),
    file: videoKey,
    mime,
    parentId,
    anchorMs: parentId ? Math.max(0, Number(form.get('anchorMs')) || 0) : null,
    durationMs: Number(form.get('durationMs')) || null,
    gain: Math.min(Math.max(Number(form.get('gain')) || 1, 0.25), 4),
    createdAt: Date.now(),
    text: '',
    words: [],
    transcriptStatus: 'pending',
  };

  await env.DB.prepare(
    `INSERT INTO messages (id, chat_id, user_id, author, video_key, mime, parent_id, anchor_ms, duration_ms, gain, created_at, transcript_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
  ).bind(msg.id, msg.chatId, msg.userId, msg.author, msg.file, msg.mime, msg.parentId, msg.anchorMs, msg.durationMs, msg.gain, msg.createdAt).run();

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
