-- one-off migration for existing DBs:
--   wrangler d1 execute splitty --local  --file migrations/2026-08-15-audio-key.sql
--   wrangler d1 execute splitty --remote --file migrations/2026-08-15-audio-key.sql
ALTER TABLE messages ADD COLUMN audio_key TEXT;
