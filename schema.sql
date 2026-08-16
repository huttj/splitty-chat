CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  owner_id TEXT,                                  -- creator; NULL = legacy open chat. Added to live DB 2026-08-15 via ALTER
  visibility TEXT NOT NULL DEFAULT 'private',     -- 'private' | 'public'. Added to live DB 2026-08-15 via ALTER
  comments INTEGER NOT NULL DEFAULT 0             -- viewers may comment in their own layer. Added to live DB 2026-08-15 via ALTER
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  author TEXT NOT NULL,
  video_key TEXT NOT NULL,
  mime TEXT,
  parent_id TEXT,
  anchor_ms INTEGER,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  words TEXT NOT NULL DEFAULT '[]',
  transcript_status TEXT NOT NULL DEFAULT 'pending',
  gain REAL DEFAULT 1,     -- client-measured loudness correction; added to live DB 2026-08-14 via ALTER
  screen_key TEXT,         -- companion screen-share video in R2; added to live DB 2026-08-15 via ALTER
  audio_key TEXT,          -- stored voice track (retranscription source); added to live DB 2026-08-15 via ALTER
  layer_user_id TEXT       -- NULL = base conversation; else the commenter whose private layer this belongs to. ALTER 2026-08-15
);

CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_tokens (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
-- users/identities/sessions/login_tokens appended; messages.user_id added via ALTER 2026-08-14
-- users.picture added via ALTER 2026-08-14 (Google profile photo URL)

-- ---------- access control (2026-08-15) ----------
-- editor: reorder/delete anything, invite, change visibility
-- commenter: record + move own messages
-- viewer: watch only
CREATE TABLE IF NOT EXISTS chat_members (
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,             -- 'editor' | 'commenter' | 'viewer'
  added_by TEXT,                  -- user id of whoever invited/approved them
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON chat_members(user_id);

-- one-time consumable invite links
CREATE TABLE IF NOT EXISTS invites (
  token TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL,
  invitee_name TEXT,              -- who the link is meant for (display only)
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  used_by TEXT,                   -- user id that consumed it
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_invites_chat ON invites(chat_id);

-- signed-in users knocking on a private chat
CREATE TABLE IF NOT EXISTS access_requests (
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);

-- web push subscriptions (one row per browser/device)
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subs(user_id);
