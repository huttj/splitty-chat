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
  // visual lag for the spoken-word glow (Whisper stamps run early) — tunable
  wordLag: (v => Number.isFinite(v) ? v : 0.3)(parseFloat(localStorage.getItem('splitty:wordlag'))),
  // shoulder kept around words when clipping silences (before-word margin is
  // half of this) — tunable
  silPad: (v => Number.isFinite(v) ? v : 0.7)(parseFloat(localStorage.getItem('splitty:silpad'))),
  // minimum silence that must survive the shoulders for a pause to be trimmed
  silMin: (v => Number.isFinite(v) ? v : 0.25)(parseFloat(localStorage.getItem('splitty:silmin'))),
  // expressiveness display: any of 'strip' (heat bar per message), 'text'
  // (colored words), 'highlight' (colored playhead wash) — comma-joined, '' = off
  expr: localStorage.getItem('splitty:expr') || '',
  // visualizer detail: 'full' (six band lines, neon blur) | 'simple' (one line, no blur — phones)
  vizMode: localStorage.getItem('splitty:viz') || (/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? 'simple' : 'full'),
  // a pause this long breaks the transcript into a new paragraph — tunable
  parPause: (v => Number.isFinite(v) ? v : 1.2)(parseFloat(localStorage.getItem('splitty:parpause'))),
  // hide your own floating preview while watching (camera stays on)
  selfHide: localStorage.getItem('splitty:selfhide') === '1',
  // voice-only: no camera at all — clips are audio files, the box shows a
  // visualizer instead of your face
  voiceOnly: localStorage.getItem('splitty:voiceonly') === '1',
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
// per-chat palette: authors get colors in order of first appearance, so no
// two people collide until the palette runs out (name-hashing collided)
let authorColors = new Map();
function rebuildAuthorColors() {
  const m = new Map();
  for (const msg of [...state.messages].sort((a, b) => a.createdAt - b.createdAt)) {
    const k = normName(msg.author);
    if (!m.has(k)) m.set(k, USER_COLORS[m.size % USER_COLORS.length]);
  }
  authorColors = m;
}
function colorFor(name) {
  const c = authorColors.get(normName(name));
  if (c) return c;
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return USER_COLORS[h % USER_COLORS.length];
}

const players = [$('#player-a'), $('#player-b')];
const preview = $('#preview');
const activeEl = () => players[state.activeIdx];
const standbyEl = () => players[state.activeIdx ^ 1];
const isAudioMsg = msg => !!msg && (msg.mime || '').startsWith('audio/');
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
// The whole chain is optional: WebAudio adds output latency and mobile
// glitches, so phones default to raw, direct element audio.
const IS_MOBILE = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
const storedComp = localStorage.getItem('splitty:compressor');
let compressorOn = storedComp === null ? !IS_MOBILE : storedComp === '1';
let audioCtx = null, compressorIn = null;
// The WebAudio chain exists when the compressor is on, OR when the full
// visualizer needs a live analyser on playback. Simple + compressor off is
// the only chain-free case (direct path: no latency). Once an element is
// wired it stays wired, so everything plays through the same path.
const wantChain = () => compressorOn || state.vizMode === 'full';
function audioChainFor(el) {
  if (!wantChain() && !audioCtx) return null;
  try {
    if (!audioCtx) {
      // 'playback' = bigger buffers: mobile underruns (dropouts that sound
      // like skipped words, worst at raised speeds) trade for latency, which
      // the word highlight compensates with the measured value
      audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
      if (compressorOn) {
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
      } else {
        compressorIn = audioCtx.destination; // chain for the analyser only — no compression
      }
      // autoplay policy can leave the context suspended — a tap wakes it,
      // but only when something is actually playing (a paused context is
      // also the fix for the mobile pause-stutter, so don't undo it)
      document.addEventListener('pointerdown', () => {
        if (players.some(p => !p.paused)) audioCtx.resume();
      }, { capture: true });
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

// Speaker leveling is cheap and always on: when the WebAudio chain is off,
// use the element's native volume — it can't boost, so gains normalize
// against the chat's quietest speaker (who plays at full volume) and louder
// speakers attenuate toward them. Zero latency, no WebAudio needed.
let _maxGain = { n: -1, v: 1 };
function chatGainNorm() {
  if (_maxGain.n !== state.messages.length) {
    let mx = 1;
    for (const m of state.messages) mx = Math.max(mx, m.gain || 1);
    _maxGain = { n: state.messages.length, v: Math.min(mx, 2.5) }; // cap: one extreme outlier mustn't mute the room
  }
  return _maxGain.v;
}

let levelingOn = localStorage.getItem('splitty:leveling') !== '0'; // default on, everywhere

function setMsgGain(el, msg) {
  const node = audioChainFor(el);
  if (!levelingOn) {
    if (node) node.gain.value = 1;
    el.volume = 1;
    return;
  }
  if (node) {
    node.gain.value = msg?.gain || 1; // full boost/cut through the chain
    el.volume = 1;
  } else {
    el.volume = Math.min(1, Math.max(0.05, (msg?.gain || 1) / chatGainNorm()));
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
// does the live stream carry a picture? (voice-only mode opens the mic alone)
const camHasVideo = () => !!camStream?.getVideoTracks().some(t => t.readyState === 'live');

let camPending = null; // in-flight getUserMedia — callers share it
async function ensureCam() {
  if (camStream && camStream.active) return camStream;
  if (camPending) return camPending;
  // saved device choices ride along as 'ideal' — a missing device (unplugged
  // webcam, other machine) falls back instead of failing
  const camId = localStorage.getItem('splitty:camid');
  const micId = localStorage.getItem('splitty:micid');
  const wantVideo = !state.voiceOnly;
  let stream;
  try {
    camPending = navigator.mediaDevices.getUserMedia({
      video: wantVideo
        ? { facingMode: 'user', width: { ideal: 960 }, ...(camId && { deviceId: { ideal: camId } }) }
        : false,
      audio: micId ? { deviceId: { ideal: micId } } : true,
    });
    stream = await camPending;
  } catch (err) {
    camPending = null;
    camError = err;
    $('#cam-enable')?.classList.remove('hidden');
    updateStage();
    throw err;
  }
  camPending = null;
  if (wantVideo === state.voiceOnly) {
    // the camera toggle flipped while the permission prompt was up — what
    // we got is the wrong shape; ask again
    stream.getTracks().forEach(t => t.stop());
    return ensureCam();
  }
  camStream = stream;
  camError = null;
  $('#cam-enable')?.classList.add('hidden');
  if (camHasVideo()) {
    preview.srcObject = camStream;
    preview.play();
  } else {
    preview.srcObject = null;
  }
  listenToMic(camStream); // the visualizer follows whichever mic is live
  updateStage();
  return camStream;
}

// camera on/off is a mode like screen sharing: it persists across clips and
// re-opens the devices with or without a picture
async function toggleVoiceOnly() {
  if (state.rec) return showToast('Finish this clip first — then switch the camera on or off');
  state.voiceOnly = !state.voiceOnly;
  localStorage.setItem('splitty:voiceonly', state.voiceOnly ? '1' : '0');
  paintCamBtn();
  if (camPending) return; // ensureCam re-asks on its own once this lands
  if (camStream || camError) {
    camStream?.getTracks().forEach(t => t.stop());
    camStream = null;
    try {
      await ensureCam();
    } catch {
      showToast(state.voiceOnly ? "Couldn't open the microphone" : "Couldn't open the camera");
    }
  }
  updateStage();
}

function paintCamBtn() {
  const btn = $('#cam-btn');
  btn.classList.toggle('cam-off', state.voiceOnly);
  btn.title = state.voiceOnly
    ? 'Camera is off — clips are voice only. Tap to turn it on.'
    : 'Turn the camera off — record voice only';
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
      pop.style.top = `${btn.getBoundingClientRect().bottom + 8}px`; // anchored, not guessed
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
  // post an existing video or audio file as a message — spliced at the
  // playhead when something's playing, exactly like recording (frozen at the
  // moment of intent)
  $('#upload-btn').onclick = () => {
    if (!canRecordHere()) return showToast("You don't have permission to post here");
    state._uploadAnchor = state.playing && state.playIdx >= 0
      ? {
          parentId: state.playlist[state.playIdx].id,
          anchorMs: Math.floor(activeEl().currentTime * 1000),
        }
      : null;
    $('#upload-input').click();
  };
  $('#upload-input').onchange = () => {
    const f = $('#upload-input').files[0];
    $('#upload-input').value = '';
    pop.classList.add('hidden');
    uploadVideoFile(f);
  };

  $('#copy-tx-btn').onclick = async () => {
    await navigator.clipboard.writeText(transcriptText());
    pop.classList.add('hidden');
    showToast('Transcript copied — attributed and in playback order');
  };

  // transcription language: applies to new clips and to the ↻ retranscribe button
  $('#lang-sel').value = localStorage.getItem('splitty:lang') || '';
  $('#lang-sel').onchange = () => localStorage.setItem('splitty:lang', $('#lang-sel').value);

  // speaker leveling: applies live — re-set the gain on whatever's playing
  const lvl = $('#level-check');
  lvl.checked = levelingOn;
  lvl.onchange = () => {
    levelingOn = lvl.checked;
    localStorage.setItem('splitty:leveling', levelingOn ? '1' : '0');
    const seg = state.playIdx >= 0 ? state.playlist[state.playIdx] : null;
    if (seg) setMsgGain(activeEl(), state.byId.get(seg.id));
  };

  // compressor: flipping it after audio has been wired into WebAudio
  // needs a reload (elements can't be unwired), so reload when necessary
  const comp = $('#comp-check');
  comp.checked = compressorOn;
  comp.onchange = () => {
    localStorage.setItem('splitty:compressor', comp.checked ? '1' : '0');
    if (audioCtx) {
      showToast('Reloading to apply…');
      setTimeout(() => location.reload(), 600);
    } else {
      compressorOn = comp.checked; // nothing wired yet — applies right away
    }
  };

  // spoken-word glow timing: 0 = trust Whisper's stamps, higher = glow later
  const lag = $('#lag-range'), lagLabel = $('#lag-label');
  const paintLag = () => {
    const ms = Math.round(state.wordLag * 1000);
    lagLabel.textContent = `${ms > 0 ? '+' : ''}${ms}ms`; // offset from the measured baseline
  };
  lag.value = state.wordLag;
  paintLag();
  let lagTimer = null;
  lag.oninput = () => {
    state.wordLag = +lag.value;
    localStorage.setItem('splitty:wordlag', String(state.wordLag));
    paintLag();
    // the expressiveness colors sample the audio at this lag — re-read them
    clearTimeout(lagTimer);
    lagTimer = setTimeout(() => { if (state.expr) { state.lastRenderKey = ''; render(); } }, 200);
  };

  // silence-trim shoulder: how much breathing room stays around words when
  // Skip pauses clips dead air (before-word margin is half of this)
  let trimTimer = null;
  const trimChanged = () => {
    // splice points move — rebuild playlist/transcript, debounced for drags
    clearTimeout(trimTimer);
    trimTimer = setTimeout(() => { if (state.hideGaps) refreshFilter(); }, 150);
  };
  const pad = $('#pad-range'), padLabel = $('#pad-label');
  const paintPad = () => (padLabel.textContent = `${Math.round(state.silPad * 1000)}ms`);
  pad.value = state.silPad;
  paintPad();
  pad.oninput = () => {
    state.silPad = +pad.value;
    localStorage.setItem('splitty:silpad', String(state.silPad));
    paintPad();
    trimChanged();
  };
  // visualizer detail: six blurred band lines, or one plain line for weaker devices
  const vz = $('#viz-sel');
  vz.value = state.vizMode;
  vz.onchange = () => {
    state.vizMode = vz.value;
    localStorage.setItem('splitty:viz', state.vizMode);
    if (state.vizMode === 'full') players.forEach(p => audioChainFor(p)); // full needs the live chain — wire it now
  };
  // expressiveness: how the speech's energy/flow/tension is shown — any mix
  const exprBoxes = [...document.querySelectorAll('#menu-expr input')];
  const paintExpr = () => document.body.classList.toggle('expr-highlight', exprOn('highlight'));
  exprBoxes.forEach(b => (b.checked = exprOn(b.value)));
  paintExpr();
  exprBoxes.forEach(b => (b.onchange = () => {
    state.expr = exprBoxes.filter(x => x.checked).map(x => x.value).join(',');
    localStorage.setItem('splitty:expr', state.expr);
    paintExpr();
    state.lastRenderKey = '';
    render();
  }));
  // a pause this long starts a new paragraph in the transcript
  const par = $('#par-range'), parLabel = $('#par-label');
  const paintPar = () => (parLabel.textContent = `${state.parPause.toFixed(1)}s`);
  par.value = state.parPause;
  paintPar();
  let parTimer = null;
  par.oninput = () => {
    state.parPause = +par.value;
    localStorage.setItem('splitty:parpause', String(state.parPause));
    paintPar();
    clearTimeout(parTimer);
    parTimer = setTimeout(() => { state.lastRenderKey = ''; render(); }, 150); // re-flow, debounced for drags
  };
  // how much silence must survive the shoulders before a pause is worth trimming
  const min = $('#min-range'), minLabel = $('#min-label');
  const paintMin = () => (minLabel.textContent = `${Math.round(state.silMin * 1000)}ms`);
  min.value = state.silMin;
  paintMin();
  min.oninput = () => {
    state.silMin = +min.value;
    localStorage.setItem('splitty:silmin', String(state.silMin));
    paintMin();
    trimChanged();
  };
}

// Safari only grants the camera from a real tap — retry on the first gesture,
// and keep an explicit button as the reliable path
function armCamRetry() {
  const retry = () =>
    ensureCam().catch(err => {
      if (err.name === 'NotAllowedError') {
        showToast(state.voiceOnly
          ? 'Microphone blocked — allow it via the icon in the address bar'
          : 'Camera blocked — allow it via the camera icon in the address bar');
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
  $('#cam-btn').onclick = toggleVoiceOnly;
  $('#nocam-btn').onclick = toggleVoiceOnly;
  paintCamBtn();

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

  // drop a video or audio file anywhere on the transcript to post it (splices
  // at the playhead when something's playing, same as the upload button)
  const msgsEl = $('#messages');
  for (const ev of ['dragover', 'dragenter']) {
    msgsEl.addEventListener(ev, e => {
      if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
      e.preventDefault();
      msgsEl.classList.add('drop-hot');
    });
  }
  msgsEl.addEventListener('dragleave', e => {
    if (!msgsEl.contains(e.relatedTarget)) msgsEl.classList.remove('drop-hot');
  });
  msgsEl.addEventListener('drop', e => {
    e.preventDefault();
    msgsEl.classList.remove('drop-hot');
    const f = [...e.dataTransfer.files].find(ff => mediaKind(ff));
    if (!f) return showToast('Drop a video or audio file');
    if (!canRecordHere()) return showToast("You don't have permission to post here");
    state._uploadAnchor = state.playing && state.playIdx >= 0
      ? { parentId: state.playlist[state.playIdx].id, anchorMs: Math.floor(activeEl().currentTime * 1000) }
      : null;
    uploadVideoFile(f);
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
    let dead = false; // vertical intent — this drag belongs to the scroller
    const scrubToTime = (mid, t) => {
      const vt = vtOfMsgTime(mid, t);
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
    const scrubTo = (span, clientX) => {
      const msg = state.byId.get(span.dataset.mid);
      if (!msg || span.dataset.t == null) return;
      // interpolate within the word/gap from the pointer's x — but the outer
      // fifths snap to the word's exact ends, so landing a splice point
      // cleanly before or after a word is easy
      const rect = span.getBoundingClientRect();
      const s = Number(span.dataset.t);
      const en = Number(span.dataset.e ?? span.dataset.t);
      const f = Math.min(Math.max((clientX - rect.left) / Math.max(rect.width, 1), 0), 1);
      const t = f < 0.2 ? s : f > 0.8 ? Math.max(en - 0.001, s) : s + f * Math.max(0, en - s);
      const vt = vtOfMsgTime(span.dataset.mid, t + 0.0005);
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
      if (dead) return;
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      if (!active) {
        // axis lock: a vertical-leaning drag is a SCROLL, not a scrub —
        // hand it to the browser and stay out of the way (the mobile fix)
        if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) {
          dead = true;
          return;
        }
        if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
        active = true;
        // no session yet? park one at the grab point so scrubbing has a stage
        if (!state.playing) playFrom(startSpan.dataset.mid, Number(startSpan.dataset.t) || 0, false);
        state.scrubbing = true;
        state.scrubResume = state.playing && !activeEl().paused;
        clearWordHighlight();
      }
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const span = under?.closest?.('.word, .gap');
      if (span) {
        scrubTo(span, ev.clientX);
        return;
      }
      // not over a word: the card's margins are seek targets too — above the
      // first word lands at the very beginning (preempt), past the last word
      // lands at the very end (splice right after the clip)
      const card = under?.closest?.('.msg');
      const firstWord = card?.querySelector(':scope > .msg-body > .word');
      const mid = firstWord?.dataset.mid;
      if (!mid) return;
      const words = card.querySelectorAll(`:scope > .msg-body > .word[data-mid="${mid}"]`);
      const first = words[0].getBoundingClientRect();
      const last = words[words.length - 1].getBoundingClientRect();
      const msg = state.byId.get(mid);
      if (!msg) return;
      if (ev.clientY < first.top || (ev.clientY <= first.bottom && ev.clientX < first.left)) {
        scrubToTime(mid, 0.001);
      } else if (ev.clientY > last.bottom || (ev.clientY >= last.top && ev.clientX > last.right)) {
        scrubToTime(mid, Math.max(msgDur(msg) - 0.02, 0));
      }
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

  const noDragClick = fn => () => {
    if (performance.now() - controlsDragTs < 350) return; // that was a drag, not a tap
    fn();
  };
  $('#rec-btn').onclick = noDragClick(toggleRecord);
  $('#stop-btn').onclick = noDragClick(stopPlayback); // clears the session: next record = new message
  $('#btn-stop').onclick = stopPlayback;
  $('#pause-btn').onclick = noDragClick(togglePause);

  // drag the record cluster anywhere; taps still do their thing
  state.recPos = JSON.parse(localStorage.getItem('splitty:recpos') || 'null');
  applyControlsPos();
  window.addEventListener('resize', applyControlsPos);
  $('#controls').addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const c = $('#controls');
    const start = { x: e.clientX, y: e.clientY };
    const rect = c.getBoundingClientRect();
    let moved = false;
    const onMove = ev => {
      if (!moved && Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) < 8) return;
      moved = true;
      state.recPos = {
        xr: (ev.clientX - (start.x - rect.left)) / innerWidth,
        br: (innerHeight - (ev.clientY + (rect.bottom - start.y))) / innerHeight,
      };
      applyControlsPos();
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', () => {
      document.removeEventListener('pointermove', onMove);
      if (moved) {
        controlsDragTs = performance.now();
        localStorage.setItem('splitty:recpos', JSON.stringify(state.recPos));
      }
    }, { once: true });
  });
  $('#self-btn').onclick = () => {
    state.selfHide = !state.selfHide;
    localStorage.setItem('splitty:selfhide', state.selfHide ? '1' : '');
    updateStage();
  };

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

  // fill (crop to fit) vs fit (letterbox, whole frame visible) — separate
  // preferences per context: faces default to Fill, screen shares to Fit
  // (text must stay whole). The button flips whichever you're looking at.
  state.fit = localStorage.getItem('splitty:fit') || 'cover';
  state.fitScreen = localStorage.getItem('splitty:fitscreen') || 'contain';
  $('#fit-btn').onclick = () => {
    const onScreen = $('#video-box').classList.contains('mode-screen');
    const key = onScreen ? 'fitScreen' : 'fit';
    state[key] = state[key] === 'cover' ? 'contain' : 'cover';
    localStorage.setItem(onScreen ? 'splitty:fitscreen' : 'splitty:fit', state[key]);
    updateStage();
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
    // the feature track is fetched per message and cached on the object —
    // carry it across polls so it isn't refetched every 2.5s
    for (const m of data.messages) {
      const prev = state.byId.get(m.id);
      if (prev?.features && m.hasFeatures) { m.features = prev.features; m._raw = prev._raw; m._expr = prev._expr; }
    }
    state.messages = data.messages;
    state.byId = new Map(data.messages.map(m => [m.id, m]));
    rebuildAuthorColors();
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
  // suspend the audio graph while nothing plays: Android Chrome otherwise
  // loops the last buffer of a paused element (the machine-gun stutter)
  if (audioCtx) {
    const anyPlaying = players.some(p => !p.paused);
    if (anyPlaying && audioCtx.state === 'suspended') audioCtx.resume();
    else if (!anyPlaying && audioCtx.state === 'running') audioCtx.suspend();
  }
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
// word ends early (and starts a touch late), so keep 0.45s after a word
// (finish the tail) and 0.25s before the next; only clip pauses clearly
// worth it (>=1.0s)
function silencesFor(msg) {
  if (!msg.words.length) return [];
  const sil = [];
  let prev = 0;
  const consider = (from, to) => {
    // no fixed minimum-gap threshold: it EMERGES from the padding. A gap is
    // clippable when ≥250ms of silence survives the shoulders, so the slider
    // trades naturally — tight padding clips more pauses, loose clips fewer.
    const s = from + state.silPad, e = to - state.silPad / 2;
    if (e - s >= state.silMin) sil.push([s, e]);
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
let controlsDragTs = 0;   // ditto for the record cluster

// the record cluster parks wherever it was dropped — anchored by its
// bottom-left corner so the hint pill still grows upward
function applyControlsPos() {
  const c = $('#controls');
  const g = state.recPos;
  if (!g) return;
  const r = c.getBoundingClientRect();
  const x = Math.min(Math.max(g.xr * innerWidth, 4), innerWidth - r.width - 4);
  const b = Math.min(Math.max(g.br * innerHeight, 4), innerHeight - r.height - 4);
  Object.assign(c.style, { left: `${x}px`, bottom: `${b}px`, right: 'auto', top: 'auto' });
}
function seekTranscript(msgId, atSec) {
  if (performance.now() - transcriptDragTs < 350) return;
  const keepPlaying = state.playing && !activeEl().paused;
  playFrom(msgId, atSec, keepPlaying);
}

// unified tap handling: one tap seeks, a second tap on the same spot within
// 350ms plays. Hand-rolled because mobile browsers don't reliably deliver
// dblclick — this works identically for mouse and touch.
let lastTap = { t: 0, key: '' };
function tapTranscript(msgId, atSec) {
  if (performance.now() - transcriptDragTs < 350) return;
  const key = `${msgId}@${atSec.toFixed(2)}`;
  if (performance.now() - lastTap.t < 350 && lastTap.key === key) {
    lastTap = { t: 0, key: '' };
    playFrom(msgId, atSec);
    return;
  }
  lastTap = { t: performance.now(), key };
  seekTranscript(msgId, atSec);
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
  if (autoplay && audioCtx?.state === 'suspended') audioCtx.resume();
  state.screenHold = false; // fresh segment, fresh buffering verdict
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
  viz.snap = autoplay ? null : { id: msg.id, t: at }; // a paused seek shows the voice at that point, once
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
  if (!msg?.screenKey || brokenScreens.has(msg.screenKey)) return;
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

const brokenScreens = new Set(); // screen tracks that errored or never loaded — play camera-only

function tickScreenSync() {
  if (state.playIdx < 0) return;
  const seg = state.playlist[state.playIdx];
  const msg = state.byId.get(seg?.id);
  if (!msg?.screenKey || brokenScreens.has(msg.screenKey)) { state.screenHold = false; return; }
  const sp = screenEl();
  if (sp.srcObject) return;
  const el = activeEl();

  // a screen track that errors, or holds us longer than 15s, gets given up
  // on — the conversation matters more than the screen half
  const giveUp = sp.error
    || (state.screenHold && performance.now() - (state.screenHoldTs || 0) > 15000);
  if (giveUp) {
    brokenScreens.add(msg.screenKey);
    const held = state.screenHold;
    state.screenHold = false;
    showToast("The screen part of this clip won't load — playing the camera only");
    updateStage(); // back to the normal camera layout
    if (held) el.play().catch(() => {});
    return;
  }

  const dur = sp.duration || Infinity;
  const pastScreenEnd = el.currentTime > dur - 0.3; // screen track can be shorter — that's fine
  const screenReady = sp.readyState >= 3 || pastScreenEnd;

  // we paused the camera to let the screen half buffer — release when ready.
  // Crucially, DRIVE the buffering: a paused, never-played element often
  // won't load past its first frame on its own (this stalled healthy files).
  if (state.screenHold) {
    if (screenReady) {
      state.screenHold = false;
      el.play().catch(() => {});
    } else if (sp.paused && !sp.error) {
      sp.play().catch(() => {}); // muted; drift-snap realigns it on release
    }
    return;
  }
  if (el.paused) {
    if (!sp.paused) sp.pause();
    return;
  }
  // camera is running: the halves move together or not at all
  if (!screenReady) {
    el.pause();
    state.screenHold = true; // spinner shows; ticker resumes us
    state.screenHoldTs = performance.now();
    return;
  }
  if (pastScreenEnd) {
    if (!sp.paused) sp.pause();
  } else {
    if (sp.paused) sp.play().catch(() => {});
    if (Math.abs(sp.currentTime - el.currentTime) > 0.35 && !sp.seeking) sp.currentTime = el.currentTime;
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
  state.screenHold = false;
  brokenScreens.clear(); // a stop is a clean slate — give screen tracks another shot
  for (const el of players) { el.pause(); el._preparedKey = null; }
  screenEl().pause();
  updateStage();
  clearWordHighlight();
  syncPlayButton();
  updateHint();
}

// bring the transcript back to where playback is about to speak
function scrollToHighlight() {
  const seg = state.playIdx >= 0 ? state.playlist[state.playIdx] : null;
  const msg = seg && state.byId.get(seg.id);
  if (!msg || !msg.words.length) return;
  const t = activeEl().currentTime;
  let i = msg.words.findIndex(w => t < w.e);
  if (i === -1) i = msg.words.length - 1;
  document.querySelector(`.word[data-mid="${seg.id}"][data-i="${i}"]`)
    ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function togglePause() {
  if (state.rec) return; // never un-pause under a recording
  if (audioCtx?.state === 'suspended') audioCtx.resume(); // still in the tap's gesture
  if (!state.playing) {
    // transport is always visible now — play from the scrubber's position
    if (!state.playlist.length) buildPlaylist();
    if (state.playlist.length) {
      seekVirtual(Number($('#scrubber').value) || 0, true);
      scrollToHighlight();
    }
    return;
  }
  const el = activeEl();
  if (el.paused) {
    el.play();
    scrollToHighlight(); // resuming: show me where we are
  } else {
    el.pause();
  }
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
    // Following re-centers before the glow reaches the bottom edge, so
    // there's always upcoming text visible below it.
    if (cls !== 'speaking') {
      span.scrollIntoView({ block: 'nearest' });
    } else if (!touchHeld && highlightOnScreen(span)) {
      const b = $('#messages').getBoundingClientRect();
      const r = span.getBoundingClientRect();
      if (r.bottom > b.top + b.height * 0.7 || r.top < b.top) {
        span.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
    lastFocus = { key, span };
  }
  span.style.setProperty('--f', `${(f * 100).toFixed(1)}%`);
}

// While a finger is on the transcript, auto-follow keeps its hands off —
// scrolling must never be a tug-of-war. Touch events, not pointer events:
// pointercancel fires the moment native scrolling takes over, which is
// exactly when we still need to know the finger is down.
let touchHeld = false;
document.addEventListener('touchstart', e => {
  if (e.target?.closest?.('#messages')) touchHeld = true;
}, { passive: true, capture: true });
for (const ev of ['touchend', 'touchcancel']) {
  document.addEventListener(ev, e => {
    if (e.touches.length === 0) touchHeld = false;
  }, { passive: true, capture: true });
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
    // and advancing on the wrong clock ping-pongs segments (the "twitch").
    // Match EITHER url form: the blob cache landing mid-playback changes what
    // mediaUrl() returns without changing what the element is playing.
    const segMsg = state.byId.get(seg.id);
    const srcOk = !segMsg
      || el.src === mediaUrl(segMsg)
      || el.src === `${location.origin}/media/${segMsg.file}`;
    if (!srcOk) {
      focusWordAt(seg, el.currentTime - state.wordLag, 'speaking');
      tickScreenSync(); // never starve the screen half over a url-form mismatch
      return;
    }
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
  // Whisper timestamps run early relative to the audio, so an unbiased
  // highlight is halfway through a word before it's spoken — lag the visual
  // clock (only the glow; seeks and splice boundaries keep the raw times).
  // The error varies (silence gets folded into word spans), so the lag is
  // user-tunable from the menu. On top of that, playback audio routes
  // through WebAudio (the compressor), whose output latency is tiny on
  // desktop but 100-500ms on mobile/Bluetooth — currentTime runs that far
  // ahead of what's actually HEARD, so compensate with the measured value.
  // Measured audio-output latency (rate-scaled: it's wall-clock) is the
  // automatic baseline; the slider is a manual offset on top of it — zero
  // means "trust the measurement", positive pushes the glow later, negative
  // earlier. Tuned per device, which is what localStorage gives us anyway.
  const outLag = audioCtx ? (audioCtx.outputLatency || audioCtx.baseLatency || 0) : 0;
  focusWordAt(seg, el.currentTime - outLag * (el.playbackRate || 1) - state.wordLag, 'speaking');
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
  if (segMsg && activeEl().src !== mediaUrl(segMsg)
    && activeEl().src !== `${location.origin}/media/${segMsg.file}`) return; // mismatched after a scrub — don't advance on the wrong clock

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

// The whole conversation as text, interleaved exactly as it plays: walk the
// playlist (which already encodes splices, filters, and layers), group
// consecutive segments per message, stamp each block with its position on
// the conversation clock, indent by reply depth.
function transcriptText() {
  if (!state.playlist.length) buildPlaylist();
  const dm = depthMap();
  const indentOf = id => '  '.repeat(Math.min(dm.get(id) || 0, 6));
  const blocks = [];
  const segs = state.playlist;
  for (let i = 0; i < segs.length;) {
    const id = segs[i].id;
    const startV = segs[i].vStart;
    let j = i;
    while (j + 1 < segs.length && segs[j + 1].id === id) j++;
    const msg = state.byId.get(id);
    if (msg) {
      const words = [];
      for (let k = i; k <= j; k++) {
        let prev = null;
        for (const w of msg.words) {
          if (w.s >= segs[k].start - 0.001 && w.s < segs[k].end) {
            // a paragraph pause becomes a line break in the text too
            if (prev && w.s - prev.e >= state.parPause) words.push('\n' + indentOf(id));
            words.push(w.w);
            prev = w;
          }
        }
      }
      const cont = blocks.some(b => b.id === id);
      if (words.length || !cont) {
        const indent = indentOf(id);
        blocks.push({
          id,
          text: `${indent}[${fmtClock(startV)}] ${msg.author}${cont ? ' (cont.)' : ''}:\n`
            + `${indent}${words.join(' ').replace(/ \n/g, '\n').replace(/\n /g, '\n') || '(no transcript)'}`,
        });
      }
    }
    i = j + 1;
  }
  return blocks.map(b => b.text).join('\n\n');
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
  // capped bitrate keeps uploads fast. Voice-only: one audio recorder — its
  // file is the message, and the server transcribes it directly.
  const voice = !camHasVideo();
  const recorder = voice
    ? new MediaRecorder(
        new MediaStream(stream.getAudioTracks()),
        { ...(audioMime && { mimeType: audioMime }), audioBitsPerSecond: 96000 }
      )
    : new MediaRecorder(stream, {
        ...(videoMime && { mimeType: videoMime }),
        videoBitsPerSecond: CAM_BITRATE,
      });
  const audioRecorder = voice ? null : new MediaRecorder(
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
  if (audioRecorder) audioRecorder.ondataavailable = e => e.data.size && aChunks.push(e.data);
  let stoppedCount = 0;
  const stopTarget = 1 + (audioRecorder ? 1 : 0) + (screenRecorder ? 1 : 0);
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
      videoBlob: new Blob(vChunks, { type: recorder.mimeType || (voice ? 'audio/webm' : 'video/webm') }),
      audioBlob: audioRecorder ? new Blob(aChunks, { type: audioRecorder.mimeType }) : null,
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
  if (audioRecorder) audioRecorder.onstop = onStop;
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
  audioRecorder?.start();
  screenRecorder?.start();
  updateStage();
  updateHint();
}

function stopRecord() {
  const rec = state.rec;
  if (!rec) return;
  if (Date.now() - rec.startTs < 700) rec.discard = true;
  rec.recorder.stop(); // the upload fires once every recorder has stopped
  rec.audioRecorder?.stop();
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
      if (job.chunks?.length) {
        // long clip: transcript streams in chunk by chunk, off the queue's back
        sendTranscriptChunks(message.id, job.chunks);
      }
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
  const { videoBlob, screenBlob, rec } = job;
  job.phase = 'sending';
  // finished keys are memoized on the job, so a Retry never redoes an upload
  const total = videoBlob.size + (screenBlob?.size || 0);
  let sent = (job.videoKey ? videoBlob.size : 0) + (job.screenKey ? screenBlob?.size || 0 : 0);
  const onBytes = b => {
    sent += b;
    uploader.progress = Math.min(99, Math.max(1, Math.round((sent / total) * 100)));
    updateHint();
  };
  // recordings: loudness + the expressiveness track come from the voice
  // track (or the voice clip itself), decoded alongside the upload; file
  // uploads get theirs from the PCM they're already extracting
  const analysis = job.audioPromise ? null : analyzeBlob(job.audioBlob?.size ? job.audioBlob : videoBlob);
  if (!job.videoKey) job.videoKey = await chunkUpload(videoBlob, onBytes);
  if (screenBlob && screenBlob.size && !job.screenKey) job.screenKey = await chunkUpload(screenBlob, onBytes);

  // file uploads extract their audio in parallel with the chunks — collect it
  let pcm = null;
  if (job.audioPromise) {
    pcm = await job.audioPromise.catch(() => null);
    if (pcm) job.durationMs ||= pcm.durationMs;
    job.audioPromise = null;
  }
  let audioBlob = job.audioBlob;
  let pcmGain = null, features = null;
  if (pcm && !audioBlob) {
    pcmGain = gainFromSamples(pcm.mono);
    features = await audioFeatures(pcm.mono, pcm.rate);
    if ((job.durationMs || 0) > 240_000) {
      // long clip: transcript arrives as a serial chunk stream after the post
      job.chunks = splitAudio(pcm.mono, pcm.rate);
    } else {
      audioBlob = wavBlob(pcm.mono, pcm.rate);
    }
  }

  // the message itself is now a small request: keys + the ~64kbps audio track
  const fd = new FormData();
  fd.append('videoKey', job.videoKey);
  if (job.screenKey) fd.append('screenKey', job.screenKey);
  if (analysis) {
    const an = await analysis;
    pcmGain = an.gain;
    features = an.features;
  }
  if (audioBlob && audioBlob.size) {
    fd.append('audio', audioBlob, `audio.${audioBlob.type.includes('mp4') ? 'm4a' : audioBlob.type.includes('wav') ? 'wav' : 'webm'}`);
  } else if (job.chunks) {
    fd.append('chunkedTranscript', '1');
  }
  if (pcmGain != null) fd.append('gain', String(pcmGain));
  if (features) fd.append('features', JSON.stringify(features));
  fd.append('author', state.name || 'anon');
  fd.append('durationMs', String(job.durationMs));
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

// ---------- expressiveness ----------
// A compact feature track per message, computed once from the audio in the
// browser and stored: loudness (dBFS) and pitch (Hz; 0 = unvoiced) at FEAT_HZ
// samples a second. Together with the word timings (pace, pauses) it's the
// multivariate stream the display — and later, whatever reads the
// conversation — characterizes a speaker's state from.
const FEAT_HZ = 4;
// the stored spectrum: SPEC_N log-spaced points from SPEC_LO to SPEC_HI Hz,
// one byte each (the analyser's own dB→byte scale, so stored and live match)
const SPEC_N = 12, SPEC_LO = 70, SPEC_HI = 7000;
const specHz = i => SPEC_LO * Math.pow(SPEC_HI / SPEC_LO, i / (SPEC_N - 1));
const dbByte = db => Math.max(0, Math.min(255, Math.round(((db + 100) / 70) * 255)));

// in-place radix-2 FFT (re, im) — small and plenty for a 1024-point window
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

const b64 = {
  enc: bytes => { // chunked: a spread of a long track would blow the call stack
    let out = '';
    for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(out);
  },
  dec: str => Uint8Array.from(atob(str), ch => ch.charCodeAt(0)),
};

async function audioFeatures(mono, rate) {
  const hop = Math.round(rate / FEAT_HZ), win = Math.round(rate * 0.04);
  const n = Math.floor(mono.length / hop);
  const loud = new Array(n).fill(-60), pitch = new Array(n).fill(0);
  const spec = new Uint8Array(n * SPEC_N);
  const minLag = Math.round(rate / 400), maxLag = Math.round(rate / 70); // 70–400Hz: speaking voices
  const FN = 1024, re = new Float32Array(FN), im = new Float32Array(FN);
  const hann = new Float32Array(FN);
  for (let j = 0; j < FN; j++) hann[j] = 0.5 - 0.5 * Math.cos((2 * Math.PI * j) / FN);
  const binHz = rate / FN;
  for (let i = 0; i < n; i++) {
    if (i % 160 === 159) await new Promise(r => setTimeout(r)); // long files: keep the page responsive
    const c = i * hop + (hop >> 1);
    // spectrum: the loudest bin in each of the log-spaced slices
    const s0 = Math.max(0, c - FN / 2);
    for (let j = 0; j < FN; j++) { re[j] = (mono[s0 + j] || 0) * hann[j]; im[j] = 0; }
    fft(re, im);
    for (let k = 0; k < SPEC_N; k++) {
      const lo = k ? Math.sqrt(specHz(k - 1) * specHz(k)) : SPEC_LO * 0.8;
      const hi = k < SPEC_N - 1 ? Math.sqrt(specHz(k) * specHz(k + 1)) : SPEC_HI;
      const a = Math.max(1, Math.round(lo / binHz)), b = Math.min(FN / 2, Math.max(a + 1, Math.round(hi / binHz)));
      let peak = 0;
      for (let j = a; j < b; j++) peak = Math.max(peak, re[j] * re[j] + im[j] * im[j]);
      spec[i * SPEC_N + k] = dbByte(20 * Math.log10((Math.sqrt(peak) * 4) / FN + 1e-9)); // hann: ×4/N ≈ sine amplitude
    }
    const a = Math.max(0, (c - win / 2) | 0), b = Math.min(mono.length, a + win);
    let e = 0;
    for (let j = a; j < b; j++) e += mono[j] * mono[j];
    const db = 20 * Math.log10(Math.sqrt(e / Math.max(1, b - a)) + 1e-6);
    loud[i] = Math.max(-60, Math.min(0, db));
    const len = b - a - maxLag;
    if (db < -45 || len < minLag) continue; // silence / clipped window: unvoiced
    // normalized autocorrelation; the shortest lag near the best score wins
    // (the true period, not its subharmonic)
    let e0 = 0;
    for (let j = a; j < a + len; j++) e0 += mono[j] * mono[j];
    let best = 0, bestLag = 0;
    const scores = new Float32Array(maxLag + 1);
    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0, e1 = 0;
      for (let j = a; j < a + len; j++) { sum += mono[j] * mono[j + lag]; e1 += mono[j + lag] * mono[j + lag]; }
      const r = sum / Math.sqrt(e0 * e1 + 1e-9);
      scores[lag] = r;
      if (r > best) { best = r; bestLag = lag; }
    }
    if (best < 0.6) continue;
    for (let lag = minLag + 1; lag < bestLag; lag++) {
      if (scores[lag] >= best * 0.9 && scores[lag] >= scores[lag - 1] && scores[lag] >= scores[lag + 1]) { bestLag = lag; break; }
    }
    // parabolic refinement around the peak: sub-sample period, true pitch
    const y0 = scores[bestLag - 1] || 0, y1 = scores[bestLag], y2 = scores[bestLag + 1] || 0;
    const denom = y0 - 2 * y1 + y2;
    const shift = denom ? Math.min(0.5, Math.max(-0.5, 0.5 * (y0 - y2) / denom)) : 0;
    pitch[i] = rate / (bestLag + shift);
  }
  return { hz: FEAT_HZ, loud: loud.map(Math.round), pitch: pitch.map(Math.round), spec: b64.enc(spec) };
}

// the expressiveness color ([L, C, h]) of the word being spoken at t, if known
function wordLCHAt(msg, t) {
  if (!msg?.words.length) return null;
  const expr = exprFor(msg);
  if (!expr) return null;
  let i = -1;
  for (let k = 0; k < msg.words.length; k++) { if (msg.words[k].s <= t) i = k; else break; }
  if (i < 0) return null;
  return exprLCH(expr[i]);
}

// the stored spectrum at a moment, as spectrum-at-Hz (0..1) — the same shape
// the live analyser gives, so the lines look the same paused or scrubbing
function storedSpecAt(features, t) {
  if (!features?.spec) return null;
  if (!features._spec) features._spec = b64.dec(features.spec);
  const n = features._spec.length / SPEC_N;
  // between two samples: blend them by time, so a moving playhead glides
  // instead of stepping 4× a second
  const pos = Math.min(n - 1, Math.max(0, t * features.hz - 0.5));
  const i = Math.floor(pos), j = Math.min(n - 1, i + 1), ft = pos - i;
  const r0 = features._spec.subarray(i * SPEC_N, (i + 1) * SPEC_N);
  const r1 = features._spec.subarray(j * SPEC_N, (j + 1) * SPEC_N);
  const lgLo = Math.log(SPEC_LO), lgSpan = Math.log(SPEC_HI / SPEC_LO);
  return hz => {
    const u = ((Math.log(Math.max(hz, SPEC_LO)) - lgLo) / lgSpan) * (SPEC_N - 1);
    const k = Math.min(SPEC_N - 2, Math.max(0, Math.floor(u))), f = Math.min(1, u - k);
    const a = r0[k] * (1 - f) + r0[k + 1] * f, b = r1[k] * (1 - f) + r1[k + 1] * f;
    return (a * (1 - ft) + b * ft) / 255;
  };
}

// features ride separately from the chat poll (they're the big part of a
// message) — fetched once per message when something wants them
const featFetching = new Set(), featFailed = new Set();
function ensureFeatures(msg) {
  if (!msg || msg.features || !msg.hasFeatures || featFetching.has(msg.id) || featFailed.has(msg.id)) return;
  featFetching.add(msg.id);
  jfetch(`/api/chats/${state.chatId}/messages/${msg.id}/features`)
    .then(d => {
      msg.features = d.features;
      msg._expr = null;
      if (state.expr) { state.lastRenderKey = ''; render(); } // (the speaker's profile shifts — every card of theirs recolors)
    })
    .catch(() => featFailed.add(msg.id)) // once — a bad fetch must not become a per-frame loop
    .finally(() => featFetching.delete(msg.id));
}

// decode any media blob → 16kHz mono, then loudness correction + the feature track
async function analyzeBlob(blob) {
  try {
    const pcm = await extractAudio(blob);
    return { gain: gainFromSamples(pcm.mono), features: await audioFeatures(pcm.mono, pcm.rate) };
  } catch {
    return { gain: 1, features: null };
  }
}

// per-word reads, each 0..1, derived from the track + word timings:
//   energy  — pace, loudness above the speaker's norm, pitch above the speaker's norm
//   flow    — smoothness: few pauses, even rhythm (vs. choppy, searching)
//   tension — punchiness: loudness and pitch swinging hard over a short span
// Heuristics, openly: they are how the numbers are read, not ground truth.
//
// Raw sub-metrics per word first; then each is placed against the SPEAKER's
// own typical range (p10–p90 across every message of theirs with a track in
// this chat), so a quiet talker's loud moments read as loud for them, and a
// big talker isn't permanently red. Composites come from those, through one
// fixed contrast curve.
const clamp01 = v => Math.min(1, Math.max(0, v));
const median = arr => { const a = [...arr].sort((x, y) => x - y); return a.length ? a[a.length >> 1] : null; };
const quantile = (sorted, p) => sorted[Math.floor((sorted.length - 1) * p)];
const stdev = arr => {
  if (arr.length < 2) return 0;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
};
const exprOn = kind => state.expr.split(',').includes(kind);
const EXPR_KEYS = ['pace', 'pause', 'cv', 'loud', 'pitch', 'loudStd', 'pitchStd'];
// a speaker's range never shrinks below these — a monotone speaker stays calm, not noisy
const EXPR_FLOOR = { pace: 1.2, pause: 0.15, cv: 0.3, loud: 5, pitch: 5, loudStd: 2.5, pitchStd: 3 };
// defaults (measured on real speech) that a speaker with few words blends toward
const EXPR_DEFAULT = { pace: [1.5, 2.8, 5.4], pause: [0.08, 0.24, 0.35], cv: [0.5, 0.7, 0.96], loud: [-7.5, -1, 7], pitch: [-3.2, 1.3, 8.8], loudStd: [1.5, 4.6, 6], pitchStd: [0.9, 3.3, 6.8] };

function rawFor(msg) {
  // Whisper's stamps run early; the audio is sampled at the same lag the
  // word glow uses, so the colors and the voice line up
  const lag = state.wordLag;
  const key = `${msg.words.length}|${msg.features ? msg.features.loud.length : 0}|${lag}`;
  if (msg._raw?.key === key) return msg._raw.v;
  const words = msg.words;
  if (!words.length) return null;
  const f = msg.features, hz = f?.hz || 0;
  const dur = msgDur(msg);
  let loudMed = null, pitchMed = null, semi = null;
  if (f) {
    loudMed = median(f.loud.filter(v => v > -50));
    semi = f.pitch.map(p => (p > 0 ? 12 * Math.log2(p / 100) : null));
    const voiced = semi.filter(v => v != null);
    pitchMed = voiced.length >= 8 ? median(voiced) : null;
  }
  // windows are short and triangular (the middle counts most) so a change
  // shows up AT the word, not smeared across the seconds around it
  const HALF = 1.25, SWING = 0.75;
  const centers = words.map(w => (w.s + w.e) / 2);
  const v = words.map((w, i) => {
    const c = centers[i];
    const lo = Math.max(0, c - HALF), hi = Math.min(dur, c + HALF);
    let n = 0, voicedSec = 0, wsum = 0;
    const starts = [];
    for (let k = 0; k < words.length; k++) {
      if (centers[k] < lo || centers[k] > hi) continue;
      const wt = 1 - Math.abs(centers[k] - c) / HALF; // triangular weight
      n += wt;
      wsum += wt;
      starts.push(words[k].s);
      voicedSec += (Math.min(words[k].e, hi) - Math.max(words[k].s, lo)) * (0.5 + 0.5 * wt);
    }
    const gaps = [];
    for (let k = 1; k < starts.length; k++) gaps.push(starts[k] - starts[k - 1]);
    const gm = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
    const span = Math.max(hi - lo, 0.5);
    const x = {
      pace: (n * 2) / span,                                   // weighted words per second around here (triangle area = half)
      pause: clamp01(1 - (voicedSec / 0.75) / span),          // fraction of the window that's silence
      cv: gm > 0 ? stdev(gaps) / gm : 0,                      // rhythm irregularity
      loud: null, pitch: null, loudStd: null, pitchStd: null,
    };
    if (f && loudMed != null) {
      const wa = Math.max(0, Math.floor((w.s + lag) * hz)), wb = Math.max(wa + 1, Math.ceil((w.e + lag) * hz));
      const wl = f.loud.slice(wa, wb).filter(y => y > -50);
      if (wl.length) x.loud = wl.reduce((a, b) => a + b, 0) / wl.length - loudMed;        // dB vs the message's norm
      const ws = semi.slice(wa, wb).filter(y => y != null);
      if (ws.length && pitchMed != null) x.pitch = ws.reduce((a, b) => a + b, 0) / ws.length - pitchMed; // semitones vs norm
      const a = Math.max(0, Math.floor((c + lag - SWING) * hz)), b = Math.ceil((c + lag + SWING) * hz);
      x.loudStd = stdev(f.loud.slice(a, b).filter(y => y > -50));
      x.pitchStd = stdev(semi.slice(a, b).filter(y => y != null));
    }
    return x;
  });
  msg._raw = { key, v };
  return v;
}

// the speaker's typical range per sub-metric, from every message of theirs
// with words (and a track, for the audio ones) loaded right now
const profiles = new Map(); // author → { key, p }
function speakerProfile(author) {
  const mine = state.messages.filter(m => normName(m.author) === normName(author) && m.words.length);
  const key = mine.map(m => `${m.id}:${m.words.length}:${m.features ? 1 : 0}`).join(',') + `|${state.wordLag}`;
  const hit = profiles.get(author);
  if (hit?.key === key) return hit.p;
  const p = {};
  for (const k of EXPR_KEYS) {
    const vals = mine.flatMap(m => (rawFor(m) || []).map(x => x[k]).filter(val => val != null)).sort((a, b) => a - b);
    const n = vals.length;
    const own = n ? [quantile(vals, 0.1), quantile(vals, 0.5), quantile(vals, 0.9)] : EXPR_DEFAULT[k];
    // few words: lean on the defaults until the speaker has shown their range
    const w = Math.min(1, n / 150);
    p[k] = own.map((val, i) => val * w + EXPR_DEFAULT[k][i] * (1 - w));
  }
  profiles.set(author, { key, p });
  return p;
}

function exprFor(msg) {
  ensureFeatures(msg);
  const raw = rawFor(msg);
  if (!raw) return null;
  const prof = speakerProfile(msg.author);
  const pkey = JSON.stringify(prof);
  if (msg._expr?.key === msg._raw.key && msg._expr.pkey === pkey) return msg._expr.v;
  const norm = (val, k) => {
    if (val == null) return 0.5;
    const [lo, , hi] = prof[k];
    const span = Math.max(hi - lo, EXPR_FLOOR[k]);
    return clamp01((val - (lo + hi) / 2) / span + 0.5);
  };
  const contrast = val => clamp01((val - 0.15) / 0.7); // the middle 70% of the speaker's range spans the palette
  const v = raw.map(x => ({
    energy: contrast(0.3 * norm(x.pace, 'pace') + 0.42 * norm(x.loud, 'loud') + 0.28 * norm(x.pitch, 'pitch')),
    flow: contrast(1 - (0.5 * norm(x.pause, 'pause') + 0.5 * norm(x.cv, 'cv'))),
    tension: contrast(0.5 * norm(x.loudStd, 'loudStd') + 0.5 * norm(x.pitchStd, 'pitchStd')),
  }));
  msg._expr = { key: msg._raw.key, pkey, v };
  return v;
}
// brightness = energy (lux is energy), hue = tension (calm blue … tense red,
// by way of purple — never through green), chroma = flow (choppy grey …
// smooth and alive). Mixed in OKLCH so the ramp is perceptually even and
// stays pastel; out-of-gamut channels are clipped.
function oklch(L, C, h, alpha = null) {
  const a = C * Math.cos((h * Math.PI) / 180), b = C * Math.sin((h * Math.PI) / 180);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3, m = m_ ** 3, sv = s_ ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * sv,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * sv,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * sv,
  ];
  const srgb = lin.map(v => {
    const c = Math.min(1, Math.max(0, v));
    return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
  });
  return alpha == null ? `rgb(${srgb.join(',')})` : `rgba(${srgb.join(',')},${alpha})`;
}
// 264° blue → 385°≡25° red. Text is a thin stroke and reads dimmer than the
// same color filling an area, so the word variant is lifted to match by eye.
const exprLCH = (x, text = false) => text
  ? [0.64 + 0.3 * x.energy, 0.05 + 0.17 * x.flow, 264 + 121 * x.tension]
  : [0.52 + 0.38 * x.energy, 0.03 + 0.17 * x.flow, 264 + 121 * x.tension];
const exprColor = (x, text = false) => oklch(...exprLCH(x, text));
// a word's gradient: halfway-to-the-previous word at its left edge, its own
// color in the middle, halfway-to-the-next at its right — so color flows
// through the line instead of stepping word to word
const mixLCH = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
function exprGradient(expr, i, text = false) {
  const cur = exprLCH(expr[i], text);
  const prev = i > 0 ? exprLCH(expr[i - 1], text) : cur;
  const next = i + 1 < expr.length ? exprLCH(expr[i + 1], text) : cur;
  return `linear-gradient(90deg, ${oklch(...mixLCH(prev, cur, 0.5))}, ${oklch(...cur)} 50%, ${oklch(...mixLCH(cur, next, 0.5))})`;
}

// Older messages have no track: the author (or an editor) quietly computes
// one from the stored voice audio and saves it — one at a time, only while
// the display is on, never for videos without a separate voice track.
const featBackfill = { tried: new Set(), running: false };
async function backfillFeatures() {
  if (featBackfill.running || !state.expr) return;
  const msg = state.messages.find(m =>
    (!m.hasFeatures || (m.features && !m.features.spec)) && m.words.length && !featBackfill.tried.has(m.id)
    && (isMine(m.author) || canEdit()) && (m.audioKey || isAudioMsg(m)));
  if (!msg) return;
  featBackfill.running = true;
  featBackfill.tried.add(msg.id);
  try {
    const res = await fetch(`${location.origin}/media/${msg.audioKey || msg.file}`);
    if (!res.ok || Number(res.headers.get('content-length')) > 30e6) throw new Error('skip');
    const { features } = await analyzeBlob(await res.blob());
    if (!features) throw new Error('no track');
    await jfetch(`/api/chats/${state.chatId}/messages/${msg.id}/features`, {
      method: 'PUT', headers: JSONH, body: JSON.stringify({ author: state.name, features }),
    });
    msg.features = features;
    msg.hasFeatures = true;
    msg._expr = null;
    state.lastRenderKey = '';
    render();
  } catch { /* next one */ } finally {
    featBackfill.running = false;
    setTimeout(backfillFeatures, 1200);
  }
}

// ---------- video / audio file upload ----------
// Post an existing video or audio file as a message: extract its audio track
// in the browser (for transcription + loudness), then ride the normal
// pipeline — chunked upload, ghost card, layer routing, the works.
// decode the audio track out of a media file → mono PCM (WAV built as needed)
async function extractAudio(file) {
  const ctx = new OfflineAudioContext(1, 1, 16000);
  const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
  const ch0 = decoded.getChannelData(0);
  let mono = ch0;
  if (decoded.numberOfChannels > 1) {
    const ch1 = decoded.getChannelData(1);
    mono = new Float32Array(ch0.length);
    for (let i = 0; i < ch0.length; i++) mono[i] = (ch0[i] + ch1[i]) / 2;
  }
  return { mono, rate: decoded.sampleRate, durationMs: Math.round(decoded.duration * 1000) };
}

// same loudness math as measureGain, straight off PCM samples
function gainFromSamples(mono) {
  let sum = 0, n = 0;
  for (let i = 0; i < mono.length; i += 2048) {
    let s = 0;
    const end = Math.min(i + 2048, mono.length);
    for (let j = i; j < end; j++) s += mono[j] * mono[j];
    const rms = Math.sqrt(s / (end - i));
    if (rms > 0.01) { sum += rms; n++; }
  }
  if (!n) return 1;
  return Math.min(Math.max(0.1 / (sum / n), 0.5), 4);
}

// Split PCM into ~3-minute chunks, cutting at the quietest 50ms window near
// each boundary so no word gets sliced. Returns [{offsetMs, blob}] ready for
// the serial /transcribe-chunk stream.
const CHUNK_SEC = 180;
function splitAudio(mono, rate) {
  const cuts = [];
  let start = 0;
  while (mono.length - start > (CHUNK_SEC + 60) * rate) { // never leave a runt tail
    const target = start + CHUNK_SEC * rate;
    const lo = Math.max(start + 60 * rate, target - 15 * rate);
    const hi = Math.min(mono.length - 30 * rate, target + 15 * rate);
    const win = Math.floor(rate * 0.05);
    let best = target, bestE = Infinity;
    for (let i = lo; i + win < hi; i += win) {
      let e = 0;
      for (let j = i; j < i + win; j++) e += mono[j] * mono[j];
      if (e < bestE) { bestE = e; best = i + (win >> 1); }
    }
    cuts.push({ start, end: best });
    start = best;
  }
  cuts.push({ start, end: mono.length });
  return cuts.map(c => ({
    offsetMs: Math.round((c.start / rate) * 1000),
    blob: wavBlob(mono.subarray(c.start, c.end), rate),
  }));
}

// stream the chunks in order; each response is the go-ahead for the next.
// A failed chunk (after one retry) is skipped — the rest of the transcript
// still lands, and the last chunk always finalizes the message.
async function sendTranscriptChunks(msgId, chunks) {
  const lang = localStorage.getItem('splitty:lang') || '';
  for (let i = 0; i < chunks.length; i++) {
    const fd = new FormData();
    fd.append('audio', chunks[i].blob, 'chunk.wav');
    fd.append('offsetMs', String(chunks[i].offsetMs));
    fd.append('author', state.name || '');
    if (lang) fd.append('lang', lang);
    if (i === chunks.length - 1) fd.append('last', '1');
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      try {
        ok = (await fetch(`/api/chats/${state.chatId}/messages/${msgId}/transcribe-chunk`, {
          method: 'POST', body: fd,
        })).ok;
      } catch { /* network blip */ }
      if (!ok) await new Promise(r => setTimeout(r, 2000));
    }
    poll(); // fresh words appear in the transcript as each chunk lands
  }
}

// fast duration read: container metadata only, no decode
const videoDurationMs = file => new Promise(res => {
  const v = document.createElement('video');
  v.preload = 'metadata';
  v.onloadedmetadata = () => {
    const d = isFinite(v.duration) ? Math.round(v.duration * 1000) : null;
    URL.revokeObjectURL(v.src);
    res(d);
  };
  v.onerror = () => res(null);
  v.src = URL.createObjectURL(file);
});

// 'video' | 'audio' | null — by declared type, else by extension (some OSes
// hand over .m4a/.opus files with no type at all)
const EXT_MIME = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg',
  opus: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac', weba: 'audio/webm',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
};
const fileMime = f => {
  const t = (f.type || '').split(';')[0];
  if (/^(video|audio)\//.test(t)) return t;
  return EXT_MIME[(f.name || '').split('.').pop().toLowerCase()] || '';
};
const mediaKind = f => (fileMime(f).split('/')[0] || null);

async function uploadVideoFile(file) {
  if (!file) return;
  const kind = mediaKind(file);
  if (!kind) return showToast("That doesn't look like a video or audio file");
  if (file.size > 800 * 1024 * 1024) return showToast('That file is too large — try under 800MB');
  // a typeless file gets its sniffed mime so the server stores the right kind
  if (file.type !== fileMime(file)) file = new File([file], file.name, { type: fileMime(file) });

  // audio decode is CPU-bound, upload is network-bound: run them in
  // parallel. The upload starts immediately; the message POST at the end
  // waits for whichever finishes last.
  const audioPromise = extractAudio(file).catch(() => null);
  const durationMs = await videoDurationMs(file); // instant — metadata only
  if (durationMs && durationMs > MAX_RECORD_MS + 30_000 && !canEdit()) {
    return showToast('Clips are capped at 10 minutes — editors can post longer files');
  }

  const recLayer = canEdit() ? state.layer : canComment() ? '' : (state.auth?.user?.id || '');
  const anchor = state._uploadAnchor || {};
  state._uploadAnchor = null;
  const job = {
    videoBlob: file,
    audioBlob: null,
    audioPromise,
    screenBlob: null,
    durationMs,
    rec: { parentId: anchor.parentId || null, anchorMs: anchor.anchorMs ?? null, resume: null, layer: recLayer },
  };
  enqueueUpload(job);
  audioPromise.then(a => {
    if (!a) return;
    job.durationMs ||= a.durationMs;
    if (a.durationMs <= 240_000) {
      // short clip: one inline audio track, and the crash-recovery copy gets it
      job.audioBlob = wavBlob(a.mono, a.rate);
      savePending(job);
    }
    // long clips split at send time; recovery re-extracts from the video file
  });
  showToast(anchor.parentId ? 'Uploading — it splices in right where you were' : 'Uploading — it appears in the chat when it lands');
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
      // a recovered upload without its audio re-extracts from the media file
      // (video, audio file, or voice clip alike — long ones chunk as usual)
      audioPromise: !r.audioBlob && /^(video|audio)\//.test(r.videoBlob?.type || '')
        ? extractAudio(r.videoBlob).catch(() => null)
        : null,
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
  spin.classList.toggle('hidden', !(el.readyState < 2 || el._waiting || state.screenHold));
}

// only transient status (recording timer, upload state) — empty hides the pill.
// Recording wins the pill; background sends show while idle.
function updateHint(text) {
  if (text == null && state.rec) {
    const elapsed = Date.now() - state.rec.startTs;
    const s = Math.floor(elapsed / 1000);
    const what = state.rec.screenRecorder
      ? (state.rec.audioRecorder ? 'Recording you + screen' : 'Recording voice + screen')
      : state.rec.audioRecorder ? 'Recording' : 'Recording voice';
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
  if (box.classList.contains('screen-split')) layoutSplit();
  if (box.classList.contains('mode-play') || box.classList.contains('mode-screenlive')) {
    layoutPip(preview, pips.cam);
  }
  const spipEl = [...players, screenEl()].find(p => p.classList.contains('spip'));
  if (spipEl) layoutPip(spipEl, pips.spip);
}

// Split layout, computed: both videos render at their true aspect ratios,
// sandwiched flush against each other and centered — the pair scaled to fit.
// Portrait boxes stack top/bottom (shared width, heights by aspect); landscape
// goes side by side (shared height, widths by aspect). A taller screen share
// naturally takes more room than the camera — no fixed 50/50.
function layoutSplit() {
  const box = $('#video-box');
  const sp = screenEl(), cam = activeEl();
  const W = box.clientWidth, H = box.clientHeight;
  if (!W || !H) return;
  const ar = el => (el.videoWidth && el.videoHeight ? el.videoWidth / el.videoHeight : 16 / 9);
  const a1 = ar(sp), a2 = ar(cam);
  const setRect = (el, l, t, w, h) => Object.assign(el.style, {
    position: 'absolute', inset: 'auto',
    left: `${l}px`, top: `${t}px`, width: `${w}px`, height: `${h}px`,
  });
  if (H > W) { // portrait: stack
    const w = Math.min(W, H / (1 / a1 + 1 / a2));
    const h1 = w / a1, h2 = w / a2;
    const left = (W - w) / 2, top = (H - (h1 + h2)) / 2;
    setRect(sp, left, top, w, h1);
    setRect(cam, left, top + h1, w, h2);
  } else { // landscape: side by side
    const h = Math.min(H, W / (a1 + a2));
    const w1 = h * a1, w2 = h * a2;
    const left = (W - (w1 + w2)) / 2, top = (H - h) / 2;
    setRect(sp, left, top, w1, h);
    setRect(cam, left + w1, top, w2, h);
  }
}

function setScreenLayout(layout) {
  state.screenLayout = layout;
  localStorage.setItem('splitty:screenlayout', layout);
  updateStage();
}

// ---------- voice visualizer ----------
// Voice-only has no picture, so the box gets one: a few translucent ribbons
// that undulate with the sound, each riding its own frequency band, hues
// drifting over time. Sources: the live mic (idle/recording) through its own
// little analyser context; a playing audio message through a tap on its
// WebAudio gain node when the chain is wired, otherwise a synthetic pulse
// driven by the transcript's word timing (so phones, where the chain is off
// for latency, still get motion that follows the speech).
let vizCtx = null, micAnalyser = null, micSrc = null;
function listenToMic(stream) {
  try {
    if (!stream.getAudioTracks().length) return;
    if (!vizCtx) {
      vizCtx = new (window.AudioContext || window.webkitAudioContext)();
      document.addEventListener('pointerdown', () => {
        if (vizCtx.state === 'suspended') vizCtx.resume();
      }, { capture: true });
    }
    micSrc?.disconnect();
    micSrc = vizCtx.createMediaStreamSource(stream);
    if (!micAnalyser) micAnalyser = makeAnalyser(vizCtx);
    micSrc.connect(micAnalyser); // analysis only — never routed to the speakers
    if (vizCtx.state === 'suspended') vizCtx.resume();
  } catch { /* no WebAudio — the lines just rest */ }
}

// 2048-point window: fine enough bins for the bands, and a long enough
// time-domain slice to read the pitch off
function makeAnalyser(ctx) {
  const an = ctx.createAnalyser();
  an.fftSize = 2048;
  an.smoothingTimeConstant = 0.6;
  return an;
}

function playbackAnalyser(el) {
  if (!el._gainNode || !audioCtx) return null;
  if (!el._analyser) {
    el._analyser = makeAnalyser(audioCtx);
    el._gainNode.connect(el._analyser); // side tap off the leveled signal
  }
  return el._analyser;
}

// six lines, one per band of the voice (Hz); each is a wave centered on the
// midline — long wavelength for bass, short for treble — whose height is that
// band's level. Nothing else moves: silence is six flat lines.
const VIZ_BANDS = [[60, 250], [250, 500], [500, 1000], [1000, 2000], [2000, 3500], [3500, 7000]];
const VIZ_N = VIZ_BANDS.length;
const viz = {
  el: null, ctx2d: null, raf: 0, mode: 'mic',
  bands: new Float32Array(VIZ_N), smooth: new Float32Array(VIZ_N),
  freq: new Uint8Array(1024), time: new Float32Array(2048),
  t0: performance.now(),
  hue: null, // from the pitch — null until a voice has been heard
  sat: 0,    // how colored the picture is: 0 = white (silence) … 1 = the voice's hue
  f0: null,  // smoothed pitch, Hz
  frame: 0,
  specAt: null, // hz → 0..1, whatever is feeding the lines right now
  snap: null,   // { id, t } — where a seek landed: shown once, static, while paused
  lch: null,    // [L, C, h] — during playback, the spoken word's expressiveness color (smoothed)
};

// Pitch → hue, fixed: the hue range is cut in two, the bottom half for low
// voices and the top half for high ones, each zone's typical pitch pinned to
// the middle of its half — so a low voice and a high voice each spread over
// their own half, and meet at the boundary between the zones. Clips past the ends.
//          Hz:  70    120 (low center)  160 (boundary)  210 (high center)  300
const PITCH_HUE = [[70, 0], [120, 67], [160, 135], [210, 202], [300, 270]];
function pitchHue(f0) {
  const lf = Math.log(f0);
  if (lf <= Math.log(PITCH_HUE[0][0])) return PITCH_HUE[0][1];
  for (let i = 1; i < PITCH_HUE.length; i++) {
    const [h1, hue1] = PITCH_HUE[i - 1], [h2, hue2] = PITCH_HUE[i];
    if (lf <= Math.log(h2)) {
      const u = (lf - Math.log(h1)) / (Math.log(h2) - Math.log(h1));
      return hue1 + (hue2 - hue1) * u;
    }
  }
  return PITCH_HUE[PITCH_HUE.length - 1][1];
}

// pitch off the time-domain slice: normalized autocorrelation, first clean
// peak in the speaking range (70–400Hz), parabolic refinement
function livePitch(an) {
  an.getFloatTimeDomainData(viz.time);
  const x = viz.time, rate = an.context.sampleRate;
  const minLag = Math.round(rate / 400), maxLag = Math.round(rate / 70);
  const len = x.length - maxLag;
  let e0 = 0;
  for (let j = 0; j < len; j += 2) e0 += x[j] * x[j];
  if (e0 / (len / 2) < 1e-5) return 0; // silence
  let best = 0, bestLag = 0;
  const scores = new Float32Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0, e1 = 0;
    for (let j = 0; j < len; j += 2) { sum += x[j] * x[j + lag]; e1 += x[j + lag] * x[j + lag]; }
    const r = sum / Math.sqrt(e0 * e1 + 1e-9);
    scores[lag] = r;
    if (r > best) { best = r; bestLag = lag; }
  }
  if (best < 0.6) return 0; // unvoiced
  for (let lag = minLag + 1; lag < bestLag; lag++) {
    if (scores[lag] >= best * 0.9 && scores[lag] >= scores[lag - 1] && scores[lag] >= scores[lag + 1]) { bestLag = lag; break; }
  }
  const y0 = scores[bestLag - 1] || 0, y1 = scores[bestLag], y2 = scores[bestLag + 1] || 0;
  const denom = y0 - 2 * y1 + y2;
  const shift = denom ? Math.min(0.5, Math.max(-0.5, 0.5 * (y0 - y2) / denom)) : 0;
  return rate / (bestLag + shift);
}

// the live spectrum, per bin, smoothed (quick to rise, slow to settle)
const SPEC_MAX_HZ = 7000;
let liveBins = null;
function readBands(an, out) {
  an.getByteFrequencyData(viz.freq);
  const binHz = an.context.sampleRate / an.fftSize;
  const nb = Math.min(viz.freq.length, Math.ceil(SPEC_MAX_HZ / binHz) + 2);
  if (!liveBins || liveBins.length !== nb) liveBins = new Float32Array(nb);
  for (let k = 0; k < nb; k++) {
    const v = viz.freq[k] / 255, d = v - liveBins[k];
    liveBins[k] += d * (d > 0 ? 0.5 : 0.12);
  }
  VIZ_BANDS.forEach(([lo, hi], i) => {
    const a = Math.max(0, Math.round(lo / binHz)), b = Math.min(nb, Math.max(a + 1, Math.round(hi / binHz)));
    let peak = 0;
    for (let k = a; k < b; k++) if (liveBins[k] > peak) peak = liveBins[k]; // the band's loudest bin
    out[i] = Math.min(1, peak * 1.25);
  });
  // resample onto a log-spaced grid, each point the mean of the bins in its
  // slice — high up, where many bins squeeze into a point, noise averages out
  const LG = 96, lgLo = Math.log(SPEC_LO), lgSpan = Math.log(SPEC_HI / SPEC_LO);
  if (!viz.logSpec) viz.logSpec = new Float32Array(LG + 1);
  for (let i = 0; i <= LG; i++) {
    const fa = Math.exp(lgLo + lgSpan * ((i - 0.5) / LG)), fb = Math.exp(lgLo + lgSpan * ((i + 0.5) / LG));
    const a = Math.max(0, Math.floor(fa / binHz)), b = Math.min(nb - 1, Math.max(a + 1, Math.ceil(fb / binHz)));
    let sum = 0;
    for (let k = a; k < b; k++) sum += liveBins[k];
    viz.logSpec[i] = sum / (b - a);
  }
  for (let pass = 0; pass < 2; pass++) { // a little smoothing along the line
    let prev = viz.logSpec[0];
    for (let i = 1; i < LG; i++) {
      const cur = viz.logSpec[i];
      viz.logSpec[i] = prev * 0.25 + cur * 0.5 + viz.logSpec[i + 1] * 0.25;
      prev = cur;
    }
  }
  viz.specAt = hz => {
    const u = ((Math.log(Math.max(hz, SPEC_LO)) - lgLo) / lgSpan) * LG;
    const k = Math.min(LG - 1, Math.max(0, Math.floor(u))), f = Math.min(1, Math.max(0, u - k));
    return viz.logSpec[k] * (1 - f) + viz.logSpec[k + 1] * f;
  };
  // pitch every other frame (it's the costly read; every fourth in simple mode);
  // hold through unvoiced stretches
  if ((viz.frame++ & (state.vizMode === 'simple' ? 3 : 1)) === 0) {
    const f0 = livePitch(an);
    if (f0) {
      const lf = Math.log(f0);
      viz.f0 = viz.f0 == null || viz.sat < 0.05 ? f0 : Math.exp(Math.log(viz.f0) + (lf - Math.log(viz.f0)) * 0.2);
      viz.hue = pitchHue(viz.f0);
    }
  }
}

// paused or scrubbing: the stored track says what the voice looked like at
// that moment — bands, spectrum shape and pitch — so the picture is honest
// there too. Returns false when there's nothing stored.
function storedBands(msg, t, out) {
  const f = msg?.features;
  const at = storedSpecAt(f, t);
  if (!at) return false;
  viz.specAt = at;
  VIZ_BANDS.forEach(([lo, hi], i) => {
    let peak = 0;
    for (let k = 0; k < 8; k++) peak = Math.max(peak, at(lo * Math.pow(hi / lo, k / 7)));
    out[i] = Math.min(1, peak * 1.25);
  });
  const p = f.pitch[Math.min(f.pitch.length - 1, Math.max(0, Math.floor(t * f.hz)))];
  if (p > 0) { viz.f0 = p; viz.hue = pitchHue(p); }
  return true;
}

function showViz(on, mode = viz.mode) {
  if (!viz.el) { viz.el = $('#viz'); viz.ctx2d = viz.el.getContext('2d'); }
  viz.mode = mode;
  viz.el.classList.toggle('hidden', !on);
  if (on && !viz.raf) viz.raf = requestAnimationFrame(vizFrame);
}

function vizFrame(now) {
  if (viz.el.classList.contains('hidden') || document.hidden) { viz.raf = 0; return; }
  viz.raf = requestAnimationFrame(vizFrame);
  const t = (now - viz.t0) / 1000;
  // size to the box (device pixels, capped — it's a glow, not text)
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5); // the neon blur is the one costly thing — keep pixels modest
  const W = Math.round(viz.el.clientWidth * dpr), H = Math.round(viz.el.clientHeight * dpr);
  if (!W || !H) return;
  if (viz.el.width !== W || viz.el.height !== H) { viz.el.width = W; viz.el.height = H; }

  let fed = false;
  if (viz.mode === 'play') {
    const el = activeEl();
    if (el.paused) {
      // paused is flat — except a seek that just landed shows the stored
      // spectrum at that point, once, as a still
      if (viz.snap && !state.scrubbing) {
        const m = state.byId.get(viz.snap.id);
        ensureFeatures(m);
        fed = storedBands(m, viz.snap.t, viz.bands);
      }
    } else {
      viz.snap = null; // once it plays, a later pause is plain flat
      const an = playbackAnalyser(el);
      const seg = state.playIdx >= 0 ? state.playlist[state.playIdx] : null;
      const cur = seg && state.byId.get(seg.id);
      if (an) { readBands(an, viz.bands); fed = true; }
      else if (cur) {
        // no WebAudio chain (compressor off): the stored track stands in, read at the playhead
        ensureFeatures(cur);
        fed = storedBands(cur, el.currentTime, viz.bands);
      }
    }
    // the color is the spoken word's expressiveness color, same as the highlighter
    const seg = state.playIdx >= 0 ? state.playlist[state.playIdx] : null;
    const cur = seg && state.byId.get(seg.id);
    const target = cur && !el.paused ? wordLCHAt(cur, el.currentTime - state.wordLag) : (viz.snap && cur ? wordLCHAt(cur, viz.snap.t) : null);
    if (target) {
      if (!viz.lch || viz.sat < 0.05) viz.lch = target.slice();
      else for (let i = 0; i < 3; i++) viz.lch[i] += (target[i] - viz.lch[i]) * 0.25;
    }
  } else if (micAnalyser) {
    viz.lch = null; // live mic: no words yet — the pitch color
    readBands(micAnalyser, viz.bands);
    fed = true;
  }
  if (!fed) { viz.bands.fill(0); viz.specAt = null; }
  for (let i = 0; i < viz.bands.length; i++) {
    const d = viz.bands[i] - viz.smooth[i];
    viz.smooth[i] += d * (d > 0 ? 0.5 : 0.12); // quick to rise, slow to settle
  }
  // color bleeds in with the energy — silence is still, flat and white
  const energy = (viz.smooth[0] + viz.smooth[1] + viz.smooth[2] + viz.smooth[3]) / 4;
  const satTarget = Math.min(1, Math.max(0, energy - 0.04) * 4);
  viz.sat += (satTarget - viz.sat) * (satTarget > viz.sat ? 0.25 : 0.06);
  drawViz(viz.ctx2d, W, H, energy);
}

const VIZ_PTS = 24; // samples per band across the half-width
function drawViz(c, W, H, energy) {
  c.globalCompositeOperation = 'source-over';
  const bg = c.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#0b0d18');
  bg.addColorStop(1, '#05060b');
  c.fillStyle = bg;
  c.fillRect(0, 0, W, H);
  c.globalCompositeOperation = 'lighter'; // lines add up into glow where they cross

  // one hue — the voice's pitch; the lines are its gradient, bass darkest
  // through treble lightest, so the picture reads as a single color breathing
  const hue = viz.hue ?? 0;
  const sat = Math.round(85 * viz.sat); // white at rest, the voice's color when it speaks
  // color source: the spoken word's expressiveness color during playback
  // (the highlighter's color), the pitch hue off the live mic; both fade to
  // white in silence. L is 0..1 lightness.
  const col = viz.lch
    ? (L, alpha) => oklch(L, viz.lch[1] * viz.sat, viz.lch[2], alpha)
    : (L, alpha) => `hsla(${hue}, ${sat}%, ${Math.round(L * 100)}%, ${alpha})`;
  const scale = W / 800 + 0.6;
  const mid = H / 2, span = H * 0.4, half = W / 2;
  const at = viz.specAt;
  const simple = state.vizMode === 'simple';
  // one line: the whole voice spectrum, bass at the center of the box rising
  // to treble at the right edge, mirrored to the left. Its color runs dark at
  // the center to light at the edges (bass → treble), and it casts a fainter
  // reflection below the midline.
  const PTS = simple ? 32 : 64, lo = VIZ_BANDS[0][0], hi = VIZ_BANDS[VIZ_N - 1][1];
  const ys = [];
  for (let k = 0; k <= PTS; k++) {
    const hz = lo * Math.pow(hi / lo, k / PTS);
    ys.push((at ? Math.min(1, at(hz) * 1.25) : 0) * span);
  }
  // one smooth curve through the points: left edge (treble) → center (bass) →
  // right edge. reverse = right → left, continuing the current path (no moveTo),
  // so a fill of top + reversed bottom is ONE closed shape — two subpaths would
  // each close with their own straight line, a diagonal across the lens
  const trace = (flip, reverse = false) => {
    const xs = [], yy = [];
    for (let k = PTS; k >= 0; k--) { xs.push(half - (k / PTS) * half); yy.push(mid + flip * ys[k]); }
    for (let k = 1; k <= PTS; k++) { xs.push(half + (k / PTS) * half); yy.push(mid + flip * ys[k]); }
    if (reverse) { xs.reverse(); yy.reverse(); c.lineTo(xs[0], yy[0]); }
    else c.moveTo(xs[0], yy[0]);
    const n = xs.length;
    for (let i = 0; i < n - 1; i++) {
      const p0 = yy[Math.max(i - 1, 0)], p1 = yy[i], p2 = yy[i + 1], p3 = yy[Math.min(i + 2, n - 1)];
      const dx = (xs[i + 1] - xs[i]) / 3;
      c.bezierCurveTo(xs[i] + dx, p1 + (p2 - p0) / 6, xs[i + 1] - dx, p2 - (p3 - p1) / 6, xs[i + 1], p2);
    }
  };
  const level = energy;
  // lightness anchors (0..1): dark at the center, light at the edges; both
  // drift toward white as the sound fades. With a word color, they sit
  // around that word's own lightness.
  const baseL = viz.lch ? viz.lch[0] : 0.58;
  const dark = (viz.lch ? Math.max(0.25, baseL - 0.24) : 0.28) * viz.sat + 0.58 * (1 - viz.sat);
  const light = (viz.lch ? Math.min(0.97, baseL + 0.12) : 0.88) * viz.sat + 0.95 * (1 - viz.sat);
  // along the line: dark at the center (bass), climbing steeply to bright at
  // the edges (treble) — the extra stops push the brightness outward
  const grad = alpha => {
    const g = c.createLinearGradient(0, 0, W, 0);
    const midL = (dark + light) / 2;
    g.addColorStop(0, col(light, alpha));
    g.addColorStop(0.22, col(midL, alpha));
    g.addColorStop(0.5, col(dark, alpha));
    g.addColorStop(0.78, col(midL, alpha));
    g.addColorStop(1, col(light, alpha));
    return g;
  };
  c.lineJoin = 'round';
  if (simple) {
    // plain: one color, no fill, no glow — the shape and nothing else
    c.beginPath();
    trace(-1);
    trace(1);
    c.strokeStyle = col((dark + light) / 2, 0.6 + 0.4 * level);
    c.lineWidth = 1.6 * scale;
    c.stroke();
    c.globalCompositeOperation = 'source-over';
    return;
  }
  // the hollow: inside the lens, a gentle gradient from the line's color at
  // the top and bottom to nothing at the midline — fixed extent, so it never
  // re-spans (or flips) as the shape breathes
  if (level > 0.01) {
    c.beginPath();
    trace(-1);        // top, left → right
    trace(1, true);   // bottom, right → left, same subpath
    c.closePath();
    const hg = c.createLinearGradient(0, mid - span, 0, mid + span);
    hg.addColorStop(0, col(dark + 0.18, 0.1 + 0.25 * level));
    hg.addColorStop(0.5, col(dark, 0));
    hg.addColorStop(1, col(dark + 0.18, 0.1 + 0.25 * level));
    c.fillStyle = hg;
    c.fill();
  }
  c.shadowColor = col(light, 0.5 + 0.5 * level);
  c.shadowBlur = 16 * scale;
  // the line, above and below alike — thin, its width never changes with volume
  c.beginPath();
  trace(-1);
  trace(1);
  c.strokeStyle = grad(0.55 + 0.45 * level);
  c.lineWidth = 1.5 * scale;
  c.stroke();
  c.shadowBlur = 0;
  c.globalCompositeOperation = 'source-over';
}

// the loop parks itself while the tab is hidden — pick it back up
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && viz.el && !viz.el.classList.contains('hidden') && !viz.raf) {
    viz.raf = requestAnimationFrame(vizFrame);
  }
});

// ---------- stage (video area) ----------
// modes: record → your camera fills the box; play → their video with your camera
// as a corner PiP; self → idle, just your camera; none → no camera yet, hide stage
function updateStage() {
  const stage = $('#stage');
  const box = $('#video-box');
  let mode = state.rec ? 'record' : state.playing ? 'play'
    : camStream ? 'self' : camError ? 'enable' : 'none';
  // with content in the chat, the stage (and its transport) always shows —
  // even for a camera-less viewer, so the player controls are ever-present
  if (mode === 'none' && state.messages.length) mode = 'self';
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
    showViz(false);
    $('#transport').classList.add('hidden');
    $('#pip-label').textContent = '';
    $('#cam-enable').textContent = state.voiceOnly ? 'Turn on microphone' : 'Turn on camera';
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
  const screenPlay = mode === 'play' && !!curMsg?.screenKey && !brokenScreens.has(curMsg.screenKey);
  const screenLive = mode !== 'play' && !!screenStream?.active;
  const audioPlay = mode === 'play' && isAudioMsg(curMsg); // no picture to show — the visualizer is it
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
  const split = screenPlay && !audioPlay && state.screenLayout === 'split';
  box.classList.toggle('screen-split', split);
  const splitBtn = $('#split-btn');
  splitBtn.classList.toggle('hidden', !screenPlay || audioPlay); // voice + screen: the screen is the whole picture
  splitBtn.textContent = split ? 'PiP' : 'Split'; // button shows the alternative
  splitBtn.onclick = () => setScreenLayout(split ? 'screen' : 'split');
  // fill/fit per context: the screen-share preference rules while a screen
  // message plays (default Fit — text stays whole), faces keep their own
  const fitVal = screenPlay ? state.fitScreen : state.fit;
  box.classList.toggle('fit-contain', fitVal === 'contain');
  $('#fit-btn').textContent = fitVal === 'contain' ? 'Fill' : 'Fit'; // shows the alternative

  // which video is the little draggable one (tap it to swap) — none when split
  players.forEach(p => p.classList.remove('spip'));
  sp.classList.remove('spip');
  if (screenPlay && !split && !audioPlay) (state.screenLayout === 'cam' ? sp : activeEl()).classList.add('spip');

  // floating-video geometry: sized to each video's real aspect, user-placed
  if (mode === 'play' || screenLive) layoutPip(preview, pips.cam);
  else clearPip(preview);
  for (const el of [...players, sp]) {
    if (el.classList.contains('spip')) layoutPip(el, pips.spip);
    else clearPip(el);
  }

  // self-view toggle: hides your floating preview while watching, never
  // while recording (there it's the main view, or the proof-of-capture pip)
  const selfIsPip = mode === 'play' || (screenLive && mode !== 'record');
  const hasCam = camHasVideo();
  $('#self-btn').classList.toggle('hidden', !(hasCam && selfIsPip));
  $('#self-btn').textContent = state.selfHide ? 'Show me' : 'Hide me';
  preview.classList.toggle('hidden', !hasCam || (state.selfHide && selfIsPip));
  // camera on/off lives on your own box while it's the main view
  const nocam = $('#nocam-btn');
  nocam.classList.toggle('hidden', mode === 'play' || screenLive || !camStream);
  nocam.textContent = state.voiceOnly ? 'Camera' : 'No camera';
  if (split) layoutSplit(); // computed rects: aspect-true, sandwiched, centered
  // the visualizer stands in for a picture: your mic while idle/recording
  // voice-only, the clip's audio while an audio message plays
  const vizLive = mode !== 'play' && !!camStream && !hasCam && !screenLive;
  showViz(vizLive || (audioPlay && !screenPlay), vizLive ? 'mic' : 'play');
  // never a silently empty box: show the camera-off glyph when the stage
  // would be showing your camera but there's no stream
  $('#cam-off').classList.toggle('hidden', !(mode !== 'play' && !camStream && !screenLive));
  activeEl().classList.toggle('hidden', mode !== 'play');
  standbyEl().classList.add('hidden');
  $('#transport').classList.toggle('hidden', mode !== 'play' && !state.messages.length);
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
  setTimeout(backfillFeatures, 800); // older messages grow their track in the background
  const pending = uploader.jobs.filter(j => !j.done);
  const key = JSON.stringify(state.messages.map(m => [m.id, m.transcriptStatus, m.words.length, m.anchorMs]))
    + '|' + pending.map(j => j.jid).join(',');
  if (key === state.lastRenderKey) return;
  state.lastRenderKey = key;

  const box = $('#messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 200;
  box.innerHTML = '';

  if (!state.messages.length && !pending.length) {
    box.innerHTML = `<div class="empty">Nothing here yet.<br>Record the first ${state.voiceOnly ? 'voice' : 'video'} note.`
      + (canRecordHere() ? '<br><button id="empty-upload" class="btn-outline">…or click to upload / drop a video or audio file here</button>' : '')
      + '</div>';
    const b = box.querySelector('#empty-upload');
    if (b) b.onclick = () => $('#upload-btn').click(); // same gate + picker as the menu
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
    ${isAudioMsg(msg) ? '<span class="screen-tag" title="Voice only">🎙</span>' : ''}
    ${msg.screenKey ? '<span class="screen-tag" title="Includes a screen share">🖥</span>' : ''}
    ${msg.layer ? '<span class="screen-tag" title="Comment — visible to its author and the editors">💬</span>' : ''}
    ${isNew ? '<span class="badge">new</span>' : ''}
    <span class="spacer"></span>
    ${(mine || canEdit()) && depth > 0 ? '<span class="drag-handle" title="Drag onto a word to move where this interjects">⠿</span>' : ''}
    ${msg.words.length || msg.text ? '<button class="copy-btn" title="Copy this message’s transcript">⧉</button>' : ''}
    ${(mine || canEdit()) && msg.transcriptStatus !== 'pending' ? '<button class="retr-btn" title="Transcribe again (uses your language setting)">↻</button>' : ''}
    ${mine || canEdit() ? '<button class="del-btn" title="Delete this message">✕</button>' : ''}`;
  const expr = state.expr && msg.words.length ? exprFor(msg) : null;
  const authorEl = head.querySelector('.author');
  authorEl.textContent = msg.author;
  authorEl.style.color = colorFor(msg.author);
  head.querySelector('.play-btn').onclick = () => playFrom(msg.id, 0);
  const handle = head.querySelector('.drag-handle');
  if (handle) handle.addEventListener('pointerdown', e => startAnchorDrag(e, msg));
  const copyBtn = head.querySelector('.copy-btn');
  if (copyBtn) copyBtn.onclick = async () => {
    await navigator.clipboard.writeText(msg.text || msg.words.map(w => w.w).join(' '));
    showToast('Copied');
  };
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

  // heat strip: the message's timeline down the right edge of its text,
  // painted word by word with its expressiveness color (pauses dark) — drag
  // or tap along it to play from there
  if (expr && exprOn('strip')) {
    const dur = msgDur(msg);
    // continuous: a stop at each word's center, blending in between; only a
    // paragraph-length pause opens a gap
    const stops = [];
    msg.words.forEach((w, i) => {
      const c = (((w.s + w.e) / 2) / dur) * 100;
      if (i === 0 && w.s > 0.4) stops.push(`transparent 0%`, `transparent ${(w.s / dur) * 100}%`);
      if (i > 0 && w.s - msg.words[i - 1].e >= state.parPause) {
        stops.push(`transparent ${(msg.words[i - 1].e / dur) * 100}%`, `transparent ${(w.s / dur) * 100}%`);
      }
      stops.push(`${exprColor(expr[i])} ${c.toFixed(2)}%`);
    });
    const last = msg.words[msg.words.length - 1];
    if (dur - last.e > 0.4) stops.push(`transparent ${(last.e / dur) * 100}%`, 'transparent 100%');
    const strip = document.createElement('div');
    strip.className = 'heat';
    strip.title = 'Brightness: energy · hue: tension · saturation: flow';
    strip.style.backgroundImage = `linear-gradient(180deg, ${stops.join(', ')})`;
    const at = e => {
      const r = strip.getBoundingClientRect();
      return Math.min(Math.max((e.clientY - r.top) / Math.max(r.height, 1), 0), 1) * dur;
    };
    strip.addEventListener('pointerdown', e => {
      e.stopPropagation();
      strip.setPointerCapture(e.pointerId);
      const vt0 = vtOfMsgTime(msg.id, at(e));
      if (vt0 != null) { $('#scrubber').value = vt0; updateTimeLabel(vt0); scrubFocus(vt0); }
      const move = ev => {
        const vt = vtOfMsgTime(msg.id, at(ev));
        if (vt == null) return;
        $('#scrubber').value = vt;
        updateTimeLabel(vt);
        scrubFocus(vt);
      };
      const up = ev => {
        strip.removeEventListener('pointermove', move);
        strip.removeEventListener('pointerup', up);
        clearScrubFocus();
        tapTranscript(msg.id, at(ev));
      };
      strip.addEventListener('pointermove', move);
      strip.addEventListener('pointerup', up);
    });
    card.classList.add('has-heat');
    body.appendChild(strip);
  }

  if (msg.transcriptStatus === 'pending') {
    body.innerHTML = '<span class="muted">Transcribing…</span>';
  } else if (msg.transcriptStatus === 'failed' || msg.transcriptStatus === 'no-key') {
    body.innerHTML = `<span class="muted">(no transcript — <a href="#" class="tap-play">tap to play</a>)</span>`;
    body.querySelector('.tap-play').onclick = e => { e.preventDefault(); playFrom(msg.id, 0); };
  }

  // interleave words with interjections, split at each anchor
  const kids = childrenOf(msg.id);
  let wi = 0;
  // audible silences render as widening dotted gaps (gi = index of the word
  // after the pause). Short ones sit inline; a pause long enough to be a
  // new thought breaks the line and sits on a row of its own, a longer
  // dotted run — the paragraph spacing IS the pause.
  const makeGap = (prevEnd, nextStart, gi) => {
    const gapSec = nextStart - prevEnd;
    if (gapSec < 0.4) return null;
    const g = document.createElement('span');
    const br = gapSec >= state.parPause && gi > 0 && gi < msg.words.length; // edges never break
    g.className = br ? 'gap gap-br' : 'gap';
    g.dataset.mid = msg.id;
    g.dataset.gi = gi;
    g.dataset.t = prevEnd;   // scrub range, same shape as words
    g.dataset.e = nextStart;
    // width grows with the pause; a paragraph gap gets its own row and a longer run
    g.style.width = br
      ? `${Math.round(Math.min(40 + (gapSec - state.parPause) * 30, 160))}px`
      : `${Math.round(Math.min(10 + (gapSec - 0.4) * 26, 56))}px`;
    g.title = `${gapSec.toFixed(1)}s pause`;
    g.onclick = () => tapTranscript(msg.id, prevEnd + 0.01);
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
      if (expr && exprOn('text')) {
        span.classList.add('grad');
        span.style.setProperty('--wg', exprGradient(expr, wi, true));
      }
      if (expr && exprOn('highlight')) {
        span.style.setProperty('--hc', exprColor(expr[wi]));      // solid: the glow
        span.style.setProperty('--hg', exprGradient(expr, wi));   // gradient: the wash
      }
      span.onclick = () => tapTranscript(msg.id, w.s + 0.001);
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
let miniBlocks = [];   // sequential minimap blocks: { t: createdAt, x0, x1 } in [0..1]

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
    // the minimap is sequential, so the window maps through block-space:
    // covered blocks define the creation-time range being kept
    if (!miniBlocks.length || (a <= 0 && b >= 1000)) {
      state.filter.t0 = state.filter.t1 = null;
      $('#win-label').textContent = 'All time';
    } else {
      const af = a / 1000, bf = b / 1000;
      const first = miniBlocks.find(bl => bl.x1 > af + 1e-6);
      const covered = miniBlocks.filter(bl => bl.x0 < bf - 1e-6);
      const last = covered[covered.length - 1];
      if (!first || !last || first.t > last.t) {
        state.filter.t0 = 1; // empty window — nothing qualifies
        state.filter.t1 = 0;
        $('#win-label').textContent = 'Nothing in window';
      } else {
        state.filter.t0 = first.t;
        state.filter.t1 = last.t;
        $('#win-label').textContent = `${fmtT(first.t)} – ${fmtT(last.t)}`;
      }
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

  // minimap: sequential, not wall-clock — clips lay out in creation order,
  // widths proportional to duration, small gaps between. A chat of separated
  // sessions has no dead space; colors are per speaker; the depth slider
  // thins which clips appear. The window slider maps through this
  // block-space back to creation times.
  const box = $('#hist-bars');
  box.innerHTML = '';
  miniBlocks = [];
  {
    const dm = depthMap();
    const visible = state.messages
      .filter(m => (dm.get(m.id) || 0) <= state.filter.depth && layerOk(m))
      .sort((a, b) => a.createdAt - b.createdAt);
    if (visible.length) {
      const GAP = Math.min(0.004, 0.15 / Math.max(visible.length, 1));
      const usable = 1 - GAP * (visible.length - 1);
      const totalDur = visible.reduce((a, m) => a + Math.max(msgDur(m), 1), 0);
      // stacked: each block rides at its reply depth, so bursts of replies
      // rise into towers — the conversation's shape, without dead space
      const laneCount = Math.max(2, Math.min(8,
        1 + Math.max(...visible.map(m => dm.get(m.id) || 0))));
      const laneH = 100 / laneCount;
      let x = 0;
      for (const m of visible) {
        const w = (Math.max(msgDur(m), 1) / totalDur) * usable;
        miniBlocks.push({ t: m.createdAt, x0: x, x1: x + w });
        const el = document.createElement('div');
        el.className = 'mini-block';
        el.style.left = `${x * 100}%`;
        el.style.width = `${Math.max(w * 100, 0.2)}%`;
        const lane = Math.min(dm.get(m.id) || 0, laneCount - 1);
        el.style.bottom = `${lane * laneH}%`;
        el.style.height = `${laneH}%`;
        el.style.background = colorFor(m.author);
        box.appendChild(el);
        x += w + GAP;
      }
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
  // owners already own it — for them it's just a copy
  const forkLabel = state.isOwner ? 'Make a copy of this conversation' : 'Fork — make this conversation yours';
  $('#share-fork').textContent = forkLabel;
  $('#share-fork').classList.toggle('hidden', !canFork);
  $('#share-fork-note').classList.toggle('hidden', !canFork);
  $('#share-fork').onclick = async () => {
    const btn = $('#share-fork');
    btn.disabled = true;
    btn.textContent = state.isOwner ? 'Copying…' : 'Forking…';
    const res = await fetch(`/api/chats/${state.chatId}/fork`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.id) {
      location.href = `/c/${data.id}`;
    } else {
      btn.disabled = false;
      btn.textContent = forkLabel;
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
