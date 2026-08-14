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
  cued: false,       // opening cue-up (earliest unheard) done
  hideGaps: localStorage.getItem('splitty:hidegaps') === '1', // clip silences from playback
  dragging: null,    // { msg, target } while re-anchoring an interjection
  lastRenderKey: '',
};

// name comparison is forgiving about case/whitespace so "Josh " on your phone
// still owns what "josh" recorded on your laptop
const normName = s => (s || '').trim().toLowerCase();
const isMine = author => normName(author) === normName(state.name);

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
// session first: signed-in users take their account name everywhere
const chatMatch = location.pathname.match(/^\/c\/([A-Za-z0-9_-]+)/);
fetch('/api/me')
  .then(r => r.json())
  .catch(() => ({ user: null, providers: {}, authEnabled: false }))
  .then(me => {
    state.auth = me;
    if (me.user) {
      state.name = me.user.name;
      localStorage.setItem('splitty:name', me.user.name);
    }
    if (chatMatch) {
      state.chatId = chatMatch[1];
      initChat();
    } else if (location.pathname === '/admin') {
      initAdmin();
    } else {
      initLanding();
    }
  });

// ---------- prefetch ----------
// Quietly pull videos into the browser HTTP cache (media responses are
// immutable) so tapping any unheard message starts instantly. One download at
// a time, capped budget, skips Save-Data connections and hidden tabs.
const prefetch = { done: new Set(), queue: [], running: false, bytes: 0, BUDGET: 80 * 1024 * 1024 };

function enqueuePrefetch(files, front = false) {
  if (navigator.connection?.saveData) return;
  const fresh = files.filter(f => f && !prefetch.done.has(f) && !prefetch.queue.includes(f));
  if (!fresh.length) return;
  prefetch.queue = front ? [...fresh, ...prefetch.queue] : [...prefetch.queue, ...fresh];
  runPrefetch();
}

async function runPrefetch() {
  if (prefetch.running) return;
  prefetch.running = true;
  while (prefetch.queue.length && prefetch.bytes < prefetch.BUDGET) {
    if (document.hidden) break; // resume on the next enqueue
    const file = prefetch.queue.shift();
    if (prefetch.done.has(file)) continue;
    try {
      const res = await fetch(`/media/${file}`, { priority: 'low' });
      if (res.ok) {
        const buf = await res.blob(); // consuming the body lands it in the HTTP cache
        prefetch.bytes += buf.size;
        prefetch.done.add(file);
      }
    } catch { /* offline blip — drop it, playback will fetch on demand */ }
  }
  prefetch.running = false;
}

// everything unheard, in the order the conversation would play it
function prefetchUnheard() {
  if (!state.playlist.length) buildPlaylist();
  const files = [];
  for (const seg of state.playlist) {
    const msg = state.byId.get(seg.id);
    if (!msg || isMine(msg.author)) continue;
    if ((state.seen[msg.id] || 0) < (msg.durationMs || 0) - 500) files.push(msg.file);
  }
  enqueuePrefetch([...new Set(files)]);
}

// ---------- audio normalization ----------
// Playback runs through a shared compressor (levels within-clip swings), and each
// message carries a client-measured gain (levels quiet vs loud speakers).
let audioCtx = null, compressorIn = null;
function audioChainFor(el) {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const comp = audioCtx.createDynamicsCompressor();
      comp.threshold.value = -24;
      comp.knee.value = 12;
      comp.ratio.value = 3;
      comp.attack.value = 0.01;
      comp.release.value = 0.25;
      const makeup = audioCtx.createGain();
      makeup.gain.value = 1.25;
      comp.connect(makeup).connect(audioCtx.destination);
      compressorIn = comp;
      // autoplay policy can leave the context suspended — any tap wakes it
      document.addEventListener('pointerdown', () => audioCtx.resume(), { capture: true });
    }
    if (!el._gainNode) {
      const src = audioCtx.createMediaElementSource(el);
      el._gainNode = audioCtx.createGain();
      src.connect(el._gainNode).connect(compressorIn);
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return el._gainNode;
  } catch {
    return null; // chain failed — element keeps its direct audio path
  }
}

function setMsgGain(el, msg) {
  const node = audioChainFor(el);
  if (node) node.gain.value = msg?.gain || 1;
}

// average RMS of the non-silent blocks, mapped to a bounded correction gain
async function measureGain(blob) {
  try {
    const ctx = new OfflineAudioContext(1, 8000, 16000);
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const data = buf.getChannelData(0);
    let sum = 0, n = 0;
    for (let i = 0; i < data.length; i += 2048) {
      let s = 0;
      const end = Math.min(i + 2048, data.length);
      for (let j = i; j < end; j++) s += data[j] * data[j];
      const rms = Math.sqrt(s / (end - i));
      if (rms > 0.01) { sum += rms; n++; } // skip silence so pauses don't skew it
    }
    if (!n) return 1;
    return Math.min(Math.max(0.1 / (sum / n), 0.5), 4); // target ≈ -20 dBFS
  } catch {
    return 1;
  }
}

// ---------- always-on camera ----------
let camStream = null;
let camError = null;
async function ensureCam() {
  if (camStream && camStream.active) return camStream;
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 960 } },
      audio: true,
    });
  } catch (err) {
    camError = err;
    $('#cam-enable')?.classList.remove('hidden');
    updateStage();
    throw err;
  }
  camError = null;
  $('#cam-enable')?.classList.add('hidden');
  preview.srcObject = camStream;
  preview.play();
  updateStage();
  return camStream;
}

// Safari only grants the camera from a real tap — retry on the first gesture,
// and keep an explicit button as the reliable path
function armCamRetry() {
  const retry = () =>
    ensureCam().catch(err => {
      if (err.name === 'NotAllowedError') {
        showToast('Camera blocked — allow it via the camera icon in the address bar');
      }
    });
  document.addEventListener('pointerdown', retry, { once: true });
  $('#cam-enable').onclick = e => { e.stopPropagation(); retry(); };
}

// wire the sign-in buttons inside the gate for a given return path
function wireAuthBox(next) {
  $('#name-form').classList.add('hidden');
  $('#auth-box').classList.remove('hidden');
  if (state.auth.providers.google) {
    $('#google-btn').classList.remove('hidden');
    $('#google-btn').href = `/auth/google?next=${encodeURIComponent(next)}`;
  }
  $('#auth-or').classList.toggle('hidden', !(state.auth.providers.google && state.auth.providers.email));
  if (state.auth.providers.email) {
    $('#email-form').classList.remove('hidden');
    $('#email-form').onsubmit = async e => {
      e.preventDefault();
      const res = await fetch('/auth/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: $('#email-input').value, next }),
      });
      $('#auth-note').textContent = (await res.json()).ok
        ? 'Check your email — the link signs you in here.'
        : "Couldn't send the email. Try again?";
    };
  }
}

// ---------- landing ----------
function initLanding() {
  $('#landing').classList.remove('hidden');
  $('#create-chat').onclick = async () => {
    if (state.auth?.authEnabled && !state.auth?.user) {
      wireAuthBox('/');
      $('#name-gate').classList.remove('hidden');
      return;
    }
    const res = await fetch('/api/chats', { method: 'POST' });
    if (!res.ok) {
      wireAuthBox('/');
      $('#name-gate').classList.remove('hidden');
      return;
    }
    const { id } = await res.json();
    location.href = `/c/${id}`;
  };
  $('#name-gate').addEventListener('click', e => {
    if (e.target === $('#name-gate')) $('#name-gate').classList.add('hidden'); // landing gate is dismissible
  });
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
        const others = (c.participants || []).filter(n => !isMine(n));
        row.querySelector('.rc-names').textContent =
          others.length ? `with ${others.join(', ')}` : c.count ? 'just you so far' : 'empty chat';
        row.querySelector('.rc-meta').textContent = `${c.count} note${c.count === 1 ? '' : 's'}`;
        // unread minutes, from this browser's listened-to positions
        const seen = JSON.parse(localStorage.getItem(`splitty:seen:${c.id}`) || '{}');
        let unreadMs = 0;
        for (const msg of c.messages || []) {
          if (isMine(msg.author)) continue;
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
let adminTab = 'chats';
function initAdmin() {
  $('#admin').classList.remove('hidden');
  $('#admin-login').onsubmit = e => {
    e.preventDefault();
    sessionStorage.setItem('splitty:admin', $('#admin-pass').value);
    loadAdmin();
  };
  $('#tab-chats').onclick = () => { adminTab = 'chats'; loadAdmin(); };
  $('#tab-users').onclick = () => { adminTab = 'users'; loadAdmin(); };
  $('#admin-search').oninput = () => loadAdmin(true);
  loadAdmin();
}

let adminCache = { chats: null, users: null };
async function loadAdmin(fromCache = false) {
  const pass = sessionStorage.getItem('splitty:admin');
  const form = $('#admin-login'), list = $('#admin-list');
  if (!pass) { form.classList.remove('hidden'); return; }
  $('#tab-chats').classList.toggle('active', adminTab === 'chats');
  $('#tab-users').classList.toggle('active', adminTab === 'users');
  const q = ($('#admin-search').value || '').trim().toLowerCase();

  if (!fromCache || !adminCache[adminTab]) {
    const res = await fetch(`/api/admin/${adminTab}`, { headers: { Authorization: `Bearer ${pass}` } });
    if (!res.ok) {
      sessionStorage.removeItem('splitty:admin');
      form.classList.remove('hidden');
      $('#admin-tabs').classList.add('hidden');
      list.innerHTML = `<p class="muted">${res.status === 401 ? 'Wrong password.' : 'Admin not available.'}</p>`;
      return;
    }
    adminCache[adminTab] = await res.json();
  }
  form.classList.add('hidden');
  $('#admin-tabs').classList.remove('hidden');

  if (adminTab === 'users') {
    const users = (adminCache.users.users || []).filter(u =>
      !q || u.name.toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q));
    list.innerHTML = users.length ? '' : '<p class="muted">No users match.</p>';
    for (const u of users) {
      const row = document.createElement('div');
      row.className = 'admin-row';
      // approved: can send · pending: can watch, one message · blocked: can't sign in
      const actions =
        u.status === 'approved'
          ? '<button class="btn-ghost act" data-s="pending">Unapprove</button><button class="btn-danger act" data-s="blocked">Block</button>'
          : u.status === 'pending'
            ? '<button class="btn-ghost act" data-s="approved">Approve</button><button class="btn-danger act" data-s="blocked">Block</button>'
            : '<button class="btn-ghost act" data-s="approved">Approve</button><button class="btn-ghost act" data-s="pending">Unblock</button>';
      row.innerHTML = `
        <div class="admin-info">
          <span>${u.picture ? `<img class="avatar" src="${escapeHtml(u.picture)}" alt="" referrerpolicy="no-referrer">` : ''}
            <b>${escapeHtml(u.name)}</b> <span class="status-pill st-${u.status}">${u.status}</span></span>
          <span class="muted">${escapeHtml(u.email || '(no email)')} · ${u.providers.join(' + ') || 'no logins'} ·
            ${u.messages} msg${u.messages === 1 ? '' : 's'} · joined ${new Date(u.createdAt).toLocaleDateString()}</span>
        </div>
        <div class="admin-actions">${actions}</div>`;
      row.querySelectorAll('.act').forEach(b => (b.onclick = async () => {
        await fetch(`/api/admin/users/${u.id}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${pass}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: b.dataset.s }),
        });
        adminCache.users = null;
        loadAdmin();
      }));
      list.appendChild(row);
    }
    return;
  }

  const chats = (adminCache.chats.chats || []).filter(c =>
    !q || c.id.toLowerCase().includes(q) || c.participants.some(p => p.toLowerCase().includes(q)));
  list.innerHTML = chats.length ? '' : '<p class="muted">No chats match.</p>';
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
  $('#stop-btn').onclick = stopPlayback; // clears the session: next record = new message
  $('#btn-stop').onclick = stopPlayback;

  // hide pauses = clip them: transcript gaps disappear AND playback skips the
  // silence, so the timeline/timestamps compress to speech-only time
  const applyGaps = () => {
    state.hideGaps = localStorage.getItem('splitty:hidegaps') === '1';
    document.body.classList.toggle('hide-gaps', state.hideGaps);
    $('#gaps-btn').textContent = state.hideGaps ? 'Show pauses' : 'Skip pauses';
    if (state.playing) remapPlayback();
    else buildPlaylist();
  };
  applyGaps();
  $('#gaps-btn').onclick = () => {
    localStorage.setItem('splitty:hidegaps',
      localStorage.getItem('splitty:hidegaps') === '1' ? '' : '1');
    applyGaps();
  };

  for (const el of players) {
    el.addEventListener('click', () => togglePause());
    el.addEventListener('timeupdate', e => e.target === activeEl() && onTimeUpdate());
    el.addEventListener('ended', e => e.target === activeEl() && advanceSegment(state.playIdx));
    el.addEventListener('error', e => {
      if (state.playing && e.target === activeEl()) {
        showToast("Couldn't play that one — skipping");
        advanceSegment();
      }
    });
    el.addEventListener('play', e => e.target === activeEl() && $('#btn-play').classList.add('playing'));
    el.addEventListener('pause', e => e.target === activeEl() && $('#btn-play').classList.remove('playing'));
    el.addEventListener('loadedmetadata', e => {
      const v = e.target;
      if (v._pendingSeek != null) {
        v.currentTime = v._pendingSeek;
        v._pendingSeek = null;
      }
      v.playbackRate = state.speed;
      if (v._autoplay) {
        v._autoplay = false;
        v.play().catch(() => {}); // autoplay may be blocked — stays cued, button shows play
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

  // undo anchor moves with cmd/ctrl+Z; space toggles play/pause
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
      e.preventDefault();
      undoLast();
      return;
    }
    if (e.code === 'Space' && !e.repeat) {
      const a = document.activeElement;
      if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return;
      e.preventDefault();
      togglePause();
    }
  });
  const scrubber = $('#scrubber');
  let lastScrubPreview = 0;
  scrubber.addEventListener('pointerdown', () => {
    state.scrubbing = true;
    state.scrubResume = state.playing && !activeEl().paused; // restore this on release
    clearWordHighlight();
  });
  scrubber.addEventListener('input', () => {
    const vt = Number(scrubber.value);
    updateTimeLabel(vt);
    scrubFocus(vt); // transcript focal glow tracks every input event
    // live (throttled) frame preview while dragging
    const now = performance.now();
    if (now - lastScrubPreview > 150) {
      lastScrubPreview = now;
      previewVirtual(vt);
    }
  });
  // pointerup as well as change: a tap that doesn't move the value never fires
  // 'change', which used to leave the scrubbing flag stuck on
  const endScrub = () => {
    if (!state.scrubbing) return;
    state.scrubbing = false;
    clearScrubFocus();
    // paused stays paused, playing keeps playing
    seekVirtual(Number(scrubber.value), state.scrubResume);
  };
  scrubber.addEventListener('change', endScrub);
  scrubber.addEventListener('pointerup', endScrub);
  scrubber.addEventListener('pointercancel', endScrub);

  // tap your corner PiP to shrink/grow it
  if (localStorage.getItem('splitty:pipmini')) $('#video-box').classList.add('pip-mini');
  preview.addEventListener('click', () => {
    const box = $('#video-box');
    if (!box.classList.contains('mode-play')) return;
    const mini = box.classList.toggle('pip-mini');
    localStorage.setItem('splitty:pipmini', mini ? '1' : '');
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

  // gate: sign-in when auth is configured, name-only otherwise
  const gateAuthMode = state.auth?.authEnabled && !state.auth?.user;
  $('#name-form').classList.toggle('hidden', gateAuthMode);
  $('#auth-box').classList.toggle('hidden', !gateAuthMode);
  if (gateAuthMode) wireAuthBox(location.pathname);
  $('#name-form').onsubmit = e => {
    e.preventDefault();
    const v = $('#name-input').value.trim();
    if (!v) return;
    state.name = v;
    localStorage.setItem('splitty:name', v);
    $('#name-gate').classList.add('hidden');
    $('#name-btn').textContent = v;
    state.lastRenderKey = '';
    render();
    ensureCam().catch(armCamRetry);
  };
  $('#name-gate').addEventListener('click', e => {
    if (e.target === $('#name-gate') && state.name && !gateAuthMode) $('#name-gate').classList.add('hidden');
  });
  const openNameGate = () => {
    $('#name-input').value = state.name;
    $('#name-gate').classList.remove('hidden');
    if (!gateAuthMode) $('#name-input').focus();
  };
  $('#name-btn').textContent = state.name || 'Set name';
  if (state.auth?.user) {
    // signed in: the header name button signs you out instead of renaming
    $('#name-btn').title = 'Sign out';
    $('#name-btn').onclick = () => {
      if (confirm(`Signed in as ${state.name}. Sign out?`)) {
        const f = document.createElement('form');
        f.method = 'POST'; f.action = '/auth/logout';
        document.body.appendChild(f); f.submit();
      }
    };
  } else {
    $('#name-btn').onclick = openNameGate;
  }
  if (gateAuthMode || !state.name) openNameGate();
  else ensureCam().catch(armCamRetry); // camera warms up immediately so recording is instant

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
    if (!state.cued && state.messages.length && !state.playing && !state.rec) {
      state.cued = true;
      cueFirstUnheard();
    }
  } catch { /* offline blip — try again next poll */ }
}

// on entry, park the player at the earliest moment you haven't heard
// (or the very beginning if you're caught up) — paused, ready to go
function cueFirstUnheard() {
  buildPlaylist();
  if (!state.playlist.length) return;
  let idx = 0, at = state.playlist[0].start, foundUnheard = false;
  for (let i = 0; i < state.playlist.length; i++) {
    const seg = state.playlist[i];
    const msg = state.byId.get(seg.id);
    if (!msg || isMine(msg.author)) continue; // your own words are always "heard"
    const seenSec = (state.seen[seg.id] || 0) / 1000;
    if (seenSec < seg.end - 0.3) {
      idx = i;
      at = Math.max(seg.start, seenSec);
      foundUnheard = true;
      break;
    }
  }
  // unheard content starts playing on arrival (stays cued if the browser blocks autoplay)
  cueAt(idx, at, foundUnheard);
}

function cueAt(idx, at, autoplay = false) {
  const seg = state.playlist[idx];
  const msg = state.byId.get(seg.id);
  if (!msg) return;
  state.playing = true; // session active, but parked
  state.playIdx = idx;
  state.playLabel = msg.author;
  const el = activeEl();
  el._pendingSeek = at;
  el._autoplay = autoplay;
  el.src = mediaUrl(msg);
  players.forEach(p => (p.playbackRate = state.speed));
  setMsgGain(el, msg);
  prepareNext(idx);
  updateStage();
  const vt = seg.vStart + (at - seg.start);
  $('#scrubber').value = vt;
  updateTimeLabel(vt);
  $('#btn-play').classList.remove('playing');
  updateHint();
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

// An anchor that lands inside a word snaps just past the word's end — cuts
// never happen mid-word, playback order matches the transcript split, and the
// 0.2s grace covers Whisper's early word-end timestamps at splice points.
function snapAnchor(msg, tSec) {
  const w = msg.words.find(w => tSec > w.s && tSec < w.e + 0.2);
  return w ? Math.min(w.e + 0.2, msgDur(msg)) : tSec;
}

// silence windows between word timestamps, padded generously: Whisper marks
// word ends early, so keep 0.3s after a word (finish the tail) and 0.15s
// before the next; only clip pauses long enough to be worth it (>=0.7s)
function silencesFor(msg) {
  if (!msg.words.length) return [];
  const sil = [];
  let prev = 0;
  const consider = (from, to) => {
    const s = from + 0.3, e = to - 0.15;
    if (to - from >= 0.7 && e - s >= 0.25) sil.push([s, e]);
  };
  for (const w of msg.words) {
    consider(prev, w.s);
    prev = Math.max(prev, w.e);
  }
  consider(prev, msgDur(msg));
  return sil;
}

// push [start,end) of msg onto segs — split around silences when skip-pauses is on
function emitChunks(msg, start, end, segs) {
  if (end <= start + 0.01) return;
  if (!state.hideGaps || !msg.words.length) {
    segs.push({ id: msg.id, start, end });
    return;
  }
  let cur = start;
  for (const [s, e] of silencesFor(msg)) {
    if (e <= cur || s >= end) continue;
    if (Math.max(s, cur) > cur + 0.01) segs.push({ id: msg.id, start: cur, end: Math.max(s, cur) });
    cur = Math.min(e, end);
  }
  if (end > cur + 0.01) segs.push({ id: msg.id, start: cur, end });
}

// Expand a message into playable segments, interleaving interjections at their anchors.
function segmentsFor(msg) {
  const dur = msgDur(msg);
  const segs = [];
  let cursor = 0;
  for (const kid of childrenOf(msg.id)) {
    const t = Math.min(snapAnchor(msg, (kid.anchorMs || 0) / 1000), dur);
    emitChunks(msg, cursor, t, segs);
    segs.push(...segmentsFor(kid));
    cursor = Math.max(cursor, t);
  }
  emitChunks(msg, cursor, Math.max(dur, cursor), segs);
  if (!segs.length) segs.push({ id: msg.id, start: 0, end: dur }); // never drop a message entirely
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

function playSegment(idx, offset, autoplay = true) {
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
    if (autoplay) activeEl().play();
  } else {
    const el = activeEl();
    if (el.src === src) {
      el.currentTime = at;
      autoplay ? el.play() : el.pause();
    } else {
      el._pendingSeek = at;
      el._autoplay = autoplay;
      el.src = src;
    }
  }
  players.forEach(p => (p.playbackRate = state.speed));
  setMsgGain(activeEl(), msg); // per-speaker loudness correction
  prepareNext(idx);
  // jump the next few files to the front of the prefetch queue
  enqueuePrefetch(
    state.playlist.slice(idx + 1, idx + 4).map(s => state.byId.get(s.id)?.file),
    true
  );
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

function advanceSegment(fromIdx = state.playIdx) {
  // both the frame ticker and timeupdate watch the boundary — only advance once
  if (!state.playing || fromIdx !== state.playIdx) return;
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

function seekVirtual(vt, autoplay = true) {
  if (!state.playlist.length) return;
  vt = Math.min(Math.max(vt, 0), Math.max(state.vDur - 0.05, 0));
  const idx = segIdxAt(vt);
  const seg = state.playlist[idx];
  playSegment(idx, seg.start + (vt - seg.vStart), autoplay);
}

function skip(delta) {
  if (state.playing) seekVirtual(currentVT() + delta, !activeEl().paused);
}

function segIdxAt(vt) {
  const idx = state.playlist.findIndex(s => vt < s.vEnd);
  return idx === -1 ? state.playlist.length - 1 : idx;
}

// glow the word containing time t in segment seg, hotspot positioned by
// interpolating within the word's start/end timestamps
let lastFocus = { key: '', span: null };
function focusWordAt(seg, t, cls) {
  const msg = state.byId.get(seg.id);
  if (!msg || !msg.words.length) return;
  let i = msg.words.findIndex(w => t < w.e);
  let selector = null, f = 0, gi = -1;

  if (i === -1) {
    // past the last word — trailing silence if one is rendered
    i = msg.words.length - 1;
    const lastEnd = msg.words[i].e;
    const gapEl = document.querySelector(`.gap[data-mid="${seg.id}"][data-gi="${msg.words.length}"]`);
    if (gapEl && gapEl.offsetParent !== null && t >= lastEnd) {
      selector = gapEl;
      gi = msg.words.length;
      const dur = msgDur(msg);
      f = dur > lastEnd ? (t - lastEnd) / (dur - lastEnd) : 1;
    } else {
      f = 1;
    }
  } else {
    const w = msg.words[i];
    if (t < w.s) {
      // inside the pause before word i (i=0 covers leading silence)
      const prevEnd = i > 0 ? msg.words[i - 1].e : 0;
      const gapEl = document.querySelector(`.gap[data-mid="${seg.id}"][data-gi="${i}"]`);
      if (gapEl && gapEl.offsetParent !== null) { // skip when pauses are hidden
        selector = gapEl;
        gi = i;
        f = w.s > prevEnd ? (t - prevEnd) / (w.s - prevEnd) : 0;
      }
    }
    if (!selector) f = w.e > w.s ? (t - w.s) / (w.e - w.s) : 0;
  }
  f = Math.min(Math.max(f, 0), 1);

  const key = selector ? `${cls}:gap:${seg.id}:${gi}` : `${cls}:${seg.id}:${i}`;
  let span = lastFocus.key === key && lastFocus.span?.isConnected ? lastFocus.span : null;
  if (!span) {
    span = selector || document.querySelector(`.word[data-mid="${seg.id}"][data-i="${i}"]`);
    if (!span) return;
    document.querySelectorAll(`.word.${cls}, .gap.${cls}`).forEach(el => {
      el.classList.remove(cls);
      el.style.removeProperty('--f');
    });
    span.classList.add(cls);
    span.scrollIntoView({ block: 'nearest' });
    lastFocus = { key, span };
  }
  span.style.setProperty('--f', `${(f * 100).toFixed(1)}%`);
}

// while dragging the scrubber
function scrubFocus(vt) {
  if (!state.playlist.length) return;
  const seg = state.playlist[segIdxAt(vt)];
  focusWordAt(seg, seg.start + (vt - seg.vStart), 'scrub-focus');
}

function clearScrubFocus() {
  lastFocus = { key: '', span: null };
  document.querySelectorAll('.word.scrub-focus, .gap.scrub-focus').forEach(el => {
    el.classList.remove('scrub-focus');
    el.style.removeProperty('--f');
  });
}

// during playback the same glow glides through words at frame rate
function tickHighlight() {
  requestAnimationFrame(tickHighlight);
  if (!state.playing || state.scrubbing || state.playIdx < 0) return;
  // runs while paused too, so the highlight stays parked where you landed
  const el = activeEl();
  const seg = state.playlist[state.playIdx];
  if (!seg) return;
  // frame-rate boundary enforcement: cut to the next segment within ~16ms of
  // the splice point, instead of overshooting by a whole timeupdate interval
  if (!el.paused && el.currentTime >= seg.end - 0.015) return advanceSegment(state.playIdx);
  focusWordAt(seg, el.currentTime, 'speaking');
}
requestAnimationFrame(tickHighlight);

// show the frame at a virtual time without playing (used while dragging the scrubber)
function previewVirtual(vt) {
  if (!state.playing || !state.playlist.length) return;
  vt = Math.min(Math.max(vt, 0), Math.max(state.vDur - 0.05, 0));
  const idx = segIdxAt(vt);
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

  if (t >= seg.end - 0.05) return advanceSegment(state.playIdx); // fallback; the frame ticker cuts tighter

  $('#scrubber').value = currentVT();
  updateTimeLabel(currentVT());

  // track furthest-played for "new" highlighting
  markSeen(seg.id, Math.floor(t * 1000));

  // un-highlight passed "unseen" words (spoken-word glow runs in tickHighlight)
  document.querySelectorAll(`.word.unseen[data-mid="${seg.id}"]`).forEach(el => {
    if (Number(el.dataset.t) <= t) el.classList.remove('unseen');
  });
}

const clearWordHighlight = () => {
  lastFocus = { key: '', span: null };
  document.querySelectorAll('.word.speaking, .gap.speaking').forEach(el => {
    el.classList.remove('speaking');
    el.style.removeProperty('--f');
  });
};

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
  if (audioBlob && audioBlob.size) fd.append('gain', String(await measureGain(audioBlob)));
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
      xhr.onload = () => {
        if (xhr.status < 300) return resolve(JSON.parse(xhr.responseText));
        let err = {};
        try { err = JSON.parse(xhr.responseText); } catch {}
        reject(Object.assign(new Error(err.error || `upload ${xhr.status}`), { code: err.code }));
      };
      xhr.onerror = () => reject(new Error('network'));
      xhr.send(fd);
    });
    // your own message never shows as "new" to you
    state.seen[message.id] = 10 * 60 * 60 * 1000;
    localStorage.setItem(`splitty:seen:${state.chatId}`, JSON.stringify(state.seen));
  } catch (err) {
    if (err.code === 'pending') showToast('Sent limit reached — an admin needs to approve you before you can send more.');
    else if (err.code === 'blocked') showToast('Your account is blocked from sending.');
    else if (err.code === 'auth') { showToast('Sign in to send messages.'); $('#name-gate').classList.remove('hidden'); }
    else showToast('Upload failed — try again.');
  }
  await poll();
  if (rec.resume) {
    // resume just past the (snapped) splice so you don't replay your own interjection
    const parent = state.byId.get(rec.resume.msgId);
    const at = parent ? snapAnchor(parent, rec.resume.atSec) + 0.001 : rec.resume.atSec;
    playFrom(rec.resume.msgId, at);
  } else {
    updateStage();
  }
  updateHint();
}

// recording timer + hint line
setInterval(() => {
  if (state.rec) {
    const s = Math.floor((Date.now() - state.rec.startTs) / 1000);
    updateHint(`● Recording ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} — tap to send`);
  }
}, 250);

// only transient status (recording timer, upload %) — empty hides the pill
function updateHint(text) {
  $('#rec-hint').textContent = text ?? '';
}

// ---------- stage (video area) ----------
// modes: record → your camera fills the box; play → their video with your camera
// as a corner PiP; self → idle, just your camera; none → no camera yet, hide stage
function updateStage() {
  const stage = $('#stage');
  const box = $('#video-box');
  const mode = state.rec ? 'record' : state.playing ? 'play'
    : camStream ? 'self' : camError ? 'enable' : 'none';
  // record button telegraphs what it'll do: splice into the conversation vs new message
  $('#rec-btn').classList.toggle('splice', mode === 'play');
  $('#stop-btn').classList.toggle('hidden', mode !== 'play');
  if (mode === 'none') { stage.classList.add('hidden'); return; }
  if (mode === 'enable') {
    // camera not granted yet: keep the stage visible with the enable button
    stage.classList.remove('hidden');
    preview.classList.add('hidden');
    players.forEach(p => p.classList.add('hidden'));
    $('#transport').classList.add('hidden');
    $('#pip-label').textContent = '';
    return;
  }
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
  const srcCard = e.target.closest('.msg');
  srcCard?.classList.add('drag-src');
  const ghost = $('#drop-ghost');

  const setTarget = el => {
    state.dragging.target?.classList.remove('drop-target');
    state.dragging.target = el;
    el?.classList.add('drop-target');
    // project the drop onto the seek track: where it would land, and how long it runs
    if (el && state.vDur > 0) {
      if (!state.playlist.length) buildPlaylist();
      const wS = Number(el.dataset.t);
      const idx = state.playlist.findIndex(
        s => s.id === msg.parentId && wS >= s.start - 0.001 && wS < s.end
      );
      if (idx >= 0) {
        const seg = state.playlist[idx];
        const vt = seg.vStart + (wS - seg.start);
        ghost.style.left = `${(vt / state.vDur) * 100}%`;
        ghost.style.width = `${Math.max((msgDur(msg) / state.vDur) * 100, 1.5)}%`;
        ghost.style.background = colorFor(msg.author);
        ghost.classList.remove('hidden');
        return;
      }
    }
    ghost.classList.add('hidden');
  };
  const onMove = ev => {
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    setTarget(el?.classList?.contains('word') && el.dataset.mid === msg.parentId ? el : null);
  };
  const onUp = async () => {
    document.removeEventListener('pointermove', onMove);
    document.body.classList.remove('dragging-anchor');
    srcCard?.classList.remove('drag-src');
    ghost.classList.add('hidden');
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
    box.innerHTML = '<div class="empty">Nothing here yet.<br>Record the first video note.</div>';
    return;
  }

  for (const msg of roots()) box.appendChild(renderMessage(msg, 0));
  if (nearBottom) box.scrollTop = box.scrollHeight;

  remapPlayback();
  prefetchUnheard();
}

function renderMessage(msg, depth) {
  const seenMs = state.seen[msg.id] || 0;
  const mine = isMine(msg.author);
  const isNew = !mine && (msg.words.length ? msg.words.some(w => w.s * 1000 > seenMs) : seenMs === 0);

  const card = document.createElement('div');
  card.className = `msg${isNew ? ' is-new' : ''}${mine ? ' mine' : ''}`;
  card.style.setProperty('--author-color', colorFor(msg.author)); // speaker bar color

  const head = document.createElement('div');
  head.className = 'msg-head';
  head.innerHTML = `<button class="play-btn" title="Play from start"><svg class="ic" viewBox="0 0 16 16"><path d="M4.5 2.2 13.5 8l-9 5.8z"/></svg></button>
    ${msg.picture ? `<img class="avatar" src="${escapeHtml(msg.picture)}" alt="" referrerpolicy="no-referrer">` : ''}
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
  // audible silences render as widening dotted gaps (gi = index of the word after the pause)
  const makeGap = (prevEnd, nextStart, gi) => {
    const gapSec = nextStart - prevEnd;
    if (gapSec < 0.4) return null;
    const g = document.createElement('span');
    g.className = 'gap';
    g.dataset.mid = msg.id;
    g.dataset.gi = gi;
    g.style.width = `${Math.round(Math.min(10 + (gapSec - 0.4) * 26, 56))}px`;
    g.title = `${gapSec.toFixed(1)}s pause`;
    g.onclick = () => playFrom(msg.id, prevEnd + 0.01);
    return g;
  };
  const flushWordsUntil = untilSec => {
    const frag = document.createDocumentFragment();
    while (wi < msg.words.length && (untilSec == null || msg.words[wi].s < untilSec)) {
      const w = msg.words[wi];
      const gap = makeGap(wi > 0 ? msg.words[wi - 1].e : 0, w.s, wi); // wi=0: leading silence
      if (gap) {
        frag.appendChild(gap);
        frag.appendChild(document.createTextNode(' ')); // match the space after words — keeps the pill centered between neighbors
      }
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

  // trailing silence after the last word, out to the recording's end
  if (msg.words.length) {
    const lastEnd = msg.words[msg.words.length - 1].e;
    const tail = makeGap(lastEnd, msgDur(msg), msg.words.length);
    if (tail) body.appendChild(tail);
  }

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
