#!/usr/bin/env node
// One-off: re-encode every stored video to the Standard rendition (640px,
// ~550kbps H.264, faststart) so old clips load as fast as new ones.
//
//   node scripts/reencode.mjs            # do it
//   node scripts/reencode.mjs --dry-run  # list what would change
//   node scripts/reencode.mjs --limit 5  # first N only
//
// Needs ffmpeg/ffprobe on PATH and a logged-in wrangler. Resumable: progress
// is kept in scripts/.reencode-done.json; a message is only flipped to the new
// key after the new object is safely in R2, and the old object is deleted
// last. Audio-only messages are skipped (nothing to shrink). Files already at
// or under the target size are skipped too.

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const BUCKET = 'splitty-media';
const DB = 'splitty';
const TMP = path.join(process.cwd(), 'scripts', '.reencode-tmp');
const DONE = path.join(process.cwd(), 'scripts', '.reencode-done.json');
const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const limit = Number(args[args.indexOf('--limit') + 1]) || Infinity;

// targets mirror QUALITY.standard in public/app.js
const TARGET = {
  cam: { width: 640, maxrate: '550k', bufsize: '1100k', crf: 26 },
  screen: { width: 1280, maxrate: '900k', bufsize: '1800k', crf: 26 },
};

fs.mkdirSync(TMP, { recursive: true });
const done = fs.existsSync(DONE) ? JSON.parse(fs.readFileSync(DONE, 'utf8')) : {};
const saveDone = () => fs.writeFileSync(DONE, JSON.stringify(done, null, 2));
const slug = n => crypto.randomBytes(n).toString('base64url').replace(/[^A-Za-z0-9_-]/g, '').slice(0, n);

const sh = (cmd, opts = {}) => execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 1 << 28, ...opts });
const d1 = sql => {
  const out = sh(`npx wrangler d1 execute ${DB} --remote --json --command ${JSON.stringify(sql)}`);
  return JSON.parse(out)[0].results;
};

const rows = d1(`SELECT id, video_key, screen_key, mime, duration_ms FROM messages ORDER BY created_at`);
console.log(`${rows.length} messages`);

const jobs = [];
for (const r of rows) {
  if (r.video_key && !(r.mime || '').startsWith('audio/')) jobs.push({ id: r.id, col: 'video_key', key: r.video_key, kind: 'cam', mime: r.mime });
  if (r.screen_key) jobs.push({ id: r.id, col: 'screen_key', key: r.screen_key, kind: 'screen' });
}

let n = 0;
for (const job of jobs) {
  if (n >= limit) break;
  const tag = `${job.id}/${job.col}`;
  if (done[tag]) continue;
  const inPath = path.join(TMP, job.key);
  const ext = 'mp4';
  const newKey = `${slug(16)}.${ext}`;
  const outPath = path.join(TMP, newKey);
  try {
    process.stdout.write(`${tag} ${job.key} … `);
    sh(`npx wrangler r2 object get ${BUCKET}/${job.key} --remote --file ${JSON.stringify(inPath)}`);
    const probe = JSON.parse(sh(`ffprobe -v error -print_format json -show_streams -show_format ${JSON.stringify(inPath)}`));
    const v = probe.streams.find(s => s.codec_type === 'video');
    const bytes = Number(probe.format.size), sec = Number(probe.format.duration) || 1;
    const kbps = Math.round((bytes * 8) / sec / 1000);
    if (!v) { console.log('no video stream — skip'); done[tag] = 'novideo'; saveDone(); continue; }
    const t = TARGET[job.kind];
    const targetK = Number(t.maxrate) || parseInt(t.maxrate);
    const isMp4 = /mp4|mov/.test(probe.format.format_name || '');
    if (isMp4 && v.width <= t.width && kbps <= targetK * 1.15) {
      console.log(`${v.width}px ${kbps}kbps — already small, skip`);
      done[tag] = 'small'; saveDone(); continue;
    }
    console.log(`${v.width}px ${kbps}kbps ${(bytes / 1e6).toFixed(1)}MB`);
    if (dry) { n++; continue; }
    execFileSync('ffmpeg', [
      '-y', '-v', 'error', '-i', inPath,
      '-vf', `scale='min(${t.width},iw)':-2`,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', String(t.crf), '-maxrate', t.maxrate, '-bufsize', t.bufsize,
      '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.0',
      '-c:a', 'aac', '-b:a', '64k', '-ac', '1',
      '-movflags', '+faststart',
      outPath,
    ], { stdio: ['ignore', 'inherit', 'inherit'] });
    const outBytes = fs.statSync(outPath).size;
    console.log(`   → ${(outBytes / 1e6).toFixed(1)}MB (${Math.round((100 * outBytes) / bytes)}%)`);
    sh(`npx wrangler r2 object put ${BUCKET}/${newKey} --remote --file ${JSON.stringify(outPath)} --content-type video/mp4`);
    // forked copies share the key — point every row at the new object, then the old one is orphaned
    const setMime = job.col === 'video_key' ? `, mime = 'video/mp4'` : '';
    d1(`UPDATE messages SET ${job.col} = '${newKey}'${setMime} WHERE ${job.col} = '${job.key}'`);
    const ref = d1(`SELECT count(*) AS c FROM messages WHERE video_key = '${job.key}' OR screen_key = '${job.key}' OR audio_key = '${job.key}'`)[0].c;
    if (Number(ref) === 0) sh(`npx wrangler r2 object delete ${BUCKET}/${job.key} --remote`);
    else console.log(`   old object still referenced ${ref}× — kept`);
    // every row that pointed at it is done too
    for (const j of jobs) if (j.key === job.key) done[`${j.id}/${j.col}`] = newKey;
    saveDone();
    n++;
  } catch (err) {
    console.log(`   FAILED: ${String(err.message || err).split('\n')[0]}`);
  } finally {
    for (const f of [inPath, outPath]) { try { fs.unlinkSync(f); } catch { /* gone */ } }
  }
}
console.log(dry ? `dry run: ${n} would be re-encoded` : `done: ${n} re-encoded this run`);
