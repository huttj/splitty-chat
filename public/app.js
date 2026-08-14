// splitty — interruptible async video conversations

const $ = s => document.querySelector(s);

const state = {
  chatId: null,
  name: localStorage.getItem('splitty:name') || '',
  messages: [],
  byId: new Map(),
  seen: {},          // msgId -> furthest played ms
  playlist: [],      // flat segments [{id, start, end, vStart, vEnd}] on the virtual timeline
  vDur: 0,
  playIdx: -1,
  playing: false,    // a playback session is active (may be paused)
  playLabel: '',     // author of what's on screen
  activeIdx: 0,      // which of the two <video> elements is live
  speed: 1,
  rec: null,         // { recorder, audioRecorder, startTs, parentId, anchorMs, resume, discard }
  undo: [],          // anchor moves: { id, prev }
  scrubbing: false,
  dragging: null,    // { msg, target } while re-anchoring an interjection
  lastRenderKey: '',
};

const USER_COLORS = ['#7c5cff', '#4dc9b0', '#e08bff', '#ffa94d', '#5db3ff', '#ff6b9d', '#9ee36b', '#ffd166'];
function colorFor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return USER_COLORS[h % USER_COLORS.length];
}

const players = [$('#player-a'), $('#player-b')];
const preview = $('#preview');
const activeEl = () => players[state.activeIdx];
const standbyEl = () => players[state.activeIdx ^ 1];
const mediaUrl = msg => `${location.origin}/media/${msg.file}`;

// ---------- boot ----------
const chatMatch = location.pathname.match(/^\/c\/([A-Za-z0-9_-]+)/);
if (chatMatch) {
  state.chatId = chatMatch[1];
  initChat();
} else if (location.pathname === '/admin') {
  initAdmin();
} else {
  initLanding();
}

// ---------- always-on camera ----------
let camStream = null;
async function ensureCam() {
  if (camStream && camStream.active) return camStream;
  camStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 960 } },
    audio: true,
  });
  preview.srcObject = camStream;
  preview.play();
  return camStream;
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
  if (!recent.length) return;
  const box = $('#recent-chats');
  box.innerHTML = '<h3>Your chats</h3>';
  const rows = new Map();
  for (const r of recent.slice(0, 10)) {
    const a = document.createElement('a');
    a.href = `/c/${r.id}`;
    a.className = 'recent-chat';
    a.innerHTML = `<span class="rc-names">…</span><span class="rc-unread"></span><span class="rc-meta">${new Date(r.ts).toLocaleDateString()}</span>`;
    box.appendChild(a);
    rows.set(r.id, a);
  }
  // fill in who's in each chat
  fetch('/api/chats/lookup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [...rows.keys()] }),
  })
    .then(r => r.json())
    .then(({ chats }) => {
      const gone = [];
      for (const c of chats) {
        const row = rows.get(c.id);
        if (!row) continue;
        if (!c.exists) { row.remove(); gone.push(c.id); continue; }
        const others = (c.participants || []).filter(n => n !== state.name);
        row.querySelector('.rc-names').textContent =
          others.length ? `with ${others.join(', ')}` : c.count ? 'just you so far' : 'empty chat';
        row.querySelector('.rc-meta').textContent = `${c.count} note${c.count === 1 ? '' : 's'}`;
        // unread minutes, from this browser's listened-to positions
        const seen = JSON.parse(localStorage.getItem(`splitty:seen:${c.id}`) || '{}');
        let unreadMs = 0;
        for (const msg of c.messages || []) {
          if (msg.author === state.name) continue;
          const dur = msg.durationMs || 0;
          const remaining = dur - Math.min(seen[msg.id] || 0, dur);
          if (remaining > 1000) unreadMs += remaining;
        }
        row.querySelector('.rc-unread').textContent =
          unreadMs >= 60000 ? `${Math.round(unreadMs / 60000)} min new`
          : unreadMs > 0 ? '<1 min new' : '';
      }
      if (gone.length) {
        const kept = JSON.parse(localStorage.getItem('splitty:recent') || '[]')
          .filter(r => !gone.includes(r.id));
        localStorage.setItem('splitty:recent', JSON.stringify(kept));
      }
    })
    .catch(() => {});
}

// ---------- admin ----------
function initAdmin() {
  $('#admin').classList.remove('hidden');
  $('#admin-login').onsubmit = e => {
    e.preventDefault();
    sessionStorage.setItem('splitty:admin', $('#admin-pass').value);
    loadAdmin();
  };
  loadAdmin();
}

async function loadAdmin() {
  const pass = sessionStorage.getItem('splitty:admin');
  const form = $('#admin-login'), list = $('#admin-list');
  if (!pass) { form.classList.remove('hidden'); return; }
  const res = await fetch('/api/admin/chats', { headers: { Authorization: `Bearer ${pass}` } });
  if (!res.ok) {
    sessionStorage.removeItem('splitty:admin');
    form.classList.remove('hidden');
    list.innerHTML = `<p class="muted">${res.status === 401 ? 'Wrong password.' : 'Admin not available.'}</p>`;
    return;
  }
  form.classList.add('hidden');
  const { chats } = await res.json();
  list.innerHTML = chats.length ? '' : '<p class="muted">No chats yet.</p>';
  for (const c of chats) {
    const row = document.createElement('div');
    row.className = 'admin-row';
    row.innerHTML = `
      <div class="admin-info">
        <a href="/c/${c.id}" target="_blank">${c.id}</a>
        <span>${c.participants.length ? escapeHtml(c.participants.join(', ')) : '<em class="muted">empty</em>'}</span>
        <span class="muted">${c.count} note${c.count === 1 ? '' : 's'} · created ${new Date(c.createdAt).toLocaleString()}${
          c.lastActivity ? ' · last activity ' + new Date(c.lastActivity).toLocaleString() : ''}</span>
      </div>
      <button class="btn-danger">Delete</button>`;
    row.querySelector('.btn-danger').onclick = async () => {
      if (!confirm(`Permanently delete chat ${c.id} and its ${c.count} videos?`)) return;
      await fetch(`/api/admin/chats/${c.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${pass}` },
      });
      loadAdmin();
    };
    list.appendChild(row);
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

  for (const el of players) {
    el.addEventListener('click', () => togglePause());
    el.addEventListener('timeupdate', e => e.target === activeEl() && onTimeUpdate());
    el.addEventListener('ended', e => e.target === activeEl() && advanceSegment());
    el.addEventListener('error', e => {
      if (state.playing && e.target === activeEl()) {
        showToast("Couldn't play that one — skipping");
        advanceSegment();
      }
    });
    el.addEventListener('play', e => e.target === activeEl() && ($('#btn-play').textContent = '⏸'));
    el.addEventListener('pause', e => e.target === activeEl() && ($('#btn-play').textContent = '▶'));
    el.addEventListener('loadedmetadata', e => {
      const v = e.target;
      if (v._pendingSeek != null) {
        v.currentTime = v._pendingSeek;
        v._pendingSeek = null;
      }
      v.playbackRate = state.speed;
      if (v._autoplay) {
        v._autoplay = false;
        v.play();
      }
    });
  }

  $('#btn-play').onclick = togglePause;
  $('#btn-back').onclick = () => skip(-10);
  $('#btn-fwd').onclick = () => skip(10);

  // playback speed
  const SPEEDS = [1, 1.25, 1.5, 2, 3];
  state.speed = Number(localStorage.getItem('splitty:speed')) || 1;
  if (!SPEEDS.includes(state.speed)) state.speed = 1;
  const speedBtn = $('#btn-speed');
  speedBtn.textContent = `${state.speed}×`;
  speedBtn.onclick = () => {
    state.speed = SPEEDS[(SPEEDS.indexOf(state.speed) + 1) % SPEEDS.length];
    localStorage.setItem('splitty:speed', String(state.speed));
    players.forEach(p => (p.playbackRate = state.speed));
    speedBtn.textContent = `${state.speed}×`;
  };

  // draggable divider: side-by-side on wide screens, video height on portrait
  const chatEl = $('#chat');
  const savedSplit = localStorage.getItem('splitty:split');
  if (savedSplit) chatEl.style.setProperty('--split', savedSplit);
  const savedStageH = localStorage.getItem('splitty:stageh');
  if (savedStageH) chatEl.style.setProperty('--stageh', savedStageH);
  $('#splitter').addEventListener('pointerdown', e => {
    e.preventDefault();
    const wide = window.matchMedia('(min-width: 880px)').matches;
    const onMove = ev => {
      if (wide) {
        const px = Math.min(Math.max(ev.clientX, 280), window.innerWidth - 380);
        chatEl.style.setProperty('--split', `${px}px`);
      } else {
        const top = $('#stage').getBoundingClientRect().top;
        const h = Math.min(Math.max(ev.clientY - top - 16, 120), window.innerHeight * 0.7);
        chatEl.style.setProperty('--stageh', `${h}px`);
      }
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      localStorage.setItem('splitty:split', chatEl.style.getPropertyValue('--split'));
      localStorage.setItem('splitty:stageh', chatEl.style.getPropertyValue('--stageh'));
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp, { once: true });
  });

  // undo anchor moves with cmd/ctrl+Z
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
      e.preventDefault();
      undoLast();
    }
  });
  const scrubber = $('#scrubber');
  let lastScrubPreview = 0;
  scrubber.addEventListener('pointerdown', () => (state.scrubbing = true));
  scrubber.addEventListener('input', () => {
    const vt = Number(scrubber.value);
    updateTimeLabel(vt);
    // live (throttled) frame preview while dragging
    const now = performance.now();
    if (now - lastScrubPreview > 150) {
      lastScrubPreview = now;
      previewVirtual(vt);
    }
  });
  scrubber.addEventListener('change', () => {
    state.scrubbing = false;
    seekVirtual(Number(scrubber.value));
  });

  // fill (crop to fit) vs fit (letterbox, whole frame visible)
  const applyFit = () => {
    $('#video-box').classList.toggle('fit-contain', state.fit === 'contain');
    $('#fit-btn').textContent = state.fit === 'contain' ? 'Fill' : 'Fit'; // button shows the alternative
  };
  state.fit = localStorage.getItem('splitty:fit') || 'cover';
  applyFit();
  $('#fit-btn').onclick = () => {
    state.fit = state.fit === 'cover' ? 'contain' : 'cover';
    localStorage.setItem('splitty:fit', state.fit);
    applyFit();
  };

  if (!state.name) {
    $('#name-gate').classList.remove('hidden');
    $('#name-form').onsubmit = e => {
      e.preventDefault();
      state.name = $('#name-input').value.trim();
      if (!state.name) return;
      localStorage.setItem('splitty:name', state.name);
      $('#name-gate').classList.add('hidden');
      ensureCam().then(updateStage).catch(() => {});
    };
  } else {
    // camera warms up immediately so recording is instant; stage shows you while idle
    ensureCam().then(updateStage).catch(() => {});
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

function msgDur(msg) {
  if (msg.durationMs) return msg.durationMs / 1000;
  if (msg.words.length) return msg.words[msg.words.length - 1].e + 0.6;
  return 3;
}

// Expand a message into playable segments, interleaving interjections at their anchors.
function segmentsFor(msg) {
  const dur = msgDur(msg);
  const segs = [];
  let cursor = 0;
  for (const kid of childrenOf(msg.id)) {
    const t = Math.min((kid.anchorMs || 0) / 1000, dur);
    if (t > cursor) segs.push({ id: msg.id, start: cursor, end: t });
    segs.push(...segmentsFor(kid));
    cursor = Math.max(cursor, t);
  }
  if (cursor < dur || !segs.length) segs.push({ id: msg.id, start: cursor, end: Math.max(dur, cursor) });
  return segs;
}

// The virtual timeline: every segment of the whole conversation stacked end to end.
function buildPlaylist() {
  const segs = roots().flatMap(segmentsFor);
  let v = 0;
  for (const s of segs) {
    s.vStart = v;
    v += s.end - s.start;
    s.vEnd = v;
  }
  state.playlist = segs;
  state.vDur = v;
  const scrubber = $('#scrubber');
  scrubber.max = Math.max(v, 0.1);
  renderTicks();
}

// the seek track is a map of the conversation, color-coded by speaker
function renderTicks() {
  const box = $('#ticks');
  box.innerHTML = '';
  if (state.vDur <= 0) return;
  for (const s of state.playlist) {
    const msg = state.byId.get(s.id);
    const seg = document.createElement('div');
    seg.className = 'seg';
    seg.style.left = `${(s.vStart / state.vDur) * 100}%`;
    seg.style.width = `${((s.vEnd - s.vStart) / state.vDur) * 100}%`;
    seg.style.background = msg ? colorFor(msg.author) : '#2a2e3a';
    box.appendChild(seg);
  }
}

// ---------- playback ----------
function playFrom(msgId, atSec) {
  buildPlaylist();
  let idx = state.playlist.findIndex(
    s => s.id === msgId && atSec >= s.start - 0.001 && atSec < s.end
  );
  if (idx === -1) {
    // past the estimated end — take the message's last segment
    idx = state.playlist.findLastIndex(s => s.id === msgId);
    if (idx === -1) return;
    atSec = Math.min(atSec, state.playlist[idx].end - 0.05);
  }
  playSegment(idx, Math.max(atSec, state.playlist[idx].start));
}

function playSegment(idx, offset) {
  const seg = state.playlist[idx];
  const msg = state.byId.get(seg.id);
  if (!msg) return stopPlayback();
  state.playIdx = idx;
  state.playing = true;
  const src = mediaUrl(msg);
  const at = offset != null ? offset : seg.start;
  const stb = standbyEl();

  if (offset == null && stb._preparedKey === segKey(seg) && stb.readyState >= 2) {
    // seamless handoff: the standby element is already loaded and parked at seg.start
    activeEl().pause();
    state.activeIdx ^= 1;
    activeEl().play();
  } else {
    const el = activeEl();
    if (el.src === src) {
      el.currentTime = at;
      el.play();
    } else {
      el._pendingSeek = at;
      el._autoplay = true;
      el.src = src;
    }
  }
  players.forEach(p => (p.playbackRate = state.speed));
  prepareNext(idx);
  state.playLabel = msg.author;
  updateStage();
  updateHint();
}

const segKey = seg => `${seg.id}@${seg.start.toFixed(3)}`;

// Park the *other* video element on the next segment so the switch is instant.
function prepareNext(idx) {
  const nseg = state.playlist[idx + 1];
  const stb = standbyEl();
  if (!nseg) { stb._preparedKey = null; return; }
  const nmsg = state.byId.get(nseg.id);
  if (!nmsg) return;
  const key = segKey(nseg);
  if (stb._preparedKey === key) return;
  const nsrc = mediaUrl(nmsg);
  stb._autoplay = false;
  if (stb.src === nsrc && stb.readyState >= 1) {
    stb.currentTime = nseg.start;
  } else {
    stb._pendingSeek = nseg.start;
    stb.preload = 'auto';
    stb.src = nsrc;
  }
  stb._preparedKey = key;
}

function advanceSegment() {
  if (!state.playing) return;
  const cur = state.playlist[state.playIdx];
  if (cur) markSeen(cur.id, Math.ceil(cur.end * 1000)); // finished segments count as fully heard
  if (state.playIdx + 1 < state.playlist.length) playSegment(state.playIdx + 1);
  else stopPlayback();
}

function stopPlayback() {
  state.playing = false;
  state.playIdx = -1;
  for (const el of players) { el.pause(); el._preparedKey = null; }
  updateStage();
  clearWordHighlight();
  updateHint();
}

function togglePause() {
  if (!state.playing) return;
  const el = activeEl();
  el.paused ? el.play() : el.pause();
}

function currentVT() {
  const seg = state.playlist[state.playIdx];
  if (!seg) return 0;
  const within = Math.min(Math.max(activeEl().currentTime - seg.start, 0), seg.end - seg.start);
  return seg.vStart + within;
}

function seekVirtual(vt) {
  if (!state.playlist.length) return;
  vt = Math.min(Math.max(vt, 0), Math.max(state.vDur - 0.05, 0));
  let idx = state.playlist.findIndex(s => vt < s.vEnd);
  if (idx === -1) idx = state.playlist.length - 1;
  const seg = state.playlist[idx];
  playSegment(idx, seg.start + (vt - seg.vStart));
}

function skip(delta) {
  if (state.playing) seekVirtual(currentVT() + delta);
}

// show the frame at a virtual time without playing (used while dragging the scrubber)
function previewVirtual(vt) {
  if (!state.playing || !state.playlist.length) return;
  vt = Math.min(Math.max(vt, 0), Math.max(state.vDur - 0.05, 0));
  let idx = state.playlist.findIndex(s => vt < s.vEnd);
  if (idx === -1) idx = state.playlist.length - 1;
  const seg = state.playlist[idx];
  const msg = state.byId.get(seg.id);
  if (!msg) return;
  const at = seg.start + (vt - seg.vStart);
  const el = activeEl();
  const src = mediaUrl(msg);
  state.playIdx = idx;
  state.playLabel = msg.author;
  $('#pip-label').textContent = msg.author;
  el.pause();
  if (el.src !== src) {
    el._pendingSeek = at;
    el._autoplay = false;
    el.src = src;
  } else {
    el.currentTime = at;
  }
}

const fmtClock = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function updateTimeLabel(vt) {
  $('#time-label').textContent = `${fmtClock(vt)} / ${fmtClock(state.vDur)}`;
}

let seenSaveTimer = null;
function markSeen(id, ms) {
  if (ms > (state.seen[id] || 0)) {
    state.seen[id] = ms;
    clearTimeout(seenSaveTimer);
    seenSaveTimer = setTimeout(
      () => localStorage.setItem(`splitty:seen:${state.chatId}`, JSON.stringify(state.seen)),
      500
    );
  }
}

function onTimeUpdate() {
  if (!state.playing || state.playIdx < 0) return;
  if (state.scrubbing) return; // paused preview seeks — don't advance or mark seen
  const seg = state.playlist[state.playIdx];
  const t = activeEl().currentTime;

  if (t >= seg.end - 0.05) return advanceSegment();

  $('#scrubber').value = currentVT();
  updateTimeLabel(currentVT());

  // track furthest-played for "new" highlighting
  markSeen(seg.id, Math.floor(t * 1000));

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

// after new data arrives mid-playback, remap our position onto the fresh playlist
function remapPlayback() {
  if (!state.playing || state.playIdx < 0) return;
  const seg = state.playlist[state.playIdx];
  const msgId = seg?.id;
  const t = activeEl().currentTime;
  buildPlaylist();
  if (!msgId) return;
  let idx = state.playlist.findIndex(s => s.id === msgId && t >= s.start - 0.001 && t < s.end);
  if (idx === -1) idx = state.playlist.findLastIndex(s => s.id === msgId);
  state.playIdx = idx;
  if (idx >= 0) prepareNext(idx);
}

// ---------- recording ----------
async function toggleRecord() {
  if (state.rec) return stopRecord();

  // interjecting? capture where we are, pause the playback
  let parentId = null, anchorMs = null, resume = null;
  if (state.playing && state.playIdx >= 0) {
    const seg = state.playlist[state.playIdx];
    parentId = seg.id;
    anchorMs = Math.floor(activeEl().currentTime * 1000);
    resume = { msgId: seg.id, atSec: activeEl().currentTime };
    activeEl().pause();
  }

  let stream;
  try {
    stream = await ensureCam(); // already warm in the normal case — instant start
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

  // record video + a small audio-only track (the audio is what gets transcribed);
  // capped bitrate keeps uploads fast
  const recorder = new MediaRecorder(stream, {
    ...(videoMime && { mimeType: videoMime }),
    videoBitsPerSecond: 1_500_000,
  });
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
    const rec = state.rec;
    state.rec = null;
    if (rec.discard) {
      // accidental tap — 79ms videos help nobody
      showToast('Too short — tap record, talk, then tap again to send');
      updateStage();
      updateHint();
      if (rec.resume) playFrom(rec.resume.msgId, rec.resume.atSec);
      return;
    }
    uploadRecording(
      new Blob(vChunks, { type: recorder.mimeType }),
      new Blob(aChunks, { type: audioRecorder.mimeType }),
      rec
    );
  };
  recorder.onstop = onStop;
  audioRecorder.onstop = onStop;

  $('#rec-btn').classList.add('recording');

  state.rec = { recorder, audioRecorder, startTs: Date.now(), parentId, anchorMs, resume };
  recorder.start();
  audioRecorder.start();
  updateStage();
  updateHint();
}

function stopRecord() {
  const rec = state.rec;
  if (!rec) return;
  if (Date.now() - rec.startTs < 700) rec.discard = true;
  rec.recorder.stop(); // uploadRecording fires once both recorders stop
  rec.audioRecorder.stop();
  // the camera stream stays live — it's the always-on preview
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
    const { message } = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/chats/${state.chatId}/messages`);
      xhr.upload.onprogress = e =>
        e.lengthComputable && updateHint(`Sending… ${Math.round((e.loaded / e.total) * 100)}%`);
      xhr.onload = () =>
        xhr.status < 300 ? resolve(JSON.parse(xhr.responseText)) : reject(new Error(`upload ${xhr.status}`));
      xhr.onerror = () => reject(new Error('network'));
      xhr.send(fd);
    });
    // your own message never shows as "new" to you
    state.seen[message.id] = 10 * 60 * 60 * 1000;
    localStorage.setItem(`splitty:seen:${state.chatId}`, JSON.stringify(state.seen));
  } catch {
    alert('Upload failed — check the server.');
  }
  await poll();
  if (rec.resume) playFrom(rec.resume.msgId, rec.resume.atSec);
  else updateStage();
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

// ---------- stage (video area) ----------
// modes: record → your camera fills the box; play → their video with your camera
// as a corner PiP; self → idle, just your camera; none → no camera yet, hide stage
function updateStage() {
  const stage = $('#stage');
  const box = $('#video-box');
  const mode = state.rec ? 'record' : state.playing ? 'play' : camStream ? 'self' : 'none';
  if (mode === 'none') { stage.classList.add('hidden'); return; }
  stage.classList.remove('hidden');
  box.classList.toggle('mode-play', mode === 'play');
  box.classList.toggle('mode-record', mode === 'record');
  preview.classList.toggle('hidden', !camStream);
  activeEl().classList.toggle('hidden', mode !== 'play');
  standbyEl().classList.add('hidden');
  $('#transport').classList.toggle('hidden', mode !== 'play');
  $('#pip-label').textContent =
    mode === 'record' ? '● you' : mode === 'play' ? state.playLabel : 'you';
}

// ---------- toast + undo ----------
let toastTimer = null;
function showToast(msg, btnLabel, onClick) {
  $('#toast-msg').textContent = msg;
  const b = $('#toast-btn');
  b.classList.toggle('hidden', !btnLabel);
  if (btnLabel) {
    b.textContent = btnLabel;
    b.onclick = () => { $('#toast').classList.add('hidden'); onClick(); };
  }
  $('#toast').classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.add('hidden'), 6000);
}

async function patchAnchor(msgId, anchorMs) {
  const res = await fetch(`/api/chats/${state.chatId}/messages/${msgId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ anchorMs, author: state.name }),
  });
  state.lastRenderKey = '';
  await poll();
  return res.ok;
}

function undoLast() {
  const u = state.undo.pop();
  if (!u) return;
  patchAnchor(u.id, u.prev).then(ok => ok && showToast('Move undone'));
}

// ---------- drag an interjection to move its split point ----------
function startAnchorDrag(e, msg) {
  e.preventDefault();
  state.dragging = { msg, target: null };
  document.body.classList.add('dragging-anchor');

  const setTarget = el => {
    state.dragging.target?.classList.remove('drop-target');
    state.dragging.target = el;
    el?.classList.add('drop-target');
  };
  const onMove = ev => {
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    setTarget(el?.classList?.contains('word') && el.dataset.mid === msg.parentId ? el : null);
  };
  const onUp = async () => {
    document.removeEventListener('pointermove', onMove);
    document.body.classList.remove('dragging-anchor');
    const target = state.dragging.target;
    target?.classList.remove('drop-target');
    state.dragging = null;
    if (!target) return;
    const prev = msg.anchorMs;
    const anchorMs = Math.round(Number(target.dataset.t) * 1000);
    if (anchorMs === prev) return;
    if (await patchAnchor(msg.id, anchorMs)) {
      state.undo.push({ id: msg.id, prev });
      showToast('Moved', 'Undo', undoLast);
    }
  };
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp, { once: true });
}

// ---------- rendering ----------
function render() {
  if (state.dragging) return; // don't rebuild the DOM out from under a drag
  const key = JSON.stringify(state.messages.map(m => [m.id, m.transcriptStatus, m.words.length, m.anchorMs]));
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

  remapPlayback();
}

function renderMessage(msg, depth) {
  const seenMs = state.seen[msg.id] || 0;
  const mine = msg.author === state.name;
  const isNew = !mine && (msg.words.length ? msg.words.some(w => w.s * 1000 > seenMs) : seenMs === 0);

  const card = document.createElement('div');
  card.className = `msg${isNew ? ' is-new' : ''}${mine ? ' mine' : ''}`;
  card.style.borderLeftColor = colorFor(msg.author); // color-coded by speaker

  const head = document.createElement('div');
  head.className = 'msg-head';
  head.innerHTML = `<button class="play-btn" title="Play from start">▶</button>
    <span class="author"></span>
    <span class="time">${fmtTime(msg.createdAt)}</span>
    <span class="dur">${fmtClock(msgDur(msg))}</span>
    ${isNew ? '<span class="badge">new</span>' : ''}
    <span class="spacer"></span>
    ${mine && depth > 0 ? '<span class="drag-handle" title="Drag onto a word to move where this interjects">⠿</span>' : ''}
    ${mine ? '<button class="del-btn" title="Delete this message">✕</button>' : ''}`;
  const authorEl = head.querySelector('.author');
  authorEl.textContent = msg.author;
  authorEl.style.color = colorFor(msg.author);
  head.querySelector('.play-btn').onclick = () => playFrom(msg.id, 0);
  const handle = head.querySelector('.drag-handle');
  if (handle) handle.addEventListener('pointerdown', e => startAnchorDrag(e, msg));
  const delBtn = head.querySelector('.del-btn');
  if (delBtn) delBtn.onclick = async () => {
    if (!confirm('Delete this message for everyone? Replies to it will attach where it was.')) return;
    await fetch(`/api/chats/${state.chatId}/messages/${msg.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: state.name }),
    });
    if (state.playing) stopPlayback();
    state.lastRenderKey = '';
    await poll();
  };
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
