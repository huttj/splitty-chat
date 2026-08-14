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
  transcript_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
