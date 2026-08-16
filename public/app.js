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
  // access control (populated by poll once auth is configured)
  myRole: null,      // 'editor' | 'commenter' | 'viewer' | null (unknown/locked)
  isOwner: false,
  chatMeta: null,    // { id, createdAt, visibility, ownerId }
  members: [],
  invites: [],
  requests: [],
  friends: null,     // lazy-loaded for the share panel
  inviteToken: null, // ?invite= view-only credential for private chats
  roleInit: false,   // first-poll gate/camera decision made
  // screen-share playback layout: 'screen' (screen big, cam floats),
  // 'cam' (swapped), or 'split' (side by side in the main box)
  screenLayout: localStorage.getItem('splitty:screenlayout') || 'screen',
  // view lens: time window over message creation + reply-depth fold level.
  // expanded = per-subtree overrides (fold chips that were clicked open).
  filter: { t0: null, t1: null, depth: Infinity, expanded: new Set() },
  // comment layer being viewed: '' = the base conversation, else a user id.
  // Recording routes into whatever you're viewing.
  layer: '',
};

// Editors flip through comment layers with the picker; everyone else just
// sees their own comments inline, as if they're part of the conversation —
// no layer concept surfaces for them at all.
const layerOk = m => {
  if (!m.layer) return true;
  if (canEdit()) return m.layer === state.layer;
  return m.layer === state.auth?.user?.id;
};

const inWindow = m =>
  (state.filter.t0 == null || m.createdAt >= state.filter.t0) &&
  (state.filter.t1 == null || m.createdAt <= state.filter.t1);

let lastPipSwap = 0; // suppress the click that trails a PiP swap tap

const ROLE_RANK = { viewer: 1, commenter: 2, editor: 3 };
// can this person record into the base conversation? (name-only mode stays open)
const canComment = () =>
  !state.auth?.authEnabled || (ROLE_RANK[state.myRole] || 0) >= ROLE_RANK.commenter;
const canEdit = () => !!state.auth?.authEnabled && state.myRole === 'editor';
// ...and can they record at all, counting comment layers? Signed-out
// visitors on a comment-enabled chat count too: they see the record button
// and get the camera prompt — tapping record is what asks them to sign in.
const canRecordHere = () =>
  canComment() || !!(state.chatMeta?.comments && state.myRole);

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
const mediaUrl = msg => {
  const b = blobStore.get(msg.file);
  if (b) { b.last = ++blobTick; return b.url; }
  return `${location.origin}/media/${msg.file}`;
};

// ---------- boot ----------
// session first: signed-in users take their account name everywhere
const chatMatch = location.pathname.match(/^\/c\/([A-Za-z0-9_-]+)/);
const inviteMatch = location.pathname.match(/^\/i\/([A-Za-z0-9_-]+)/);
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
    } else if (inviteMatch) {
      initInvite(inviteMatch[1]);
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

// In-memory blob store: mobile Chrome downgrades video preload to save data,
// so feed the <video> elements blob: URLs — playback and seeks are fully local.
const blobStore = new Map(); // file -> { url, size, last }
let blobTick = 0, blobBytes = 0;
const BLOB_BUDGET = 48 * 1024 * 1024;

function storeBlob(file, blob) {
  if (blobStore.has(file) || blob.size > 20 * 1024 * 1024) return;
  blobStore.set(file, { url: URL.createObjectURL(blob), size: blob.size, last: ++blobTick });
  blobBytes += blob.size;
  // LRU eviction, never yanking a URL a player is currently using
  while (blobBytes > BLOB_BUDGET) {
    let oldest = null;
    for (const [f, b] of blobStore) {
      if (players.some(p => p.src === b.url)) continue;
      if (!oldest || b.last < blobStore.get(oldest).last) oldest = f;
    }
    if (!oldest) break;
    const b = blobStore.get(oldest);
    URL.revokeObjectURL(b.url);
    blobBytes -= b.size;
    blobStore.delete(oldest);
    prefetch.done.delete(oldest); // may be re-fetched later if needed
  }
}

function enqueuePrefetch(files, front = false) {
  if (navigator.connection?.saveData) return;
  const fresh = files.filter(f => f && !prefetch.done.has(f) && !prefetch.queue.includes(f));
  if (!fresh.length) return;
  prefetch.queue = front ? [...fresh, ...prefetch.queue] : [...prefetch.queue, ...fresh];
  runPrefetch();
}

// the person watching always outranks the cache-warmer
const playbackStarving = () => {
  if (!state.playing || state.playIdx < 0) return false;
  const el = activeEl();
  return !el.paused && (el.readyState < 3 || el._waiting);
};

async function runPrefetch() {
  if (prefetch.running) return;
  prefetch.running = true;
  while (prefetch.queue.length && prefetch.bytes < prefetch.BUDGET) {
    if (document.hidden) break; // resume on the next enqueue
    if (playbackStarving()) {
      // don't fight the active video for bandwidth — retry shortly
      prefetch.running = false;
      setTimeout(runPrefetch, 1500);
      return;
    }
    const file = prefetch.queue.shift();
    if (prefetch.done.has(file)) continue;
    try {
      const res = await fetch(`/media/${file}`, { priority: 'low' });
      if (res.ok) {
        const buf = await res.blob(); // consuming the body lands it in the HTTP cache
        prefetch.bytes += buf.size;
        prefetch.done.add(file);
        storeBlob(file, buf); // and keep it hot in memory for instant swaps
      }
    } catch { /* offline blip — drop it, playback will fetch on demand */ }
  }
  prefetch.running = false;
}

// everything unheard, in the order the conversation would play it.
// Long clips are excluded: fully downloading a 60MB video "just in case"
// starves actual playback (fresh forks made this vivid — every clip is
// unheard there); big files stream fine on demand via range requests.
function prefetchUnheard() {
  if (!state.playlist.length) buildPlaylist();
  const files = [];
  for (const seg of state.playlist) {
    const msg = state.byId.get(seg.id);
    if (!msg || isMine(msg.author)) continue;
    if (msgDur(msg) > 240) continue; // ~4 min ≈ 35MB — past that, stream it
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
// screen sharing is a mode, not a one-shot: while the stream is live, every
// recording captures it alongside the camera (which keeps carrying the mic)
let screenStream = null;
const screenEl = () => $('#screen-player');

async function toggleScreen() {
  if (state.rec) {
    if (state.rec.screenRecorder) {
      // turning the share off mid-clip ends the clip — the screen track is
      // part of what's being recorded
      stopRecord();
      stopScreenShare();
    } else {
      showToast('Finish this clip first — then turn on screen sharing');
    }
    return;
  }
  if (screenStream) return stopScreenShare();
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      // capped at 1080p/10fps — screens are mostly still, and this keeps a
      // 10-minute share under ~90MB. (A crisper HD preset could be a paid
      // tier later: bump these caps + SCREEN_BITRATE together.)
      video: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { ideal: 10, max: 15 } },
      audio: false, // the mic on the camera track is the voice
    });
  } catch {
    return; // picker dismissed
  }
  // the browser's own floating "Stop sharing" button
  screenStream.getVideoTracks()[0].onended = () => {
    if (state.rec?.screenRecorder) stopRecord();
    stopScreenShare();
  };
  updateStage();
}

function stopScreenShare() {
  screenStream?.getTracks().forEach(t => t.stop());
  screenStream = null;
  updateStage();
}

function paintScreenBtn() {
  const btn = $('#screen-btn');
  btn.classList.toggle('hidden', !navigator.mediaDevices?.getDisplayMedia);
  btn.classList.toggle('screen-on', !!screenStream?.active);
  btn.title = screenStream
    ? 'Screen sharing is on — recordings include it. Tap to turn off.'
    : 'Share your screen — while it\'s on, recordings include it';
}
async function ensureCam() {
  if (camStream && camStream.active) return camStream;
  // saved device choices ride along as 'ideal' — a missing device (unplugged
  // webcam, other machine) falls back instead of failing
  const camId = localStorage.getItem('splitty:camid');
  const micId = localStorage.getItem('splitty:micid');
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 960 }, ...(camId && { deviceId: { ideal: camId } }) },
      audio: micId ? { deviceId: { ideal: micId } } : true,
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

// ---------- device picker ----------
async function fillDeviceLists() {
  const devs = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const fill = (sel, kind, savedKey, fallbackLabel) => {
    sel.innerHTML = '';
    let i = 1;
    for (const d of devs.filter(dd => dd.kind === kind)) {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `${fallbackLabel} ${i}`;
      sel.appendChild(o);
      i++;
    }
    // show what's actually in use, else the saved preference
    const tracks = kind === 'videoinput' ? camStream?.getVideoTracks() : camStream?.getAudioTracks();
    const activeId = tracks?.[0]?.getSettings().deviceId;
    const want = activeId || localStorage.getItem(savedKey);
    if (want && [...sel.options].some(o => o.value === want)) sel.value = want;
  };
  fill($('#cam-sel'), 'videoinput', 'splitty:camid', 'Camera');
  fill($('#mic-sel'), 'audioinput', 'splitty:micid', 'Microphone');
}

// swap the live stream to the picked devices (preview + future recordings)
async function applyDevicePick() {
  if (state.rec) {
    showToast('Finish this clip first — devices switch between recordings');
    fillDeviceLists(); // snap the selects back to what's actually in use
    return;
  }
  localStorage.setItem('splitty:camid', $('#cam-sel').value);
  localStorage.setItem('splitty:micid', $('#mic-sel').value);
  camStream?.getTracks().forEach(t => t.stop());
  camStream = null;
  try {
    await ensureCam();
  } catch {
    showToast("Couldn't open that camera — check it isn't in use elsewhere");
  }
  fillDeviceLists();
}

// the ⋮ menu: pauses toggle, notifications, name/sign-out, device pickers
function initMenu() {
  const btn = $('#menu-btn'), pop = $('#menu-pop');
  btn.onclick = async () => {
    if (pop.classList.contains('hidden')) {
      pop.classList.remove('hidden');
      // device labels only exist once camera permission is granted — warm it
      // for people who can record here; pure viewers never get prompted
      if (!camStream && canRecordHere()) await ensureCam().catch(() => {});
      fillDeviceLists();
    } else {
      pop.classList.add('hidden');
    }
  };
  document.addEventListener('pointerdown', e => {
    // btn.contains: clicks land on the svg inside the button, and this runs
    // before the button's own click toggle — don't fight it
    if (!pop.contains(e.target) && !btn.contains(e.target)) pop.classList.add('hidden');
  });
  if (navigator.mediaDevices?.getUserMedia) {
    navigator.mediaDevices.addEventListener?.('devicechange', () => {
      if (!pop.classList.contains('hidden')) fillDeviceLists();
    });
    $('#cam-sel').onchange = applyDevicePick;
    $('#mic-sel').onchange = applyDevicePick;
  } else {
    $('#menu-devices').classList.add('hidden');
  }
  // transcription language: applies to new clips and to the ↻ retranscribe button
  $('#lang-sel').value = localStorage.getItem('splitty:lang') || '';
  $('#lang-sel').onchange = () => localStorage.setItem('splitty:lang', $('#lang-sel').value);
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
  if (state.auth?.isAdmin) $('#admin-link').classList.remove('hidden');
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
        if (c.private) {
          // you can no longer see inside (signed out, or access was removed)
          row.querySelector('.rc-names').textContent = 'Private chat';
          row.querySelector('.rc-meta').textContent = '';
          continue;
        }
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
  if (!state.auth?.isAdmin) {
    $('#admin-denied').classList.remove('hidden');
    if (state.auth?.user) {
      $('#admin-denied-msg').textContent = `Signed in as ${state.auth.user.name}, but this account isn't an admin.`;
    } else {
      $('#admin-denied-msg').textContent = 'Admins only — sign in to continue.';
      $('#admin-signin').classList.remove('hidden');
    }
    return;
  }
  $('#tab-chats').onclick = () => { adminTab = 'chats'; loadAdmin(); };
  $('#tab-users').onclick = () => { adminTab = 'users'; loadAdmin(); };
  $('#admin-search').oninput = () => loadAdmin(true);
  loadAdmin();
}

let adminCache = { chats: null, users: null };
async function loadAdmin(fromCache = false) {
  const list = $('#admin-list');
  $('#tab-chats').classList.toggle('active', adminTab === 'chats');
  $('#tab-users').classList.toggle('active', adminTab === 'users');
  const q = ($('#admin-search').value || '').trim().toLowerCase();

  if (!fromCache || !adminCache[adminTab]) {
    const res = await fetch(`/api/admin/${adminTab}`); // session cookie is the credential
    if (!res.ok) {
      $('#admin-tabs').classList.add('hidden');
      list.innerHTML = '<p class="muted">Admin access denied.</p>';
      return;
    }
    adminCache[adminTab] = await res.json();
  }
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
          headers: { 'Content-Type': 'application/json' },
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
      await fetch(`/api/admin/chats/${c.id}`, { method: 'DELETE' });
      adminCache.chats = null;
      loadAdmin();
    };
    list.appendChild(row);
  }
}

// ---------- chat ----------
function initChat() {
  state.seen = JSON.parse(localStorage.getItem(`splitty:seen:${state.chatId}`) || '{}');
  state.inviteToken = new URLSearchParams(location.search).get('invite');
  $('#chat').classList.remove('hidden');
  // share opens the panel whenever auth exists (legacy chats get the setup
  // pitch inside); name-only mode just copies the link
  $('#share-btn').onclick = () => {
    if (state.auth?.authEnabled && state.chatMeta) return openShare();
    copyChatLink($('#share-btn'), 'Share');
  };
  $('#share-close').onclick = () => $('#share-gate').classList.add('hidden');
  $('#share-gate').addEventListener('click', e => {
    if (e.target === $('#share-gate')) $('#share-gate').classList.add('hidden');
  });
  initPush();
  initMenu();
  initTimeline();
  restorePendingUploads();

  // layer picker popover: type-ahead over commenters, anchored to its button
  $('#layer-pick').onclick = () => {
    const pop = $('#layer-pop');
    pop.classList.toggle('hidden');
    if (!pop.classList.contains('hidden')) {
      const r = $('#layer-pick').getBoundingClientRect();
      pop.style.top = `${r.bottom + 6}px`;
      pop.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - 260))}px`;
      $('#layer-search').value = '';
      renderLayerList();
      $('#layer-search').focus();
    }
  };
  $('#layer-search').oninput = renderLayerList;
  document.addEventListener('pointerdown', e => {
    const pop = $('#layer-pop');
    if (!pop.contains(e.target) && !$('#layer-pick').contains(e.target)) pop.classList.add('hidden');
  });

  // dragging across the transcript scrubs the playhead — words are a seek
  // surface, not selectable text
  let lastWordPreview = 0;
  $('#messages').addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const startSpan = e.target.closest?.('.word, .gap');
    if (!startSpan) return;
    const start = { x: e.clientX, y: e.clientY };
    let active = false;
    const scrubTo = (span, clientX) => {
      const msg = state.byId.get(span.dataset.mid);
      if (!msg || span.dataset.t == null) return;
      // interpolate within the word/gap from the pointer's x, so the glow's
      // hotspot tracks the mouse and the playhead moves inch by inch
      const rect = span.getBoundingClientRect();
      const s = Number(span.dataset.t);
      const en = Number(span.dataset.e ?? span.dataset.t);
      const f = Math.min(Math.max((clientX - rect.left) / Math.max(rect.width, 1), 0), 1);
      const vt = vtOfMsgTime(span.dataset.mid, s + f * Math.max(0, en - s) + 0.0005);
      if (vt == null) return;
      $('#scrubber').value = vt;
      updateTimeLabel(vt);
      scrubFocus(vt);
      const now = performance.now();
      if (now - lastWordPreview > 150) {
        lastWordPreview = now;
        previewVirtual(vt);
      }
    };
    const onMove = ev => {
      if (!active) {
        if (Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) < 8) return;
        active = true;
        // no session yet? park one at the grab point so scrubbing has a stage
        if (!state.playing) playFrom(startSpan.dataset.mid, Number(startSpan.dataset.t) || 0, false);
        state.scrubbing = true;
        state.scrubResume = state.playing && !activeEl().paused;
        clearWordHighlight();
      }
      const span = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.word, .gap');
      if (span) scrubTo(span, ev.clientX);
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      if (active) {
        transcriptDragTs = performance.now();
        state.scrubbing = false;
        clearScrubFocus();
        // land where the drag ended, restoring the play/pause state it began with
        seekVirtual(Number($('#scrubber').value), state.scrubResume);
      }
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp, { once: true });
  });

  $('#rec-btn').onclick = toggleRecord;
  $('#stop-btn').onclick = stopPlayback; // clears the session: next record = new message
  $('#btn-stop').onclick = stopPlayback;
  $('#pause-btn').onclick = togglePause;

  // hide pauses = clip them: transcript gaps disappear AND playback skips the
  // silence, so the timeline/timestamps compress to speech-only time
  const applyGaps = () => {
    state.hideGaps = localStorage.getItem('splitty:hidegaps') === '1';
    document.body.classList.toggle('hide-gaps', state.hideGaps);
    $('#gaps-check').checked = state.hideGaps;
    if (state.playing) remapPlayback();
    else buildPlaylist();
  };
  applyGaps();
  $('#gaps-check').onchange = () => {
    localStorage.setItem('splitty:hidegaps', $('#gaps-check').checked ? '1' : '');
    applyGaps();
  };

  $('#screen-btn').onclick = toggleScreen;

  // the recorded screen track: pending-seek plumbing like the players
  const sp = screenEl();
  sp.addEventListener('loadedmetadata', () => {
    if (sp._pendingSeek != null && !sp.srcObject) {
      sp.currentTime = sp._pendingSeek;
      sp._pendingSeek = null;
    }
    sp.playbackRate = state.speed;
  });
  sp.addEventListener('click', () => {
    // big screen video = tap to pause; when it's the PiP, taps mean swap (handled below)
    if (!sp.classList.contains('spip') && !sp.srcObject && performance.now() - lastPipSwap > 350) togglePause();
  });

  // Floating-video gestures, shared by your camera preview and the small
  // video during screen playback: grab a corner to resize, grab the middle
  // to move, tap for the element's own action (preview: shrink/restore;
  // screen pip: swap which video is big).
  $('#video-box').addEventListener('pointerdown', e => {
    const box = $('#video-box');
    const el = e.target;
    let conf = null;
    if (el === preview && (box.classList.contains('mode-play') || box.classList.contains('mode-screenlive'))) {
      conf = pips.cam;
    } else if (el instanceof HTMLVideoElement && el.classList.contains('spip')) {
      conf = pips.spip;
    }
    if (!conf) return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const grab = { x: e.clientX, y: e.clientY };
    const nearL = grab.x - rect.left < 20, nearR = rect.right - grab.x < 20;
    const nearT = grab.y - rect.top < 20, nearB = rect.bottom - grab.y < 20;
    const resizing = (nearL || nearR) && (nearT || nearB);
    const ar = rect.width / rect.height;
    const anchor = { x: nearL ? rect.right : rect.left, y: nearT ? rect.bottom : rect.top }; // opposite corner stays put
    let moved = false;
    const apply = (x, y, w) => {
      // viewport ratios — pips live anywhere in the window, not just the box
      conf.geom = { xr: x / window.innerWidth, yr: y / window.innerHeight, wr: w / window.innerWidth };
      localStorage.setItem(conf.key, JSON.stringify(conf.geom));
      layoutPip(el, conf);
    };
    const onMove = ev => {
      if (Math.abs(ev.clientX - grab.x) + Math.abs(ev.clientY - grab.y) > 6) moved = true;
      if (!moved) return;
      if (resizing) {
        if (conf.mini) { conf.mini = false; localStorage.setItem('splitty:pipmini', ''); }
        const w = Math.min(Math.max(Math.abs(ev.clientX - anchor.x), 80), window.innerWidth * 0.8);
        const h = w / ar;
        apply(nearL ? anchor.x - w : anchor.x, nearT ? anchor.y - h : anchor.y, w);
      } else {
        apply(ev.clientX - rect.width / 2, ev.clientY - rect.height / 2, rect.width);
      }
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', () => {
      document.removeEventListener('pointermove', onMove);
      if (!moved) conf.onTap();
    }, { once: true });
  });

  for (const el of players) {
    el.addEventListener('click', () => {
      // taps on the PiP are swap gestures, not pause — and ignore the click
      // that trails a swap so it doesn't immediately pause the new big view
      if (el.classList.contains('spip') || performance.now() - lastPipSwap < 350) return;
      togglePause();
    });
    el.addEventListener('timeupdate', e => e.target === activeEl() && onTimeUpdate());
    el.addEventListener('ended', e => e.target === activeEl() && advanceSegment(state.playIdx));
    el.addEventListener('error', e => {
      if (state.playing && e.target === activeEl()) {
        showToast("Couldn't play that one — skipping");
        advanceSegment();
      }
    });
    // any play/pause on either element re-derives the button from the active
    // one — during boundary handoffs events fire on both, in racy orders.
    // While recording, playback is flatly forbidden: whatever slipped through
    // (space bar, a stray tap, a retry timer) gets paused right back.
    el.addEventListener('play', () => {
      if (state.rec) return el.pause();
      syncPlayButton();
    });
    el.addEventListener('pause', syncPlayButton);
    // buffering flags feed the loading spinner
    el.addEventListener('waiting', () => { el._waiting = true; updateVidSpinner(); });
    for (const ev of ['playing', 'canplay', 'seeked']) {
      el.addEventListener(ev, () => { el._waiting = false; updateVidSpinner(); });
    }
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
      relayoutPips(); // floating videos stay inside the resized box
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

  // floating videos track the box and their own intrinsic size
  window.addEventListener('resize', relayoutPips);
  for (const el of [...players, screenEl(), preview]) {
    el.addEventListener('resize', relayoutPips);         // intrinsic size changed (e.g. shared window resized mid-clip)
    el.addEventListener('loadedmetadata', relayoutPips); // aspect known — snap the pip box to it
    el.addEventListener('pointermove', pipHoverCursor);  // diagonal cursors over the corners
  }

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
  $('#name-btn').textContent = state.auth?.user
    ? `Sign out (${state.name})` // say what tapping it does
    : state.name || 'Set name';
  if (state.auth?.user) {
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
  state.openNameGate = openNameGate;
  if (!state.auth?.authEnabled) {
    // name-only mode: gate on a name, then warm the camera
    if (!state.name) openNameGate();
    else ensureCam().catch(armCamRetry);
  }
  // with auth configured, wait for the first poll: viewers never get gated or
  // asked for a camera, and locked chats show the request-access screen instead

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
    const inv = state.inviteToken ? `?invite=${encodeURIComponent(state.inviteToken)}` : '';
    const res = await fetch(`/api/chats/${state.chatId}${inv}`);
    if (res.status === 404) {
      $('#messages').innerHTML = '<div class="empty">This chat doesn\'t exist.</div>';
      return;
    }
    if (res.status === 401 || res.status === 403) {
      showLocked(await res.json().catch(() => ({})), res.status);
      return;
    }
    hideLocked();
    const data = await res.json();
    state.messages = data.messages;
    state.byId = new Map(data.messages.map(m => [m.id, m]));
    state.chatMeta = data.chat;
    state.isOwner = !!data.isOwner;
    state.members = data.members || [];
    state.invites = data.invites || [];
    state.requests = data.requests || [];
    if (data.myRole !== undefined) setRole(data.myRole);
    updateLayerPick();
    render();
    refreshTimelinePanel();
    if (!$('#share-gate').classList.contains('hidden')) renderShare();
    if (!state.cued && state.messages.length && !state.playing && !state.rec) {
      state.cued = true;
      cueFirstUnheard();
    }
  } catch { /* offline blip — try again next poll */ }
}

// ---------- access states ----------
function showLocked(err, status) {
  if (state.playing) stopPlayback(); // access can vanish mid-watch (kicked, made private)
  $('#chat').classList.add('hidden');
  $('#locked').classList.remove('hidden');
  const signedOut = status === 401 || err.code === 'auth';
  $('#locked-msg').textContent = signedOut
    ? 'This chat is private — sign in to ask for access.'
    : "This chat is private. You can knock, and whoever's inside can let you in.";
  $('#locked-signin').classList.toggle('hidden', !signedOut);
  $('#locked-request').classList.toggle('hidden', signedOut || err.requested);
  $('#locked-note').classList.toggle('hidden', !err.requested);
  $('#locked-signin').onclick = () => {
    wireAuthBox(location.pathname);
    $('#name-gate').classList.remove('hidden');
  };
  $('#locked-request').onclick = async () => {
    const r = await fetch(`/api/chats/${state.chatId}/request`, { method: 'POST' });
    if (r.ok) {
      $('#locked-request').classList.add('hidden');
      $('#locked-note').classList.remove('hidden');
    }
  };
}

function hideLocked() {
  if ($('#locked').classList.contains('hidden')) return;
  $('#locked').classList.add('hidden');
  $('#chat').classList.remove('hidden');
}

// role is known (or changed — e.g. you just got approved or promoted)
function setRole(role) {
  const changed = state.myRole !== role;
  state.myRole = role;
  document.body.classList.toggle('role-viewer', !canRecordHere());
  const n = state.requests.length;
  $('#share-btn').textContent = canEdit() && n ? `Share (${n})` : 'Share';
  paintPush(); // the notification nudge depends on the role (participants only)
  if (changed) {
    state.lastRenderKey = ''; // drag handles / delete buttons depend on the role
    if (!state.auth?.authEnabled) return;
    if (state.roleInit) return;
    state.roleInit = true;
    // first sight of the chat: anyone who could record here warms the camera
    // (including signed-out visitors on comment-enabled chats — recording is
    // what asks them to sign in)
    if (canRecordHere()) {
      if (canComment() && !state.name && !state.auth.user) state.openNameGate?.();
      else ensureCam().catch(armCamRetry);
    }
    // back from the sign-in they started by tapping record: don't auto-record,
    // but light the path — pulsing button + a hint until they tap it
    if (sessionStorage.getItem('splitty:recintent') && state.auth?.user && canRecordHere()) {
      sessionStorage.removeItem('splitty:recintent');
      state.recNudge = true;
      $('#rec-btn').classList.add('attract');
      updateHint();
    }
  }
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
  loadScreenFor(msg, at);
  updateStage();
  const vt = seg.vStart + (at - seg.start);
  $('#scrubber').value = vt;
  updateTimeLabel(vt);
  syncPlayButton();
  updateHint();
}

// single source of truth for the transport play/pause button: the session is
// live AND the on-screen element is actually running. Overlap handoffs swap in
// an already-playing element that never fires a fresh 'play' event, so the
// button must be derived, not event-toggled.
function syncPlayButton() {
  const playing = state.playing && !activeEl().paused;
  $('#btn-play').classList.toggle('playing', playing);
  $('#pause-btn').classList.toggle('playing', playing);
}

// ---------- message tree ----------
// roots/children respect the time window; depth is positional and handled by
// the callers (segmentsFor / renderMessage), so playback and transcript can
// never disagree about what's visible.
// The window filters each message by its OWN timestamp: replies outlive a
// parent that slides out of the window — they promote to top level (orphans)
// instead of vanishing with it.
const hasVisibleParent = m => {
  if (!m.parentId) return false;
  const p = state.byId.get(m.parentId);
  return !!p && inWindow(p) && layerOk(p);
};
const roots = () => state.messages
  .filter(m => inWindow(m) && layerOk(m) && !hasVisibleParent(m))
  .sort((a, b) => a.createdAt - b.createdAt);
const childrenOf = id =>
  state.messages.filter(m => m.parentId === id && inWindow(m) && layerOk(m))
    .sort((a, b) => (a.anchorMs - b.anchorMs) || (a.createdAt - b.createdAt));

// is this child visible at the current fold level? `unlocked` = an ancestor's
// fold chip was opened, which reveals its whole subtree
const kidVisible = (kid, depth, unlocked) =>
  unlocked || depth + 1 <= state.filter.depth || state.filter.expanded.has(kid.id);

function subtreeStats(msg) {
  let n = 1, dur = msgDur(msg);
  for (const k of childrenOf(msg.id)) {
    const s = subtreeStats(k);
    n += s.n;
    dur += s.dur;
  }
  return { n, dur };
}

function msgDur(msg) {
  // wall-clock durationMs can undercount the real file (recorder start skew),
  // so the last word's timestamp extends it — never cut a clip mid-word
  const fromWords = msg.words.length ? msg.words[msg.words.length - 1].e + 0.3 : 0;
  if (msg.durationMs) return Math.max(msg.durationMs / 1000, fromWords);
  return fromWords || 3;
}

// is this segment the final chunk of its message's file?
const isTailSeg = seg => {
  const msg = state.byId.get(seg.id);
  return !!msg && seg.end >= msgDur(msg) - 0.03;
};

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

// Expand a message into playable segments, interleaving interjections at their
// anchors. Folded subtrees (past the depth level, not chip-expanded) don't play.
function segmentsFor(msg, depth = 0, unlocked = false) {
  const dur = msgDur(msg);
  const segs = [];
  let cursor = 0;
  for (const kid of childrenOf(msg.id)) {
    if (!kidVisible(kid, depth, unlocked)) continue;
    const t = Math.min(snapAnchor(msg, (kid.anchorMs || 0) / 1000), dur);
    emitChunks(msg, cursor, t, segs);
    segs.push(...segmentsFor(kid, depth + 1, unlocked || state.filter.expanded.has(kid.id)));
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
function playFrom(msgId, atSec, autoplay = true) {
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
  playSegment(idx, Math.max(atSec, state.playlist[idx].start), autoplay);
}

// transcript click = seek only (keep playing if playing, stay paused if not);
// double-click = seek and play; drag = scrub. Makes placing comments precise.
let transcriptDragTs = 0; // the click that trails a drag isn't a seek
function seekTranscript(msgId, atSec) {
  if (performance.now() - transcriptDragTs < 350) return;
  const keepPlaying = state.playing && !activeEl().paused;
  playFrom(msgId, atSec, keepPlaying);
}

// message-time → virtual-timeline time, if it's in the current playlist
function vtOfMsgTime(msgId, t) {
  if (!state.playlist.length) buildPlaylist();
  const seg = state.playlist.find(s => s.id === msgId && t >= s.start - 0.001 && t < s.end);
  return seg ? seg.vStart + (t - seg.start) : null;
}

const safePlay = el => el.play()?.catch(() => {
  // mobile rejects plays that race a load — one retry covers the transient case
  setTimeout(() => {
    if (state.playing && el === activeEl() && el.paused) el.play().catch(() => {});
  }, 120);
});

function playSegment(idx, offset, autoplay = true) {
  if (state.rec) autoplay = false; // seeks are fine mid-recording; playing is not
  const seg = state.playlist[idx];
  const msg = state.byId.get(seg.id);
  if (!msg) return stopPlayback();
  state.playIdx = idx;
  state.playing = true;
  const src = mediaUrl(msg);
  const at = offset != null ? offset : seg.start;
  const stb = standbyEl();

  if (offset == null && stb._preparedKey === segKey(seg) && stb.readyState >= 1) {
    // handoff: the standby is parked (or already running muted via overlap launch)
    const old = activeEl();
    state.activeIdx ^= 1;
    const el = activeEl();
    el._preparedKey = null; // used up — never trust this park position again
    old.pause();
    if (el._launched) {
      el._launched = false;
      // resync only on real drift (rAF jank, blown estimates) — small overshoot
      // plays through; a routine back-seek here reads as a stutter
      if (Math.abs(el.currentTime - seg.start) > 0.4) el.currentTime = seg.start;
    } else {
      el.currentTime = seg.start; // parked early for overlap — snap to the real start
    }
    el.muted = false;
    if (autoplay) { if (el.paused) safePlay(el); }
    else el.pause();
  } else {
    const el = activeEl();
    el._preparedKey = null;
    el._launched = false;
    el.muted = false;
    if (el.src === src) {
      el.currentTime = at;
      autoplay ? safePlay(el) : el.pause();
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
  loadScreenFor(msg, at);
  updateStage();
  syncPlayButton();
  updateHint();
}

// ---------- screen-share playback ----------
// The camera element is the master clock (it has the voice); the screen video
// just follows it. Cheap to keep honest: seek on load, mirror play/pause, and
// snap whenever drift exceeds a third of a second.
function loadScreenFor(msg, at) {
  if (!msg?.screenKey) return;
  const sp = screenEl();
  const surl = `${location.origin}/media/${msg.screenKey}`;
  if (sp.srcObject) sp.srcObject = null; // playback takes the element over from live preview
  if (sp.getAttribute('src') !== surl) {
    sp._pendingSeek = at;
    sp.preload = 'auto';
    sp.src = surl;
  } else if (sp.readyState >= 1) {
    sp.currentTime = at;
  } else {
    sp._pendingSeek = at;
  }
  sp.muted = true;
  sp.playbackRate = state.speed;
}

function tickScreenSync() {
  if (state.playIdx < 0) return;
  const seg = state.playlist[state.playIdx];
  const msg = state.byId.get(seg?.id);
  if (!msg?.screenKey) return;
  const sp = screenEl();
  if (sp.srcObject || sp.readyState < 1) return;
  const el = activeEl();
  if (el.paused) {
    if (!sp.paused) sp.pause();
  } else {
    if (sp.paused) sp.play().catch(() => {});
    if (Math.abs(sp.currentTime - el.currentTime) > 0.35) sp.currentTime = el.currentTime;
  }
  if (sp.playbackRate !== state.speed) sp.playbackRate = state.speed;
}

const segKey = seg => `${seg.id}@${seg.start.toFixed(3)}`;

// Park the *other* video element just ahead of the next segment. The frame
// ticker launches it muted LEAD seconds before the boundary, so by swap time
// it's already rendering — pause/play startup latency never shows.
const LEAD = 0.25;
function prepareNext(idx) {
  const nseg = state.playlist[idx + 1];
  const stb = standbyEl();
  if (!nseg) { stb._preparedKey = null; return; }
  const nmsg = state.byId.get(nseg.id);
  if (!nmsg) return;
  const key = segKey(nseg);
  if (stb._preparedKey === key && !stb._launched) return;
  const parkAt = Math.max(0, nseg.start - LEAD);
  const nsrc = mediaUrl(nmsg);
  stb._autoplay = false;
  stb._launched = false;
  stb.pause();
  if (stb.src === nsrc && stb.readyState >= 1) {
    stb.currentTime = parkAt;
  } else {
    stb._pendingSeek = parkAt;
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
  screenEl().pause();
  updateStage();
  clearWordHighlight();
  syncPlayButton();
  updateHint();
}

function togglePause() {
  if (!state.playing || state.rec) return; // never un-pause under a recording
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
  // a wild scrub leaves stale machinery behind (parked keys, a muted standby
  // still running from an overlap launch) — reset it all before landing
  for (const p of players) {
    p._launched = false;
    p._preparedKey = null;
  }
  standbyEl().pause();
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
    // Follow the live highlight only while it's on screen. Scroll it out of
    // view and reading stays put; it re-attaches once the highlight is back in
    // view — because you scrolled to it, or playback caught up to where you
    // are. Scrub focus always follows (you're actively steering there).
    if (cls !== 'speaking' || highlightOnScreen(span)) span.scrollIntoView({ block: 'nearest' });
    lastFocus = { key, span };
  }
  span.style.setProperty('--f', `${(f * 100).toFixed(1)}%`);
}

// Is the spoken-word highlight inside the transcript viewport? A couple of
// lines of grace below the fold, so the word that just crossed the bottom
// edge still counts as visible and gets pinned — that's what makes playback
// keep the highlight at the bottom instead of detaching the moment it exits.
// No grace above: if you scrolled down past it, it stays detached.
function highlightOnScreen(span) {
  const box = $('#messages').getBoundingClientRect();
  const r = span.getBoundingClientRect();
  const line = r.height || 24;
  return r.bottom > box.top && r.top < box.bottom + 2.5 * line;
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
  if (!el.paused) {
    // sanity: only enforce boundaries when the active element is actually
    // showing this segment's file — a scrub can briefly leave them mismatched,
    // and advancing on the wrong clock ping-pongs segments (the "twitch")
    const segMsg = state.byId.get(seg.id);
    if (segMsg && el.src !== mediaUrl(segMsg)) return;
    // content-time on both sides: active and standby play at the same rate,
    // so speed cancels out — never scale these thresholds by playbackRate
    const remain = seg.end - el.currentTime;
    // frame-rate boundary enforcement: cut within ~16ms of the splice point.
    // File-end segments are exempt — the 'ended' event is the truth there,
    // since estimated duration can undershoot the real file.
    if (remain <= 0.015 && !isTailSeg(seg)) return advanceSegment(state.playIdx);
    // overlap launch: run the standby muted through the boundary so the swap
    // reveals an already-playing video instead of paying play() startup cost
    if (remain <= LEAD && remain > -1) {
      const nseg = state.playlist[state.playIdx + 1];
      const stb = standbyEl();
      if (nseg && !stb._launched && stb._preparedKey === segKey(nseg) && stb.readyState >= 1) {
        stb._launched = true;
        stb.muted = true;
        stb.playbackRate = state.speed;
        stb.play().catch(() => { stb._launched = false; });
      }
    }
  }
  focusWordAt(seg, el.currentTime, 'speaking');
  tickScreenSync();
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
  // a standby launched muted for an overlap must not keep running under a scrub
  const stb = standbyEl();
  if (stb._launched) {
    stb.pause();
    stb._launched = false;
    stb._preparedKey = null;
  }
  if (el.src !== src) {
    el._pendingSeek = at;
    el._autoplay = false;
    el.src = src;
  } else {
    el.currentTime = at;
  }
  // scrubbing through a screen share previews the screen frame too
  screenEl().pause();
  loadScreenFor(msg, at);
  updateStage();
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
  const segMsg = state.byId.get(seg.id);
  if (segMsg && activeEl().src !== mediaUrl(segMsg)) return; // mismatched after a scrub — don't advance on the wrong clock

  // fallback boundary check (frame ticker cuts tighter); file ends advance via 'ended'
  if (t >= seg.end - 0.05 && !isTailSeg(seg)) return advanceSegment(state.playIdx);

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
  if (idx === -1) return stopPlayback(); // what we were playing got filtered out of view
  state.playIdx = idx;
  prepareNext(idx);
}

// ---------- comment layers ----------
// The picker chooses whose comments you're viewing; recordings route into
// whatever's selected. It only exists once there ARE comment layers to see
// (editors: everyone's; others: their own), and the list is type-ahead
// searchable so a pile of commenters stays navigable.
let layerEntries = [];

function updateLayerPick() {
  const btn = $('#layer-pick');
  const me = state.auth?.user;
  const layers = new Map(); // id -> { label, n }
  for (const mm of state.messages) {
    if (!mm.layer) continue;
    const e = layers.get(mm.layer) || { label: null, n: 0 };
    e.n++;
    if (!e.label && mm.userId === mm.layer) e.label = mm.author; // the layer owner's own clip names it
    layers.set(mm.layer, e);
  }
  layerEntries = [{ id: '', label: 'Conversation', n: null }];
  for (const [id, e] of layers) {
    const label = id === me?.id ? 'My comments'
      : e.label || state.messages.find(mm => mm.layer === id)?.author || 'Commenter';
    layerEntries.push({ id, label, n: e.n });
  }
  const show = canEdit() && layerEntries.length > 1; // editor tool only
  btn.classList.toggle('hidden', !show);
  if (!show) {
    $('#layer-pop').classList.add('hidden');
    if (state.layer) { state.layer = ''; refreshFilter(); }
    return;
  }
  if (!layerEntries.some(e => e.id === state.layer)) { state.layer = ''; refreshFilter(); }
  const cur = layerEntries.find(e => e.id === state.layer);
  btn.textContent = state.layer ? `💬 ${cur.label}` : 'Conversation';
  if (!$('#layer-pop').classList.contains('hidden')) renderLayerList();
}

function renderLayerList() {
  const list = $('#layer-list');
  const q = ($('#layer-search').value || '').trim().toLowerCase();
  list.innerHTML = '';
  for (const e of layerEntries) {
    if (q && !e.label.toLowerCase().includes(q)) continue;
    const row = document.createElement('button');
    row.className = 'menu-row' + (e.id === state.layer ? ' layer-cur' : '');
    row.textContent = e.n != null ? `${e.label} · ${e.n} clip${e.n === 1 ? '' : 's'}` : e.label;
    row.onclick = () => {
      state.layer = e.id;
      $('#layer-pop').classList.add('hidden');
      refreshFilter();
      updateLayerPick();
    };
    list.appendChild(row);
  }
}

// view lens changed (time window, depth, layer, or a fold chip) — rebuild everything
function refreshFilter() {
  state.lastRenderKey = '';
  if (state.playing) remapPlayback();
  else buildPlaylist();
  render();
}

// ---------- recording ----------
const MAX_RECORD_MS = 10 * 60 * 1000; // keep clips balanced
// screens carry text (bits matter), faces don't — weight the budget that way
const SCREEN_BITRATE = 1_500_000;
const CAM_BITRATE = 1_100_000;

async function toggleRecord() {
  if (state.rec) return stopRecord();
  if (!canComment()) {
    const me = state.auth?.user;
    if (state.chatMeta?.comments && me && state.myRole) {
      // commenters just record — their clips land inline in their own view,
      // shared with the editors. One-time heads-up, then stay out of the way.
      if (!state._commentToast) {
        state._commentToast = true;
        showToast('Your clips join the conversation as comments — you and the editors see them');
      }
    } else if (state.chatMeta?.comments && !me) {
      // the moment of intent: they tried to comment — ask them to sign in and
      // remember why, so landing back doesn't feel like a dead end
      sessionStorage.setItem('splitty:recintent', '1');
      wireAuthBox(location.pathname);
      $('#name-gate').classList.remove('hidden');
      return;
    } else {
      return showToast("You're watching this chat — ask an editor for record access");
    }
  }

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
    videoBitsPerSecond: CAM_BITRATE,
  });
  const audioRecorder = new MediaRecorder(
    new MediaStream(stream.getAudioTracks()),
    { ...(audioMime && { mimeType: audioMime }), audioBitsPerSecond: 64000 }
  );
  // screen armed? record it too — same clock, no audio track of its own
  let screenRecorder = null;
  const sChunks = [];
  if (screenStream?.active) {
    screenRecorder = new MediaRecorder(screenStream, {
      ...(videoMime && { mimeType: videoMime }),
      videoBitsPerSecond: SCREEN_BITRATE,
    });
    screenRecorder.ondataavailable = e => e.data.size && sChunks.push(e.data);
  }

  const vChunks = [], aChunks = [];
  recorder.ondataavailable = e => e.data.size && vChunks.push(e.data);
  audioRecorder.ondataavailable = e => e.data.size && aChunks.push(e.data);
  let stoppedCount = 0;
  const stopTarget = screenRecorder ? 3 : 2;
  const onStop = () => {
    if (++stoppedCount < stopTarget) return;
    const rec = state.rec;
    const durationMs = Date.now() - rec.startTs;
    state.rec = null;
    if (rec.discard) {
      // accidental tap — 79ms videos help nobody
      showToast('Too short — tap record, talk, then tap again to send');
      updateStage();
      updateHint();
      if (rec.resume) playFrom(rec.resume.msgId, rec.resume.atSec);
      return;
    }
    enqueueUpload({
      videoBlob: new Blob(vChunks, { type: recorder.mimeType }),
      audioBlob: new Blob(aChunks, { type: audioRecorder.mimeType }),
      screenBlob: sChunks.length ? new Blob(sChunks, { type: screenRecorder.mimeType }) : null,
      rec,
      durationMs,
    });
    // don't wait for the upload — resume watching (and recording) right away
    if (rec.resume) {
      // resume just past the (snapped) splice so you don't replay your own interjection
      const parent = state.byId.get(rec.resume.msgId);
      const at = parent ? snapAnchor(parent, rec.resume.atSec) + 0.001 : rec.resume.atSec;
      playFrom(rec.resume.msgId, at);
    } else {
      updateStage();
    }
    updateHint();
  };
  recorder.onstop = onStop;
  audioRecorder.onstop = onStop;
  if (screenRecorder) screenRecorder.onstop = onStop;

  $('#rec-btn').classList.add('recording');
  $('#rec-btn').classList.remove('attract');
  state.recNudge = false; // the nudge did its job
  $('#menu-pop').classList.add('hidden'); // no device swaps mid-clip

  // where the clip routes: editors record into whatever layer they're
  // viewing; members post to the base; comment-only viewers into their own
  const recLayer = canEdit() ? state.layer : canComment() ? '' : (state.auth?.user?.id || '');
  state.rec = { recorder, audioRecorder, screenRecorder, startTs: Date.now(), parentId, anchorMs, resume, layer: recLayer };
  recorder.start();
  audioRecorder.start();
  screenRecorder?.start();
  updateStage();
  updateHint();
}

function stopRecord() {
  const rec = state.rec;
  if (!rec) return;
  if (Date.now() - rec.startTs < 700) rec.discard = true;
  rec.recorder.stop(); // the upload fires once every recorder has stopped
  rec.audioRecorder.stop();
  rec.screenRecorder?.stop();
  // camera and screen streams stay live — camera is the always-on preview,
  // and screen sharing is a mode that persists across clips until toggled off
  $('#rec-btn').classList.remove('recording');
}

// Background upload queue: sends never block playback or the next recording.
// Jobs go one at a time in FIFO order so clips land in the conversation in the
// order they were recorded (the server stamps createdAt at insert).
const uploader = { jobs: [], running: false, progress: null };

function enqueueUpload(job) {
  job.jid ||= Math.random().toString(36).slice(2);
  job.done = false;
  job.phase = null;
  savePending(job); // survives a refresh/crash — restorePendingUploads offers a resend
  uploader.jobs.push(job);
  state.lastRenderKey = ''; // the placeholder card appears immediately
  render();
  runUploads();
  updateHint();
}

async function runUploads() {
  if (uploader.running) return;
  uploader.running = true;
  while (uploader.jobs.length) {
    const job = uploader.jobs[0];
    try {
      const { message } = await uploadJob(job);
      // your own message never shows as "new" to you
      state.seen[message.id] = 10 * 60 * 60 * 1000;
      localStorage.setItem(`splitty:seen:${state.chatId}`, JSON.stringify(state.seen));
      job.done = true; // placeholder yields...
      await poll();    // ...to the real message, in the same render pass
      uploader.jobs.shift();
      dropPending(job.jid);
    } catch (err) {
      uploader.jobs.shift();
      state.lastRenderKey = ''; // drop the placeholder card
      render();
      if (err.code === 'pending') showToast('Sent limit reached — an admin needs to approve you before you can send more.');
      else if (err.code === 'blocked') showToast('Your account is blocked from sending.');
      else if (err.code === 'role') showToast("You don't have permission to record in this chat.");
      else if (err.code === 'budget') showToast(err.message);
      else if (err.code === 'auth') { showToast('Sign in to send messages.'); $('#name-gate').classList.remove('hidden'); }
      else showToast('Upload failed — the clip is saved here until it sends.', 'Retry', () => enqueueUpload(job));
    }
    uploader.progress = null;
    updateHint();
  }
  uploader.running = false;
}

const jfetch = async (url, opts) => {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `http ${res.status}`), { code: data.code });
  return data;
};

// Big files go up in 8MB parts (R2 multipart via the worker): no single
// request ever hits the Worker body cap, and a flaky part just retries.
const PART_SIZE = 8 * 1024 * 1024;

async function chunkUpload(blob, onBytes) {
  const { key, uploadId } = await jfetch(`/api/chats/${state.chatId}/uploads`, {
    method: 'POST', headers: JSONH, body: JSON.stringify({ mime: blob.type }),
  });
  try {
    const parts = [];
    for (let off = 0, n = 1; off < blob.size; off += PART_SIZE, n++) {
      const slice = blob.slice(off, off + PART_SIZE);
      let attempt = 0, res;
      for (;;) {
        try {
          res = await fetch(
            `/api/chats/${state.chatId}/uploads/part?key=${key}&id=${encodeURIComponent(uploadId)}&n=${n}`,
            { method: 'PUT', body: slice }
          );
          if (!res.ok) throw new Error(`part ${res.status}`);
          break;
        } catch (err) {
          if (++attempt >= 3) throw err;
          await new Promise(r => setTimeout(r, 1500 * attempt)); // network blip — same part again
        }
      }
      parts.push({ partNumber: n, etag: (await res.json()).etag });
      onBytes(slice.size);
    }
    await jfetch(`/api/chats/${state.chatId}/uploads/complete`, {
      method: 'POST', headers: JSONH, body: JSON.stringify({ key, uploadId, parts }),
    });
    return key;
  } catch (err) {
    // leave nothing half-assembled in the bucket
    fetch(`/api/chats/${state.chatId}/uploads/abort`, {
      method: 'POST', headers: JSONH, body: JSON.stringify({ key, uploadId }),
    }).catch(() => {});
    throw err;
  }
}

async function uploadJob(job) {
  const { videoBlob, audioBlob, screenBlob, rec, durationMs } = job;
  job.phase = 'sending';
  // finished keys are memoized on the job, so a Retry never redoes an upload
  const total = videoBlob.size + (screenBlob?.size || 0);
  let sent = (job.videoKey ? videoBlob.size : 0) + (job.screenKey ? screenBlob?.size || 0 : 0);
  const onBytes = b => {
    sent += b;
    uploader.progress = Math.min(99, Math.max(1, Math.round((sent / total) * 100)));
    updateHint();
  };
  if (!job.videoKey) job.videoKey = await chunkUpload(videoBlob, onBytes);
  if (screenBlob && screenBlob.size && !job.screenKey) job.screenKey = await chunkUpload(screenBlob, onBytes);

  // the message itself is now a small request: keys + the ~64kbps audio track
  const fd = new FormData();
  fd.append('videoKey', job.videoKey);
  if (job.screenKey) fd.append('screenKey', job.screenKey);
  if (audioBlob && audioBlob.size) {
    fd.append('audio', audioBlob, `audio.${audioBlob.type.includes('mp4') ? 'm4a' : 'webm'}`);
    fd.append('gain', String(await measureGain(audioBlob)));
  }
  fd.append('author', state.name || 'anon');
  fd.append('durationMs', String(durationMs));
  const lang = localStorage.getItem('splitty:lang');
  if (lang) fd.append('lang', lang); // pin the transcription language
  if (rec.layer) fd.append('layer', rec.layer); // route into a comment layer
  if (rec.parentId) {
    fd.append('parentId', rec.parentId);
    fd.append('anchorMs', String(rec.anchorMs));
  }
  job.phase = 'processing';
  return await jfetch(`/api/chats/${state.chatId}/messages`, { method: 'POST', body: fd });
}

// ---------- audio harvesting ----------
// Old messages predate stored voice tracks, and their videos are too big to
// feed Whisper whole. The browser can demux for us: decodeAudioData pulls the
// audio out of the video container, we downsample to 16kHz mono WAV (all
// Whisper uses anyway), upload that, and the server keeps it as the message's
// audio track — so this only ever has to happen once per message.
function wavBlob(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); ws(8, 'WAVE');
  ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ws(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

async function harvestAndRetranscribe(msg, btn) {
  try {
    showToast('Pulling the audio out of the video — this can take a moment…');
    const res = await fetch(mediaUrl(msg));
    if (!res.ok) throw new Error('fetch');
    // decodeAudioData resamples to the context rate; mix to mono ourselves
    const ctx = new OfflineAudioContext(1, 1, 16000);
    const decoded = await ctx.decodeAudioData(await res.arrayBuffer());
    const ch0 = decoded.getChannelData(0);
    let mono = ch0;
    if (decoded.numberOfChannels > 1) {
      const ch1 = decoded.getChannelData(1);
      mono = new Float32Array(ch0.length);
      for (let i = 0; i < ch0.length; i++) mono[i] = (ch0[i] + ch1[i]) / 2;
    }
    const wav = wavBlob(mono, decoded.sampleRate);
    showToast('Uploading the extracted audio…');
    const key = await chunkUpload(wav, () => {});
    const r = await fetch(`/api/chats/${state.chatId}/messages/${msg.id}/transcribe`, {
      method: 'POST', headers: JSONH,
      body: JSON.stringify({
        author: state.name,
        language: localStorage.getItem('splitty:lang') || '',
        audioKey: key,
      }),
    });
    if (!r.ok) throw new Error('transcribe');
    showToast('Retranscribing…');
    state.lastRenderKey = '';
    poll();
  } catch {
    showToast("Couldn't extract audio from that video on this device");
    if (btn) btn.disabled = false;
  }
}

// ---------- unsent-clip persistence ----------
// Recordings live only in memory while uploading; IndexedDB keeps a copy (it
// holds Blobs, unlike localStorage) so a refresh or crash can't eat a clip.
const idbPending = async (mode, fn) => {
  try {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('splitty', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('pending', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const out = await new Promise((resolve, reject) => {
      const tx = db.transaction('pending', mode);
      const req = fn(tx.objectStore('pending'));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return out;
  } catch {
    return null; // private browsing etc. — persistence is best-effort
  }
};

const savePending = job => idbPending('readwrite', s => s.put({
  id: job.jid, chatId: state.chatId, ts: Date.now(),
  videoBlob: job.videoBlob, audioBlob: job.audioBlob, screenBlob: job.screenBlob,
  durationMs: job.durationMs, parentId: job.rec.parentId, anchorMs: job.rec.anchorMs,
  layer: job.rec.layer || '',
}));
const dropPending = jid => idbPending('readwrite', s => s.delete(jid));

async function restorePendingUploads() {
  const rows = await idbPending('readonly', s => s.getAll());
  if (!rows?.length) return;
  const mine = [];
  for (const r of rows) {
    if (Date.now() - r.ts > 7 * 24 * 3600 * 1000) dropPending(r.id); // stale — let it go
    else if (r.chatId === state.chatId) mine.push(r);
  }
  if (!mine.length) return;
  showToast(
    mine.length > 1 ? `${mine.length} clips from earlier never finished sending` : 'A clip from earlier never finished sending',
    'Send now',
    () => mine.forEach(r => enqueueUpload({
      jid: r.id,
      videoBlob: r.videoBlob, audioBlob: r.audioBlob, screenBlob: r.screenBlob,
      durationMs: r.durationMs,
      rec: { parentId: r.parentId, anchorMs: r.anchorMs, resume: null, layer: r.layer || '' },
    }))
  );
}

// a pending upload would be lost if the tab closes now
window.addEventListener('beforeunload', e => {
  if (uploader.jobs.length) e.preventDefault();
});

// recording timer + hint line + the 10-minute cap
setInterval(() => {
  if (state.rec && !state.rec.discard && Date.now() - state.rec.startTs >= MAX_RECORD_MS) {
    stopRecord();
    showToast('Hit the 10-minute limit — sending this clip');
  }
  updateHint();
  updatePendingCards();
  updateVidSpinner();
}, 250);

// spinner over the video box while the active video has no frame to show
// (first load) or is stalled buffering mid-play
function updateVidSpinner() {
  const spin = $('#vid-spin');
  if (!state.playing || state.playIdx < 0) return spin.classList.add('hidden');
  const el = activeEl();
  spin.classList.toggle('hidden', !(el.readyState < 2 || el._waiting));
}

// only transient status (recording timer, upload state) — empty hides the pill.
// Recording wins the pill; background sends show while idle.
function updateHint(text) {
  if (text == null && state.rec) {
    const elapsed = Date.now() - state.rec.startTs;
    const s = Math.floor(elapsed / 1000);
    const what = state.rec.screenRecorder ? 'Recording you + screen' : 'Recording';
    text = `● ${what} ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} — tap to send`;
    const left = MAX_RECORD_MS - elapsed;
    if (left < 60_000) text += ` · ${Math.max(Math.ceil(left / 1000), 0)}s left`;
  }
  if (text == null && state.recNudge) text = "You're in — tap ● to record";
  if (text == null && uploader.jobs.length) {
    const pct = uploader.progress != null ? ` ${uploader.progress}%` : '';
    text = uploader.jobs.length > 1 ? `Sending ${uploader.jobs.length} clips…${pct}` : `Sending…${pct}`;
  }
  $('#rec-hint').textContent = text ?? '';
}

// ---------- floating videos (PiPs) ----------
// Geometry lives in JS as box-relative ratios: the pip box always matches the
// video's real aspect ratio (no blank bars, no cropping), survives box
// resizes, and follows mid-clip size changes via the 'resize' video event.
const pips = {
  cam: {   // your own camera preview while watching / screen-sharing
    key: 'splitty:pip:cam',
    geom: null,
    defW: 0.22, defRight: true,
    mini: localStorage.getItem('splitty:pipmini') === '1',
    onTap() { // tap still shrinks/restores — the quick gesture stays
      this.mini = !this.mini;
      localStorage.setItem('splitty:pipmini', this.mini ? '1' : '');
      relayoutPips();
    },
  },
  spip: {  // the small video during screen-share playback
    key: 'splitty:pip:screen',
    geom: null,
    defW: 0.24, defRight: false,
    mini: false,
    onTap() { // tap swaps which video is big
      setScreenLayout(state.screenLayout === 'cam' ? 'screen' : 'cam');
      lastPipSwap = performance.now();
    },
  },
};
for (const c of Object.values(pips)) {
  try { c.geom = JSON.parse(localStorage.getItem(c.key)) || null; } catch { /* fresh */ }
}

const pipAspect = el => (el.videoWidth && el.videoHeight ? el.videoWidth / el.videoHeight : 4 / 3);

// pips are position:fixed so they can live anywhere in the window (the video
// box's overflow:hidden doesn't clip fixed descendants); geometry is stored
// as viewport ratios so it survives window resizes
function layoutPip(el, conf) {
  const vw = window.innerWidth, vh = window.innerHeight;
  const box = $('#video-box').getBoundingClientRect();
  const ar = pipAspect(el);
  let w = conf.mini ? 110 : (conf.geom ? conf.geom.wr * vw : conf.defW * Math.max(box.width, 320));
  w = Math.min(Math.max(w, 80), vw * 0.8);
  let h = w / ar;
  if (h > vh * 0.8) { h = vh * 0.8; w = h * ar; }
  // default perch: over the video box, corners apart so the two never stack
  let x = conf.geom ? conf.geom.xr * vw : conf.defRight ? box.right - w - 8 : box.left + 12;
  let y = conf.geom ? conf.geom.yr * vh : Math.max(box.top + 8, 4);
  x = Math.min(Math.max(x, 4), Math.max(vw - w - 4, 4));
  y = Math.min(Math.max(y, 4), Math.max(vh - h - 4, 4));
  Object.assign(el.style, {
    position: 'fixed', inset: 'auto', zIndex: 70, // above the page, below modals/toasts
    left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`,
  });
}

function clearPip(el) {
  for (const p of ['position', 'inset', 'left', 'top', 'width', 'height', 'z-index', 'cursor']) {
    el.style.removeProperty(p);
  }
}

// is this element currently one of the floating videos?
function isPipNow(el) {
  const box = $('#video-box');
  if (el === preview) return box.classList.contains('mode-play') || box.classList.contains('mode-screenlive');
  return el.classList.contains('spip');
}

// diagonal resize cursors over the corners, grab elsewhere
function pipHoverCursor(e) {
  const el = e.currentTarget;
  if (!isPipNow(el)) { el.style.removeProperty('cursor'); return; }
  const r = el.getBoundingClientRect();
  const L = e.clientX - r.left < 20, R = r.right - e.clientX < 20;
  const T = e.clientY - r.top < 20, B = r.bottom - e.clientY < 20;
  el.style.cursor = (L && T) || (R && B) ? 'nwse-resize'
    : (R && T) || (L && B) ? 'nesw-resize' : 'grab';
}

function relayoutPips() {
  const box = $('#video-box');
  if (box.classList.contains('mode-play') || box.classList.contains('mode-screenlive')) {
    layoutPip(preview, pips.cam);
  }
  const spipEl = [...players, screenEl()].find(p => p.classList.contains('spip'));
  if (spipEl) layoutPip(spipEl, pips.spip);
}

function setScreenLayout(layout) {
  state.screenLayout = layout;
  localStorage.setItem('splitty:screenlayout', layout);
  updateStage();
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
  $('#pause-btn').classList.toggle('hidden', mode !== 'play');
  paintScreenBtn();
  if (mode === 'none') { stage.classList.add('hidden'); return; }
  if (mode === 'enable') {
    // camera not granted yet: keep the stage visible with the enable button
    stage.classList.remove('hidden');
    preview.classList.add('hidden');
    players.forEach(p => p.classList.add('hidden'));
    $('#transport').classList.add('hidden');
    $('#pip-label').textContent = '';
    $('#cam-off').classList.remove('hidden'); // blocked camera: glyph behind the enable button
    return;
  }
  stage.classList.remove('hidden');
  box.classList.toggle('mode-play', mode === 'play');
  box.classList.toggle('mode-record', mode === 'record');

  // screen layers: live share preview while idle/recording, or the recorded
  // screen track of whatever's playing
  const seg = mode === 'play' && state.playIdx >= 0 ? state.playlist[state.playIdx] : null;
  const curMsg = seg ? state.byId.get(seg.id) : null;
  const screenPlay = mode === 'play' && !!curMsg?.screenKey;
  const screenLive = mode !== 'play' && !!screenStream?.active;
  const sp = screenEl();
  if (screenLive && sp.srcObject !== screenStream) {
    sp.removeAttribute('src');
    sp.srcObject = screenStream;
    sp.play().catch(() => {});
  }
  if (!screenLive && sp.srcObject) sp.srcObject = null;
  if (!screenPlay && !screenLive && !sp.paused) sp.pause(); // moved on to a screen-less message
  box.classList.toggle('mode-screen', screenPlay);
  box.classList.toggle('mode-screenlive', screenLive);
  sp.classList.toggle('hidden', !(screenPlay || screenLive));
  const split = screenPlay && state.screenLayout === 'split';
  box.classList.toggle('screen-split', split);
  const splitBtn = $('#split-btn');
  splitBtn.classList.toggle('hidden', !screenPlay);
  splitBtn.textContent = split ? 'PiP' : 'Split'; // button shows the alternative
  splitBtn.onclick = () => setScreenLayout(split ? 'screen' : 'split');
  // which video is the little draggable one (tap it to swap) — none when split
  players.forEach(p => p.classList.remove('spip'));
  sp.classList.remove('spip');
  if (screenPlay && !split) (state.screenLayout === 'cam' ? sp : activeEl()).classList.add('spip');

  // floating-video geometry: sized to each video's real aspect, user-placed
  if (mode === 'play' || screenLive) layoutPip(preview, pips.cam);
  else clearPip(preview);
  for (const el of [...players, sp]) {
    if (el.classList.contains('spip')) layoutPip(el, pips.spip);
    else clearPip(el);
  }

  preview.classList.toggle('hidden', !camStream);
  // never a silently empty box: show the camera-off glyph when the stage
  // would be showing your camera but there's no stream
  $('#cam-off').classList.toggle('hidden', !(mode !== 'play' && !camStream && !screenLive));
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
  const pending = uploader.jobs.filter(j => !j.done);
  const key = JSON.stringify(state.messages.map(m => [m.id, m.transcriptStatus, m.words.length, m.anchorMs]))
    + '|' + pending.map(j => j.jid).join(',');
  if (key === state.lastRenderKey) return;
  state.lastRenderKey = key;

  const box = $('#messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 200;
  box.innerHTML = '';

  if (!state.messages.length && !pending.length) {
    box.innerHTML = '<div class="empty">Nothing here yet.<br>Record the first video note.</div>';
    return;
  }

  for (const msg of roots()) box.appendChild(renderMessage(msg, 0));
  // in-flight clips whose card didn't land inline (new roots, or the parent
  // isn't on screen) sit at the bottom until the server hands back the real one
  for (const job of pending) {
    if (!box.querySelector(`.pending-msg[data-jid="${job.jid}"]`)) box.appendChild(pendingCard(job));
  }
  if (nearBottom) box.scrollTop = box.scrollHeight;

  remapPlayback();
  prefetchUnheard();
}

// ghost card for a clip that's still uploading/processing
function pendingCard(job) {
  const card = document.createElement('div');
  card.className = 'msg mine pending-msg';
  card.dataset.jid = job.jid;
  card.style.setProperty('--author-color', colorFor(state.name || 'anon'));
  card.innerHTML = `
    <div class="msg-head">
      <span class="pending-spin"></span>
      <span class="author"></span>
      <span class="dur">${job.durationMs ? fmtClock(job.durationMs / 1000) : ''}</span>
      <span class="spacer"></span>
    </div>
    <div class="msg-body"><span class="muted pending-status"></span></div>`;
  const author = card.querySelector('.author');
  author.textContent = state.name || 'anon';
  author.style.color = colorFor(state.name || 'anon');
  card.querySelector('.pending-status').textContent = pendingStatusText(job);
  return card;
}

function pendingStatusText(job) {
  if (job.phase === 'processing') return 'Processing…';
  const active = uploader.jobs.find(j => !j.done);
  if (job !== active) return 'Waiting to send…';
  return uploader.progress != null ? `Sending… ${uploader.progress}%` : 'Sending…';
}

// keep the ghost cards' status lines live without rebuilding the transcript
function updatePendingCards() {
  for (const el of document.querySelectorAll('.pending-msg')) {
    const job = uploader.jobs.find(j => j.jid === el.dataset.jid);
    if (job) el.querySelector('.pending-status').textContent = pendingStatusText(job);
  }
}

function renderMessage(msg, depth, unlocked = false) {
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
    ${msg.screenKey ? '<span class="screen-tag" title="Includes a screen share">🖥</span>' : ''}
    ${msg.layer ? '<span class="screen-tag" title="Comment — visible to its author and the editors">💬</span>' : ''}
    ${isNew ? '<span class="badge">new</span>' : ''}
    <span class="spacer"></span>
    ${(mine || canEdit()) && depth > 0 ? '<span class="drag-handle" title="Drag onto a word to move where this interjects">⠿</span>' : ''}
    ${(mine || canEdit()) && msg.transcriptStatus !== 'pending' ? '<button class="retr-btn" title="Transcribe again (uses your language setting)">↻</button>' : ''}
    ${mine || canEdit() ? '<button class="del-btn" title="Delete this message">✕</button>' : ''}`;
  const authorEl = head.querySelector('.author');
  authorEl.textContent = msg.author;
  authorEl.style.color = colorFor(msg.author);
  head.querySelector('.play-btn').onclick = () => playFrom(msg.id, 0);
  const handle = head.querySelector('.drag-handle');
  if (handle) handle.addEventListener('pointerdown', e => startAnchorDrag(e, msg));
  const retrBtn = head.querySelector('.retr-btn');
  if (retrBtn) retrBtn.onclick = async () => {
    retrBtn.disabled = true;
    const res = await fetch(`/api/chats/${state.chatId}/messages/${msg.id}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: state.name, language: localStorage.getItem('splitty:lang') || '' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // video too big to feed Whisper whole — extract the audio right here
      if (data.code === 'toobig') return harvestAndRetranscribe(msg, retrBtn);
      retrBtn.disabled = false;
      return showToast(data.error || "Couldn't retranscribe that one");
    }
    showToast('Retranscribing…');
    state.lastRenderKey = '';
    poll();
  };
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
    g.dataset.t = prevEnd;   // scrub range, same shape as words
    g.dataset.e = nextStart;
    g.style.width = `${Math.round(Math.min(10 + (gapSec - 0.4) * 26, 56))}px`;
    g.title = `${gapSec.toFixed(1)}s pause`;
    g.onclick = () => seekTranscript(msg.id, prevEnd + 0.01);
    g.ondblclick = () => playFrom(msg.id, prevEnd + 0.01);
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
      span.dataset.e = w.e;
      span.textContent = w.w;
      span.onclick = () => seekTranscript(msg.id, w.s + 0.001);
      span.ondblclick = () => playFrom(msg.id, w.s + 0.001);
      frag.appendChild(span);
      frag.appendChild(document.createTextNode(' '));
      wi++;
    }
    return frag;
  };

  // interleave real replies with in-flight ghosts at their anchors
  const pendKids = uploader.jobs.filter(j => !j.done && j.rec?.parentId === msg.id);
  const entries = [
    ...kids.map(k => ({ t: (k.anchorMs || 0) / 1000, kid: k })),
    ...pendKids.map(j => ({ t: (j.rec.anchorMs || 0) / 1000, job: j })),
  ].sort((a, b) => a.t - b.t);
  for (const { t, kid, job } of entries) {
    body.appendChild(flushWordsUntil(t));
    if (job) {
      body.appendChild(pendingCard(job));
      continue;
    }
    if (kidVisible(kid, depth, unlocked)) {
      body.appendChild(renderMessage(kid, depth + 1, unlocked || state.filter.expanded.has(kid.id)));
    } else {
      // folded: the subtree collapses to a chip at its anchor — tap to open it
      const s = subtreeStats(kid);
      const chip = document.createElement('button');
      chip.className = 'fold-chip';
      chip.style.setProperty('--chip-color', colorFor(kid.author));
      chip.textContent = `▸ ${kid.author} · ${s.n === 1 ? '1 clip' : `${s.n} clips`} · ${fmtClock(s.dur)}`;
      chip.title = 'Show this thread';
      chip.onclick = () => {
        state.filter.expanded.add(kid.id);
        refreshFilter();
      };
      body.appendChild(chip);
    }
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

// ---------- timeline lens (time window + reply-depth fold) ----------
// A dual-ended window over message creation time (with a histogram of when
// people talked), plus a fold-level slider for reply depth. Both feed the
// same visibility rules that build the transcript and the playlist.
let histBounds = null; // { min, max } createdAt across the whole chat
let histCount = -1;

function initTimeline() {
  const bar = $('#history-bar');
  const tMinEl = $('#t-min'), tMaxEl = $('#t-max'), tFill = $('#time-fill');
  const dual = $('#time-dual');
  const dr = $('#depth-range');

  $('#lens-btn').onclick = () => {
    const hidden = bar.classList.toggle('hidden');
    $('#lens-btn').classList.toggle('lens-open', !hidden);
    if (!hidden) refreshTimelinePanel(true);
  };

  // rebuilding transcript + playlist every input event janks on long chats
  let queued = false;
  const throttledRefresh = () => {
    if (queued) return;
    queued = true;
    setTimeout(() => { queued = false; refreshFilter(); }, 120);
  };

  // thumbs travel an inset track ([tw/2, 100% - tw/2]) — the fill bar must
  // live in the same coordinate space or it pokes past the dots at the ends
  const fillCss = (a, b) => {
    tFill.style.left = `calc(7.5px + (100% - 15px) * ${a / 1000})`;
    tFill.style.width = `calc((100% - 15px) * ${Math.max(0, b - a) / 1000})`;
  };
  const fmtT = ms => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  function applyTime() {
    const a = +tMinEl.value, b = +tMaxEl.value;
    fillCss(a, b);
    if (!histBounds || (a <= 0 && b >= 1000)) {
      state.filter.t0 = state.filter.t1 = null;
      $('#win-label').textContent = 'All time';
    } else {
      const span = histBounds.max - histBounds.min || 1;
      state.filter.t0 = histBounds.min + span * (a / 1000);
      state.filter.t1 = histBounds.min + span * (b / 1000);
      $('#win-label').textContent = `${fmtT(state.filter.t0)} – ${fmtT(state.filter.t1)}`;
    }
    throttledRefresh();
  }
  state._applyTime = applyTime;

  tMinEl.oninput = () => { if (+tMinEl.value > +tMaxEl.value) tMinEl.value = tMaxEl.value; applyTime(); };
  tMaxEl.oninput = () => { if (+tMaxEl.value < +tMinEl.value) tMaxEl.value = tMinEl.value; applyTime(); };

  // pointer feel (ported from moots): near a thumb grabs that handle, inside
  // the window drags the whole window, outside jumps the nearest handle
  dual.addEventListener('pointerdown', e => {
    e.preventDefault();
    const r = dual.getBoundingClientRect();
    const TW = 15;
    const val = ev => Math.round(Math.min(1, Math.max(0, (ev.clientX - r.left - TW / 2) / (r.width - TW))) * 1000);
    const xOf = v => r.left + TW / 2 + (v / 1000) * (r.width - TW);
    const v0 = val(e), a0 = +tMinEl.value, b0 = +tMaxEl.value;
    const GRAB = 9;
    const nearA = Math.abs(e.clientX - xOf(a0)) <= GRAB, nearB = Math.abs(e.clientX - xOf(b0)) <= GRAB;
    const inside = v0 > a0 && v0 < b0;
    const mode = nearA && nearB ? 'pan' : nearA ? 'a' : nearB ? 'b' : inside ? 'pan' : v0 < a0 ? 'a' : 'b';
    if (mode === 'pan') tFill.focus({ preventScroll: true });
    const move = ev => {
      const nv = val(ev);
      if (mode === 'pan') {
        const dv = Math.max(-a0, Math.min(1000 - b0, nv - v0));
        tMinEl.value = a0 + dv;
        tMaxEl.value = b0 + dv;
      } else if (mode === 'a') {
        tMinEl.value = Math.min(nv, +tMaxEl.value);
      } else {
        tMaxEl.value = Math.max(nv, +tMinEl.value);
      }
      applyTime();
    };
    dual.setPointerCapture(e.pointerId);
    if (mode !== 'pan') move(e); // handles jump to the pointer; panning starts in place
    dual.addEventListener('pointermove', move);
    const up = () => dual.removeEventListener('pointermove', move);
    dual.addEventListener('pointerup', up, { once: true });
    dual.addEventListener('pointercancel', up, { once: true });
  });

  // once the fill bar is focused, arrows slide the whole window
  tFill.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = (e.shiftKey ? 50 : 10) * (e.key === 'ArrowLeft' ? -1 : 1);
    const a = +tMinEl.value, b = +tMaxEl.value;
    const dv = Math.max(-a, Math.min(1000 - b, step));
    tMinEl.value = a + dv;
    tMaxEl.value = b + dv;
    applyTime();
  });

  function applyDepth() {
    const max = +dr.max, v = +dr.value;
    state.filter.depth = v >= max ? Infinity : v;
    state.filter.expanded.clear(); // moving the slider resets chip overrides
    $('#depth-label').textContent = v >= max ? 'All' : v === 0 ? 'Roots' : String(v);
    refreshTimelinePanel(true); // the histogram thins along with the fold level
    throttledRefresh();
  }
  dr.oninput = applyDepth;

  $('#lens-reset').onclick = () => {
    tMinEl.value = 0;
    tMaxEl.value = 1000;
    dr.value = dr.max;
    state.filter.expanded.clear();
    applyTime();
    applyDepth();
  };
}

function depthMap() {
  const memo = new Map();
  const d = m => {
    if (!m.parentId) return 0;
    if (memo.has(m.id)) return memo.get(m.id);
    const p = state.byId.get(m.parentId);
    const v = p ? d(p) + 1 : 0;
    memo.set(m.id, v);
    return v;
  };
  for (const m of state.messages) memo.set(m.id, d(m));
  return memo;
}

function maxTreeDepth() {
  return state.messages.length ? Math.max(...depthMap().values()) : 0;
}

// histogram + slider bounds follow the data; runs on open and on new messages
function refreshTimelinePanel(force = false) {
  if ($('#history-bar').classList.contains('hidden')) return;
  if (!force && histCount === state.messages.length) return;
  histCount = state.messages.length;
  const ts = state.messages.map(m => m.createdAt);
  histBounds = ts.length ? { min: Math.min(...ts), max: Math.max(...ts) } : null;

  // minimap: every clip is a block — positioned at its creation moment, width
  // proportional to its duration, packed into stacked lanes when clips
  // overlap, colored by speaker. Recorded-live conversations tile into the
  // reply-structure silhouette; the depth slider thins the stacks.
  const box = $('#hist-bars');
  box.innerHTML = '';
  if (histBounds && ts.length > 1) {
    const dm = depthMap();
    const visible = state.messages
      .filter(m => (dm.get(m.id) || 0) <= state.filter.depth && layerOk(m))
      .sort((a, b) => a.createdAt - b.createdAt);
    const min = histBounds.min;
    const span = Math.max(1,
      Math.max(...visible.map(m => m.createdAt + msgDur(m) * 1000), histBounds.max) - min);
    const lanes = []; // right edge of the last block in each lane
    const blocks = [];
    for (const m of visible) {
      const x0 = (m.createdAt - min) / span;
      const w = Math.max((msgDur(m) * 1000) / span, 0.006);
      let L = lanes.findIndex(end => end <= x0 + 0.002);
      if (L === -1) {
        if (lanes.length < 8) { L = lanes.length; lanes.push(0); }
        else L = lanes.indexOf(Math.min(...lanes)); // crowded — least-bad lane
      }
      lanes[L] = x0 + w;
      blocks.push({ x0, w, L, author: m.author });
    }
    const laneH = 100 / Math.max(3, lanes.length);
    for (const b of blocks) {
      const el = document.createElement('div');
      el.className = 'mini-block';
      el.style.left = `${b.x0 * 100}%`;
      el.style.width = `${Math.min(b.w, 1 - b.x0) * 100}%`;
      el.style.bottom = `${b.L * laneH}%`;
      el.style.height = `${laneH}%`;
      el.style.background = colorFor(b.author);
      box.appendChild(el);
    }
  }

  const dr = $('#depth-range');
  const max = Math.max(1, maxTreeDepth());
  const wasAll = +dr.value >= +dr.max;
  dr.max = max;
  if (wasAll) dr.value = max;
  $('#depth-label').textContent = +dr.value >= max ? 'All' : +dr.value === 0 ? 'Roots' : dr.value;
  state._applyTime?.();
}

// ---------- share panel ----------
const JSONH = { 'Content-Type': 'application/json' };

async function copyChatLink(btn, label) {
  await navigator.clipboard.writeText(`${location.origin}/c/${state.chatId}`);
  btn.textContent = 'Copied!';
  setTimeout(() => (btn.textContent = label), 1500);
}

function openShare() {
  $('#share-gate').classList.remove('hidden');
  lastShareKey = ''; // always paint fresh on open
  renderShare();
  if (canEdit() && state.friends === null) loadFriends();
}

async function loadFriends() {
  try {
    const res = await fetch('/api/friends');
    if (!res.ok) return;
    state.friends = (await res.json()).friends || [];
    renderShare();
  } catch { /* panel just skips the quick-add list */ }
}

// one row of the share panel: avatar + name/subtitle + trailing controls
function shareRow(name, sub, picture) {
  const row = document.createElement('div');
  row.className = 'share-row';
  if (picture) {
    const img = document.createElement('img');
    img.className = 'avatar';
    img.src = picture;
    img.referrerPolicy = 'no-referrer';
    row.appendChild(img);
  }
  const label = document.createElement('span');
  label.className = 'sr-name';
  label.textContent = name;
  if (sub) {
    const s = document.createElement('small');
    s.className = 'sr-sub';
    s.textContent = sub;
    label.appendChild(s);
  }
  row.appendChild(label);
  return row;
}

const roleSelect = (value, disabled = false) => {
  const sel = document.createElement('select');
  for (const [v, t] of [['editor', 'Editor'], ['commenter', 'Commenter'], ['viewer', 'Viewer']]) {
    sel.appendChild(Object.assign(document.createElement('option'), { value: v, textContent: t }));
  }
  sel.value = value;
  sel.disabled = disabled;
  return sel;
};

let lastShareKey = '';
function renderShare() {
  const editor = canEdit();
  // polls call this every 2.5s while the panel is open — only rebuild the DOM
  // when the underlying data changed, so open menus/half-typed text survive
  const key = JSON.stringify([
    editor, state.chatMeta?.ownerId, state.chatMeta?.visibility, state.chatMeta?.comments,
    state.members, state.invites, state.requests, state.friends,
  ]);
  if (key === lastShareKey) return;
  lastShareKey = key;

  // legacy chat: no owner yet — offer to switch sharing controls on
  const legacy = !state.chatMeta?.ownerId;
  $('#share-claim-wrap').classList.toggle('hidden', !legacy);
  if (legacy) {
    for (const id of ['#vis-row', '#comments-row', '#share-ask', '#share-fork', '#share-fork-note',
      '#share-requests-wrap', '#share-members-wrap', '#share-invite-wrap']) {
      $(id).classList.add('hidden');
    }
    $('#share-copy').onclick = () => copyChatLink($('#share-copy'), 'Copy chat link');
    const signedIn = !!state.auth?.user;
    $('#share-claim').classList.toggle('hidden', !signedIn);
    $('#share-claim-note').classList.toggle('hidden', signedIn);
    $('#share-claim').onclick = async () => {
      $('#share-claim').disabled = true;
      const res = await fetch(`/api/chats/${state.chatId}/claim`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      $('#share-claim').disabled = false;
      if (!res.ok) return showToast(data.error || "Couldn't set up sharing");
      showToast("Sharing is on — you're the owner now");
      await poll(); // panel repaints with the full member/invite UI
    };
    return;
  }

  $('#vis-row').classList.toggle('hidden', !editor);
  const vis = $('#vis-toggle');
  vis.checked = state.chatMeta?.visibility === 'public';
  vis.onchange = async () => {
    const visibility = vis.checked ? 'public' : 'private';
    const res = await fetch(`/api/chats/${state.chatId}`, {
      method: 'PATCH', headers: JSONH, body: JSON.stringify({ visibility }),
    });
    if (res.ok) {
      state.chatMeta.visibility = visibility;
      showToast(visibility === 'public' ? 'Anyone with the link can watch now' : 'Back to invite-only');
    } else {
      vis.checked = !vis.checked;
    }
  };
  $('#share-copy').onclick = () => copyChatLink($('#share-copy'), 'Copy chat link');

  // comments switch: viewers get their own private annotation layers
  $('#comments-row').classList.toggle('hidden', !editor);
  const ct = $('#comments-toggle');
  ct.checked = !!state.chatMeta?.comments;
  ct.onchange = async () => {
    const comments = ct.checked;
    const res = await fetch(`/api/chats/${state.chatId}`, {
      method: 'PATCH', headers: JSONH, body: JSON.stringify({ comments }),
    });
    if (res.ok) {
      state.chatMeta.comments = comments;
      showToast(comments
        ? 'Comments on — share the link and anyone who can watch can leave them'
        : 'Comments off — existing ones stay visible to you');
      updateLayerPick();
      setRole(state.myRole); // record button visibility can change for viewers
    } else {
      ct.checked = !comments;
    }
  };

  // a signed-in viewer who isn't a member yet (public chat / invite peek) can knock
  const amMember = state.members.some(mm => mm.userId === state.auth?.user?.id);
  const canAsk = !!state.auth?.user && !amMember && !editor && !!state.chatMeta?.ownerId;
  $('#share-ask').classList.toggle('hidden', !canAsk);
  $('#share-ask').onclick = async () => {
    const r = await fetch(`/api/chats/${state.chatId}/request`, { method: 'POST' });
    if (r.ok) {
      $('#share-ask').textContent = 'Asked — waiting for an editor';
      $('#share-ask').disabled = true;
    }
  };

  // fork: approved accounts with access can spin this conversation (plus
  // their own comments, woven in) into a chat they own
  const canFork = state.auth?.user?.status === 'approved' && !!state.chatMeta?.ownerId;
  $('#share-fork').classList.toggle('hidden', !canFork);
  $('#share-fork-note').classList.toggle('hidden', !canFork);
  $('#share-fork').onclick = async () => {
    const btn = $('#share-fork');
    btn.disabled = true;
    btn.textContent = 'Forking…';
    const res = await fetch(`/api/chats/${state.chatId}/fork`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.id) {
      location.href = `/c/${data.id}`;
    } else {
      btn.disabled = false;
      btn.textContent = 'Fork — make this conversation yours';
      showToast(data.error || "Couldn't fork this chat");
    }
  };

  // knocking at the door
  $('#share-requests-wrap').classList.toggle('hidden', !editor || !state.requests.length);
  const rq = $('#share-requests');
  rq.innerHTML = '';
  if (editor) {
    for (const r of state.requests) {
      const row = shareRow(r.name, 'wants to join', r.picture);
      const sel = roleSelect('commenter');
      const ok = Object.assign(document.createElement('button'), { className: 'btn-ghost', textContent: 'Let in' });
      ok.onclick = async () => {
        await fetch(`/api/chats/${state.chatId}/requests/${r.userId}`, {
          method: 'POST', headers: JSONH, body: JSON.stringify({ role: sel.value }),
        });
        poll();
      };
      const no = Object.assign(document.createElement('button'), { className: 'btn-danger', textContent: '✕', title: 'Deny' });
      no.onclick = async () => {
        await fetch(`/api/chats/${state.chatId}/requests/${r.userId}`, { method: 'DELETE' });
        poll();
      };
      row.append(sel, ok, no);
      rq.appendChild(row);
    }
  }

  // who's in
  $('#share-members-wrap').classList.toggle('hidden', !state.members.length);
  const mb = $('#share-members');
  mb.innerHTML = '';
  for (const mem of state.members) {
    const me = mem.userId === state.auth?.user?.id;
    const row = shareRow(mem.name + (me ? ' (you)' : ''), null, mem.picture);
    if (mem.isOwner) {
      row.appendChild(Object.assign(document.createElement('span'), { className: 'owner-pill', textContent: 'owner' }));
    } else if (editor) {
      const sel = roleSelect(mem.role);
      sel.onchange = async () => {
        const res = await fetch(`/api/chats/${state.chatId}/members/${mem.userId}`, {
          method: 'PATCH', headers: JSONH, body: JSON.stringify({ role: sel.value }),
        });
        if (!res.ok) sel.value = mem.role;
        poll();
      };
      const kick = Object.assign(document.createElement('button'), { className: 'btn-danger', textContent: '✕', title: 'Remove from chat' });
      kick.onclick = async () => {
        if (!confirm(`Remove ${mem.name} from this chat?`)) return;
        await fetch(`/api/chats/${state.chatId}/members/${mem.userId}`, { method: 'DELETE' });
        poll();
      };
      row.append(sel, kick);
    } else {
      row.appendChild(Object.assign(document.createElement('span'), { className: 'sr-sub', textContent: mem.role }));
    }
    mb.appendChild(row);
  }

  // invites + quick-add
  $('#share-invite-wrap').classList.toggle('hidden', !editor);
  if (!editor) return;

  $('#invite-form').onsubmit = async e => {
    e.preventDefault();
    const name = $('#invite-name').value.trim();
    const res = await fetch(`/api/chats/${state.chatId}/invites`, {
      method: 'POST', headers: JSONH,
      body: JSON.stringify({ name, role: $('#invite-role').value }),
    });
    if (!res.ok) return showToast("Couldn't create the invite");
    const { url } = await res.json();
    try { await navigator.clipboard.writeText(url); } catch {}
    showToast(name ? `Invite link for ${name} copied — send it over` : 'Invite link copied — send it over');
    $('#invite-name').value = '';
    poll();
  };

  const iv = $('#share-invites');
  iv.innerHTML = '';
  for (const inv of state.invites) {
    const used = !!inv.usedBy;
    const row = shareRow(
      inv.name || 'Unnamed invite',
      used ? `${inv.role} · used by ${inv.usedByName || 'someone'}` : `${inv.role} · not used yet`,
    );
    if (!used) {
      const copy = Object.assign(document.createElement('button'), { className: 'btn-ghost', textContent: 'Copy' });
      copy.onclick = async () => {
        await navigator.clipboard.writeText(`${location.origin}/i/${inv.token}`);
        copy.textContent = 'Copied!';
        setTimeout(() => (copy.textContent = 'Copy'), 1500);
      };
      row.appendChild(copy);
    }
    const del = Object.assign(document.createElement('button'), {
      className: 'btn-danger', textContent: '✕',
      title: used ? 'Forget this invite (kick the person from the People list)' : 'Revoke this link',
    });
    del.onclick = async () => {
      await fetch(`/api/chats/${state.chatId}/invites/${inv.token}`, { method: 'DELETE' });
      poll();
    };
    row.appendChild(del);
    iv.appendChild(row);
  }

  const memberIds = new Set(state.members.map(mm => mm.userId));
  const friends = (state.friends || []).filter(f => !memberIds.has(f.userId));
  $('#share-friends-wrap').classList.toggle('hidden', !friends.length);
  const fr = $('#share-friends');
  fr.innerHTML = '';
  for (const f of friends) {
    const row = shareRow(f.name, null, f.picture);
    const sel = roleSelect('commenter');
    const add = Object.assign(document.createElement('button'), { className: 'btn-ghost', textContent: 'Add' });
    add.onclick = async () => {
      add.disabled = true;
      const res = await fetch(`/api/chats/${state.chatId}/members`, {
        method: 'POST', headers: JSONH,
        body: JSON.stringify({ userId: f.userId, role: sel.value }),
      });
      if (!res.ok) { add.disabled = false; return showToast("Couldn't add them"); }
      poll();
    };
    row.append(sel, add);
    fr.appendChild(row);
  }
}

// ---------- invite landing (/i/:token) ----------
async function initInvite(token) {
  $('#invite-page').classList.remove('hidden');
  $('#name-gate').addEventListener('click', e => {
    if (e.target === $('#name-gate')) $('#name-gate').classList.add('hidden');
  });
  let inv;
  try {
    const res = await fetch(`/api/invites/${token}`);
    if (!res.ok) throw 0;
    inv = await res.json();
  } catch {
    $('#invite-lead').textContent = "This invite doesn't exist — it may have been revoked.";
    $('#invite-note').innerHTML = '<a href="/">Go home</a>';
    return;
  }
  if (inv.status === 'member' || inv.status === 'used-by-you') {
    location.replace(`/c/${inv.chatId}`);
    return;
  }
  if (inv.status === 'used') {
    $('#invite-lead').textContent = 'This invite was already used — each link only works once.';
    $('#invite-note').textContent = 'If it was meant for you, ask for a fresh one.';
    return;
  }
  const who = inv.inviteeName ? `${inv.inviteeName}, you're` : "You're";
  const withWho = inv.participants?.length ? ` with ${inv.participants.slice(0, 4).join(', ')}` : '';
  const art = inv.role === 'editor' ? 'an' : 'a';
  $('#invite-lead').textContent = `${who} invited to a video conversation${withWho} — as ${art} ${inv.role}.`;
  $('#invite-note').textContent = 'This link works once: joining ties it to your account.';
  const join = $('#invite-join');
  const watch = $('#invite-watch');
  join.classList.remove('hidden');
  watch.href = `/c/${inv.chatId}?invite=${encodeURIComponent(token)}`;
  watch.classList.remove('hidden');
  if (!inv.signedIn) {
    if (!state.auth?.authEnabled) {
      join.classList.add('hidden');
      $('#invite-note').textContent = 'Sign-in isn\'t configured on this server, so invites can\'t be accepted.';
      return;
    }
    join.textContent = 'Sign in to join';
    join.onclick = () => {
      wireAuthBox(`/i/${token}`);
      $('#name-gate').classList.remove('hidden');
    };
  } else {
    join.textContent = 'Join chat';
    join.onclick = async () => {
      join.disabled = true;
      const res = await fetch(`/api/invites/${token}/accept`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return location.replace(`/c/${data.chatId}`);
      join.disabled = false;
      if (data.code === 'used') $('#invite-lead').textContent = 'Someone else used this invite first.';
      else showToast(data.error || "Couldn't join this chat");
    };
  }
}

// ---------- push notifications ----------
const b64uToBytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

// One subscription per device, tied to your account: it covers every chat
// you're a member of. The bell toggles it; the floating banner nudges
// signed-in participants who haven't turned it on here yet.
const push = { reg: null, sub: null, supported: false };

async function initPush() {
  if (!('serviceWorker' in navigator)) return;
  try {
    push.reg = await navigator.serviceWorker.register('/sw.js');
  } catch {
    return;
  }
  if (!state.auth?.user || !state.auth?.pushKey || !('PushManager' in window)) return;
  push.supported = true;
  push.sub = await push.reg.pushManager.getSubscription().catch(() => null);
  $('#bell-btn').classList.remove('hidden');
  $('#bell-btn').onclick = () => (push.sub ? disablePush() : enablePush());
  $('#push-banner-on').onclick = enablePush;
  $('#push-banner-x').onclick = () => {
    sessionStorage.setItem('splitty:pushnag', '1'); // quiet for this visit; nudges again next time
    paintPush();
  };
  paintPush();
}

async function enablePush() {
  try {
    if ((await Notification.requestPermission()) !== 'granted') {
      showToast('Notifications are blocked for this site in your browser');
      paintPush();
      return;
    }
    push.sub = await push.reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64uToBytes(state.auth.pushKey),
    });
    await fetch('/api/push/subscribe', {
      method: 'POST', headers: JSONH, body: JSON.stringify({ subscription: push.sub.toJSON() }),
    });
    showToast("Notifications on — they cover all your chats");
  } catch {
    showToast("Couldn't set up notifications on this device");
  }
  paintPush();
}

async function disablePush() {
  try {
    await fetch('/api/push/unsubscribe', {
      method: 'POST', headers: JSONH, body: JSON.stringify({ endpoint: push.sub.endpoint }),
    });
    await push.sub.unsubscribe();
    push.sub = null;
    showToast('Notifications off');
  } catch {
    showToast("Couldn't turn notifications off");
  }
  paintPush();
}

function paintPush() {
  if (!push.supported) return;
  const bell = $('#bell-btn');
  bell.textContent = push.sub ? '🔔 Notifications on' : '🔕 Notifications off';
  bell.title = push.sub ? 'Covers all your chats — tap to turn off' : 'Get notified about new messages';
  bell.classList.toggle('bell-on', !!push.sub);
  // the nudge: signed-in participants (can record here) without push on this
  // device — viewers don't care, so they're never nagged
  const show = !push.sub && !!state.auth?.user && !!state.auth?.authEnabled && canComment()
    && Notification.permission !== 'denied' && !sessionStorage.getItem('splitty:pushnag');
  $('#push-banner').classList.toggle('hidden', !show);
}

const escapeHtml = s => s.replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
