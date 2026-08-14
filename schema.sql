CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
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
  gain REAL DEFAULT 1  -- client-measured loudness correction; added to live DB 2026-08-14 via ALTER
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
