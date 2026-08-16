-- one-off migration for existing DBs:
--   wrangler d1 execute splitty --local  --file migrations/2026-08-15-comment-layers.sql
--   wrangler d1 execute splitty --remote --file migrations/2026-08-15-comment-layers.sql
ALTER TABLE chats ADD COLUMN comments INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN layer_user_id TEXT;
