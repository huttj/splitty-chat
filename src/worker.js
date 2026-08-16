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

const isAdmin = (env, user) =>
  !!user?.email &&
  (env.ADMIN_EMAIL || '').toLowerCase().split(',').map(s => s.trim()).includes(user.email.toLowerCase());

// account-stamped messages belong to the account; legacy rows fall back to name match
const ownsMessage = (user, row, claimedAuthor) =>
  row.user_id ? !!user && user.id === row.user_id : sameAuthor(claimedAuthor, row.author);

// ---------- roles & chat access ----------
// editor: reorder/delete anything, invite people, flip visibility
// commenter: record + move their own messages
// viewer: watch only
const ROLE_RANK = { viewer: 1, commenter: 2, editor: 3 };
const roleAtLeast = (role, min) => (ROLE_RANK[role] || 0) >= ROLE_RANK[min];
const validRole = r => Object.hasOwn(ROLE_RANK, r);

// Resolve what `user` may do in `chat`. role === null means no access at all.
// An unconsumed invite token grants read-only viewing (the "peek before you
// sign up" path); consuming it is a separate explicit step.
async function chatAccess(env, user, chat, inviteToken) {
  if (!authEnabled(env)) return { user, role: 'editor', isOwner: true }; // name-only dev mode stays open
  if (user?.status === 'blocked') return { user, role: null, isOwner: false };
  if (user && isAdmin(env, user)) return { user, role: 'editor', isOwner: user.id === chat.owner_id };
  if (!chat.owner_id) {
    // legacy chat from before access control — open like it always was
    return { user, role: user ? 'commenter' : 'viewer', isOwner: false };
  }
  if (user) {
    if (user.id === chat.owner_id) return { user, role: 'editor', isOwner: true };
    const mem = await env.DB.prepare('SELECT role FROM chat_members WHERE chat_id = ? AND user_id = ?')
      .bind(chat.id, user.id).first();
    if (mem) return { user, role: mem.role, isOwner: false };
  }
  if ((chat.visibility || 'private') === 'public') return { user, role: 'viewer', isOwner: false };
  if (inviteToken) {
    const inv = await env.DB.prepare('SELECT used_by FROM invites WHERE token = ? AND chat_id = ?')
      .bind(inviteToken, chat.id).first();
    if (inv && !inv.used_by) return { user, role: 'viewer', isOwner: false, viaInvite: true };
  }
  return { user, role: null, isOwner: false };
}

// everyone who should see editor-level alerts for a chat (owner + editors)
async function chatEditorIds(env, chat) {
  const { results } = await env.DB.prepare(
    "SELECT user_id FROM chat_members WHERE chat_id = ? AND role = 'editor'").bind(chat.id).all();
  const ids = new Set(results.map(r => r.user_id));
  if (chat.owner_id) ids.add(chat.owner_id);
  return [...ids];
}

// add (or upgrade) a member, clear any pending access request, tell them
async function addMember(env, chat, userId, role, addedBy) {
  await env.DB.prepare(
    'INSERT INTO chat_members (chat_id, user_id, role, added_by, created_at) VALUES (?, ?, ?, ?, ?) ' +
    'ON CONFLICT (chat_id, user_id) DO UPDATE SET role = excluded.role, added_by = excluded.added_by'
  ).bind(chat.id, userId, role, addedBy?.id || null, Date.now()).run();
  await env.DB.prepare('DELETE FROM access_requests WHERE chat_id = ? AND user_id = ?')
    .bind(chat.id, userId).run();
  if (addedBy && addedBy.id !== userId) {
    await pushToUsers(env, [userId], {
      title: 'splitty',
      body: `${addedBy.name} added you to a chat as ${role}`,
      url: `/c/${chat.id}`,
      tag: `chat-${chat.id}`,
    });
  }
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
  screenKey: r.screen_key || null,
  layer: r.layer_user_id || null,
  userId: r.user_id || null,
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
        return json({
          user,
          providers: providers(env),
          authEnabled: authEnabled(env),
          isAdmin: isAdmin(env, user),
          pushKey: pushEnabled(env) ? vapidPublicKey(env) : null,
        });
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
        let user = null;
        if (authEnabled(env)) {
          user = await getUser(request, env);
          if (!user) return json({ error: 'sign in to create a chat', code: 'auth' }, 401);
          if (user.status === 'blocked') return json({ error: 'your account is blocked', code: 'blocked' }, 403);
        }
        const id = slug(12);
        // private by default; the creator is the owner and an editor-member
        await env.DB.prepare("INSERT INTO chats (id, created_at, owner_id, visibility) VALUES (?, ?, ?, 'private')")
          .bind(id, Date.now(), user?.id || null).run();
        if (user) {
          await env.DB.prepare(
            "INSERT INTO chat_members (chat_id, user_id, role, added_by, created_at) VALUES (?, ?, 'editor', ?, ?)"
          ).bind(id, user.id, user.id, Date.now()).run();
        }
        return json({ id });
      }

      // participant info for the landing page's "your chats" list
      if (pathname === '/api/chats/lookup' && request.method === 'POST') {
        const { ids } = await request.json();
        if (!Array.isArray(ids)) return json({ error: 'bad request' }, 400);
        const lookupUser = await getUser(request, env);
        const out = [];
        for (const id of ids.slice(0, 30)) {
          if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) continue;
          const chat = await env.DB.prepare('SELECT * FROM chats WHERE id = ?').bind(id).first();
          if (!chat) { out.push({ id, exists: false }); continue; }
          if (!(await chatAccess(env, lookupUser, chat)).role) {
            out.push({ id, exists: true, private: true });
            continue;
          }
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

      // ---- admin (session-gated: signed-in accounts on the ADMIN_EMAIL list) ----
      if (pathname.startsWith('/api/admin/')) {
        const user = await getUser(request, env);
        if (!isAdmin(env, user)) return json({ error: 'admins only' }, user ? 403 : 401);
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
          .prepare('SELECT video_key, screen_key, audio_key FROM messages WHERE chat_id = ?').bind(m[1]).all();
        const keys = results.flatMap(r => [r.video_key, r.screen_key, r.audio_key]).filter(Boolean);
        for (let i = 0; i < keys.length; i += 1000) {
          await env.MEDIA.delete(keys.slice(i, i + 1000));
        }
        await env.DB.prepare('DELETE FROM messages WHERE chat_id = ?').bind(m[1]).run();
        await env.DB.prepare('DELETE FROM chat_members WHERE chat_id = ?').bind(m[1]).run();
        await env.DB.prepare('DELETE FROM invites WHERE chat_id = ?').bind(m[1]).run();
        await env.DB.prepare('DELETE FROM access_requests WHERE chat_id = ?').bind(m[1]).run();
        await env.DB.prepare('DELETE FROM chats WHERE id = ?').bind(m[1]).run();
        return json({ ok: true, deletedVideos: keys.length });
      }

      if ((m = pathname.match(/^\/api\/chats\/([A-Za-z0-9_-]+)$/)) && request.method === 'GET') {
        const chat = await env.DB.prepare('SELECT * FROM chats WHERE id = ?').bind(m[1]).first();
        if (!chat) return json({ error: 'not found' }, 404);
        const user = await getUser(request, env);
        const access = await chatAccess(env, user, chat, url.searchParams.get('invite'));
        if (!access.role) {
          if (!user) return json({ error: 'sign in to view this chat', code: 'auth' }, 401);
          const req = await env.DB.prepare('SELECT 1 AS x FROM access_requests WHERE chat_id = ? AND user_id = ?')
            .bind(chat.id, user.id).first();
          return json({ error: 'this chat is private', code: 'private', requested: !!req }, 403);
        }
        const { results: allRows } = await env.DB
          .prepare(`SELECT msg.*, u.picture FROM messages msg
                    LEFT JOIN users u ON u.id = msg.user_id
                    WHERE msg.chat_id = ? ORDER BY msg.created_at`)
          .bind(m[1]).all();
        // comment layers are private-ish: editors see them all, everyone else
        // only their own; the base conversation is visible to anyone with access
        const results = allRows.filter(r =>
          !r.layer_user_id || access.role === 'editor' || (user && r.layer_user_id === user.id));
        const payload = {
          chat: {
            id: chat.id, createdAt: chat.created_at,
            visibility: chat.visibility || 'private', ownerId: chat.owner_id,
            comments: !!chat.comments,
          },
          myRole: access.role,
          isOwner: !!access.isOwner,
          viaInvite: !!access.viaInvite,
          messages: results.map(rowToMessage),
        };
        if (authEnabled(env) && chat.owner_id) {
          const { results: mems } = await env.DB.prepare(
            `SELECT cm.user_id, cm.role, cm.created_at, u.name, u.picture FROM chat_members cm
             JOIN users u ON u.id = cm.user_id WHERE cm.chat_id = ? ORDER BY cm.created_at`
          ).bind(chat.id).all();
          payload.members = mems.map(r => ({
            userId: r.user_id, role: r.role, name: r.name, picture: r.picture,
            isOwner: r.user_id === chat.owner_id,
          }));
          if (access.role === 'editor') {
            const { results: invs } = await env.DB.prepare(
              `SELECT i.token, i.role, i.invitee_name, i.created_at, i.used_by, i.used_at, u.name AS used_name
               FROM invites i LEFT JOIN users u ON u.id = i.used_by
               WHERE i.chat_id = ? ORDER BY i.created_at DESC`
            ).bind(chat.id).all();
            payload.invites = invs.map(i => ({
              token: i.token, role: i.role, name: i.invitee_name, createdAt: i.created_at,
              usedBy: i.used_by, usedByName: i.used_name, usedAt: i.used_at,
            }));
            const { results: reqs } = await env.DB.prepare(
              `SELECT r.user_id, r.created_at, u.name, u.picture FROM access_requests r
               JOIN users u ON u.id = r.user_id WHERE r.chat_id = ? ORDER BY r.created_at`
            ).bind(chat.id).all();
            payload.requests = reqs.map(r => ({
              userId: r.user_id, name: r.name, picture: r.picture, createdAt: r.created_at,
            }));
          }
        }
        return json(payload);
      }

      // ---- sharing: visibility, members, invites, access requests, friends ----
      if ((m = pathname.match(/^\/api\/chats\/([A-Za-z0-9_-]+)$/)) && request.method === 'PATCH') {
        const chat = await env.DB.prepare('SELECT * FROM chats WHERE id = ?').bind(m[1]).first();
        if (!chat) return json({ error: 'not found' }, 404);
        const user = await getUser(request, env);
        const access = await chatAccess(env, user, chat);
        if (access.role !== 'editor') return json({ error: 'editors only' }, 403);
        const patch = await request.json();
        if (patch.visibility !== undefined) {
          if (!['private', 'public'].includes(patch.visibility)) return json({ error: 'bad visibility' }, 400);
          await env.DB.prepare('UPDATE chats SET visibility = ? WHERE id = ?').bind(patch.visibility, chat.id).run();
        }
        if (patch.comments !== undefined) {
          await env.DB.prepare('UPDATE chats SET comments = ? WHERE id = ?').bind(patch.comments ? 1 : 0, chat.id).run();
        }
        return json({ ok: true });
      }

      if ((m = pathname.match(/^\/api\/chats\/([A-Za-z0-9_-]+)\/members$/)) && request.method === 'POST') {
        // direct add — the "people you've chatted with" one-click path
        const chat = await env.DB.prepare('SELECT * FROM chats WHERE id = ?').bind(m[1]).first();
        if (!chat) return json({ error: 'not found' }, 404);
        const user = await getUser(request, env);
        if ((await chatAccess(env, user, chat)).role !== 'editor') return json({ error: 'editors only' }, 403);
        const { userId, role } = await request.json();
        if (!validRole(role)) return json({ error: 'bad role' }, 400);
        const target = await env.DB.prepare('SELECT id, status FROM users WHERE id = ?').bind(userId).first();
        if (!target || target.status === 'blocked') return json({ error: 'no such user' }, 404);
        await addMember(env, chat, target.id, role, user);
        return json({ ok: true });
      }

      if ((m = pathname.match(/^\/api\/chats\/([A-Za-z0-9_-]+)\/members\/([A-Za-z0-9_-]+)$/))) {
        const chat = await env.DB.prepare('SELECT * FROM chats WHERE id = ?').bind(m[1]).first();
        if (!chat) return json({ error: 'not found' }, 404);
        const user = await getUser(request, env);
        const access = await chatAccess(env, user, chat);
        if (m[2] === chat.owner_id) return json({ error: "the owner's access can't be changed" }, 400);
        if (request.method === 'PATCH') {
          if (access.role !== 'editor') return json({ error: 'editors only' }, 403);
          const { role } = await request.json();
          if (!validRole(role)) return json({ error: 'bad role' }, 400);
          await env.DB.prepare('UPDATE chat_members SET role = ? WHERE chat_id = ? AND user_id = ?')
            .bind(role, chat.id, m[2]).run();
          return json({ ok: true });
        }
        if (request.method === 'DELETE') {
          // editors kick anyone (but the owner); anyone may remove themself
          if (access.role !== 'editor' && user?.id !== m[2]) return json({ error: 'editors only' }, 403);
          await env.DB.prepare('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?')
            .bind(chat.id, m[2]).run();
          return json({ ok: true });
        }
      }

      if ((m = pathname.match(/^\/api\/chats\/([A-Za-z0-9_-]+)\/invites$/)) && request.method === 'POST') {
        const chat = await env.DB.prepare('SELECT * FROM chats WHERE id = ?').bind(m[1]).first();
        if (!chat) return json({ error: 'not found' }, 404);
        const user = await getUser(request, env);
        if ((await chatAccess(env, user, chat)).role !== 'editor') return json({ error: 'editors only' }, 403);
        const { name, role } = await request.json();
        if (!validRole(role)) return json({ error: 'bad role' }, 400);
        const token = slug(20);
        await env.DB.prepare(
          'INSERT INTO invites (token, chat_id, role, invitee_name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(token, chat.id, role, String(name || '').slice(0, 40) || null, user?.id || '', Date.now()).run();
        return json({ token, url: `${url.origin}/i/${token}` });
      }

      if ((m = pathname.match(/^\/api\/chats\/([A-Za-z0-9_-]+)\/invites\/([A-Za-z0-9_-]+)$/)) && request.method === 'DELETE') {
        const chat = await env.DB.prepare('SELECT * FROM chats WHERE id = ?').bind(m[1]).first();
        if (!chat) return json({ error: 'not found' }, 404);
        const user = await getUser(request, env);
        if ((await chatAccess(env, user, chat)).role !== 'editor') return json({ error: 'editors only' }, 403);
        await env.DB.prepare('DELETE FROM invites WHERE token = ? AND chat_id = ?').bind(m[2], chat.id).run();
        return json({ ok: true });
      }

      // what an invite link points at (public: the landing page for the link)
      if ((m = pathname.match(/^\/api\/invites\/([A-Za-z0-9_-]+)$/)) && request.method === 'GET') {
        const inv = await env.DB.prepare('SELECT * FROM invites WHERE token = ?').bind(m[1]).first();
        if (!inv) return json({ error: 'invite not found' }, 404);
        const user = await getUser(request, env);
        const member = user
          ? await env.DB.prepare('SELECT 1 AS x FROM chat_members WHERE chat_id = ? AND user_id = ?')
              .bind(inv.chat_id, user.id).first()
          : null;
        const { results } = await env.DB
          .prepare('SELECT DISTINCT author FROM messages WHERE chat_id = ?').bind(inv.chat_id).all();
        return json({
          chatId: inv.chat_id,
          role: inv.role,
          inviteeName: inv.invitee_name,
          participants: results.map(r => r.author),
          signedIn: !!user,
          status: member ? 'member'
            : !inv.used_by ? 'open'
            : user && inv.used_by === user.id ? 'used-by-you' : 'used',
        });
      }

      // upgrade a legacy (pre-access-control) chat: claimer becomes owner,
      // everyone who has posted from an account is backfilled as a commenter.
      // Visibility starts public so the link keeps working until the owner
      // decides otherwise.
      if ((m = pathname.match(/^\/api\/chats\/([A-Za-z0-9_-]+)\/claim$/)) && request.method === 'POST') {
        if (!authEnabled(env)) return json({ error: 'sharing controls need sign-in configured' }, 400);
        const chat = await env.DB.prepare('SELECT * FROM chats WHERE id = ?').bind(m[1]).first();
        if (!chat) return json({ error: 'not found' }, 404);
        if (chat.owner_id) return json({ error: 'this chat already has sharing set up' }, 409);
        const user = await getUser(request, env);
        if (!user) return json({ error: 'sign in first', code: 'auth' }, 401);
        if (user.status === 'blocked') return json({ error: 'your account is blocked', code: 'blocked' }, 403);
        const { results: msgs } = await env.DB
          .prepare('SELECT DISTINCT user_id, author FROM messages WHERE chat_id = ?').bind(chat.id).all();
        const participated = msgs.some(r => r.user_id === user.id || sameAuthor(r.author, user.name));
        if (!participated && msgs.length && !isAdmin(env, user)) {
          return json({ error: 'only someone who has posted in this chat can set up sharing' }, 403);
        }
        await env.DB.prepare("UPDATE chats SET owner_id = ?, visibility = 'public' WHERE id = ?")
          .bind(user.id, chat.id).run();
        await env.DB.prepare(
          "INSERT OR IGNORE INTO chat_members (chat_id, user_id, role, added_by, created_at) VALUES (?, ?, 'editor', ?, ?)"
        ).bind(chat.id, user.id, user.id, Date.now()).run();
        // silent backfill — these people are already in the conversation
        for (const uid of new Set(msgs.map(r => r.user_id).filter(id => id && id !== user.id))) {
          await env.DB.prepare(
            "INSERT OR IGNORE INTO chat_members (chat_id, user_id, role, added_by, created_at) VALUES (?, ?, 'commenter', ?, ?)"
          ).bind(chat.id, uid, user.id, Date.now()).run();
        }
        return json({ ok: true });
      }

      if ((m = pathname.match(/^\/api\/invites\/([A-Za-z0-9_-]+)\/accept$/)) && request.method === 'POST') {
        const inv = await env.DB.prepare('SELECT * FROM invites WHERE token = ?').bind(m[1]).first();
        if (!inv) return json({ error: 'invite not found' }, 404);
        const user = await getUser(request, env);
        if (!user) return json({ error: 'sign in first', code: 'auth' }, 401);
        if (user.status === 'blocked') return json({ error: 'your account is blocked', code: 'blocked' }, 403);
        const chat = await env.DB.prepare('SELECT * FROM chats WHERE id = ?').bind(inv.chat_id).first();
        if (!chat) return json({ error: 'chat gone' }, 404);
        const member = await env.DB.prepare('SELECT 1 AS x FROM chat_members WHERE chat_id = ? AND user_id = ?')
          .bind(chat.id, user.id).first();
        if (member || user.id === chat.owner_id) return json({ ok: true, chatId: chat.id }); // already in — don't burn the link
        if (inv.used_by && inv.used_by !== user.id) return json({ error: 'this invite was already used', code: 'used' }, 409);
        if (!inv.used_by) {
          await env.DB.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE token = ?')
            .bind(user.id, Date.now(), inv.token).run();
        }
        await addMember(env, chat, user.id, inv.role, null);
        // tell whoever sent the link that it got used
        ctx.waitUntil(pushToUsers(env, [inv.created_by], {
          title: 'splitty',
          body: `${user.name} accepted your invite${inv.invitee_name ? ` (sent to ${inv.invitee_name})` : ''}`,
          url: `/c/${chat.id}`,
          tag: `chat-${chat.id}`,
        }));
        return json({ ok: true, chatId: chat.id });
      }

      if ((m = pathname.match(/^\/api\/chats\/([A-Za-z0-9_-]+)\/request$/)) && request.method === 'POST') {
        const chat = await env.DB.prepare('SELECT * FROM chats WHERE id = ?').bind(m[1]).first();
        if (!chat) return json({ error: 'not found' }, 404);
        const user = await getUser(request, env);
        if (!user) return json({ error: 'sign in first', code: 'auth' }, 401);
        if (user.status === 'blocked') return json({ error: 'your account is blocked', code: 'blocked' }, 403);
        const member = await env.DB.prepare('SELECT 1 AS x FROM chat_members WHERE chat_id = ? AND user_id = ?')
          .bind(chat.id, user.id).first();
        if (member || user.id === chat.owner_id) return json({ ok: true, already: true });
        await env.DB.prepare(
          'INSERT OR IGNORE INTO access_requests (chat_id, user_id, created_at) VALUES (?, ?, ?)'
        ).bind(chat.id, user.id, Date.now()).run();
        ctx.waitUntil(chatEditorIds(env, chat).then(ids => pushToUsers(env, ids, {
          title: 'splitty',
          body: `${user.name} is asking to join your chat`,
          url: `/c/${chat.id}`,
          tag: `chat-${chat.id}`,
        })));
        return json({ ok: true });
      }

      if ((m = pathname.match(/^\/api\/chats\/([A-Za-z0-9_-]+)\/requests\/([A-Za-z0-9_-]+)$/))) {
        const chat = await env.DB.prepare('SELECT * FROM chats WHERE id = ?').bind(m[1]).first();
        if (!chat) return json({ error: 'not found' }, 404);
        const user = await getUser(request, env);
        if ((await chatAccess(env, user, chat)).role !== 'editor') return json({ error: 'editors only' }, 403);
        if (request.method === 'POST') { // approve, with a role
          const { role } = await request.json();
          if (!validRole(role)) return json({ error: 'bad role' }, 400);
          await addMember(env, chat, m[2], role, user);
          return json({ ok: true });
        }
        if (request.method === 'DELETE') { // deny
          await env.DB.prepare('DELETE FROM access_requests WHERE chat_id = ? AND user_id = ?')
            .bind(chat.id, m[2]).run();
          return json({ ok: true });
        }
      }

      // everyone you've explicitly shared a chat with — the quick-add list
      if (pathname === '/api/friends' && request.method === 'GET') {
        const user = await getUser(request, env);
        if (!user) return json({ error: 'sign in first', code: 'auth' }, 401);
        const { results } = await env.DB.prepare(
          `SELECT DISTINCT u.id, u.name, u.picture FROM chat_members a
           JOIN chat_members b ON b.chat_id = a.chat_id AND b.user_id != a.user_id
           JOIN users u ON u.id = b.user_id
           WHERE a.user_id = ? AND u.status != 'blocked'
           ORDER BY u.name COLLATE NOCASE`
        ).bind(user.id).all();
        return json({ friends: results.map(r => ({ userId: r.id, name: r.name, picture: r.picture })) });
      }

      // ---- web push subscriptions ----
      if (pathname === '/api/push/subscribe' && request.method === 'POST') {
        const user = await getUser(request, env);
        if (!user) return json({ error: 'sign in first', code: 'auth' }, 401);
        const sub = (await request.json()).subscription || {};
        if (!sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) return json({ error: 'bad subscription' }, 400);
        await env.DB.prepare(
          'INSERT OR REPLACE INTO push_subs (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)'
        ).bind(sub.endpoint, user.id, sub.keys.p256dh, sub.keys.auth, Date.now()).run();
        return json({ ok: true });
      }

      if (pathname === '/api/push/unsubscribe' && request.method === 'POST') {
        const { endpoint } = await request.json();
        if (endpoint) await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(endpoint).run();
        return json({ ok: true });
      }

      if ((m = pathname.match(/^\/api\/chats\/([A-Za-z0-9_-]+)\/messages$/)) && request.method === 'POST') {
        return await createMessage(request, env, ctx, m[1]);
      }

      // re-anchor an interjection (drag-to-move the split point) — author or editor
      if ((m = pathname.match(/^\/api\/chats\/([A-Za-z0-9_-]+)\/messages\/([A-Za-z0-9_-]+)$/)) && request.method === 'PATCH') {
        const chat = await env.DB.prepare('SELECT * FROM chats WHERE id = ?').bind(m[1]).first();
        if (!chat) return json({ error: 'not found' }, 404);
        const row = await env.DB.prepare('SELECT parent_id, author, user_id FROM messages WHERE id = ? AND chat_id = ?')
          .bind(m[2], m[1]).first();
        if (!row) return json({ error: 'not found' }, 404);
        if (!row.parent_id) return json({ error: 'not an interjection' }, 400);
        const body = await request.json();
        const user = await getUser(request, env);
        const access = await chatAccess(env, user, chat);
        // name-only mode has no real roles — keep it author-only there
        const canMove = authEnabled(env)
          ? access.role === 'editor' || (roleAtLeast(access.role, 'commenter') && ownsMessage(user, row, body.author))
          : ownsMessage(user, row, body.author);
        if (!canMove) return json({ error: 'only the author or an editor can move this' }, 403);
        const anchorMs = Math.max(0, Math.round(Number(body.anchorMs) || 0));
        await env.DB.prepare('UPDATE messages SET anchor_ms = ? WHERE id = ?').bind(anchorMs, m[2]).run();
        return json({ ok: true, anchorMs });
      }

      // re-run transcription (optionally pinning a language) — author or editor
      if ((m = pathname.match(/^\/api\/chats\/([A-Za-z0-9_-]+)\/messages\/([A-Za-z0-9_-]+)\/transcribe$/)) && request.method === 'POST') {
        const chat = await env.DB.prepare('SELECT * FROM chats WHERE id = ?').bind(m[1]).first();
        if (!chat) return json({ error: 'not found' }, 404);
        const row = await env.DB
          .prepare('SELECT author, user_id, audio_key, video_key FROM messages WHERE id = ? AND chat_id = ?')
          .bind(m[2], m[1]).first();
        if (!row) return json({ error: 'not found' }, 404);
        const body = await request.json();
        const user = await getUser(request, env);
        const access = await chatAccess(env, user, chat);
        const allowed = authEnabled(env)
          ? access.role === 'editor' || (roleAtLeast(access.role, 'commenter') && ownsMessage(user, row, body.author))
          : ownsMessage(user, row, body.author);
        if (!allowed) return json({ error: 'only the author or an editor can retranscribe this' }, 403);
        // the client can hand us a freshly-harvested audio track (extracted
        // from the video in the browser) — it becomes the stored one
        let srcKey = row.audio_key || row.video_key;
        if (body.audioKey) {
          const claimed = await claimUploadedKey(env, body.audioKey);
          if (!claimed) return json({ error: 'bad audio key' }, 400);
          if (row.audio_key && row.audio_key !== claimed.key) {
            await env.MEDIA.delete(row.audio_key); // replaced — don't strand the old track
          }
          await env.DB.prepare('UPDATE messages SET audio_key = ? WHERE id = ?').bind(claimed.key, m[2]).run();
          srcKey = claimed.key;
        }
        const obj = await env.MEDIA.get(srcKey);
        if (!obj) return json({ error: 'media missing' }, 404);
        if (obj.size > 24 * 1024 * 1024) {
          // no stored voice track and the full video won't fit in Worker
          // memory — the client offers to extract the audio locally instead
          return json({ error: 'the video is too big to transcribe whole', code: 'toobig' }, 400);
        }
        await env.DB.prepare("UPDATE messages SET transcript_status = 'pending' WHERE id = ?").bind(m[2]).run();
        const buf = await obj.arrayBuffer();
        ctx.waitUntil(transcribe(env, m[2], buf, cleanLang(body.language)));
        return json({ ok: true });
      }

      // delete a message; its interjections fall onto its spot in the parent — author or editor
      if ((m = pathname.match(/^\/api\/chats\/([A-Za-z0-9_-]+)\/messages\/([A-Za-z0-9_-]+)$/)) && request.method === 'DELETE') {
        const chat = await env.DB.prepare('SELECT * FROM chats WHERE id = ?').bind(m[1]).first();
        if (!chat) return json({ error: 'not found' }, 404);
        const row = await env.DB
          .prepare('SELECT author, user_id, parent_id, anchor_ms, video_key, screen_key, audio_key FROM messages WHERE id = ? AND chat_id = ?')
          .bind(m[2], m[1]).first();
        if (!row) return json({ error: 'not found' }, 404);
        const body = await request.json();
        const user = await getUser(request, env);
        const access = await chatAccess(env, user, chat);
        const canDelete = authEnabled(env)
          ? access.role === 'editor' || (roleAtLeast(access.role, 'commenter') && ownsMessage(user, row, body.author))
          : ownsMessage(user, row, body.author);
        if (!canDelete) return json({ error: 'only the author or an editor can delete this' }, 403);
        if (row.parent_id) {
          await env.DB.prepare('UPDATE messages SET parent_id = ?, anchor_ms = ? WHERE parent_id = ?')
            .bind(row.parent_id, row.anchor_ms, m[2]).run();
        } else {
          await env.DB.prepare('UPDATE messages SET parent_id = NULL, anchor_ms = NULL WHERE parent_id = ?')
            .bind(m[2]).run();
        }
        await env.MEDIA.delete([row.video_key, row.screen_key, row.audio_key].filter(Boolean));
        await env.DB.prepare('DELETE FROM messages WHERE id = ?').bind(m[2]).run();
        return json({ ok: true });
      }

      // ---- chunked uploads (R2 multipart) ----
      // Long recordings and screen shares are too big for one Worker request
      // (body cap + form parsing buffers in memory), so the client uploads
      // 8MB parts straight through to R2, then references the finished keys
      // when it creates the message.
      if ((m = pathname.match(/^\/api\/chats\/([A-Za-z0-9_-]+)\/uploads(\/[a-z]+)?$/))) {
        const gate = await uploadGate(request, env, m[1]);
        if (gate) return gate;
        const action = m[2] || '';

        if (action === '' && request.method === 'POST') {
          const { mime } = await request.json();
          const clean = String(mime || 'video/webm').split(';')[0];
          const ext = {
            'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
            'audio/wav': 'wav', 'audio/webm': 'webm', 'audio/mp4': 'm4a',
          }[clean] || 'webm';
          const key = `${slug(16)}.${ext}`;
          const mpu = await env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType: clean } });
          return json({ key, uploadId: mpu.uploadId });
        }

        if (action === '/part' && request.method === 'PUT') {
          const key = url.searchParams.get('key') || '';
          const id = url.searchParams.get('id') || '';
          const n = Number(url.searchParams.get('n'));
          if (!UPLOAD_KEY_RE.test(key) || !id || !(n >= 1 && n <= 10000)) return json({ error: 'bad part' }, 400);
          const part = await env.MEDIA.resumeMultipartUpload(key, id).uploadPart(n, request.body);
          return json({ etag: part.etag });
        }

        if (action === '/complete' && request.method === 'POST') {
          const { key, uploadId, parts } = await request.json();
          if (!UPLOAD_KEY_RE.test(key || '') || !uploadId || !Array.isArray(parts) || !parts.length) {
            return json({ error: 'bad complete' }, 400);
          }
          await env.MEDIA.resumeMultipartUpload(key, uploadId)
            .complete(parts.map(p => ({ partNumber: Number(p.partNumber), etag: String(p.etag) })));
          return json({ ok: true });
        }

        if (action === '/abort' && request.method === 'POST') {
          const { key, uploadId } = await request.json();
          if (UPLOAD_KEY_RE.test(key || '') && uploadId) {
            await env.MEDIA.resumeMultipartUpload(key, uploadId).abort().catch(() => {});
          }
          return json({ ok: true });
        }
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

const MAX_RECORD_MS = 10 * 60 * 1000; // keep clips balanced — 10 minutes each
const UPLOAD_KEY_RE = /^[A-Za-z0-9_-]{16}\.(webm|mp4|mov|wav|m4a)$/;

// chunked-upload routes share the message-posting gate: signed-in, not
// blocked, commenter or better in this chat (name-only mode stays open)
async function uploadGate(request, env, chatId) {
  const chat = await env.DB.prepare('SELECT * FROM chats WHERE id = ?').bind(chatId).first();
  if (!chat) return json({ error: 'not found' }, 404);
  if (!authEnabled(env)) return null;
  const user = await getUser(request, env);
  if (!user) return json({ error: 'sign in first', code: 'auth' }, 401);
  if (user.status === 'blocked') return json({ error: 'your account is blocked', code: 'blocked' }, 403);
  const access = await chatAccess(env, user, chat);
  if (!roleAtLeast(access.role, 'commenter')) return json({ error: 'no permission to record here', code: 'role' }, 403);
  return null;
}

// a client-supplied key must be a real, freshly uploaded object that no
// message already points at — never a way to alias someone else's file
async function claimUploadedKey(env, key) {
  if (typeof key !== 'string' || !UPLOAD_KEY_RE.test(key)) return null;
  const head = await env.MEDIA.head(key);
  if (!head) return null;
  const ref = await env.DB.prepare('SELECT 1 AS x FROM messages WHERE video_key = ? OR screen_key = ? OR audio_key = ?')
    .bind(key, key, key).first();
  if (ref) return null;
  return { key, mime: head.httpMetadata?.contentType || 'video/webm' };
}

async function createMessage(request, env, ctx, chatId) {
  const chat = await env.DB.prepare('SELECT * FROM chats WHERE id = ?').bind(chatId).first();
  if (!chat) return json({ error: 'not found' }, 404);

  const form = await request.formData();
  const video = form.get('video');
  const audio = form.get('audio'); // small audio-only track for transcription
  // a non-empty layer routes this into that person's private comment layer
  let layer = String(form.get('layer') || '') || null;
  // 30s of slack over the client's auto-stop covers recorder stop latency
  if (Number(form.get('durationMs')) > MAX_RECORD_MS + 30_000) {
    return json({ error: 'recordings are capped at 10 minutes', code: 'toolong' }, 400);
  }

  // approvals only apply once auth is configured; name-only mode stays open
  let user = null;
  if (authEnabled(env)) {
    user = await getUser(request, env);
    if (!user) return json({ error: 'sign in to send messages', code: 'auth' }, 401);
    if (user.status === 'blocked') return json({ error: 'your account is blocked', code: 'blocked' }, 403);
    const access = await chatAccess(env, user, chat);
    if (layer) {
      // commenting: needs the chat's comments switch on and at least view
      // access; you write into your own layer, editors into anyone's
      if (!chat.comments) return json({ error: 'comments are off for this chat', code: 'role' }, 403);
      if (!access.role) return json({ error: 'no access to this chat', code: 'role' }, 403);
      if (layer !== user.id && access.role !== 'editor') {
        return json({ error: "you can only comment in your own layer", code: 'role' }, 403);
      }
    } else if (!roleAtLeast(access.role, 'commenter')) {
      return json({ error: "you can watch this chat, but you don't have permission to record in it", code: 'role' }, 403);
    }
    if (user.status === 'pending') {
      const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE user_id = ?')
        .bind(user.id).first();
      if (n >= 1) {
        return json({ error: 'you can send one message until an admin approves you — hang tight', code: 'pending' }, 403);
      }
    }
  } else {
    layer = null; // layers need accounts — name-only mode has none
  }

  const extFor = mm => ({ 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' }[mm] || 'webm');

  // preferred path: the client already chunk-uploaded the big files to R2
  // and hands us their keys; fallback: small inline files (legacy/dev)
  let videoKey, mime, screenKey = null;
  const preVideo = await claimUploadedKey(env, form.get('videoKey'));
  if (preVideo) {
    videoKey = preVideo.key;
    mime = preVideo.mime;
  } else {
    if (!(video instanceof File)) return json({ error: 'missing video' }, 400);
    mime = (video.type || 'video/webm').split(';')[0];
    videoKey = `${slug(16)}.${extFor(mime)}`;
    await env.MEDIA.put(videoKey, video.stream(), { httpMetadata: { contentType: mime } });
  }

  // optional companion screen-share track (camera carries the audio)
  const preScreen = await claimUploadedKey(env, form.get('screenKey'));
  if (preScreen) {
    screenKey = preScreen.key;
  } else {
    const screen = form.get('screen');
    if (screen instanceof File && screen.size > 0) {
      const smime = (screen.type || 'video/webm').split(';')[0];
      screenKey = `${slug(16)}.${extFor(smime)}`;
      await env.MEDIA.put(screenKey, screen.stream(), { httpMetadata: { contentType: smime } });
    }
  }

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
    screenKey,
    layer,
    durationMs: Number(form.get('durationMs')) || null,
    gain: Math.min(Math.max(Number(form.get('gain')) || 1, 0.25), 4),
    createdAt: Date.now(),
    text: '',
    words: [],
    transcriptStatus: 'pending',
  };

  // the ~64kbps voice track gets stored too — it's tiny and makes
  // retranscription (e.g. with a language override) cheap forever
  let audioKey = null, transcriptBuf = null;
  if (audio instanceof File && audio.size > 0) {
    transcriptBuf = await audio.arrayBuffer();
    const amime = (audio.type || 'audio/webm').split(';')[0];
    audioKey = `${slug(16)}.${amime.includes('mp4') ? 'm4a' : 'webm'}`;
    await env.MEDIA.put(audioKey, transcriptBuf, { httpMetadata: { contentType: amime } });
  } else if (video instanceof File) {
    transcriptBuf = await video.arrayBuffer(); // legacy/dev inline path
  }

  await env.DB.prepare(
    `INSERT INTO messages (id, chat_id, user_id, author, video_key, mime, parent_id, anchor_ms, screen_key, audio_key, layer_user_id, duration_ms, gain, created_at, transcript_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
  ).bind(msg.id, msg.chatId, msg.userId, msg.author, msg.file, msg.mime, msg.parentId, msg.anchorMs, msg.screenKey, audioKey, msg.layer, msg.durationMs, msg.gain, msg.createdAt).run();

  // transcribe after the response goes out; client polls for the result.
  // Push notifications wait for the transcript so they can quote the message.
  if (transcriptBuf) {
    const lang = cleanLang(form.get('lang'));
    ctx.waitUntil(transcribe(env, msg.id, transcriptBuf, lang).then(() => notifyNewMessage(env, msg)));
  } else {
    await env.DB.prepare("UPDATE messages SET transcript_status = 'failed' WHERE id = ?").bind(msg.id).run();
    ctx.waitUntil(notifyNewMessage(env, msg));
  }

  return json({ message: msg });
}

const cleanLang = s => (typeof s === 'string' && /^[a-z]{2,3}$/i.test(s.trim()) ? s.trim().toLowerCase() : '');

async function transcribe(env, messageId, audioBuf, language = '') {
  let status = 'failed', text = '', words = [];
  try {
    const out = await env.AI.run('@cf/openai/whisper-large-v3-turbo', {
      audio: toBase64(audioBuf),
      ...(language && { language }), // pin it when auto-detect guesses wrong
    });
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

// ---------- web push ----------
// VAPID key is one Worker secret: the private JWK (kty EC / P-256, with d,x,y).
// Generate with: node -e "const{generateKeyPairSync}=require('crypto');console.log(JSON.stringify(generateKeyPairSync('ec',{namedCurve:'P-256'}).privateKey.export({format:'jwk'})))"
// then: wrangler secret put VAPID_JWK
const b64u = {
  enc: buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)),
};

const pushEnabled = env => !!env.VAPID_JWK;

// uncompressed P-256 point (0x04 || x || y) — the applicationServerKey clients use
function vapidPublicKey(env) {
  const jwk = JSON.parse(env.VAPID_JWK);
  const buf = new Uint8Array(65);
  buf[0] = 4;
  buf.set(b64u.dec(jwk.x), 1);
  buf.set(b64u.dec(jwk.y), 33);
  return b64u.enc(buf);
}

async function vapidAuthHeader(env, endpoint) {
  const key = await crypto.subtle.importKey('jwk', JSON.parse(env.VAPID_JWK),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const te = new TextEncoder();
  const head = b64u.enc(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64u.enc(te.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: 'mailto:' + ((env.EMAIL_FROM || '').match(/<(.+)>/)?.[1] || 'no-reply@splitty.chat'),
  })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(`${head}.${payload}`));
  return `vapid t=${head}.${payload}.${b64u.enc(sig)}, k=${vapidPublicKey(env)}`;
}

// RFC 8291 message encryption (aes128gcm content coding)
async function encryptPush(sub, payload) {
  const uaPub = b64u.dec(sub.p256dh);   // subscriber's public key, 65 bytes
  const authSecret = b64u.dec(sub.auth);
  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));

  const te = new TextEncoder();
  const hkdf = async (ikm, salt, info, len) => {
    const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
  };
  const keyInfo = new Uint8Array([...te.encode('WebPush: info\0'), ...uaPub, ...asPub]);
  const ikm = await hkdf(ecdh, authSecret, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(ikm, salt, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(ikm, salt, te.encode('Content-Encoding: nonce\0'), 12);

  const record = new Uint8Array([...te.encode(payload), 2]); // 0x02 delimiter = last record
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, record));

  // header: salt(16) | record size(4) | keyid len(1) | as public key(65) | ciphertext
  const out = new Uint8Array(86 + ct.length);
  out.set(salt, 0);
  new DataView(out.buffer).setUint32(16, 4096);
  out[20] = 65;
  out.set(asPub, 21);
  out.set(ct, 86);
  return out;
}

async function sendPush(env, sub, payloadObj) {
  try {
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: await vapidAuthHeader(env, sub.endpoint),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: '86400',
        Urgency: 'normal',
      },
      body: await encryptPush(sub, JSON.stringify(payloadObj)),
    });
    if (res.status === 404 || res.status === 410) {
      // subscription is dead — stop keeping it around
      await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(sub.endpoint).run();
    }
  } catch (err) {
    console.error('push failed:', String(err));
  }
}

async function pushToUsers(env, userIds, payload) {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (!pushEnabled(env) || !ids.length) return;
  const { results } = await env.DB.prepare(
    `SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id IN (${ids.map(() => '?').join(',')})`
  ).bind(...ids).all();
  await Promise.all(results.map(sub => sendPush(env, sub, payload)));
}

// after transcription lands: quote the message to whoever can hear it.
// Base messages → every member. Comment-layer messages → the editors (who can
// see all layers) plus the layer's owner (an editor may have replied in it).
async function notifyNewMessage(env, msg) {
  let targets;
  if (msg.layer) {
    const chat = await env.DB.prepare('SELECT * FROM chats WHERE id = ?').bind(msg.chatId).first();
    targets = chat ? [...await chatEditorIds(env, chat), msg.layer] : [msg.layer];
  } else {
    const { results } = await env.DB.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?')
      .bind(msg.chatId).all();
    targets = results.map(r => r.user_id);
  }
  const row = await env.DB.prepare('SELECT text FROM messages WHERE id = ?').bind(msg.id).first();
  const text = (row?.text || '').trim();
  const quote = text ? `“${text.length > 90 ? text.slice(0, 90) + '…' : text}”` : 'sent a video note';
  await pushToUsers(env,
    targets.filter(id => id !== msg.userId),
    {
      title: `${msg.author} · splitty`,
      body: msg.layer ? `commented: ${quote}` : quote,
      url: `/c/${msg.chatId}`,
      tag: `chat-${msg.chatId}`,
    });
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
