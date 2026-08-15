-- one-off migration for existing DBs:
--   wrangler d1 execute splitty --local  --file migrations/2026-08-15-screen-share.sql
--   wrangler d1 execute splitty --remote --file migrations/2026-08-15-screen-share.sql
ALTER TABLE messages ADD COLUMN screen_key TEXT;
