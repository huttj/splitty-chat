// splitty — interruptible async video conversations

const $ = s => document.querySelector(s);

const state = {
  chatId: null,
  name: localStorage.getItem('splitty:name') || '',
  messages: [],
  byId: new Map(),
  seen: {},          // msgId -> furthest played ms
  playlist: [],      // flat segments [{id, start, end|null}]
  playIdx: -1,
  playing: false,
  pendingSeek: null,
  rec: null,         // { recorder, stream, startTs, parentId, anchorMs, resume }
  lastRenderKey: '',
};

const player = $('#player');
const preview = $('#preview');

// ---------- boot ----------
const chatMatch = location.pathname.match(/^\/c\/([A-Za-z0-9_-]+)/);
if (chatMatch) {
  state.chatId = chatMatch[1];
  initChat();
} else {
  initLanding();
}

// ---------- landing ----------
function initLanding() {
  $('#landing').classList.remove('hidden');
  $('#create-chat').onclick = async () => {
    const res = await fetch('/api/chats', { method: 'POST' });
    const { id } = await res.json();
    location.href = `/c/${id}`;
  };
  const recent = JSON.parse(localStorage.getItem('splitty:recent') || '[]');
  if (recent.length) {
    const box = $('#recent-chats');
    box.innerHTML = '<h3>Your chats</h3>';
    for (const r of recent.slice(0, 10)) {
      const a = document.createElement('a');
      a.href = `/c/${r.id}`;
      a.className = 'recent-chat';
      a.textContent = `${r.id} · ${new Date(r.ts).toLocaleDateString()}`;
      box.appendChild(a);
    }
  }
}

// ---------- chat ----------
function initChat() {
  state.seen = JSON.parse(localStorage.getItem(`splitty:seen:${state.chatId}`) || '{}');
  $('#chat').classList.remove('hidden');
  $('#copy-link').onclick = async () => {
    await navigator.clipboard.writeText(location.href);
    $('#copy-link').textContent = 'Copied!';
    setTimeout(() => ($('#copy-link').textContent = 'Copy invite link'), 1500);
  };
  $('#rec-btn').onclick = toggleRecord;
  player.onclick = () => (player.paused ? player.play() : player.pause());
  player.addEventListener('timeupdate', onTimeUpdate);
  player.addEventListener('ended', () => advanceSegment());
  player.addEventListener('loadedmetadata', () => {
    if (state.pendingSeek != null) {
      player.currentTime = state.pendingSeek;
      state.pendingSeek = null;
      player.play();
    }
  });

  if (!state.name) {
    $('#name-gate').classList.remove('hidden');
    $('#name-form').onsubmit = e => {
      e.preventDefault();
      state.name = $('#name-input').value.trim();
      if (!state.name) return;
      localStorage.setItem('splitty:name', state.name);
      $('#name-gate').classList.add('hidden');
    };
  }

  // remember this chat on the landing page
  const recent = JSON.parse(localStorage.getItem('splitty:recent') || '[]')
    .filter(r => r.id !== state.chatId);
  recent.unshift({ id: state.chatId, ts: Date.now() });
  localStorage.setItem('splitty:recent', JSON.stringify(recent.slice(0, 20)));

  poll();
  setInterval(poll, 2500);
}

async function poll() {
  try {
    const res = await fetch(`/api/chats/${state.chatId}`);
    if (res.status === 404) {
      $('#messages').innerHTML = '<div class="empty">This chat doesn\'t exist.</div>';
      return;
    }
    const data = await res.json();
    state.messages = data.messages;
    state.byId = new Map(data.messages.map(m => [m.id, m]));
    render();
  } catch { /* offline blip — try again next poll */ }
}

// ---------- message tree ----------
const roots = () => state.messages.filter(m => !m.parentId).sort((a, b) => a.createdAt - b.createdAt);
const childrenOf = id =>
  state.messages.filter(m => m.parentId === id).sort((a, b) => (a.anchorMs - b.anchorMs) || (a.createdAt - b.createdAt));

// Expand a message into playable segments, interleaving interjections at their anchors.
function segmentsFor(msg) {
  const segs = [];
  let cursor = 0;
  for (const kid of childrenOf(msg.id)) {
    const t = (kid.anchorMs || 0) / 1000;
    if (t > cursor) segs.push({ id: msg.id, start: cursor, end: t });
    segs.push(...segmentsFor(kid));
    cursor = Math.max(cursor, t);
  }
  segs.push({ id: msg.id, start: cursor, end: null });
  return segs;
}

const fullPlaylist = () => roots().flatMap(segmentsFor);

// ---------- playback ----------
function playFrom(msgId, atSec) {
  state.playlist = fullPlaylist();
  let idx = state.playlist.findIndex(
    s => s.id === msgId && atSec >= s.start - 0.001 && (s.end == null || atSec < s.end)
  );
  if (idx === -1) idx = state.playlist.findIndex(s => s.id === msgId);
  if (idx === -1) return;
  playSegment(idx, atSec);
}

function playSegment(idx, offset) {
  const seg = state.playlist[idx];
  const msg = state.byId.get(seg.id);
  if (!msg) return stopPlayback();
  state.playIdx = idx;
  state.playing = true;
  showPip('play', msg.author);
  const src = `/media/${msg.file}`;
  const at = offset != null ? offset : seg.start;
  if (!player.src.endsWith(src)) {
    state.pendingSeek = at;
    player.src = src;
  } else {
    player.currentTime = at;
    player.play();
  }
  updateHint();
}

function advanceSegment() {
  if (!state.playing) return;
  if (state.playIdx + 1 < state.playlist.length) playSegment(state.playIdx + 1);
  else stopPlayback();
}

function stopPlayback() {
  state.playing = false;
  state.playIdx = -1;
  player.pause();
  hidePip();
  clearWordHighlight();
  updateHint();
}

let seenSaveTimer = null;
function onTimeUpdate() {
  if (!state.playing || state.playIdx < 0) return;
  const seg = state.playlist[state.playIdx];
  const t = player.currentTime;

  if (seg.end != null && t >= seg.end - 0.05) return advanceSegment();

  // track furthest-played for "new" highlighting
  const ms = Math.floor(t * 1000);
  if (ms > (state.seen[seg.id] || 0)) {
    state.seen[seg.id] = ms;
    clearTimeout(seenSaveTimer);
    seenSaveTimer = setTimeout(
      () => localStorage.setItem(`splitty:seen:${state.chatId}`, JSON.stringify(state.seen)),
      500
    );
  }

  // highlight the word being spoken, un-highlight passed "unseen" words
  const msg = state.byId.get(seg.id);
  clearWordHighlight();
  if (msg && msg.words.length) {
    let i = msg.words.findIndex(w => t >= w.s && t < w.e);
    if (i === -1) i = msg.words.findLastIndex(w => w.s <= t);
    if (i >= 0) {
      const span = document.querySelector(`.word[data-mid="${seg.id}"][data-i="${i}"]`);
      if (span) {
        span.classList.add('speaking');
        span.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
    document.querySelectorAll(`.word.unseen[data-mid="${seg.id}"]`).forEach(el => {
      if (Number(el.dataset.t) <= t) el.classList.remove('unseen');
    });
  }
}

const clearWordHighlight = () =>
  document.querySelectorAll('.word.speaking').forEach(el => el.classList.remove('speaking'));

// ---------- recording ----------
async function toggleRecord() {
  if (state.rec) return stopRecord();

  // interjecting? capture where we are, pause the playback
  let parentId = null, anchorMs = null, resume = null;
  if (state.playing && state.playIdx >= 0) {
    const seg = state.playlist[state.playIdx];
    parentId = seg.id;
    anchorMs = Math.floor(player.currentTime * 1000);
    resume = { msgId: seg.id, atSec: player.currentTime };
    player.pause();
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 960 } },
      audio: true,
    });
  } catch (err) {
    alert('Camera/mic access is needed to record. ' + err.message);
    if (resume) playFrom(resume.msgId, resume.atSec);
    return;
  }

  const videoMime = [
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm',
  ].find(m => MediaRecorder.isTypeSupported(m)) || '';
  const audioMime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']
    .find(m => MediaRecorder.isTypeSupported(m)) || '';

  // record video + a small audio-only track (the audio is what gets transcribed)
  const recorder = new MediaRecorder(stream, videoMime ? { mimeType: videoMime } : {});
  const audioRecorder = new MediaRecorder(
    new MediaStream(stream.getAudioTracks()),
    { ...(audioMime && { mimeType: audioMime }), audioBitsPerSecond: 64000 }
  );
  const vChunks = [], aChunks = [];
  recorder.ondataavailable = e => e.data.size && vChunks.push(e.data);
  audioRecorder.ondataavailable = e => e.data.size && aChunks.push(e.data);
  let stoppedCount = 0;
  const onStop = () => {
    if (++stoppedCount < 2) return;
    uploadRecording(
      new Blob(vChunks, { type: recorder.mimeType }),
      new Blob(aChunks, { type: audioRecorder.mimeType }),
      state.rec
    );
  };
  recorder.onstop = onStop;
  audioRecorder.onstop = onStop;

  preview.srcObject = stream;
  preview.play();
  showPip('record');
  $('#rec-btn').classList.add('recording');

  state.rec = { recorder, audioRecorder, stream, startTs: Date.now(), parentId, anchorMs, resume };
  recorder.start();
  audioRecorder.start();
  updateHint();
}

function stopRecord() {
  const rec = state.rec;
  if (!rec) return;
  rec.recorder.stop(); // uploadRecording fires once both recorders stop
  rec.audioRecorder.stop();
  rec.stream.getTracks().forEach(t => t.stop());
  preview.srcObject = null;
  $('#rec-btn').classList.remove('recording');
}

async function uploadRecording(videoBlob, audioBlob, rec) {
  state.rec = null;
  updateHint('Sending…');
  const fd = new FormData();
  fd.append('video', videoBlob, `note.${videoBlob.type.includes('mp4') ? 'mp4' : 'webm'}`);
  if (audioBlob && audioBlob.size) {
    fd.append('audio', audioBlob, `audio.${audioBlob.type.includes('mp4') ? 'm4a' : 'webm'}`);
  }
  fd.append('author', state.name || 'anon');
  fd.append('durationMs', String(Date.now() - rec.startTs));
  if (rec.parentId) {
    fd.append('parentId', rec.parentId);
    fd.append('anchorMs', String(rec.anchorMs));
  }
  try {
    const res = await fetch(`/api/chats/${state.chatId}/messages`, { method: 'POST', body: fd });
    const { message } = await res.json();
    // your own message never shows as "new" to you
    state.seen[message.id] = 10 * 60 * 60 * 1000;
    localStorage.setItem(`splitty:seen:${state.chatId}`, JSON.stringify(state.seen));
  } catch {
    alert('Upload failed — check the server.');
  }
  await poll();
  if (rec.resume) playFrom(rec.resume.msgId, rec.resume.atSec);
  else hidePip();
  updateHint();
}

// recording timer + hint line
setInterval(() => {
  if (state.rec) {
    const s = Math.floor((Date.now() - state.rec.startTs) / 1000);
    updateHint(`● Recording ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} — tap to send`);
  }
}, 250);

function updateHint(text) {
  $('#rec-hint').textContent =
    text ??
    (state.rec ? '' :
     state.playing ? 'Tap record to jump in — playback pauses, then picks back up' :
     'Tap record to leave a video note');
}

// ---------- pip ----------
function showPip(mode, label = '') {
  $('#pip').classList.remove('hidden');
  player.classList.toggle('hidden', mode !== 'play');
  preview.classList.toggle('hidden', mode !== 'record');
  $('#pip-label').textContent = mode === 'record' ? '● you' : label;
}
function hidePip() {
  if (state.rec || state.playing) return;
  $('#pip').classList.add('hidden');
}

// ---------- rendering ----------
function render() {
  const key = JSON.stringify(state.messages.map(m => [m.id, m.transcriptStatus, m.words.length]));
  if (key === state.lastRenderKey) return;
  state.lastRenderKey = key;

  const box = $('#messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 200;
  box.innerHTML = '';

  if (!state.messages.length) {
    box.innerHTML = '<div class="empty">Nothing here yet.<br>Record the first video note 👇</div>';
    return;
  }

  for (const msg of roots()) box.appendChild(renderMessage(msg, 0));
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

function renderMessage(msg, depth) {
  const seenMs = state.seen[msg.id] || 0;
  const mine = msg.author === state.name;
  const isNew = !mine && (msg.words.length ? msg.words.some(w => w.s * 1000 > seenMs) : seenMs === 0);

  const card = document.createElement('div');
  card.className = `msg depth-${Math.min(depth, 4)}${isNew ? ' is-new' : ''}${mine ? ' mine' : ''}`;

  const head = document.createElement('div');
  head.className = 'msg-head';
  head.innerHTML = `<button class="play-btn" title="Play from start">▶</button>
    <span class="author">${escapeHtml(msg.author)}</span>
    <span class="time">${fmtTime(msg.createdAt)}</span>
    ${isNew ? '<span class="badge">new</span>' : ''}`;
  head.querySelector('.play-btn').onclick = () => playFrom(msg.id, 0);
  card.appendChild(head);

  const body = document.createElement('div');
  body.className = 'msg-body';

  if (msg.transcriptStatus === 'pending') {
    body.innerHTML = '<span class="muted">Transcribing…</span>';
  } else if (msg.transcriptStatus === 'failed' || msg.transcriptStatus === 'no-key') {
    body.innerHTML = `<span class="muted">(no transcript — <a href="#" class="tap-play">tap to play</a>)</span>`;
    body.querySelector('.tap-play').onclick = e => { e.preventDefault(); playFrom(msg.id, 0); };
  }

  // interleave words with interjections, split at each anchor
  const kids = childrenOf(msg.id);
  let wi = 0;
  const flushWordsUntil = untilSec => {
    const frag = document.createDocumentFragment();
    while (wi < msg.words.length && (untilSec == null || msg.words[wi].s < untilSec)) {
      const w = msg.words[wi];
      const span = document.createElement('span');
      span.className = 'word' + (!mine && w.s * 1000 > seenMs ? ' unseen' : '');
      span.dataset.mid = msg.id;
      span.dataset.i = wi;
      span.dataset.t = w.s;
      span.textContent = w.w;
      span.onclick = () => playFrom(msg.id, w.s + 0.001);
      frag.appendChild(span);
      frag.appendChild(document.createTextNode(' '));
      wi++;
    }
    return frag;
  };

  for (const kid of kids) {
    body.appendChild(flushWordsUntil((kid.anchorMs || 0) / 1000));
    body.appendChild(renderMessage(kid, depth + 1));
  }
  body.appendChild(flushWordsUntil(null));

  card.appendChild(body);
  return card;
}

const fmtTime = ts => {
  const d = new Date(ts);
  const today = new Date().toDateString() === d.toDateString();
  return (today ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ') +
    d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};

const escapeHtml = s => s.replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
