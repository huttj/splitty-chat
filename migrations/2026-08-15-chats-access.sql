-- one-off migration for existing DBs (new tables come from schema.sql):
--   wrangler d1 execute splitty --local  --file migrations/2026-08-15-chats-access.sql
--   wrangler d1 execute splitty --remote --file migrations/2026-08-15-chats-access.sql
-- Existing chats keep owner_id NULL, which the worker treats as a legacy open chat.
ALTER TABLE chats ADD COLUMN owner_id TEXT;
ALTER TABLE chats ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';
