/* Dreamer – random-clip video wanderer. Everything runs locally in your browser. */
(() => {
'use strict';
const $ = s => document.querySelector(s);
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

/* ------------------------------------------------------------------ settings */
const DEFAULTS = {
  theme: 'dream',       // app color theme (see THEMES)
  clipSec: 30,          // seconds each clip plays
  sessionMin: 0,        // 0 = unlimited
  maxClips: 0,          // 0 = unlimited
  transition: 'static', // any transition id, or a mix: 'classic' | 'gamer' | 'tvmix' | 'mix3d' | 'random'
  transMs: 1000,
  transSound: true,
  bannerStyle: 'off',   // 'off' | one of BANNERS | 'random'
  bannerSec: 8,         // how long before the switch the "Up Next" banner shows
  bannerSound: true,
  frame: 'clean',       // the set around the video (see FRAMES)
  frameFs: false,       // keep the frame when fullscreen
  filter: 'off',        // screen filter (see FILTERS)
  filterAmt: 2,         // 1 light, 2 medium, 3 strong
  wx: false,            // weather overlay
  wxCorner: 'br',       // tl | tr | bl | br
  wxUnit: /^en-US/i.test(navigator.language || '') ? 'f' : 'c',
  wxStyle: 'compact',   // compact | detailed
  volume: 0.8,
  muted: false,
  fit: 'contain',
  subfolders: true,
  wake: true,
  fadeEnd: true
};
let settings = Object.assign({}, DEFAULTS);
try { Object.assign(settings, JSON.parse(localStorage.getItem('dreamer.settings') || '{}')); } catch (e) {}
const save = () => { try { localStorage.setItem('dreamer.settings', JSON.stringify(settings)); } catch (e) {} };

const VIDEO_EXT = new Set(['mp4','m4v','mov','webm','mkv','avi','ogv','wmv','mpg','mpeg','m2ts','mts','3gp','3g2','flv','asf','divx','vob']);
const isVideoName = n => !n.startsWith('.') && VIDEO_EXT.has((n.split('.').pop() || '').toLowerCase());
const PRELOAD_S = 8;          // start loading the next clip this many seconds before the switch
const FADE_MS = 20000;        // sound fade-out length at the end of a session
const HIST_MAX = 60;          // how many past clips "Previous" can walk back through

/* ------------------------------------------------------------------ state */
const S = {
  lib: [], bag: [], bad: new Map(), lastIdx: -1,
  dirHandle: null, rawFiles: null, rootName: '',
  running: false, paused: false, phase: 'idle',   // idle | transition | playing | ended
  cur: null, clips: 0, sessionMs: 0, lastTick: performance.now(),
  token: 0, prepP: null, prepIsPlan: false, switching: false, lastKind: '', lastBanner: '', wake: null, nextEntry: null,
  hist: [], hi: -1, navOverride: null            // clip history + cursor (powers Previous)
};
const vids = { A: $('#vA'), B: $('#vB') };
let activeKey = 'A';
const activeEl = () => vids[activeKey];
const standbyEl = () => vids[activeKey === 'A' ? 'B' : 'A'];
const stage = $('#stage');

/* ------------------------------------------------------------------ helpers */
function fmt(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = n => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function waitFor(v, ev, ms) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => { cl(); rej(new Error('Timed out waiting for ' + ev)); }, ms);
    const ok = () => { cl(); res(); };
    const bad = () => { cl(); rej(new Error('The browser could not decode this file')); };
    function cl() { clearTimeout(t); v.removeEventListener(ev, ok); v.removeEventListener('error', bad); }
    v.addEventListener(ev, ok); v.addEventListener('error', bad);
  });
}
/* friendly names for on-screen titles: "The_Great_Escape_(1963).mp4" -> "The Great Escape (1963)" */
const titleOf = e => (e && e.name ? String(e.name).replace(/\.[^.]+$/, '').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim() : '') || 'Next video';
const folderLabel = e => {
  if (!e) return 'DREAMER';
  const parts = String(e.path || '').split('/');
  return (parts.length > 1 ? parts[parts.length - 2] : (S.rootName || 'Dreamer')).slice(0, 28);
};

/* ------------------------------------------------------------------ background-proof timers (Web Worker) */
let worker = null; const sleepers = new Map(); let sid = 0;
try {
  const src = `let iv=0;onmessage=e=>{const d=e.data;if(d.cmd==='tick'){clearInterval(iv);iv=setInterval(()=>postMessage({type:'tick'}),d.ms)}else if(d.cmd==='sleep'){setTimeout(()=>postMessage({type:'wake',id:d.id}),d.ms)}}`;
  worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  worker.onmessage = e => {
    if (e.data.type === 'tick') tick();
    else if (e.data.type === 'wake') { const r = sleepers.get(e.data.id); sleepers.delete(e.data.id); r && r(); }
  };
  worker.postMessage({ cmd: 'tick', ms: 250 });
} catch (e) { worker = null; setInterval(() => tick(), 250); }
function sleep(ms) {
  return new Promise(res => {
    if (!worker) return void setTimeout(res, ms);
    const id = ++sid; sleepers.set(id, res); worker.postMessage({ cmd: 'sleep', id, ms });
  });
}

/* ------------------------------------------------------------------ remember the folder (IndexedDB) */
const DB = {
  open() { return new Promise((res, rej) => { const r = indexedDB.open('dreamer', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  async get(k) { const db = await this.open(); return new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); },
  async set(k, v) { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); }
};

/* ------------------------------------------------------------------ folder scanning */
async function walk(dir, path, out, depthOK) {
  for await (const [name, h] of dir.entries()) {
    if (name.startsWith('.')) continue;
    if (h.kind === 'file') {
      if (isVideoName(name)) { out.push({ handle: h, name, path: path + name }); if (out.length % 40 === 0) setFolderInfo(`Scanning… found ${out.length} videos`); }
    } else if (depthOK) {
      await walk(h, path + name + '/', out, true);
    }
  }
}
async function rescan() {
  S.lib = []; S.bag = []; S.bad = new Map(); S.lastIdx = -1; S.hist = []; S.hi = -1; S.navOverride = null;
  renderSkipped();
  setFolderInfo('Scanning…');
  try {
    if (S.dirHandle) {
      const out = [];
      await walk(S.dirHandle, '', out, settings.subfolders);
      S.lib = out; S.rootName = S.dirHandle.name;
    } else if (S.rawFiles) {
      S.lib = S.rawFiles.filter(f => {
        if (!isVideoName(f.name)) return false;
        return settings.subfolders || f.path.split('/').length <= 2;
      });
    }
  } catch (e) {
    console.error(e);
    setFolderInfo('Could not read that folder: ' + (e.message || e));
  }
  setFolderInfo();
  ui();
}
function setFolderInfo(msg) {
  const el = $('#folderInfo');
  if (msg) { el.textContent = msg; return; }
  if (!S.dirHandle && !S.rawFiles) { el.textContent = 'No folder chosen yet.'; return; }
  const n = S.lib.length;
  el.innerHTML = `<b>${escapeHtml(S.rootName || 'Folder')}</b><br>${n} video${n === 1 ? '' : 's'} found${settings.subfolders ? ' (including subfolders)' : ''}.` +
    (n === 0 ? '<br>Nothing playable here. Try another folder?' : '');
}
const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function chooseFolder() {
  if (window.showDirectoryPicker) {
    try {
      const h = await window.showDirectoryPicker({ id: 'dreamer', mode: 'read' });
      await useHandle(h);
    } catch (e) { if (e.name !== 'AbortError') { console.error(e); $('#fallbackPicker').click(); } }
  } else {
    $('#fallbackPicker').click();
  }
}
async function useHandle(h) {
  S.dirHandle = h; S.rawFiles = null; S.rootName = h.name;
  try { await DB.set('dir', h); } catch (e) { console.warn('Could not remember folder', e); }
  $('#btnReconnect').hidden = true;
  await rescan();
}
$('#fallbackPicker').addEventListener('change', async e => {
  const files = [...e.target.files];
  if (!files.length) return;
  S.dirHandle = null;
  S.rawFiles = files.map(f => ({ file: f, name: f.name, path: f.webkitRelativePath || f.name }));
  S.rootName = (files[0].webkitRelativePath || '').split('/')[0] || 'Folder';
  e.target.value = '';
  await rescan();
});
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', async e => {
  e.preventDefault();
  for (const item of e.dataTransfer.items || []) {
    if (item.getAsFileSystemHandle) {
      const h = await item.getAsFileSystemHandle();
      if (h && h.kind === 'directory') { await useHandle(h); return; }
    }
  }
});
async function getFile(entry) { return entry.file || entry.handle.getFile(); }

/* ------------------------------------------------------------------ picking + preparing clips */
function goodCount() { return S.lib.length - S.bad.size; }
function pickEntry() {
  if (!goodCount()) return null;
  for (let guard = 0; guard < S.lib.length * 3 + 10; guard++) {
    if (!S.bag.length) S.bag = shuffle(S.lib.map((_, i) => i));
    const i = S.bag.pop();
    const e = S.lib[i];
    if (S.bad.has(e)) continue;
    if (i === S.lastIdx && goodCount() > 1) { S.bag = []; continue; }
    S.lastIdx = i;
    return e;
  }
  return null;
}
function randomStart(dur) {
  const len = Math.min(settings.clipSec, dur);
  const max = Math.max(0, dur - len - 0.5);
  return Math.random() * max;
}
function releaseVideo(v) {
  try { v.pause(); } catch (e) {}
  v.classList.remove('on');
  v.removeAttribute('src');
  try { v.load(); } catch (e) {}
  if (v._url) { URL.revokeObjectURL(v._url); v._url = null; }
}
function markBad(entry, err) {
  S.bad.set(entry, err && err.message ? err.message : 'Unplayable');
  renderSkipped();
}
/* where does "next" lead? Forward through history if you stepped back, otherwise a fresh random clip */
const atTip = () => S.hi >= S.hist.length - 1;
function planNext() {
  if (S.hi >= 0 && S.hi < S.hist.length - 1) { const h = S.hist[S.hi + 1]; return { entry: h.entry, start: h.start, hi: S.hi + 1 }; }
  return null;
}
async function prepare() {
  const token = S.token;
  const v = standbyEl();
  let plan = S.navOverride || planNext(); S.navOverride = null;
  for (let tries = 0; tries < 15; tries++) {
    if (token !== S.token) throw new Error('cancelled');
    let entry, forcedStart = null, hi = null;
    if (plan) { entry = plan.entry; forcedStart = plan.start; hi = plan.hi; plan = null; S.prepIsPlan = true; }
    else { entry = pickEntry(); S.prepIsPlan = false; }
    if (!entry) throw new Error('No playable videos found');
    S.nextEntry = entry;     // known right away, so banners / TV-guide transitions can show the real title
    releaseVideo(v);
    try {
      const file = await getFile(entry);
      v._url = URL.createObjectURL(file);
      v.muted = true;
      v.src = v._url; v.load();
      await waitFor(v, 'loadedmetadata', 20000);
      if (token !== S.token) throw new Error('cancelled');
      if (!v.videoWidth || !isFinite(v.duration) || v.duration <= 0) throw new Error('No video track in this file');
      const dur = v.duration, start = forcedStart != null ? clamp(forcedStart, 0, Math.max(0, dur - 0.6)) : randomStart(dur);
      if (start > 0.3) { const p = waitFor(v, 'seeked', 20000); v.currentTime = start; await p; }
      if (v.readyState < 2) await waitFor(v, 'loadeddata', 20000);
      if (token !== S.token) throw new Error('cancelled');
      return { el: v, entry, start: v.currentTime || start, dur, hi };
    } catch (err) {
      if (token !== S.token) throw err;
      markBad(entry, err);
    }
  }
  throw new Error('Too many unplayable files in a row');
}
function ensurePrep() {
  if (!S.prepP) { const p = prepare(); S.prepP = p; p.catch(() => {}); }
  return S.prepP;
}
/* throw away a pre-loaded "next" clip (used when you press Previous) and put its pick back in the shuffle bag */
function discardPrep() {
  if (!S.prepP && !S.nextEntry) return;
  const e = S.nextEntry, wasPlan = S.prepIsPlan;
  S.token++; S.prepP = null; S.nextEntry = null;
  if (e && !wasPlan) { const i = S.lib.indexOf(e); if (i >= 0) { S.bag.push(i); S.lastIdx = -1; } }
  releaseVideo(standbyEl());
}
/* the last clip of a limited session = we're at the newest clip and the count is used up */
function isLast() { return settings.maxClips > 0 && S.clips >= settings.maxClips && atTip(); }

/* ------------------------------------------------------------------ session control */
function playEl(v) {
  const p = v.play();
  if (p && p.catch) p.catch(err => { if (err && err.name === 'NotAllowedError') $('#tapResume').hidden = false; });
}
function startClip(prep) {
  banner.stop();
  const old = activeEl();
  activeKey = prep.el === vids.A ? 'A' : 'B';
  if (old !== prep.el) releaseVideo(old);
  prep.el.classList.add('on');
  S.nextEntry = null;
  if (prep.hi != null) S.hi = prep.hi;               // revisiting a clip from history: doesn't use up your clip count
  else {
    S.hist.length = Math.max(0, S.hi + 1);           // a brand-new clip ends any "forward" history
    S.hist.push({ entry: prep.entry, start: prep.start });
    if (S.hist.length > HIST_MAX) S.hist.shift();
    S.hi = S.hist.length - 1; S.clips++;
  }
  S.cur = { el: prep.el, entry: prep.entry, start: prep.start, dur: prep.dur, wall: 0, lastT: prep.start, stall: 0, bannerDone: false };
  applyVolume();
  if (!S.paused) playEl(prep.el);
  mediaSession();
}
async function doSwitch() {
  if (S.switching || !S.running) return;
  S.switching = true;
  const token = S.token;
  S.phase = 'transition'; stage.classList.add('inTrans');
  banner.close();
  if (S.cur) try { S.cur.el.pause(); } catch (e) {}
  const kind = pickKind();
  const ms = kind === 'cut' ? 0 : Math.max(settings.transMs, MIN_MS[kind] || 0);
  const prev = S.cur ? S.cur.entry : null;
  ensurePrep();   // picks the next video right now, so TV-guide / 3D transitions can show its real title
  const info = { next: () => S.nextEntry, prev, lib: S.lib, root: S.rootName };
  if (D3.includes(kind)) t3.begin(kind, ms, S.clips + 1, info); else fx.begin(kind, ms, S.clips + 1, info);
  playTransitionSound(kind, ms);
  const t0 = performance.now();
  let prep = null, errMsg = '';
  try { prep = await ensurePrep(); } catch (e) { errMsg = e.message; }
  S.prepP = null;
  if (token !== S.token) { S.switching = false; return; }
  const wait = ms - (performance.now() - t0);
  if (wait > 0) await sleep(wait);
  if (token !== S.token) { S.switching = false; return; }
  S.switching = false;
  if (!prep) { fx.kill(); t3.kill(); endSession('error', errMsg); return; }
  startClip(prep);
  S.phase = 'playing'; stage.classList.remove('inTrans');
  fx.end(); t3.end();
  ui();
}
function pickKind() {
  let k = settings.transition;
  if (k === 'random' || k === 'gamer' || k === 'tvmix' || k === 'classic' || k === 'mix3d') {
    const pool = (k === 'gamer' ? GAME : k === 'tvmix' ? GUIDE : k === 'classic' ? CLASSIC : k === 'mix3d' ? D3 : CLASSIC.concat(GAME, GUIDE, D3)).filter(x => x !== S.lastKind);
    k = pool[Math.floor(Math.random() * pool.length)];
  }
  S.lastKind = k;
  return k;
}
/* auto-advance and the Next button */
function advance() {
  if (isLast()) endSession('count'); else doSwitch();
}
/* Previous: step back through the clips you've already seen, restarting at the same spot. At the very first clip it restarts it. */
function goPrev() {
  if (!S.running || S.phase !== 'playing' || !S.cur) return;
  const i = S.hi > 0 ? S.hi - 1 : Math.max(0, S.hi), h = S.hist[i];
  if (!h) return;
  discardPrep();
  S.navOverride = { entry: h.entry, start: h.start, hi: i };
  doSwitch();
}
async function startSession() {
  if (!S.lib.length) { chooseFolder(); return; }
  initAudio();
  banner.stop();
  S.token++; S.prepP = null; S.switching = false;
  S.running = true; S.paused = false; S.clips = 0; S.sessionMs = 0; S.cur = null; S.nextEntry = null; S.lastTick = performance.now();
  S.hist = []; S.hi = -1; S.navOverride = null;
  $('#idle').hidden = true; $('#endCard').hidden = true; $('#tapResume').hidden = true;
  acquireWake();
  ui();
  doSwitch();
}
function teardown() {
  S.token++; S.prepP = null; S.switching = false; S.cur = null; S.nextEntry = null; S.navOverride = null;
  banner.stop(); stage.classList.remove('inTrans');
  releaseVideo(vids.A); releaseVideo(vids.B);
  fx.kill(); t3.kill();
  releaseWake();
  if ('mediaSession' in navigator) { try { navigator.mediaSession.metadata = null; } catch (e) {} }
  document.title = 'Dreamer';
}
function stopSession() {
  if (!S.running) return;
  S.running = false; S.paused = false; S.phase = 'idle';
  teardown();
  $('#tapResume').hidden = true; $('#endCard').hidden = true; $('#idle').hidden = false;
  ui();
}
function endSession(reason, detail) {
  if (!S.running) return;
  const clips = S.clips, time = fmt(S.sessionMs / 1000);
  S.running = false; S.paused = false; S.phase = 'ended';
  teardown();
  $('#tapResume').hidden = true;
  let msg;
  if (reason === 'error') msg = `Dreamer couldn't play any of these files (${detail || 'unsupported formats'}). Try MP4 (H.264) or WebM.`;
  else msg = `Sweet dreams. ${clips} clip${clips === 1 ? '' : 's'} over ${time}.`;
  $('#endText').textContent = msg;
  $('#endCard').hidden = false;
  ui();
}
function flashPause(paused) {
  const o = $('#osdPause'); o.textContent = paused ? '❚❚' : '▶';
  o.classList.remove('show'); void o.offsetWidth; o.classList.add('show');
}
function togglePause() {
  if (!S.running) { startSession(); return; }
  S.paused = !S.paused;
  const v = S.cur && S.cur.el;
  if (S.phase === 'playing' && v) { if (S.paused) v.pause(); else playEl(v); }
  flashPause(S.paused);
  ui();
}
function skip() { if (S.running && S.phase === 'playing') advance(); }

/* ------------------------------------------------------------------ the heartbeat */
function fadeFactor() {
  if (!settings.fadeEnd || !S.running) return 1;
  let f = 1;
  if (settings.sessionMin > 0) {
    const rem = settings.sessionMin * 60000 - S.sessionMs;
    f = Math.min(f, clamp(rem / FADE_MS, 0, 1));
  }
  if (isLast() && S.cur && S.phase === 'playing') {
    const rem = (settings.clipSec - (S.cur.el.currentTime - S.cur.start)) * 1000;
    f = Math.min(f, clamp(rem / Math.min(FADE_MS, settings.clipSec * 1000), 0, 1));
  }
  return f;
}
function applyVolume() {
  const vol = settings.muted ? 0 : clamp(settings.volume * fadeFactor(), 0, 1);
  for (const v of [vids.A, vids.B]) {
    if (v === standbyEl() && S.phase !== 'transition' && S.phase !== 'idle') { v.muted = true; continue; }
    v.muted = settings.muted; v.volume = vol;
  }
}
function bannerLead() { return Math.max(2, Math.min(settings.bannerSec, settings.clipSec * 0.7)); }
function tick() {
  const now = performance.now();
  const dt = Math.min(now - S.lastTick, 2000);
  S.lastTick = now;
  weatherMaybeRefresh();
  if (!S.running) return;
  if (S.paused) { ui(); return; }
  S.sessionMs += dt;
  const lim = settings.sessionMin * 60000;
  if (lim && S.sessionMs >= lim) { endSession('time'); return; }
  if (S.phase === 'playing' && S.cur) {
    const c = S.cur, v = c.el;
    if (!v.paused) c.wall += dt;
    if (v.currentTime === c.lastT && !v.paused && !v.ended) c.stall += dt; else { c.stall = 0; c.lastT = v.currentTime; }
    const elapsed = v.currentTime - c.start, remain = settings.clipSec - elapsed;
    const left = Math.min(remain, c.dur - v.currentTime), lead = bannerLead();
    const wantBanner = settings.bannerStyle !== 'off';
    if (remain <= Math.max(PRELOAD_S, wantBanner ? lead + 1.5 : 0) && !S.prepP && !isLast()) ensurePrep();
    if (wantBanner && !c.bannerDone && !banner.active && !isLast() && S.nextEntry && elapsed >= 0.8 && left <= lead &&
        (!lim || (lim - S.sessionMs) / 1000 > left + 0.5)) { c.bannerDone = true; showBanner(); }
    if (elapsed >= settings.clipSec || v.ended || c.wall >= settings.clipSec * 1000 + 6000 || c.stall > 15000) advance();
  }
  applyVolume();
  ui();
}

/* ------------------------------------------------------------------ transitions: visuals */
const CLASSIC = ['static', 'flicker', 'bars', 'dream', 'fade', 'roll', 'bluescreen', 'tuner', 'degauss', 'testcard', 'rewind'];
const GAME = ['glitch', 'pixel', 'crt', 'matrix', 'loading', 'coin', 'synth', 'warp', 'pong', 'iris'];
const GUIDE = ['guide', 'surf', 'upnext', 'teletext', 'standby'];
const D3 = ['remote', 'clap', 'title3d', 'dice', 'cube', 'flip', 'shatter', 'tunnel'];   // built in the 3D section further down
const MIN_MS = { guide: 3000, surf: 2400, upnext: 2600, teletext: 3200, standby: 2600,
  roll: 1200, bluescreen: 1500, tuner: 1800, degauss: 1200, testcard: 1800, rewind: 1500 };   // long enough to actually read / enjoy
const REVEAL = new Set(['pixel', 'iris', 'crt']);   // these cut "holes" so the picture shows through while they play
const TIPS = ['Reticulating splines…', 'Feeding the hamsters…', 'Rolling for initiative…', 'Defragmenting your dreams…', 'Blowing on the cartridge…',
  'Untangling the joystick…', 'Warming up the flux capacitor…', 'Asking the NPC for directions…', 'Saving your progress (jk)…', 'Convincing pixels to cooperate…',
  'Locating the secret level…', 'Charging the Hadouken…', 'Buffering destiny…', 'Respawning the popcorn…'];
const fx = (() => {
  const c = $('#fx'), g = c.getContext('2d'), W = c.width, H = c.height;
  const img = g.createImageData(W, H), buf = new Uint32Array(img.data.buffer);
  const nc = document.createElement('canvas'); nc.width = W; nc.height = H;
  const ng = nc.getContext('2d'), nimg = ng.createImageData(W, H), nbuf = new Uint32Array(nimg.data.buffer);
  const stars = Array.from({ length: 60 }, () => ({ x: Math.random() * W, y: Math.random() * H, p: Math.random() * 6, r: 0.6 + Math.random() * 1.6 }));
  const R = Math.random;
  let info = null, tkFlips = 3, raf = 0, kind = 'cut', active = false, mode = 'in', t0 = 0, outT0 = 0, ms = 1000, hideT = 0, level = 1, outMs = 450;
  let flick = { until: 0, level: 0 }, drops = [], lastStep = 0, wst = [], order = [], pcol = [], tip = '';
  const BARS = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
  const PAL = ['#fc0d1b', '#00a8f3', '#fcbc3c', '#58d854', '#f83800', '#b53cf8', '#ffffff', '#0058f8'];
  const GW = 32, GH = 18, CW = W / GW, CH = H / GH;
  const ease = x => 1 - Math.pow(1 - x, 3);
  const lerp = (a, b, t) => a + (b - a) * t;
  const tri = x => { const u = ((x % 2) + 2) % 2; return u < 1 ? u : 2 - u; };

  function noise(alpha) { const a = alpha << 24; for (let i = 0; i < buf.length; i++) { const v = (R() * 256) | 0; buf[i] = a | (v << 16) | (v << 8) | v; } }
  function noiseLayer(alpha) { const a = alpha << 24; for (let i = 0; i < nbuf.length; i++) { const v = (R() * 256) | 0; nbuf[i] = a | (v << 16) | (v << 8) | v; } ng.putImageData(nimg, 0, 0); g.drawImage(nc, 0, 0); }
  function scan(alpha) { g.fillStyle = `rgba(0,0,0,${alpha})`; for (let y = 0; y < H; y += 2) g.fillRect(0, y, W, 1); }
  function text(s, x, y, size, col, align = 'center') { g.font = `bold ${size}px monospace`; g.textAlign = align; g.textBaseline = 'middle'; g.fillStyle = col; g.fillText(s, x, y); }

  const DRAW = {
    /* ---------- classic TV ---------- */
    static(t) {
      noise(255); g.putImageData(img, 0, 0);
      const y = ((t * 1000 / 5) % (H + 50)) - 25; g.fillStyle = 'rgba(255,255,255,.14)'; g.fillRect(0, y, W, 16);
      if (R() < .25) { const ty = (R() * H) | 0; g.drawImage(c, 0, ty, W, 6, (R() * 30 - 15) | 0, ty, W, 6); }
      scan(.22);
    },
    flicker() {
      const ts = performance.now();
      if (ts > flick.until) { const levels = [0, 0, 0, 8, 25, 70, 150, 235, 255]; flick = { until: ts + 35 + R() * 90, level: levels[(R() * levels.length) | 0] }; }
      const l = flick.level; g.fillStyle = `rgb(${l},${l},${Math.min(255, l + 12)})`; g.fillRect(0, 0, W, H);
      for (let i = 0; i < 5; i++) { g.fillStyle = `rgba(255,255,255,${R() * .25})`; g.fillRect(0, (R() * H) | 0, W, 1 + (R() * 3 | 0)); }
      scan(.12);
    },
    bars(t) {
      const bw = W / 7, th = H * .68;
      BARS.forEach((col, i) => { g.fillStyle = col; g.fillRect(i * bw, 0, bw + 1, th); });
      for (let i = 0; i < 7; i++) { g.fillStyle = ['#0000c0', '#131313', '#c000c0', '#131313', '#00c0c0', '#131313', '#c0c0c0'][i]; g.fillRect(i * bw, th, bw + 1, H * .1); }
      const bw2 = W / 6; ['#00214c', '#ffffff', '#32006a', '#131313', '#090909', '#1d1d1d'].forEach((col, i) => { g.fillStyle = col; g.fillRect(i * bw2, th + H * .1, bw2 + 1, H); });
      g.fillStyle = '#000'; g.fillRect(W / 2 - 50, H / 2 - 12, 100, 24);
      text('NO SIGNAL', W / 2, H / 2 + 1, 14, (Math.floor(t * 4) % 2) ? '#fff' : '#bbb');
      noiseLayer(70);
      if (R() < .3) { const ty = (R() * H) | 0; g.drawImage(c, 0, ty, W, 4, (R() * 16 - 8) | 0, ty, W, 4); }
      scan(.18);
    },
    dream(t) {
      g.globalCompositeOperation = 'source-over'; g.fillStyle = '#0b0820'; g.fillRect(0, 0, W, H);
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 4; i++) {
        const x = W / 2 + Math.cos(t * (.8 + i * .3) + i * 2) * W * .3, y = H / 2 + Math.sin(t * (.9 + i * .25) + i) * H * .3;
        const gr = g.createRadialGradient(x, y, 0, x, y, H * .75);
        gr.addColorStop(0, `hsla(${(t * 40 + i * 70) % 360},80%,60%,.55)`); gr.addColorStop(1, 'transparent');
        g.fillStyle = gr; g.fillRect(0, 0, W, H);
      }
      for (const s of stars) { g.fillStyle = `rgba(255,255,255,${.4 + .6 * Math.abs(Math.sin(t * 2 + s.p))})`; g.beginPath(); g.arc(s.x, s.y, s.r, 0, 7); g.fill(); }
      g.globalCompositeOperation = 'source-over';
    },
    fade() { g.fillStyle = '#000'; g.fillRect(0, 0, W, H); },

    /* ---------- more classic TV ---------- */
    roll(t, a) {            // vertical hold lost: the picture rolls past with a black bar between frames
      const Hp = H + 18, speed = 300 * (1 - .55 * a.p), off = (t * speed) % Hp;
      g.fillStyle = '#05050a'; g.fillRect(0, 0, W, H);
      const frameAt = y0 => {
        const jx = Math.sin(y0 * .08 + t * 30) * 3;
        g.save(); g.translate(jx, 0);
        const bw = W / 7; BARS.forEach((col, i) => { g.globalAlpha = .75; g.fillStyle = col; g.fillRect(i * bw, y0, bw + 1, H * .62); });
        g.globalAlpha = 1;
        for (let i = 0; i < 8; i++) { const v = 30 + i * 30; g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(i * W / 8, y0 + H * .62, W / 8 + 1, H * .26); }
        g.fillStyle = '#000'; g.fillRect(0, y0 + H * .88, W, H * .12 + 1);
        text('CH 07', W / 2, y0 + H * .94, 10, '#39ff14');
        g.restore();
        g.fillStyle = '#000'; g.fillRect(0, y0 + H, W, 18);              // the vertical-blanking bar
        g.fillStyle = 'rgba(255,255,255,.35)'; g.fillRect(0, y0 + H + 18, W, 2);
      };
      frameAt(off - Hp); frameAt(off);
      noiseLayer(34);
      scan(.2);
    },
    bluescreen(t) {         // VCR "no signal" blue with a bouncing logo
      g.fillStyle = '#0a1fd6'; g.fillRect(0, 0, W, H);
      noiseLayer(22);
      const bw = 88, bh = 34, ux = t * .55 + .13, uy = t * .37 + .31;
      const x = lerp(8, W - 8 - bw, tri(ux)), y = lerp(24, H - 40 - bh, tri(uy)), hue = ((Math.floor(ux) + Math.floor(uy)) * 67) % 360;
      g.fillStyle = `hsl(${hue},85%,58%)`; g.fillRect(x, y, bw, bh); g.fillStyle = '#fff'; g.fillRect(x + 3, y + 3, bw - 6, 2);
      text('DREAMER', x + bw / 2, y + bh / 2 + 1, 13, '#0a0a30');
      text('AV 1', 14, 14, 11, '#fff', 'left'); text('▶', W - 20, 14, 11, '#fff', 'right');
      text('NO SIGNAL', W / 2, H - 26, 11, '#fff'); text('CHECK ANTENNA / INPUT', W / 2, H - 12, 7, 'rgba(255,255,255,.75)');
      if (R() < .12) { g.fillStyle = 'rgba(255,255,255,.18)'; g.fillRect(0, (R() * H) | 0, W, 2); }
      scan(.14);
    },
    tuner(t, a) {           // analog tuning: static clears into a picture while a dial bar sweeps
      const p = a.p, sp = p * p * (3 - 2 * p);
      g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
      const bw = W / 7; g.globalAlpha = .06 + .55 * sp; BARS.forEach((col, i) => { g.fillStyle = col; g.fillRect(i * bw, 0, bw + 1, H * .75); }); g.globalAlpha = 1;
      noiseLayer(Math.max(30, Math.round(235 * (1 - .82 * sp))));
      if (p < .75 && R() < .35) { const ty = (R() * H) | 0, h = 3 + (R() * 10 | 0); g.drawImage(c, 0, ty, W, h, (R() * 40 - 20) | 0, ty, W, h); }
      const locked = p > .86, ch = 2 + Math.min(5, Math.floor(p * 6));
      const OSD = (s, x, y, sz, col, al) => { text(s, x + 1, y + 1, sz, '#000', al); text(s, x, y, sz, col, al); };
      OSD('CH ' + String(ch).padStart(2, '0'), W - 14, 18, 18, '#39ff14', 'right');
      const bx0 = 40, bx1 = W - 40, by = H - 28; g.fillStyle = 'rgba(0,0,0,.65)'; g.fillRect(bx0 - 10, by - 16, bx1 - bx0 + 20, 34);
      for (let x = bx0; x <= bx1; x += 6) { g.fillStyle = '#e8e8e8'; g.fillRect(x, by - 3, 1, ((x - bx0) % 30 === 0) ? 11 : 5); }
      const px = lerp(bx0 + 4, bx1 - 4, sp) + Math.sin(t * 9) * (1 - sp) * 16;
      g.fillStyle = locked ? '#39ff14' : '#ffe14a'; g.beginPath(); g.moveTo(px, by - 6); g.lineTo(px - 5, by - 15); g.lineTo(px + 5, by - 15); g.closePath(); g.fill(); g.fillRect(px - 1, by - 6, 2, 16);
      OSD(locked ? 'LOCKED' : 'TUNING' + '.'.repeat(1 + Math.floor(t * 4) % 3), W / 2, by + 11, 8, locked ? '#39ff14' : '#fff');
      scan(.15);
    },
    degauss(t, a) {         // the big "BOOONG" colour wobble when a CRT degausses
      const e = Math.exp(-t * 2.8);
      g.fillStyle = '#040408'; g.fillRect(0, 0, W, H);
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 6; i++) {
        const cx = W / 2 + Math.sin(t * 24 + i * 1.7) * 26 * e, cy = H / 2 + Math.cos(t * 20 + i * 2.1) * 14 * e, r = 36 + i * 30 + Math.sin(t * 15 + i) * 18 * e;
        const gr = g.createRadialGradient(cx, cy, r * .45, cx, cy, r);
        gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(.72, `hsla(${(i * 62 + t * 120) % 360},95%,58%,${.12 + .5 * e})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = gr; g.fillRect(0, 0, W, H);
      }
      for (let x = 0; x < W; x += 8) { g.fillStyle = `hsla(${(x * 1.7 + t * 420) % 360},90%,55%,${.06 + .22 * e})`; g.fillRect(x + Math.sin(t * 34 + x * .09) * 9 * e, 0, 5, H); }
      g.globalCompositeOperation = 'source-over';
      if (a.p > .82) { g.fillStyle = `rgba(0,0,0,${(a.p - .82) / .18 * .6})`; g.fillRect(0, 0, W, H); }
      noiseLayer(18); scan(.16);
    },
    testcard(t, a) {        // vintage test pattern
      g.fillStyle = '#505058'; g.fillRect(0, 0, W, H);
      g.strokeStyle = 'rgba(255,255,255,.7)'; g.lineWidth = 1; g.beginPath();
      for (let x = 0; x <= W; x += W / 16) { g.moveTo(Math.round(x) + .5, 0); g.lineTo(Math.round(x) + .5, H); }
      for (let y = 0; y <= H; y += H / 9) { g.moveTo(0, Math.round(y) + .5); g.lineTo(W, Math.round(y) + .5); }
      g.stroke();
      g.lineWidth = 2; g.strokeStyle = '#fff'; g.beginPath(); g.arc(W / 2, H / 2, 72, 0, 7); g.stroke();
      g.lineWidth = 1; g.beginPath(); g.moveTo(W / 2 - 72, H / 2); g.lineTo(W / 2 + 72, H / 2); g.moveTo(W / 2, H / 2 - 72); g.lineTo(W / 2, H / 2 + 72); g.moveTo(W / 2 - 51, H / 2 - 51); g.lineTo(W / 2 + 51, H / 2 + 51); g.moveTo(W / 2 + 51, H / 2 - 51); g.lineTo(W / 2 - 51, H / 2 + 51); g.stroke();
      const bw = (W - 40) / 7; BARS.forEach((col, i) => { g.fillStyle = col; g.fillRect(20 + i * bw, 12, bw, 26); });
      for (let i = 0; i < 9; i++) { const v = i * 31; g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(20 + i * (W - 40) / 9, H - 38, (W - 40) / 9 + 1, 26); }
      [[0, 0], [W - 20, 0], [0, H - 20], [W - 20, H - 20]].forEach(([x, y], i) => { g.fillStyle = i % 3 ? '#000' : '#fff'; g.fillRect(x, y, 20, 20); });
      g.fillStyle = '#000'; g.fillRect(W / 2 - 52, H / 2 - 16, 104, 32); g.strokeStyle = '#fff'; g.strokeRect(W / 2 - 52, H / 2 - 16, 104, 32);
      text('DREAMER', W / 2, H / 2 - 5, 13, '#fff'); text('TEST CARD · CH 0' + (1 + Math.floor(a.p * 6)), W / 2, H / 2 + 9, 7, '#ffe14a');
      if (R() < .1) { g.fillStyle = 'rgba(255,255,255,.12)'; g.fillRect(0, 0, W, H); }
      noiseLayer(14); scan(.13);
    },
    rewind(t, a) {          // VCR rewind: noise bands racing up the screen
      g.fillStyle = '#0d0d1a'; g.fillRect(0, 0, W, H);
      const bw = W / 7; g.globalAlpha = .22; BARS.forEach((col, i) => { g.fillStyle = col; g.fillRect(i * bw + Math.sin(t * 9 + i) * 3, 0, bw + 1, H); }); g.globalAlpha = 1;
      noiseLayer(55);
      for (let i = 0; i < 7; i++) {
        const h = 12 + (i * 17) % 26, y = H - ((t * (170 + i * 14) + i * 61) % (H + 50)) + 10, jx = (R() - .5) * 26;
        g.save(); g.translate(jx, 0);
        for (let k = 0; k < 6; k++) { g.fillStyle = `rgba(255,255,255,${.1 + R() * .42})`; g.fillRect(R() * W * .5, y + (R() * h | 0), W * (.3 + R() * .7), 1 + (R() * 3 | 0)); }
        g.restore();
      }
      const OSD = (s, x, y, sz, col, al) => { text(s, x + 1, y + 1, sz, '#000', al); text(s, x, y, sz, col, al); };
      const secs = Math.max(0, 3599 - Math.floor(t * 410)), mm = String(Math.floor(secs / 60) % 60).padStart(2, '0'), ss = String(secs % 60).padStart(2, '0');
      OSD('◀◀ REW', 14, 16, 14, '#39ff14', 'left'); OSD('0:' + mm + ':' + ss, 14, 36, 10, '#39ff14', 'left'); OSD('SP', W - 14, 16, 10, '#39ff14', 'right');
      scan(.15);
    },

    /* ---------- gamer pack ---------- */
    glitch() {
      if (R() < .55) { g.fillStyle = '#07070f'; g.fillRect(0, 0, W, H); }
      const cols = ['#00ffff', '#ff00ff', '#ffffff', '#000000', '#ff2d55', '#39ff14'];
      const n = 4 + (R() * 10 | 0);
      for (let i = 0; i < n; i++) {
        const y = (R() * H) | 0, h = 2 + (R() * 22 | 0), w = W * (.2 + R() * .8), x = R() * (W - w);
        g.globalAlpha = .5 + R() * .5; g.fillStyle = cols[(R() * cols.length) | 0]; g.fillRect(x, y, w, h); g.globalAlpha = 1;
        if (R() < .5) g.drawImage(c, 0, y, W, h, (R() * 60 - 30) | 0, y, W, h);
      }
      for (let i = 0; i < 7; i++) { g.fillStyle = cols[(R() * cols.length) | 0]; const s = 4 + R() * 10; g.fillRect(R() * W, R() * H, s, s); }
      if (R() < .6) {
        const j = () => (R() * 4 - 2);
        text('SYSTEM ERROR', W / 2 + j() - 2, H / 2 + j(), 20, '#00ffff'); text('SYSTEM ERROR', W / 2 + j() + 2, H / 2 + j(), 20, '#ff00ff'); text('SYSTEM ERROR', W / 2, H / 2, 20, '#fff');
        text('0x00DEAD', W / 2, H / 2 + 18, 9, '#fff');
      }
      scan(.2);
    },
    pixel(t, a) {
      g.clearRect(0, 0, W, H);
      const frac = mode === 'out' ? 1 - ease(a.q) : ease(a.a);
      const n = Math.floor(frac * order.length);
      for (let i = 0; i < n; i++) { const k = order[i]; g.fillStyle = pcol[k]; g.fillRect((k % GW) * CW, ((k / GW) | 0) * CH, CW + .5, CH + .5); }
      if (mode === 'in' && frac >= 1) for (let i = 0; i < 14; i++) pcol[(R() * pcol.length) | 0] = PAL[(R() * PAL.length) | 0];
    },
    crt(t, a) {
      const s = mode === 'out' ? 1 - ease(1 - a.q) : ease(a.a);      // 0 = picture on, 1 = fully off
      const o = 1 - s;
      let w = W, h = H;
      if (o > .35) h = Math.max(2, ((o - .35) / .65) * H); else { h = 2; w = Math.max(3, (o / .35) * W); }
      g.globalCompositeOperation = 'source-over';
      g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
      g.globalCompositeOperation = 'destination-out'; g.fillRect((W - w) / 2, (H - h) / 2, w, h);
      g.globalCompositeOperation = 'source-over';
      if (h <= 4) { g.fillStyle = `rgba(255,255,255,${o > .02 ? 1 : .55 + .4 * Math.sin(t * 20)})`; g.fillRect((W - w) / 2, (H - h) / 2 - 1, w, 3); }
      else if (h < H * .25) { g.fillStyle = 'rgba(255,255,255,.35)'; g.fillRect((W - w) / 2, (H - h) / 2, w, h); }
    },
    matrix(t, a, ts) {
      g.fillStyle = 'rgba(0,0,0,.17)'; g.fillRect(0, 0, W, H);
      const step = ts - lastStep > 45; if (step) lastStep = ts;
      g.font = '8px monospace'; g.textAlign = 'left'; g.textBaseline = 'top';
      for (let i = 0; i < drops.length; i++) {
        const x = i * 8, y = drops[i] * 8, ch = String.fromCharCode(0xFF66 + ((R() * 56) | 0));
        g.fillStyle = '#00ff41'; g.fillText(ch, x, y - 8);
        g.fillStyle = '#d7ffd7'; g.fillText(ch, x, y);
        if (step) { drops[i]++; if (drops[i] * 8 > H + 40 && R() > .93) drops[i] = -(R() * 12 | 0); }
      }
      const msg = a.p < .5 ? 'Wake up, Dreamer...' : 'Follow the white rabbit.';
      g.fillStyle = 'rgba(0,0,0,.88)'; g.fillRect(W / 2 - 98, H / 2 - 13, 196, 26);
      const shown = msg.slice(0, Math.max(1, Math.floor((a.p < .5 ? a.p / .4 : (a.p - .5) / .4) * msg.length)));
      text(shown + ((Math.floor(t * 3) % 2) ? '_' : ''), W / 2, H / 2 + 1, 13, '#00ff41');
    },
    loading(t, a) {
      const p = a.p, gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, '#0a0f2c'); gr.addColorStop(1, '#1a1048');
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
      for (const s of stars) { g.fillStyle = `rgba(255,255,255,${.25 + .4 * Math.abs(Math.sin(t + s.p))})`; g.fillRect(s.x | 0, s.y | 0, 1, 1); }
      text('NOW LOADING', W / 2, 34, 20, '#fcbc3c'); text('LEVEL ' + String(level).padStart(2, '0'), W / 2, 56, 10, '#58d854');
      const y = 104, x0 = 30, x1 = W - 30, px = lerp(x0, x1, p);
      for (let x = x0 + 8; x <= x1; x += 10) if (x > px + 8) { g.fillStyle = '#ffd9a8'; g.fillRect(x - 1, y - 1, 3, 3); }
      const mouth = .05 + Math.abs(Math.sin(t * 14)) * .32 * Math.PI;
      g.fillStyle = '#ffe600'; g.beginPath(); g.moveTo(px, y); g.arc(px, y, 9, mouth, 2 * Math.PI - mouth); g.closePath(); g.fill();
      const gx = px - 30; if (gx > x0 - 20) {   // a ghost is chasing
        g.fillStyle = '#ff3b3b'; g.beginPath(); g.arc(gx, y - 1, 8, Math.PI, 0); g.lineTo(gx + 8, y + 8); for (let k = 0; k < 4; k++) g.lineTo(gx + 8 - (k + .5) * 4, y + (k % 2 ? 8 : 5)); g.lineTo(gx - 8, y + 8); g.closePath(); g.fill();
        g.fillStyle = '#fff'; g.fillRect(gx - 5, y - 4, 4, 5); g.fillRect(gx + 1, y - 4, 4, 5); g.fillStyle = '#1b3cff'; g.fillRect(gx - 3, y - 2, 2, 3); g.fillRect(gx + 3, y - 2, 2, 3);
      }
      g.fillStyle = '#fff'; g.fillRect(x0 - 4, y + 18, x1 - x0 + 8, 6); g.fillStyle = '#0a0f2c'; g.fillRect(x0 - 3, y + 19, x1 - x0 + 6, 4);
      g.fillStyle = '#58d854'; for (let b = 0; b < Math.floor(p * 26); b++) g.fillRect(x0 - 2 + b * ((x1 - x0 + 4) / 26), y + 20, (x1 - x0 + 4) / 26 - 1, 2);
      if (p >= 1) text('READY!', W / 2, 146, 14, (Math.floor(t * 6) % 2) ? '#fcbc3c' : '#fff'); else text(Math.floor(p * 100) + '%', W / 2, 146, 14, '#fff');
      text(tip, W / 2, 168, 8, '#9aa3d8'); scan(.1);
    },
    coin(t, a) {
      g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
      for (const s of stars) { const y = (s.y + t * 30 * s.r) % H; g.fillStyle = `rgba(255,255,255,${.3 + .5 * Math.abs(Math.sin(t * 2 + s.p))})`; g.fillRect(s.x | 0, y | 0, 1, 1); }
      text('1UP', 36, 12, 9, (Math.floor(t * 3) % 2) ? '#ff3b3b' : '#fff'); text(String(level * 1000).padStart(6, '0'), 36, 24, 9, '#fff');
      text('HI-SCORE', W / 2, 12, 9, '#ff3b3b'); text('042069', W / 2, 24, 9, '#fff');
      const on = Math.floor(t * 2.5) % 2 === 0, msg = a.p < .5 ? 'INSERT COIN' : 'PRESS START';
      if (on || (a.p >= .5 && Math.floor(t * 5) % 2 === 0)) text(msg, W / 2, 78, 24, `hsl(${(t * 220) % 360},95%,60%)`);
      const rx = Math.abs(Math.cos(t * 6)) * 13 + 1.5;
      g.fillStyle = '#ffcc00'; g.beginPath(); g.ellipse(W / 2, 128, rx, 13, 0, 0, 7); g.fill();
      g.strokeStyle = '#b8860b'; g.lineWidth = 2; g.beginPath(); g.ellipse(W / 2, 128, Math.max(1, rx - 3), 9, 0, 0, 7); g.stroke();
      text('© 1985 DREAMER CORP', W / 2, 168, 8, '#8a8fb5'); if (a.p >= .5) text('CREDIT 01', W - 38, 168, 8, '#fff');
      scan(.15);
    },
    synth(t) {
      const hz = 104, sky = g.createLinearGradient(0, 0, 0, hz); sky.addColorStop(0, '#14052e'); sky.addColorStop(.55, '#5a0f7a'); sky.addColorStop(1, '#ff2e97');
      g.fillStyle = sky; g.fillRect(0, 0, W, hz);
      for (let i = 0; i < 26; i++) { g.fillStyle = `rgba(255,255,255,${.3 + .5 * Math.abs(Math.sin(t * 2 + i))})`; g.fillRect((i * 47) % W, (i * 31) % (hz - 30), 1, 1); }
      const sg = g.createLinearGradient(0, hz - 50, 0, hz); sg.addColorStop(0, '#ffe45e'); sg.addColorStop(1, '#ff4fa0');
      g.fillStyle = sg; g.beginPath(); g.arc(W / 2, hz - 4, 44, 0, 7); g.fill();
      for (let k = 0; k < 7; k++) { const y = hz - 40 + k * 8; g.fillStyle = `rgb(${lerp(90, 255, k / 6) | 0},${lerp(15, 46, k / 6) | 0},${lerp(122, 151, k / 6) | 0})`; g.fillRect(W / 2 - 46, y, 92, 1 + k * .75); }
      g.fillStyle = '#0a0220'; g.fillRect(0, hz, W, H - hz);
      g.strokeStyle = '#ff2e97'; g.lineWidth = 1; g.beginPath();
      const off = (t * 1.1) % 1;
      for (let i = 0; i < 11; i++) { const z = (i + off) / 11, y = hz + (H - hz) * z * z; g.moveTo(0, y | 0); g.lineTo(W, y | 0); }
      for (let k = -12; k <= 12; k++) { g.moveTo(W / 2 + k * 5, hz); g.lineTo(W / 2 + k * 42, H); }
      g.stroke();
      g.fillStyle = 'rgba(255,46,151,.55)'; g.fillRect(0, hz - 1, W, 2);
      text('D R E A M E R', W / 2, 18, 11, '#7ff9ff'); scan(.12);
    },
    warp(t, a) {
      g.fillStyle = 'rgba(2,3,10,.38)'; g.fillRect(0, 0, W, H);
      const speed = .012 + ease(a.p) * .075, cx = W / 2, cy = H / 2;
      for (const s of wst) {
        const pz = s.z; s.z -= speed * (.5 + s.k);
        if (s.z <= .03) { s.x = R() * 2 - 1; s.y = R() * 2 - 1; s.z = 1; s.k = R(); continue; }
        const sx = cx + s.x / s.z * cx * .5, sy = cy + s.y / s.z * cy * .5, px = cx + s.x / pz * cx * .5, py = cy + s.y / pz * cy * .5;
        g.strokeStyle = s.k > .66 ? '#9fd8ff' : s.k > .33 ? '#ffffff' : '#c9a8ff'; g.lineWidth = Math.max(.5, (1 - s.z) * 2.2);
        g.beginPath(); g.moveTo(px, py); g.lineTo(sx, sy); g.stroke();
      }
      if (a.p > .8) { const f = (a.p - .8) / .2, gr = g.createRadialGradient(cx, cy, 0, cx, cy, W * .5); gr.addColorStop(0, `rgba(255,255,255,${.75 * f})`); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, W, H); }
    },
    pong(t) {
      g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
      g.fillStyle = '#fff'; for (let y = 4; y < H; y += 12) g.fillRect(W / 2 - 1, y, 2, 6);
      const T = .55, bx = lerp(20, W - 25, tri(t / T)), by = lerp(8, H - 13, tri(t / .83));
      const ly = clamp(by - 14 + Math.sin(t * 5) * 6, 2, H - 30), ry = clamp(by - 14 + Math.cos(t * 4) * 6, 2, H - 30);
      g.fillRect(12, ly, 4, 28); g.fillRect(W - 16, ry, 4, 28); g.fillRect(bx, by, 5, 5);
      text(String(Math.floor(t / (T * 2))).padStart(2, '0'), W * .27, 22, 26, '#fff'); text(String(Math.floor(t / (T * 3.1))).padStart(2, '0'), W * .73, 22, 26, '#fff');
      scan(.15);
    },
    iris(t, a) {
      const R0 = Math.hypot(W, H) / 2 + 3, r = mode === 'out' ? ease(a.q) * R0 : R0 * (1 - ease(a.a));
      g.globalCompositeOperation = 'source-over'; g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
      if (r > 0) { g.globalCompositeOperation = 'destination-out'; g.beginPath(); g.arc(W / 2, H / 2, r, 0, 7); g.fill(); g.globalCompositeOperation = 'source-over'; }
    }
  };

  /* ---------- TV guide pack (these read real titles from your library) ---------- */
  const FILLERS = ['TEST PATTERN', 'DREAM SHOPPING NETWORK', 'THE PILLOW OF DESTINY', 'LATE NIGHT STATIC', 'NATURE (WITH SNACKS)', 'INFOMERCIAL: ROTATING MOP',
    'PLEASE STAND BY', 'THE SLEEPY NEWS', 'COUCH POTATO THEATER', 'CLASSIC REPEATS', 'COOKING WITH NOBODY', 'WEATHER ON THE 8S', 'MYSTERY RERUN', 'SNOOZE-A-THON'];
  const prettyName = n => String(n || '').replace(/\.[^.]+$/, '').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  const nameOf = e => (typeof e === 'string' ? e : prettyName(e && e.name)).toUpperCase() || 'UNTITLED';
  const folderOf = e => {
    if (!e || typeof e === 'string') return 'DRMR';
    const parts = String(e.path || '').split('/'); const f = parts.length > 1 ? parts[parts.length - 2] : (info && info.root) || 'DRMR';
    return f.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'DRMR';
  };
  const nextEntry = () => (info && info.next && info.next()) || null;
  const nextTitle = () => { const e = nextEntry(); return e ? nameOf(e) : null; };
  const fitText = (s, maxW, size, weight = 'bold') => {
    g.font = `${weight} ${size}px monospace`;
    if (g.measureText(s).width <= maxW) return s;
    while (s.length > 1 && g.measureText(s + '…').width > maxW) s = s.slice(0, -1);
    return s.trimEnd() + '…';
  };
  function wrapText(s, maxW, size, maxLines) {
    g.font = `bold ${size}px monospace`;
    const words = s.split(' '), lines = []; let cur = '';
    for (const w of words) {
      const test = cur ? cur + ' ' + w : w;
      if (g.measureText(test).width <= maxW) cur = test;
      else { if (cur) lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    let out = lines.slice(0, maxLines);
    if (lines.length > maxLines) out[maxLines - 1] = fitText(out[maxLines - 1] + '…', maxW, size);
    return out.map(l => fitText(l, maxW, size));
  }
  function sampleTitles(n, skip) {   // your library titles first (recycled if needed); silly fillers only when the library is tiny
    const lib = (info && info.lib) || [], out = [], seen = new Set(skip ? [nameOf(skip)] : []);
    const uniq = []; for (const e of shuffle(lib.slice())) { const nm = nameOf(e); if (!seen.has(nm)) { seen.add(nm); uniq.push(e); } }
    if (uniq.length >= 3) { let k = 0; while (out.length < n) { if (k && k % uniq.length === 0) shuffle(uniq); out.push(uniq[k++ % uniq.length]); } return out; }
    out.push(...uniq); const fl = shuffle(FILLERS.slice()); let k = 0;
    while (out.length < n) out.push(fl[k++ % fl.length]);
    return shuffle(out);
  }
  const clockStr = (d, mins) => { const x = new Date(d.getTime() + mins * 60000); let h = x.getHours(), m = x.getMinutes(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${h}:${String(m).padStart(2, '0')} ${ap}`; };
  const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'], MONS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  let gRows = [], sTitles = [], sChans = [], tRows = [], tkTitles = [];
  const G_ROWH = 18, G_TOP = 42, G_SEL = 3, G_T = 9, SURF_MS = 330;
  const flipsFor = ms => Math.max(3, Math.round(ms / SURF_MS));

  Object.assign(DRAW, {
    guide(t, a) {
      const d = new Date(), half = d.getMinutes() < 30 ? 0 : 30, base = new Date(d.getTime() - (d.getMinutes() - half) * 60000);
      g.fillStyle = '#0a0a6e'; g.fillRect(0, 0, W, H);
      let gr = g.createLinearGradient(0, 0, 0, 26); gr.addColorStop(0, '#2020c8'); gr.addColorStop(1, '#0a0a50'); g.fillStyle = gr; g.fillRect(0, 0, W, 26);
      text('DREAMER GUIDE', 8, 13, 11, '#ffe14a', 'left');
      text(`${DAYS[d.getDay()]} ${MONS[d.getMonth()]} ${d.getDate()}  ${clockStr(d, 0)}`, W - 8, 13, 9, '#ffffff', 'right');
      g.fillStyle = '#000040'; g.fillRect(0, 28, W, 12);
      const cw = (W - 74) / 3;
      for (let i = 0; i < 3; i++) { text(clockStr(base, i * 30), 74 + i * cw + 4, 34, 8, '#9fd8ff', 'left'); g.fillStyle = '#4a4ae0'; g.fillRect(74 + i * cw, 28, 1, 12); }
      text('CHANNEL', 6, 34, 8, '#9fd8ff', 'left');
      const sc = (G_T - G_SEL) * G_ROWH * ease(clamp(a.p / .72, 0, 1));
      g.save(); g.beginPath(); g.rect(0, G_TOP, W, G_ROWH * 7); g.clip();
      const selY = G_TOP + G_SEL * G_ROWH, settled = a.p > .72;
      gRows.forEach((row, i) => {
        const y = G_TOP + i * G_ROWH - sc; if (y < G_TOP - G_ROWH || y > G_TOP + G_ROWH * 7) return;
        const hot = Math.abs(y - selY) < G_ROWH / 2, isT = i === G_T;
        g.fillStyle = hot ? '#ffe14a' : '#05053a'; g.fillRect(2, y + 1, 68, G_ROWH - 2);
        const ent = isT ? nextEntry() : row.segs[0].e;
        text(String(2 + ((i * 7 + 3) % 97)).padStart(2, '0'), 8, y + G_ROWH / 2, 9, hot ? '#000' : '#7cf7ff', 'left');
        text(folderOf(ent), 24, y + G_ROWH / 2, 8, hot ? '#000' : '#ffffff', 'left');
        let x = 74;
        row.segs.forEach((sg, k) => {
          const w = sg.span * cw, isNow = isT && k === 0;
          const flash = isNow && settled && Math.floor(t * 6) % 2 === 0;
          g.fillStyle = isNow && settled ? (flash ? '#ffffff' : '#ffe14a') : hot ? '#ffe14a' : (k + i) % 2 ? '#2323b8' : '#1a1a96';
          g.fillRect(x + 1, y + 1, w - 2, G_ROWH - 2);
          let ti = isNow ? nextTitle() : nameOf(sg.e);
          const lit = hot || (isNow && settled);
          if (ti === null) ti = 'TUNING' + '.'.repeat(1 + Math.floor(t * 4) % 3);
          text(fitText((isNow && settled ? '▶ ' : '') + ti, w - 8, 8), x + 5, y + G_ROWH / 2 + .5, 8, lit ? '#000' : '#ffffff', 'left');
          x += w;
        });
      });
      g.restore();
      g.fillStyle = '#000040'; g.fillRect(0, G_TOP + G_ROWH * 7, W, H - (G_TOP + G_ROWH * 7));
      const nt = nextTitle();
      text(fitText('NOW TUNING: ' + (nt || '...'), W - 16, 9), 8, 174, 9, '#7cf7ff', 'left');
      scan(.1);
    },
    surf(t, a) {
      const n = tkFlips, idx = Math.min(n - 1, Math.floor(a.p * n)), fp = a.p * n - idx, last = idx === n - 1 || a.p >= .999;
      if (!last && fp < .3) {   // channel-change hit
        noise(255); g.putImageData(img, 0, 0);
        g.fillStyle = `hsla(${(idx * 67) % 360},80%,50%,.18)`; g.fillRect(0, 0, W, H);
      } else {
        const hue = last ? 225 : (idx * 67) % 360;
        const gr = g.createLinearGradient(0, 0, W, H); gr.addColorStop(0, `hsl(${hue},55%,${last ? 14 : 24}%)`); gr.addColorStop(1, `hsl(${(hue + 50) % 360},60%,${last ? 8 : 14}%)`);
        g.fillStyle = gr; g.fillRect(0, 0, W, H);
        noiseLayer(last ? 28 : 60);
        const ent = last ? nextEntry() : sTitles[idx], ti = last ? nextTitle() : nameOf(sTitles[idx]);
        const OSD = (s, x, y, sz, col, al) => { text(s, x + 1, y + 1, sz, '#000', al); text(s, x, y, sz, col, al); };
        OSD('CH ' + (last ? String(2 + (sChans[idx] % 97)).padStart(2, '0') : String(sChans[idx]).padStart(2, '0')), W - 14, 16, 16, '#39ff14', 'right');
        OSD('▶ PLAY', 14, 16, 10, '#39ff14', 'left');
        OSD(folderOf(ent), 14, 30, 8, '#9bffb0', 'left');
        if (last) {
          OSD('NOW TUNING', W / 2, 62, 9, '#ffe14a', 'center');
          wrapText(ti || 'TUNING...', W - 40, 16, 3).forEach((l, i, arr) => OSD(l, W / 2, 92 + (i - (arr.length - 1) / 2) * 20, 16, '#ffffff', 'center'));
        } else {
          OSD(fitText(ti, W - 28, 11), W / 2, 150, 11, '#ffffff', 'center');
        }
        OSD('SP  0:' + String(Math.floor((a.p * 59))).padStart(2, '0') + ':' + String(Math.floor(fp * 59)).padStart(2, '0'), 14, H - 12, 9, '#39ff14', 'left');
      }
      if (R() < .35) { const ty = (R() * H) | 0, h = 3 + (R() * 8 | 0); g.drawImage(c, 0, ty, W, h, (R() * 28 - 14) | 0, ty, W, h); }
      scan(.16);
    },
    upnext(t, a) {
      const s = ease(clamp(a.p / .22, 0, 1)), s2 = ease(clamp((a.p - .06) / .22, 0, 1));
      const gr = g.createLinearGradient(0, 0, W, H); gr.addColorStop(0, '#050a30'); gr.addColorStop(1, '#2b0f5c'); g.fillStyle = gr; g.fillRect(0, 0, W, H);
      for (let k = -2; k < 12; k++) { const x = ((k * 46 + t * 22) % (W + 120)) - 60; g.fillStyle = 'rgba(255,255,255,.045)'; g.beginPath(); g.moveTo(x, 0); g.lineTo(x + 22, 0); g.lineTo(x - 38, H); g.lineTo(x - 60, H); g.closePath(); g.fill(); }
      g.fillStyle = '#e11d48'; g.fillRect(0, 0, 8 * s, H); g.fillStyle = '#ffd24a'; g.fillRect(8 * s, 0, 2 * s, H);
      const ox = (1 - s) * -320, ox2 = (1 - s2) * -320;
      text('COMING UP NEXT'.split('').join(' '), 24 + ox, 34, 10, '#ffd24a', 'left');
      g.fillStyle = '#ffd24a'; g.fillRect(24 + ox, 44, 150 * s, 2);
      const ti = nextEntry() ? prettyName(nextEntry().name) : 'Tuning…';
      wrapText(ti, W - 48, 20, 3).forEach((l, i) => { text(l, 25 + ox2, 78 + i * 25 + 1, 20, '#000', 'left'); text(l, 24 + ox2, 78 + i * 25, 20, '#ffffff', 'left'); });
      text('FROM THE ' + folderOf(nextEntry()) + ' CHANNEL', 24 + ox2, 150, 8, '#7cf7ff', 'left');
      const pv = info && info.prev ? prettyName(info.prev.name) : '';
      if (pv) text(fitText('PREVIOUSLY: ' + pv, W - 48, 8), 24, 166, 8, '#9aa3d8', 'left');
      const sh = ((t * 0.9) % 1.6) - .3; g.save(); g.globalCompositeOperation = 'lighter'; const gx = sh * (W + 120) - 60;
      const gs = g.createLinearGradient(gx, 0, gx + 50, 0); gs.addColorStop(0, 'rgba(255,255,255,0)'); gs.addColorStop(.5, 'rgba(255,255,255,.16)'); gs.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gs; g.fillRect(0, 0, W, H); g.restore();
      const bw = W / 7; BARS.forEach((col, i) => { g.fillStyle = col; g.globalAlpha = .85; g.fillRect(i * bw, H - 5, bw + 1, 5); g.globalAlpha = 1; });
      scan(.14);
    },
    teletext(t, a) {
      g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
      const CWd = 8, RH = 12, d = new Date(), seeking = a.p < .22;
      const cell = (ch, col, row, fg, bg) => { if (bg) { g.fillStyle = bg; g.fillRect(col * CWd, row * RH, CWd, RH); } g.fillStyle = fg; g.font = 'bold 10px monospace'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(ch, col * CWd + CWd / 2, row * RH + RH / 2 + .5); };
      const str = (s, col, row, fg, bg) => { for (let i = 0; i < s.length && col + i < 40; i++) cell(s[i], col + i, row, fg, bg); };
      const page = seeking ? 'P1' + String(Math.floor(t * 38) % 100).padStart(2, '0') : 'P100';
      str(page + ' ', 0, 0, seeking ? '#ffe14a' : '#ffffff', '#000');
      str('DREAMER TEXT ' + DAYS[d.getDay()] + ' ' + String(d.getDate()).padStart(2, '0') + ' ' + MONS[d.getMonth()], 5, 0, '#ffffff');
      str(String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + '/' + String(d.getSeconds()).padStart(2, '0'), 32, 0, '#ffe14a');
      for (let r = 1; r <= 2; r++) for (let c2 = 0; c2 < 40; c2++) cell(' ', c2, r, '#fff', '#0000ee');
      g.save(); g.beginPath(); g.rect(0, RH, W, RH * 2); g.clip(); g.fillStyle = '#ffe14a'; g.font = 'bold 20px monospace'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('T V   L I S T I N G S', W / 2, RH * 2 + 1); g.restore();
      const shown = seeking ? 0 : Math.floor(ease(clamp((a.p - .22) / .5, 0, 1)) * (tRows.length + .999));
      const cols = ['#00ffff', '#ffffff', '#00ff00', '#ffe14a', '#ff66ff'], T = 4;
      let mins = Math.ceil(d.getMinutes() / 5) * 5;
      tRows.forEach((e, i) => {
        if (i >= shown) return;
        const row = 4 + i, isT = i === T, hh = new Date(d.getTime() + (mins - d.getMinutes() + i * 25) * 60000);
        const tm = String(hh.getHours()).padStart(2, '0') + ':' + String(hh.getMinutes()).padStart(2, '0');
        const settled = a.p > .72, blink = isT && settled && Math.floor(t * 4) % 2 === 0;
        const fg = isT ? (blink ? '#000' : '#fff') : cols[i % cols.length], bg = isT && settled ? (blink ? '#ffe14a' : '#d00000') : null;
        let ti = isT ? nextTitle() : nameOf(e); if (ti === null) ti = 'SEARCHING...';
        if (bg) for (let c2 = 0; c2 < 40; c2++) cell(' ', c2, row, '#fff', bg);
        str(tm, 0, row, isT ? fg : '#ffe14a', bg); ti = ti.slice(0, 27);
        str(ti, 6, row, fg, bg);
        for (let c2 = 6 + ti.length + 1; c2 < 36; c2++) cell(c2 % 2 ? '.' : ' ', c2, row, isT ? fg : '#5555ff', bg);
        str(String(100 + ((i * 37 + 11) % 900)), 36, row, isT ? fg : '#00ff00', bg);
      });
      const fb = [['NOW', '#e00000'], ['NEXT', '#00c000'], ['LATER', '#e0e000'], ['INDEX', '#00c8c8']];
      fb.forEach(([l, col], k) => { for (let c2 = 0; c2 < 10; c2++) cell(' ', k * 10 + c2, 14, '#000', col); str(l, k * 10 + Math.floor((10 - l.length) / 2), 14, '#000', col); });
      scan(.18);
    },
    standby(t, a) {
      g.fillStyle = '#10121c'; g.fillRect(0, 0, W, H);
      g.strokeStyle = 'rgba(255,255,255,.07)'; g.lineWidth = 1; g.beginPath(); for (let x = 0; x <= W; x += 20) { g.moveTo(x, 0); g.lineTo(x, H); } for (let y = 0; y <= H; y += 20) { g.moveTo(0, y); g.lineTo(W, y); } g.stroke();
      g.strokeStyle = 'rgba(255,255,255,.35)'; g.beginPath(); g.arc(W / 2, 92, 62, 0, 7); g.stroke(); g.beginPath(); g.arc(W / 2, 92, 38, 0, 7); g.stroke();
      const bw = W / 7; BARS.forEach((col, i) => { g.fillStyle = col; g.fillRect(i * bw, 0, bw + 1, 40); });
      g.fillStyle = 'rgba(0,0,0,.72)'; g.fillRect(40, 62, W - 80, 44);
      if (Math.floor(t * 2.2) % 2 === 0 || a.p > .8) text('PLEASE STAND BY', W / 2, 78, 20, '#ffffff');
      text('DREAMS ARE BEING SELECTED', W / 2, 98, 8, '#9fd8ff');
      g.fillStyle = '#e11d48'; g.fillRect(0, 118, 60, 22); text('UP NEXT', 30, 129, 9, '#fff');
      g.fillStyle = '#1b2b78'; g.fillRect(60, 118, W - 60, 22);
      text(fitText(nextTitle() || 'TUNING...', W - 72, 12), 68, 129, 12, '#ffe14a', 'left');
      g.fillStyle = '#05061a'; g.fillRect(0, 146, W, 22); g.fillStyle = '#ffd24a'; g.fillRect(0, 146, 60, 22); text('LATER', 30, 157, 9, '#000');
      const crawl = tkTitles.map(nameOf).join('   •   ') + '   •   ', cw2 = (() => { g.font = 'bold 10px monospace'; return g.measureText(crawl).width; })();
      g.save(); g.beginPath(); g.rect(60, 146, W - 60, 22); g.clip(); const x0 = W - ((t * 70) % (cw2 + W)); text(crawl, x0, 157, 10, '#ffffff', 'left'); g.restore();
      text('DREAMER NETWORK   ' + clockStr(new Date(), 0), W / 2, 176, 8, '#6f77a8');
      scan(.15);
    }
  });

  function init(k) {
    if (k === 'matrix') { drops = Array.from({ length: W / 8 }, () => -(R() * 30 | 0)); g.fillStyle = '#000'; g.fillRect(0, 0, W, H); }
    else if (k === 'warp') { wst = Array.from({ length: 130 }, () => ({ x: R() * 2 - 1, y: R() * 2 - 1, z: R(), k: R() })); g.fillStyle = '#02030a'; g.fillRect(0, 0, W, H); }
    else if (k === 'pixel') { order = shuffle(Array.from({ length: GW * GH }, (_, i) => i)); pcol = order.map(() => PAL[(R() * PAL.length) | 0]); }
    else if (k === 'loading') tip = TIPS[(R() * TIPS.length) | 0];
    else if (k === 'glitch') { g.fillStyle = '#07070f'; g.fillRect(0, 0, W, H); }
    else if (k === 'guide') {
      const pool = sampleTitles(40, nextEntry()); let n = 0; const take = () => pool[n++ % pool.length];
      const shapes = [[3], [1, 2], [2, 1], [1, 1, 1]];
      gRows = Array.from({ length: 14 }, (_, i) => {
        const sh = i === G_T ? [2, 1] : shapes[(R() * shapes.length) | 0];
        return { segs: sh.map(span => ({ span, e: take() })) };
      });
    }
    else if (k === 'surf') {
      tkFlips = flipsFor(ms); sTitles = sampleTitles(tkFlips, nextEntry()); sChans = Array.from({ length: tkFlips }, () => 2 + ((R() * 97) | 0));
    }
    else if (k === 'teletext') { tRows = sampleTitles(10, nextEntry()); }
    else if (k === 'standby') { tkTitles = sampleTitles(8, nextEntry()); }
  }
  function frame(ts) {
    const q = mode === 'out' ? clamp((ts - outT0) / outMs, 0, 1) : 0;
    const a = { p: clamp((ts - t0) / Math.max(1, ms), 0, 1), a: clamp((ts - t0) / Math.min(Math.max(1, ms) * .55, 650), 0, 1), q };
    DRAW[kind]((ts - t0) / 1000, a, ts);
    if (mode === 'out' && q >= 1) { kill(); return; }
    raf = requestAnimationFrame(frame);
  }
  function kill() { active = false; clearTimeout(hideT); cancelAnimationFrame(raf); c.classList.remove('show'); }
  return {
    begin(k, msIn, lvl, infoIn) {
      clearTimeout(hideT); cancelAnimationFrame(raf);
      if (k === 'cut' || !DRAW[k]) { active = false; return; }
      kind = k; ms = msIn; level = lvl || 1; info = infoIn || null; active = true; mode = 'in'; t0 = performance.now(); lastStep = 0;
      g.clearRect(0, 0, W, H); init(k);
      const soft = k === 'dream' || k === 'fade';
      c.classList.toggle('smooth', soft); c.classList.toggle('slow', soft); c.classList.toggle('instant', REVEAL.has(k));
      c.classList.add('show');
      raf = requestAnimationFrame(frame);
    },
    end() {
      if (!active) return;
      if (REVEAL.has(kind)) { mode = 'out'; outT0 = performance.now(); active = false; return; }
      active = false; c.classList.add('slow'); c.classList.remove('show');
      clearTimeout(hideT); hideT = setTimeout(() => cancelAnimationFrame(raf), 450);
    },
    kill
  };
})();

/* ------------------------------------------------------------------ transitions: sound */
let ac = null, noiseBuf = null;
function initAudio() {
  try {
    if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume();
  } catch (e) { ac = null; }
}
function noiseSrc() {
  if (!noiseBuf) {
    noiseBuf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
    const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const s = ac.createBufferSource(); s.buffer = noiseBuf; s.loop = true; return s;
}
function tone(type, f0, f1, at, dur, gain) {
  const o = ac.createOscillator(), g = ac.createGain(); o.type = type; o.frequency.setValueAtTime(f0, at);
  if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, at + dur);
  g.gain.setValueAtTime(0.0001, at); g.gain.linearRampToValueAtTime(gain, at + .01); g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g); g.connect(ac.destination); o.start(at); o.stop(at + dur + .05);
}
function noiseBurst(at, dur, gain, type, freq) {
  const n = noiseSrc(), f = ac.createBiquadFilter(), g = ac.createGain(); f.type = type; f.frequency.value = freq;
  g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(gain, at + .02); g.gain.linearRampToValueAtTime(0, at + dur);
  n.connect(f); f.connect(g); g.connect(ac.destination); n.start(at); n.stop(at + dur + .05);
}
function whoosh(at, dur, gain, f0, f1) {
  const n = noiseSrc(), f = ac.createBiquadFilter(), g = ac.createGain(); f.type = 'bandpass'; f.Q.value = 1.3;
  f.frequency.setValueAtTime(f0, at); f.frequency.exponentialRampToValueAtTime(f1, at + dur);
  g.gain.setValueAtTime(0.0001, at); g.gain.linearRampToValueAtTime(gain, at + dur * .4); g.gain.linearRampToValueAtTime(0, at + dur);
  n.connect(f); f.connect(g); g.connect(ac.destination); n.start(at); n.stop(at + dur + .05);
}
/* 8-bit sound effects for the gamer transitions */
function playGameSound(kind, ms) {
  const t = ac.currentTime + .01, dur = ms / 1000, v = settings.volume * .55;
  if (kind === 'glitch') {
    for (let i = 0; i < 16; i++) tone('square', 200 + Math.random() * 2000, 100 + Math.random() * 3000, t + Math.random() * dur * .9, .03 + Math.random() * .06, .25 * v);
    for (let i = 0; i < 6; i++) noiseBurst(t + Math.random() * dur * .85, .05 + Math.random() * .08, .3 * v, 'highpass', 1500);
  } else if (kind === 'pixel') {
    for (let i = 0; i < 9; i++) tone('square', 300 + i * 110, 0, t + i * Math.min(.07, dur * .07), .07, .3 * v);
    tone('square', 1500, 600, t + dur, .2, .25 * v);
  } else if (kind === 'crt') {
    tone('sawtooth', 900, 35, t, .45, .3 * v); noiseBurst(t, .35, .25 * v, 'highpass', 800); tone('sine', 70, 55, t + .42, .15, .5 * v);
    tone('sine', 80, 1000, t + dur, .3, .22 * v);
  } else if (kind === 'matrix') {
    tone('sine', 55, 55, t, dur, .5 * v);
    for (let i = 0; i < Math.floor(dur * 11); i++) tone('square', 900 + Math.random() * 1800, 0, t + Math.random() * dur, .02, .1 * v);
  } else if (kind === 'loading') {
    const steps = [0, 4, 7, 12, 7, 4, 0, 4, 7, 12, 16, 19], sp = dur * .8 / steps.length;
    steps.forEach((s, i) => tone('square', 261.63 * Math.pow(2, s / 12), 0, t + i * sp, Math.min(.12, sp * .9), .25 * v));
    tone('square', 784, 0, t + dur * .85, .1, .28 * v); tone('square', 1047, 0, t + dur * .85 + .1, .3, .28 * v);
  } else if (kind === 'coin') {
    tone('square', 988, 0, t, .08, .3 * v); tone('square', 1319, 0, t + .08, .4, .3 * v);
    tone('square', 988, 0, t + dur * .5, .08, .3 * v); tone('square', 1319, 0, t + dur * .5 + .08, .4, .3 * v);
  } else if (kind === 'synth') {
    const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(300, t); f.frequency.exponentialRampToValueAtTime(2400, t + dur * .8);
    const g = ac.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(.2 * v, t + .15); g.gain.setValueAtTime(.2 * v, t + Math.max(.16, dur - .2)); g.gain.linearRampToValueAtTime(0, t + dur);
    f.connect(g); g.connect(ac.destination);
    [110, 220, 261.63, 329.63].forEach((fq, i) => { const o = ac.createOscillator(); o.type = 'sawtooth'; o.frequency.value = fq; o.detune.value = (i - 1.5) * 7; o.connect(f); o.start(t); o.stop(t + dur + .1); });
    [440, 523.25, 659.25, 880, 659.25, 523.25].forEach((fq, i) => tone('triangle', fq, 0, t + i * dur / 6, .18, .2 * v));
  } else if (kind === 'warp') {
    const n = noiseSrc(), f = ac.createBiquadFilter(), g = ac.createGain(); f.type = 'bandpass'; f.Q.value = 1.2;
    f.frequency.setValueAtTime(200, t); f.frequency.exponentialRampToValueAtTime(5000, t + dur);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(.5 * v, t + dur * .85); g.gain.linearRampToValueAtTime(0, t + dur);
    n.connect(f); f.connect(g); g.connect(ac.destination); n.start(t); n.stop(t + dur + .1);
    tone('sawtooth', 80, 1400, t, dur, .15 * v);
  } else if (kind === 'pong') {
    for (let k = 0; k * .55 < dur; k++) tone('square', k % 2 ? 459 : 490, 0, t + k * .55, .06, .3 * v);
  } else if (kind === 'iris') {
    [523.25, 493.88, 466.16, 440].forEach((fq, i) => tone('sawtooth', fq, fq * .96, t + i * .13, .15, .22 * v)); tone('sawtooth', 220, 110, t + .55, .35, .22 * v);
  }
}
/* sounds for the TV guide transitions */
function playGuideSound(kind, ms) {
  const t = ac.currentTime + .01, dur = ms / 1000, v = settings.volume * .55;
  if (kind === 'guide') {            // smooth-jazz hold music + cursor ticks
    const chords = [[261.63, 329.63, 392, 493.88], [220, 261.63, 329.63, 392], [174.61, 220, 261.63, 329.63], [196, 246.94, 293.66, 349.23]];
    const step = dur / 8;
    for (let i = 0; i < 8; i++) { const ch = chords[Math.floor(i / 2) % 4]; tone('triangle', ch[i % 4] * 2, 0, t + i * step, step * 1.6, .2 * v); if (i % 2 === 0) tone('sine', ch[0] / 2, 0, t + i * step, step * 1.8, .3 * v); }
    for (let i = 0; i < 6; i++) tone('square', 1800, 0, t + dur * (.05 + i * .11), .02, .08 * v);
    tone('sine', 1319, 0, t + dur * .74, .35, .25 * v);
  } else if (kind === 'surf') {
    const n = Math.max(3, Math.round(ms / 330)), per = dur / n;
    for (let i = 0; i < n; i++) { noiseBurst(t + i * per, per * .3, .38 * v, 'highpass', 400); tone('square', 880 + (i % 3) * 110, 0, t + i * per + per * .32, .05, .1 * v); }
    tone('sine', 1000, 0, t + dur - .35, .3, .22 * v);
  } else if (kind === 'upnext') {    // network bumper stinger
    [392, 493.88, 587.33].forEach((fq, i) => { tone('sawtooth', fq, 0, t + i * .09, .9, .16 * v); tone('square', fq / 2, 0, t + i * .09, .6, .12 * v); });
    tone('sawtooth', 783.99, 0, t + .35, .8, .15 * v); tone('sine', 1567.98, 0, t + .45, .9, .14 * v);
    tone('sine', 1046.5, 0, t + dur - .5, .45, .16 * v);
  } else if (kind === 'teletext') {  // chunky data blips
    for (let i = 0; i < Math.floor(dur * 11); i++) tone('square', 500 + ((i * 137) % 7) * 120, 0, t + i * (dur * .8 / Math.floor(dur * 11)), .035, .13 * v);
    tone('square', 1500, 0, t + dur - .3, .12, .2 * v); tone('square', 2000, 0, t + dur - .18, .2, .2 * v);
  } else if (kind === 'standby') {   // test-tone hum + chime
    const o = ac.createOscillator(), g = ac.createGain(); o.type = 'sine'; o.frequency.value = 1000;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(.12 * v, t + .1); g.gain.setValueAtTime(.12 * v, t + dur - .5); g.gain.linearRampToValueAtTime(0, t + dur - .4);
    o.connect(g); g.connect(ac.destination); o.start(t); o.stop(t + dur);
    tone('sine', 880, 0, t + dur - .45, .5, .22 * v); tone('sine', 1318.5, 0, t + dur - .3, .5, .2 * v);
  }
}
/* sounds for the newer classic-TV transitions */
function playClassicNew(kind, ms) {
  const t = ac.currentTime + .01, dur = ms / 1000, v = settings.volume * .55;
  if (kind === 'roll') {             // mains hum + a thump every time the picture wraps
    tone('sawtooth', 60, 60, t, dur, .22 * v);
    for (let i = 0; i * .38 < dur; i++) { tone('sine', 110, 50, t + i * .38, .16, .45 * v); noiseBurst(t + i * .38, .06, .22 * v, 'lowpass', 900); }
  } else if (kind === 'bluescreen') {
    noiseBurst(t, dur, .1 * v, 'lowpass', 2400); tone('square', 1000, 0, t, .08, .16 * v); tone('square', 1000, 0, t + dur - .12, .08, .16 * v);
  } else if (kind === 'tuner') {     // sweeping station-search hiss, then a "locked" ping
    const n = noiseSrc(), f = ac.createBiquadFilter(), g = ac.createGain(); f.type = 'bandpass'; f.Q.value = 3;
    f.frequency.setValueAtTime(300, t); f.frequency.exponentialRampToValueAtTime(3600, t + dur * .85);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(.45 * v, t + .1); g.gain.linearRampToValueAtTime(0, t + dur * .9);
    n.connect(f); f.connect(g); g.connect(ac.destination); n.start(t); n.stop(t + dur);
    tone('sine', 1760, 0, t + dur * .86, .3, .22 * v);
  } else if (kind === 'degauss') {   // the classic BOOOONG
    tone('sine', 55, 38, t, .8, .7 * v); tone('sawtooth', 120, 50, t, .5, .18 * v); noiseBurst(t, .12, .35 * v, 'lowpass', 500);
    for (let i = 0; i < 5; i++) tone('sine', 62 - i * 3, 0, t + .05 + i * .1, .25, .3 * v / (i + 1));
  } else if (kind === 'testcard') {  // steady 1 kHz test tone
    const o = ac.createOscillator(), g = ac.createGain(); o.type = 'sine'; o.frequency.value = 1000;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(.14 * v, t + .1); g.gain.setValueAtTime(.14 * v, t + dur - .3); g.gain.linearRampToValueAtTime(0, t + dur - .05);
    o.connect(g); g.connect(ac.destination); o.start(t); o.stop(t + dur);
  } else if (kind === 'rewind') {    // whirring VCR motor + tracking noise
    tone('sawtooth', 220, 900, t, dur * .8, .12 * v); tone('sawtooth', 900, 260, t + dur * .8, dur * .2, .12 * v);
    for (let i = 0; i < Math.floor(dur * 9); i++) noiseBurst(t + i * (dur / Math.floor(dur * 9)), .08, .22 * v, 'highpass', 1200 + (i % 3) * 900);
    tone('square', 1200, 0, t + dur - .08, .05, .2 * v);
  }
}
/* sounds for the 3D transitions (clicks and claps are timed to line up with the animation) */
function playSound3D(kind, ms) {
  const t = ac.currentTime + .01, dur = ms / 1000, v = settings.volume * .55, R = Math.random;
  if (kind === 'remote') {
    whoosh(t, dur * .34, .4 * v, 300, 2600);
    const c = t + dur * .54;
    tone('square', 2600, 0, c, .02, .5 * v); tone('square', 1500, 0, c + .025, .03, .3 * v);                 // the click
    for (let i = 0; i < 3; i++) tone('square', 2300, 0, c + .06 + i * .07, .04, .12 * v);                    // IR beeps
    noiseBurst(c + .05, Math.min(dur * .42, 1.1), .3 * v, 'highpass', 400);                                   // static
    whoosh(t + dur, .45, .3 * v, 2200, 300);
  } else if (kind === 'clap') {
    whoosh(t, dur * .3, .4 * v, 250, 2200);
    const c = t + dur * .58;
    noiseBurst(c, .08, .75 * v, 'highpass', 900); tone('square', 240, 70, c, .09, .5 * v); tone('triangle', 100, 55, c, .22, .55 * v);
    whoosh(t + dur, .4, .3 * v, 1800, 300);
  } else if (kind === 'title3d') {
    [220, 277.18, 329.63, 440].forEach((fq, i) => { tone('triangle', fq, 0, t + i * .05, dur * .7, .2 * v); });
    whoosh(t, dur * .4, .35 * v, 200, 3000); tone('sine', 1760, 0, t + dur * .45, .6, .14 * v);
    whoosh(t + dur, .4, .3 * v, 2000, 300);
  } else if (kind === 'dice') {
    [.18, .36, .52, .64].forEach(f => { tone('sine', 130, 42, t + dur * f, .2, .6 * v); noiseBurst(t + dur * f, .06, .3 * v, 'lowpass', 700); });
    for (let i = 0; i < 9; i++) noiseBurst(t + dur * (.1 + i * .06), .04, .14 * v, 'highpass', 2200);
    whoosh(t + dur, .4, .35 * v, 400, 2800);
  } else if (kind === 'cube' || kind === 'flip') {
    whoosh(t, dur * .6, .4 * v, 200, 3200); tone('sine', 140, 60, t + dur * .55, .15, .3 * v);
    whoosh(t + dur, .5, .4 * v, 3200, 250); tone('sine', 110, 55, t + dur + .45, .2, .4 * v);
  } else if (kind === 'shatter') {
    noiseBurst(t, .28, .5 * v, 'highpass', 3000);
    for (let i = 0; i < 16; i++) tone('sine', 1800 + R() * 4200, 0, t + R() * dur * .55, .1 + R() * .1, .12 * v);
    whoosh(t, dur * .6, .3 * v, 300, 2400); whoosh(t + dur, .5, .35 * v, 2600, 300);
  } else if (kind === 'tunnel') {
    whoosh(t, dur, .45 * v, 150, 5200); tone('sawtooth', 70, 1300, t, dur, .12 * v);
    whoosh(t + dur, .5, .35 * v, 3000, 250);
  }
}
function playTransitionSound(kind, ms) {
  if (!ac || !settings.transSound || settings.muted || settings.volume <= 0 || kind === 'cut') return;
  if (GAME.includes(kind)) { try { playGameSound(kind, ms); } catch (e) { console.warn(e); } return; }
  if (GUIDE.includes(kind)) { try { playGuideSound(kind, ms); } catch (e) { console.warn(e); } return; }
  if (D3.includes(kind)) { try { playSound3D(kind, ms); } catch (e) { console.warn(e); } return; }
  if (['roll', 'bluescreen', 'tuner', 'degauss', 'testcard', 'rewind'].includes(kind)) { try { playClassicNew(kind, ms); } catch (e) { console.warn(e); } return; }
  try {
    const t = ac.currentTime, dur = Math.max(.25, ms / 1000), vol = settings.volume;
    const out = ac.createGain(); out.gain.value = 0; out.connect(ac.destination);
    const stop = [];
    const env = (peak, a = .03, r = .15) => { out.gain.setValueAtTime(0, t); out.gain.linearRampToValueAtTime(peak, t + a); out.gain.setValueAtTime(peak, t + Math.max(a, dur - r)); out.gain.linearRampToValueAtTime(0, t + dur); };
    if (kind === 'static') {
      const n = noiseSrc(), f = ac.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 300;
      n.connect(f); f.connect(out); env(.3 * vol); stop.push(n); n.start(t);
    } else if (kind === 'flicker') {
      const n = noiseSrc(); n.connect(out); stop.push(n); n.start(t);
      out.gain.setValueAtTime(0, t);
      for (let x = 0; x < dur; x += .04 + Math.random() * .08) out.gain.setValueAtTime(Math.random() < .55 ? .3 * vol * Math.random() : 0, t + x);
      out.gain.setValueAtTime(0, t + dur);
      const o = ac.createOscillator(), og = ac.createGain(); o.frequency.value = 60; og.gain.value = .18 * vol; o.connect(og); og.connect(ac.destination); o.start(t); o.stop(t + dur); og.gain.setValueAtTime(.18 * vol, t + dur - .05); og.gain.linearRampToValueAtTime(0, t + dur);
    } else if (kind === 'bars') {
      const o = ac.createOscillator(); o.type = 'sine'; o.frequency.value = 1000; const og = ac.createGain(); og.gain.value = .12; o.connect(og); og.connect(out);
      const n = noiseSrc(), ng = ac.createGain(); ng.gain.value = .35; n.connect(ng); ng.connect(out);
      env(.35 * vol); stop.push(o, n); o.start(t); n.start(t);
    } else if (kind === 'dream') {
      [261.63, 329.63, 392, 523.25].forEach((fq, i) => {
        const o = ac.createOscillator(); o.type = 'sine'; o.frequency.value = fq; o.detune.value = (i - 1.5) * 6;
        const g = ac.createGain(); g.gain.value = .25; o.connect(g); g.connect(out); o.start(t); stop.push(o);
      });
      env(.22 * vol, dur * .45, dur * .45);
    } else {
      const n = noiseSrc(), f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 500;
      n.connect(f); f.connect(out); env(.5 * vol, dur * .5, dur * .5); stop.push(n); n.start(t);
    }
    stop.forEach(s => s.stop(t + dur + .1));
  } catch (e) { console.warn(e); }
}

/* ------------------------------------------------------------------ "Up Next" banners (near the end of each clip) */
const BANNERS = ['lower', 'bug', 'crawl', 'squeeze', 'toon', 'vcr', 'strip', 'arcade'];
const banner = (() => {
  const c = $('#ov'), g = c.getContext('2d'), W = c.width, H = c.height;
  const SANS = '"Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif';
  const MONO = '"Courier New", ui-monospace, Menlo, Consolas, monospace';
  const HEAVY = '"Arial Black", Impact, "Segoe UI", system-ui, sans-serif';
  const ease = x => 1 - Math.pow(1 - x, 3);
  const back = x => { const k = 1.70158; return 1 + (k + 1) * Math.pow(x - 1, 3) + k * Math.pow(x - 1, 2); };
  const c01 = x => clamp(x, 0, 1);
  const lerp = (a, b, t) => a + (b - a) * t;
  const pad2 = n => String(n).padStart(2, '0');
  const mmss = s => { s = Math.max(0, Math.ceil(s)); return `${Math.floor(s / 60)}:${pad2(s % 60)}`; };
  const clock = (plusSec = 0) => { const d = new Date(Date.now() + plusSec * 1000); let h = d.getHours(); const m = d.getMinutes(), ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${h}:${pad2(m)} ${ap}`; };
  const font = (sz, fam = SANS, w = 'bold') => `${w} ${sz}px ${fam}`;
  let raf = 0, st = null;

  function T(s, x, y, f, col, al = 'left') { g.font = f; g.textAlign = al; g.textBaseline = 'middle'; g.fillStyle = col; g.fillText(s, x, y); }
  function fit(s, maxW, f) {
    g.font = f; if (g.measureText(s).width <= maxW) return s;
    while (s.length > 1 && g.measureText(s + '…').width > maxW) s = s.slice(0, -1);
    return s.trimEnd() + '…';
  }
  function wrap(s, maxW, f, maxLines) {
    g.font = f; const words = s.split(' '), lines = []; let cur = '';
    for (const w of words) { const test = cur ? cur + ' ' + w : w; if (g.measureText(test).width <= maxW) cur = test; else { if (cur) lines.push(cur); cur = w; } }
    if (cur) lines.push(cur);
    const out = lines.slice(0, maxLines);
    if (lines.length > maxLines) out[maxLines - 1] = out[maxLines - 1] + '…';
    return out.map(l => fit(l, maxW, f));
  }
  function rr(x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  function star(x, y, r, col) {
    g.fillStyle = col; g.beginPath();
    for (let i = 0; i < 10; i++) { const a = Math.PI / 5 * i - Math.PI / 2, rad = i % 2 ? r * .45 : r; g.lineTo(x + Math.cos(a) * rad, y + Math.sin(a) * rad); }
    g.closePath(); g.fill();
  }
  function moon(cx, cy, r, alpha = 1) {
    g.save(); g.globalAlpha *= alpha;
    g.beginPath(); g.arc(cx, cy, r, 0, 7); g.clip();
    g.beginPath(); g.rect(cx - r - 2, cy - r - 2, r * 2 + 4, r * 2 + 4); g.arc(cx + r * .42, cy - r * .12, r * .86, 0, 7);
    g.shadowColor = 'rgba(253,230,170,.7)'; g.shadowBlur = 20; g.fillStyle = '#fde6aa'; g.fill('evenodd');
    g.restore();
  }

  const DRAW = {
    /* 📰 broadcast-news style lower third */
    lower(o) {
      const { age, inf } = o, x0 = 48, y0 = H - 178, tagW = 180, tagH = 66;
      const slide = (1 - ease(c01(age / .45))) * -(tagW + 90), outX = -(1 - o.aOut) * 100;
      g.save(); g.globalAlpha = o.aOut; g.translate(outX, 0);
      const tf = font(36, SANS, '800'); const title = fit(inf.title, 640, tf); g.font = tf;
      const tw = g.measureText(title).width, barW = Math.max(380, tw + 70), reveal = ease(c01((age - .2) / .6)), bx = x0 + tagW - 22;
      g.save(); g.beginPath(); g.rect(bx - 4, y0 - 20, barW * reveal + 4, 220); g.clip();
      g.shadowColor = 'rgba(0,0,0,.55)'; g.shadowBlur = 22; g.shadowOffsetY = 6;
      let gr = g.createLinearGradient(0, y0, 0, y0 + tagH); gr.addColorStop(0, '#1a3a8c'); gr.addColorStop(1, '#0a1642');
      g.fillStyle = gr; g.fillRect(bx, y0, barW, tagH);
      g.shadowColor = 'transparent'; g.fillStyle = 'rgba(6,10,30,.92)'; g.fillRect(bx, y0 + tagH, barW, 32);
      const sx = bx + ((age * .45) % 1.8 - .4) * barW; gr = g.createLinearGradient(sx, 0, sx + 90, 0);
      gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(.5, 'rgba(255,255,255,.16)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(bx, y0, barW, tagH);
      T(title, bx + 44, y0 + tagH / 2 + 1, tf, '#fff');
      T(`COMING UP IN ${mmss(o.rem)}   •   ${inf.folder.toUpperCase()}`, bx + 44, y0 + tagH + 17, font(16), '#8fe3ff');
      g.restore();
      g.save(); g.translate(slide, 0); g.shadowColor = 'rgba(0,0,0,.5)'; g.shadowBlur = 18;
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x0 + tagW, y0); g.lineTo(x0 + tagW - 22, y0 + tagH); g.lineTo(x0, y0 + tagH); g.closePath();
      gr = g.createLinearGradient(0, y0, 0, y0 + tagH); gr.addColorStop(0, '#ff4a5e'); gr.addColorStop(1, '#c0122b'); g.fillStyle = gr; g.fill();
      g.shadowColor = 'transparent'; T('UP NEXT', x0 + 22, y0 + tagH / 2 + 1, font(30, SANS, '900'), '#fff');
      g.restore(); g.restore();
    },
    /* 🔔 little corner bug with a countdown ring */
    bug(o) {
      const { inf } = o, w = 360, h = 112, x = W - 48 - w, y = 44, sc = Math.max(.001, back(c01(o.age / .55)) * o.aOut);
      g.save(); g.globalAlpha = o.aOut; g.translate(x + w, y); g.scale(sc, sc); g.translate(-w, 0);
      g.shadowColor = 'rgba(0,0,0,.6)'; g.shadowBlur = 24; g.shadowOffsetY = 8;
      rr(0, 0, w, h, 22); g.fillStyle = 'rgba(14,10,40,.92)'; g.fill(); g.shadowColor = 'transparent';
      const gr = g.createLinearGradient(0, 0, w, h); gr.addColorStop(0, '#a78bfa'); gr.addColorStop(1, '#f0abfc'); g.strokeStyle = gr; g.lineWidth = 3; rr(1.5, 1.5, w - 3, h - 3, 21); g.stroke();
      const cx = 58, cy = h / 2, frac = c01(o.rem / inf.lead);
      g.lineWidth = 8; g.lineCap = 'round'; g.strokeStyle = 'rgba(255,255,255,.14)'; g.beginPath(); g.arc(cx, cy, 31, 0, 7); g.stroke();
      g.strokeStyle = frac > .3 ? '#5eead4' : '#ff6b81'; g.beginPath(); g.arc(cx, cy, 31, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac); g.stroke();
      T(String(Math.ceil(o.rem)), cx, cy + 1, font(28, SANS, '800'), '#fff', 'center');
      T('UP NEXT', 108, 27, font(15, SANS, '800'), '#f0abfc');
      wrap(inf.title, w - 128, font(23, SANS, '700'), 2).forEach((l, i, a) => T(l, 108, (a.length > 1 ? 56 : 66) + i * 28, font(23, SANS, '700'), '#fff'));
      g.restore();
    },
    /* 📜 bottom news-ticker crawl */
    crawl(o) {
      const { inf } = o, h = 60, y = H - h + (1 - ease(c01(o.age / .5))) * h + (1 - o.aOut) * h, bx = 200;
      g.save();
      let gr = g.createLinearGradient(0, y, 0, y + h); gr.addColorStop(0, '#1b2a7a'); gr.addColorStop(1, '#0a1040'); g.fillStyle = gr; g.fillRect(0, y, W, h);
      g.fillStyle = '#ffd24a'; g.fillRect(0, y, W, 3);
      g.save(); g.beginPath(); g.rect(bx, y + 3, W - bx, h - 3); g.clip();
      const f = font(28, SANS, '700'), unit = `${inf.title}   ◆   STAY TUNED   ◆   `; g.font = f; const uw = g.measureText(unit).width;
      let pos = (W - bx) - o.age * 130; while (pos < -uw) pos += uw;
      for (let k = 0; k < 6; k++) T(unit, bx + 20 + pos + k * uw, y + h / 2 + 3, f, '#fff');
      g.restore();
      g.fillStyle = '#0a1040'; g.fillRect(W - 128, y + 3, 128, h - 3);
      T(mmss(o.rem), W - 24, y + h / 2 + 3, font(28, MONO, 'bold'), '#8fe3ff', 'right'); T('IN', W - 94, y + h / 2 + 3, font(15, SANS, '700'), '#8fe3ff', 'right');
      g.beginPath(); g.moveTo(0, y + 3); g.lineTo(bx, y + 3); g.lineTo(bx - 24, y + h); g.lineTo(0, y + h); g.closePath();
      gr = g.createLinearGradient(0, y, 0, y + h); gr.addColorStop(0, '#ff4a5e'); gr.addColorStop(1, '#bd1229'); g.fillStyle = gr; g.fill();
      T('UP NEXT', 28, y + h / 2 + 3, font(29, SANS, '900'), '#fff');
      g.restore();
    },
    /* 🖼 squeeze-back: the video shrinks into a corner and a panel takes over */
    squeeze(o) {
      const a = o.a, { inf } = o, sc = 1 - .38 * a, mx = 24 * a, my = 24 * a, hw = W * sc, hh = H * sc;
      if (st.target) st.target.style.transform = a > .0005 ? `translate(${(mx / W * 100).toFixed(3)}%, ${(my / H * 100).toFixed(3)}%) scale(${sc.toFixed(4)})` : '';
      if (a <= 0) return;
      g.save(); g.globalAlpha = a;
      let gr = g.createLinearGradient(0, 0, W, H); gr.addColorStop(0, '#1d1268'); gr.addColorStop(1, '#090525'); g.fillStyle = gr; g.fillRect(0, 0, W, H);
      g.fillStyle = 'rgba(255,255,255,.035)'; for (let k = -2; k < 14; k++) { const x = ((k * 90 + o.t * 24) % (W + 200)) - 100; g.beginPath(); g.moveTo(x, 0); g.lineTo(x + 40, 0); g.lineTo(x - 140, H); g.lineTo(x - 180, H); g.closePath(); g.fill(); }
      g.restore();
      g.clearRect(mx, my, hw, hh);
      g.save(); g.globalAlpha = a; g.lineWidth = 4; gr = g.createLinearGradient(mx, my, mx + hw, my + hh); gr.addColorStop(0, '#a78bfa'); gr.addColorStop(1, '#f0abfc'); g.strokeStyle = gr; g.strokeRect(mx - 2, my - 2, hw + 4, hh + 4); g.restore();
      const ca = c01((a - .35) / .65); if (ca <= 0) { return; }
      g.save(); g.globalAlpha = ca;
      const rx = mx + hw + 30, rw = W - 24 - rx, rc = rx + rw / 2;
      moon(rc, 100, 44);
      T('UP', rc, 184, font(54, HEAVY, '900'), '#ffd24a', 'center'); T('NEXT', rc, 238, font(54, HEAVY, '900'), '#f0abfc', 'center');
      rr(rc - 82, 280, 164, 46, 23); g.fillStyle = 'rgba(255,255,255,.1)'; g.fill(); T('IN ' + mmss(o.rem), rc, 304, font(26, MONO, 'bold'), '#8fe3ff', 'center');
      const by = my + hh + 36;
      T('FROM  ' + inf.folder.toUpperCase(), 28, by, font(19, SANS, '700'), '#8fe3ff');
      const tf = font(46, SANS, '800'), lines = wrap(inf.title, W - 56, tf, 2);
      lines.forEach((l, i) => T(l, 28, by + 52 + i * 52, tf, '#fff'));
      g.fillStyle = 'rgba(255,255,255,.12)'; g.fillRect(28, H - 30, W - 56, 8);
      gr = g.createLinearGradient(28, 0, W - 28, 0); gr.addColorStop(0, '#a78bfa'); gr.addColorStop(1, '#f0abfc'); g.fillStyle = gr; g.fillRect(28, H - 30, (W - 56) * c01(1 - o.rem / inf.lead), 8);
      g.restore();
    },
    /* 🎨 Saturday-morning cartoon bumper */
    toon(o) {
      const { inf, t } = o, bandH = 176, y = H - bandH * Math.max(0, back(c01(o.age / .6))) + (1 - o.aOut) * bandH;
      g.save();
      g.save(); g.beginPath(); g.moveTo(0, y + 30); g.lineTo(W, y); g.lineTo(W, H + 4); g.lineTo(0, H + 4); g.closePath(); g.clip();
      const sz = 36, sh = (t * 44) % (sz * 2);
      for (let r = 0; r < 7; r++) for (let c2 = -3; c2 < W / sz + 3; c2++) { g.fillStyle = (r + c2 + 100) % 2 ? '#ffcf1f' : '#ff8a00'; g.fillRect(c2 * sz - sh, y - 10 + r * sz, sz + 1, sz + 1); }
      g.restore();
      g.strokeStyle = '#ff2d95'; g.lineWidth = 12; g.beginPath(); g.moveTo(-10, y + 30); g.lineTo(W + 10, y - 2); g.stroke();
      g.strokeStyle = '#111'; g.lineWidth = 4; g.beginPath(); g.moveTo(-10, y + 40); g.lineTo(W + 10, y + 8); g.stroke();
      g.save(); g.translate(40, y + 96 + Math.sin(t * 6) * 4); g.rotate(-.06 + Math.sin(t * 4) * .02);
      g.font = font(66, HEAVY, '900'); g.textAlign = 'left'; g.textBaseline = 'middle'; g.lineJoin = 'round';
      g.lineWidth = 16; g.strokeStyle = '#111'; g.strokeText('UP NEXT!', 5, 6); g.strokeText('UP NEXT!', 0, 0);
      g.fillStyle = '#ff2d95'; g.fillText('UP NEXT!', 5, 6); g.fillStyle = '#fff44f'; g.fillText('UP NEXT!', 0, 0);
      g.restore();
      star(352, y + 52 + Math.sin(t * 5) * 6, 16, '#fff'); star(386, y + 150 + Math.cos(t * 4) * 5, 11, '#fff44f'); star(30, y + 40 + Math.sin(t * 3) * 4, 10, '#fff');
      const tf = font(40, HEAVY, '900'), lines = wrap(inf.title, W - 470 - 100, tf, 2); g.font = tf; g.textAlign = 'left'; g.textBaseline = 'middle';
      lines.forEach((l, i) => { const ty = y + 98 + (i - (lines.length - 1) / 2) * 48; g.lineWidth = 11; g.lineJoin = 'round'; g.strokeStyle = '#111'; g.strokeText(l, 440, ty); g.fillStyle = '#fff'; g.fillText(l, 440, ty); });
      g.beginPath(); g.arc(W - 62, y + 100, 38, 0, 7); g.fillStyle = '#fff'; g.fill(); g.lineWidth = 6; g.strokeStyle = '#111'; g.stroke();
      T(String(Math.ceil(o.rem)), W - 62, y + 103, font(42, HEAVY, '900'), '#ff2d95', 'center');
      g.restore();
    },
    /* 📼 VCR on-screen display */
    vcr(o) {
      const { inf, age } = o, G = '#39ff14';
      if (age < .3 && Math.floor(age * 22) % 2) return;
      g.save(); g.globalAlpha = o.aOut;
      const osd = (s, x, y, sz, al = 'left') => { T(s, x + 3, y + 3, font(sz, MONO, 'bold'), 'rgba(0,0,0,.85)', al); T(s, x, y, font(sz, MONO, 'bold'), G, al); };
      osd('▶ PLAY', 56, 64, 38); osd('SP  0:00:' + pad2(Math.min(59, Math.floor(age))), 56, 106, 26);
      if (Math.floor(age * 1.6) % 2 === 0) osd('●', W - 74, 64, 34, 'right'); osd('CH 03', W - 56, 106, 26, 'right');
      osd(fit('NEXT: ' + inf.title.toUpperCase(), W - 112, font(34, MONO, 'bold')), 56, H - 112, 34);
      osd('IN 0:' + pad2(Math.max(0, Math.ceil(o.rem))), 56, H - 68, 28);
      if (age < .5 || o.rem < 1) { for (let i = 0; i < 7; i++) { g.fillStyle = `rgba(255,255,255,${Math.random() * .22})`; g.fillRect(0, H - 150 + Math.random() * 130, W, 2 + Math.random() * 9); } }
      g.restore();
    },
    /* 📺 mini cable-guide strip, Prevue-channel style */
    strip(o) {
      const { inf, t } = o, h = 184, y = H - h * ease(c01(o.age / .5)) + (1 - o.aOut) * h;
      g.save();
      g.shadowColor = 'rgba(0,0,0,.6)'; g.shadowBlur = 24; g.shadowOffsetY = -4; g.fillStyle = '#0a0a6e'; g.fillRect(0, y, W, h + 40); g.shadowColor = 'transparent';
      let gr = g.createLinearGradient(0, y, 0, y + 36); gr.addColorStop(0, '#2a2ad8'); gr.addColorStop(1, '#0c0c58'); g.fillStyle = gr; g.fillRect(0, y, W, 36);
      T('DREAMER GUIDE', 24, y + 19, font(20, MONO, 'bold'), '#ffe14a'); T(clock(), W - 24, y + 19, font(20, MONO, 'bold'), '#fff', 'right');
      g.fillStyle = '#000040'; g.fillRect(0, y + 36, W, 30);
      T('CHANNEL', 24, y + 52, font(15, MONO, 'bold'), '#9fd8ff'); T('NOW', 220, y + 52, font(15, MONO, 'bold'), '#9fd8ff'); T('NEXT  ' + clock(o.rem), 592, y + 52, font(15, MONO, 'bold'), '#9fd8ff');
      const ry = y + 70, rh = 60, nowW = 364, nxX = 592, nxW = W - 24 - nxX;
      g.fillStyle = '#05053a'; g.fillRect(24, ry, 188, rh); T(String(2 + (inf.folder.length * 7) % 90).padStart(2, '0'), 36, ry + rh / 2, font(22, MONO, 'bold'), '#7cf7ff');
      T(fit(inf.folder.toUpperCase().replace(/[^A-Z0-9 ]/g, ''), 120, font(18, MONO, 'bold')), 76, ry + rh / 2, font(18, MONO, 'bold'), '#fff');
      g.fillStyle = '#1a1a96'; g.fillRect(218, ry, nowW, rh); T(fit(inf.now.toUpperCase(), nowW - 24, font(22, MONO, 'bold')), 232, ry + rh / 2, font(22, MONO, 'bold'), '#fff');
      const flash = o.rem < 3 && Math.floor(t * 5) % 2 === 0; g.fillStyle = flash ? '#fff' : '#ffe14a'; g.fillRect(nxX, ry, nxW, rh);
      T(fit('▶ ' + inf.title.toUpperCase(), nxW - 24, font(22, MONO, 'bold')), nxX + 14, ry + rh / 2, font(22, MONO, 'bold'), '#000');
      g.fillStyle = '#000040'; g.fillRect(0, ry + rh + 6, W, 40);
      T(`COMING UP IN ${mmss(o.rem)}   •   STAY TUNED`, 24, ry + rh + 26, font(17, MONO, 'bold'), '#7cf7ff');
      g.fillStyle = 'rgba(255,255,255,.15)'; g.fillRect(W - 264, ry + rh + 20, 240, 10); g.fillStyle = '#ffe14a'; g.fillRect(W - 264, ry + rh + 20, 240 * c01(1 - o.rem / inf.lead), 10);
      for (let y2 = y; y2 < y + h; y2 += 3) { g.fillStyle = 'rgba(0,0,0,.12)'; g.fillRect(0, y2, W, 1); }
      g.restore();
    },
    /* 🕹 8-bit "next stage" banner */
    arcade(o) {
      const { inf, t } = o, w = 780, h = 168, x = (W - w) / 2, y = 34 - ((1 - ease(c01(o.age / .5))) + (1 - o.aOut)) * (h + 60);
      g.save();
      g.fillStyle = 'rgba(0,0,0,.9)'; g.fillRect(x, y, w, h);
      g.lineWidth = 7; g.strokeStyle = `hsl(${(t * 140) % 360},100%,60%)`; g.strokeRect(x + 3.5, y + 3.5, w - 7, h - 7);
      g.lineWidth = 2; g.strokeStyle = 'rgba(255,255,255,.28)'; g.strokeRect(x + 14, y + 14, w - 28, h - 28);
      T(`▶ NEXT STAGE ${pad2(inf.level)} ◀`, W / 2, y + 42, font(30, MONO, 'bold'), Math.floor(t * 3) % 2 ? '#ffe14a' : '#ff5ec8', 'center');
      T(fit(inf.title.toUpperCase(), w - 70, font(36, MONO, 'bold')), W / 2, y + 90, font(36, MONO, 'bold'), '#fff', 'center');
      const n = 24, frac = c01(o.rem / inf.lead), on = Math.ceil(n * frac), bx = x + 118, by = y + 120;
      T('TIME', x + 36, by + 10, font(20, MONO, 'bold'), '#ff5ec8');
      const avail = w - 250, step = avail / n;
      for (let i = 0; i < n; i++) { g.fillStyle = i < on ? (frac > .5 ? '#39ff14' : frac > .25 ? '#ffe14a' : '#ff3b3b') : '#222'; g.fillRect(bx + i * step, by, step - 5, 20); }
      T(pad2(Math.max(0, Math.ceil(o.rem))), x + w - 36, by + 10, font(24, MONO, 'bold'), '#fff', 'right');
      g.restore();
    }
  };

  function backdrop() {     // a stand-in "picture" for previews with no video playing
    g.save(); g.globalCompositeOperation = 'destination-over';
    const gr = g.createLinearGradient(0, 0, W, H); gr.addColorStop(0, '#2a1a6e'); gr.addColorStop(1, '#0b0820'); g.fillStyle = gr; g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'source-over'; moon(W / 2, H / 2 - 18, 54, .35);
    T('YOUR VIDEO PLAYS HERE', W / 2, H / 2 + 70, font(20, SANS, '700'), 'rgba(255,255,255,.28)', 'center'); g.restore();
  }
  function frame(now) {
    if (!st) return;
    const age = (now - st.t0) / 1000, inf = st.get(age), rem = inf.rem;
    const aIn = ease(c01(age / .7));
    let aOut = 1 - c01((.45 - rem) / .45);
    if (st.closing) aOut = Math.min(aOut, 1 - c01((now - st.closing) / 260));
    g.clearRect(0, 0, W, H); g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1; g.shadowColor = 'transparent'; g.lineCap = 'butt';
    DRAW[st.style]({ age, rem, inf, aIn, aOut, a: aIn * aOut, t: now / 1000 });
    if (st.preview) backdrop();
    if ((st.closing && now - st.closing >= 260) || (st.preview && age >= st.lead)) { stop(); return; }
    raf = requestAnimationFrame(frame);
  }
  function start(style, lead, get, preview) {
    stop();
    st = { style, lead, get: age => Object.assign({ lead }, get(age)), preview: !!preview, t0: performance.now(), closing: 0, target: activeEl() };
    c.classList.add('on'); stage.classList.add('bannerOn'); if (preview) stage.classList.add('previewing');
    raf = requestAnimationFrame(frame);
  }
  function close() { if (st && !st.closing) st.closing = performance.now(); }
  function stop() {
    cancelAnimationFrame(raf); raf = 0;
    if (st) { vids.A.style.transform = ''; vids.B.style.transform = ''; }
    st = null; c.classList.remove('on'); stage.classList.remove('previewing', 'bannerOn'); g.clearRect(0, 0, W, H);
  }
  return { start, close, stop, get active() { return !!st; }, get preview() { return !!(st && st.preview); } };
})();

function showBanner() {
  const c = S.cur; if (!c) return;
  let style = settings.bannerStyle;
  if (style === 'random') { const pool = BANNERS.filter(x => x !== S.lastBanner); style = pool[Math.floor(Math.random() * pool.length)]; }
  if (!BANNERS.includes(style)) return;
  S.lastBanner = style;
  const v = c.el, lead = bannerLead(), nowE = c.entry;
  banner.start(style, lead, () => ({
    title: titleOf(S.nextEntry), folder: folderLabel(S.nextEntry), now: titleOf(nowE), level: S.clips + 1,
    rem: Math.max(0, Math.min(settings.clipSec - (v.currentTime - c.start), c.dur - v.currentTime))
  }), false);
  playBannerSound(style);
}
function previewBanner() {
  if (banner.preview) { banner.stop(); ui(); return; }
  if (S.running) return;
  initAudio();
  let style = settings.bannerStyle;
  if (style === 'random' || style === 'off') style = style === 'off' ? 'lower' : BANNERS[Math.floor(Math.random() * BANNERS.length)];
  const lead = Math.min(10, settings.bannerSec);
  const pick = () => (S.lib.length ? titleOf(S.lib[Math.floor(Math.random() * S.lib.length)]) : 'The Great Dream (Director’s Cut)');
  const next = pick(), now = S.lib.length > 1 ? pick() : 'The Dream Before This One';
  banner.start(style, lead, age => ({ title: next, folder: S.rootName || 'Dreamer', now, level: 7, rem: lead - age }), true);
  playBannerSound(style); ui();
}
function playBannerSound(style) {
  if (!ac || !settings.bannerSound || settings.muted || settings.volume <= 0) return;
  try {
    const t = ac.currentTime + .01, v = settings.volume * .5;
    if (style === 'toon') { tone('sine', 180, 700, t, .22, .35 * v); tone('square', 880, 0, t + .24, .08, .12 * v); tone('sine', 1175, 0, t + .32, .25, .2 * v); }
    else if (style === 'vcr') { tone('square', 1000, 0, t, .09, .14 * v); tone('square', 1000, 0, t + .14, .09, .14 * v); }
    else if (style === 'arcade') { tone('square', 988, 0, t, .07, .22 * v); tone('square', 1319, 0, t + .07, .3, .22 * v); }
    else if (style === 'strip') { tone('triangle', 1318.5, 0, t, .18, .3 * v); tone('triangle', 1760, 0, t + .1, .35, .26 * v); }
    else if (style === 'squeeze') { [392, 493.88, 587.33, 783.99].forEach((f, i) => tone('triangle', f, 0, t + i * .1, .6, .24 * v)); }
    else { tone('sine', 880, 0, t, .35, .3 * v); tone('sine', 1318.5, 0, t + .14, .55, .26 * v); }
  } catch (e) { console.warn(e); }
}

/* ------------------------------------------------------------------ screen frames (the set around the video) */
const tvWrap = $('#tvWrap'), tvFrame = $('#tvFrame'), tvArt = $('#tvArt'), picture = $('#picture');
const rep = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join('');
const FRAMES = {
  clean: { label: '🖼 Clean' },

  /* 📻 1950s wooden console with rabbit ears and dials */
  wood: { label: '📻 Old television', VW: 1000, VH: 770, sx: 70, sy: 150, sw: 660, r: 68, art: (sx, sy, sw, sh) => {
    const knob = (cx, cy, label) => `<g><circle cx="${cx}" cy="${cy}" r="64" fill="#1b0f05"/>${rep(11, i => { const a = (-135 + i * 27) * Math.PI / 180; return `<line x1="${cx + Math.sin(a) * 58}" y1="${cy - Math.cos(a) * 58}" x2="${cx + Math.sin(a) * 69}" y2="${cy - Math.cos(a) * 69}" stroke="#d9b866" stroke-width="3"/>`; })}
      <circle cx="${cx}" cy="${cy}" r="48" fill="url(#wKn)" stroke="#4a3410" stroke-width="3"/><line x1="${cx}" y1="${cy - 6}" x2="${cx}" y2="${cy - 40}" stroke="#2b1a05" stroke-width="7" stroke-linecap="round" transform="rotate(35 ${cx} ${cy})"/>
      <text x="${cx}" y="${cy + 94}" text-anchor="middle" font-size="15" fill="#d9b866" font-family="Georgia,serif" letter-spacing="3">${label}</text></g>`;
    return `<defs>
      <linearGradient id="wWd" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b06c32"/><stop offset=".55" stop-color="#8a4f22"/><stop offset="1" stop-color="#56300f"/></linearGradient>
      <filter id="wGr" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.008 0.2" numOctaves="3" seed="7"/><feColorMatrix type="matrix" values="0 0 0 0 .16  0 0 0 0 .07  0 0 0 0 .02  1.9 0 0 0 -.6"/></filter>
      <radialGradient id="wKn" cx=".35" cy=".3" r=".85"><stop offset="0" stop-color="#f6e9c6"/><stop offset=".55" stop-color="#b9954a"/><stop offset="1" stop-color="#5b3f12"/></radialGradient></defs>
      <path d="M118 730h46l-9 38h-28z M836 730h46l-9 38h-28z" fill="#34190a"/>
      <g stroke="#262626" stroke-width="7" stroke-linecap="round"><path d="M500 98L330 12"/><path d="M500 98L682 24"/></g>
      <circle cx="330" cy="12" r="9" fill="#c9a54b"/><circle cx="682" cy="24" r="9" fill="#c9a54b"/><ellipse cx="500" cy="100" rx="66" ry="20" fill="#1b1b1b"/>
      <rect x="18" y="94" width="964" height="644" rx="74" fill="url(#wWd)"/><clipPath id="wCl"><rect x="18" y="94" width="964" height="644" rx="74"/></clipPath><g clip-path="url(#wCl)"><rect x="18" y="94" width="964" height="644" filter="url(#wGr)"/></g>
      <rect x="18" y="94" width="964" height="644" rx="74" fill="none" stroke="#2f1707" stroke-width="5"/>
      <rect x="27" y="103" width="946" height="626" rx="66" fill="none" stroke="rgba(255,226,180,.28)" stroke-width="3"/>
      <rect x="${sx - 36}" y="${sy - 36}" width="${sw + 72}" height="${sh + 72}" rx="96" fill="#120c06"/>
      <rect x="${sx - 22}" y="${sy - 22}" width="${sw + 44}" height="${sh + 44}" rx="84" fill="none" stroke="#c9a54b" stroke-width="5"/>
      <rect x="290" y="570" width="240" height="44" rx="10" fill="#1b1209" stroke="#c9a54b" stroke-width="3"/>
      <text x="410" y="600" text-anchor="middle" font-size="24" font-weight="700" fill="#e3c26a" font-family="Georgia,serif" letter-spacing="7">DREAMER</text>
      <rect x="790" y="130" width="170" height="580" rx="36" fill="#2a1608" stroke="#140a03" stroke-width="4"/>
      ${knob(875, 226, 'VOLUME')}${knob(875, 410, 'CHANNEL')}
      ${rep(8, i => `<rect x="815" y="${540 + i * 20}" width="120" height="9" rx="4.5" fill="#0f0803"/>`)}`;
  } },

  /* 📺 chunky 90s CRT with a button strip */
  box: { label: '📺 Box TV (90s)', VW: 1000, VH: 830, sx: 110, sy: 96, sw: 780, r: 72, art: (sx, sy, sw, sh) => `<defs>
      <linearGradient id="bBd" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#454852"/><stop offset="1" stop-color="#1c1e23"/></linearGradient>
      <linearGradient id="bBt" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5b5f6b"/><stop offset="1" stop-color="#2b2d34"/></linearGradient>
      <radialGradient id="bPw" cx=".4" cy=".35" r=".8"><stop offset="0" stop-color="#8a8f9c"/><stop offset="1" stop-color="#2a2c33"/></radialGradient></defs>
      <rect x="120" y="796" width="150" height="32" rx="9" fill="#101114"/><rect x="730" y="796" width="150" height="32" rx="9" fill="#101114"/>
      <rect x="0" y="0" width="1000" height="806" rx="58" fill="url(#bBd)" stroke="#0b0c0f" stroke-width="4"/>
      <rect x="6" y="6" width="988" height="794" rx="54" fill="none" stroke="rgba(255,255,255,.13)" stroke-width="2"/>
      <rect x="${sx - 52}" y="${sy - 48}" width="${sw + 104}" height="${sh + 96}" rx="70" fill="#0a0b0d"/>
      <rect x="${sx - 16}" y="${sy - 16}" width="${sw + 32}" height="${sh + 32}" rx="88" fill="none" stroke="rgba(255,255,255,.1)" stroke-width="3"/>
      <rect x="40" y="604" width="920" height="3" fill="#0b0c0f"/>
      <text x="84" y="670" font-size="38" font-weight="800" font-style="italic" fill="#dfe2ea" font-family="Arial,Helvetica,sans-serif" letter-spacing="3">DREAMER</text>
      <text x="86" y="704" font-size="14" fill="#8f94a3" font-family="Arial,Helvetica,sans-serif" letter-spacing="5">COLOR TELEVISION</text>
      ${['CH+', 'CH−', 'VOL+', 'VOL−', 'MENU'].map((l, i) => `<rect x="${372 + i * 72}" y="640" width="58" height="26" rx="7" fill="url(#bBt)" stroke="#0a0a0c" stroke-width="2"/><text x="${401 + i * 72}" y="694" text-anchor="middle" font-size="12" fill="#8f94a3" font-family="Arial,sans-serif">${l}</text>`).join('')}
      <circle cx="790" cy="662" r="14" fill="#ff3b3b" opacity=".28"/><circle cx="790" cy="662" r="7" fill="#ff4a4a"/><text x="790" y="696" text-anchor="middle" font-size="12" fill="#8f94a3" font-family="Arial,sans-serif">POWER</text>
      <circle cx="880" cy="662" r="26" fill="url(#bPw)" stroke="#0a0a0c" stroke-width="3"/><path d="M871 654a13 13 0 1 0 18 0M880 650v13" fill="none" stroke="#1b1c20" stroke-width="3.5" stroke-linecap="round"/>
      ${rep(5, i => `<rect x="84" y="${726 + i * 9}" width="190" height="4" rx="2" fill="#0d0e11"/>`)}${rep(5, i => `<rect x="726" y="${726 + i * 9}" width="190" height="4" rx="2" fill="#0d0e11"/>`)}` },

  /* 🖥 flat plasma on a stand */
  plasma: { label: '🖥 Plasma / flat screen', VW: 1000, VH: 670, sx: 26, sy: 26, sw: 948, r: 6, art: (sx, sy, sw, sh) => `<defs>
      <linearGradient id="pBd" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#36363c"/><stop offset=".5" stop-color="#121214"/><stop offset="1" stop-color="#050506"/></linearGradient>
      <linearGradient id="pSl" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#6b6e78"/><stop offset=".5" stop-color="#d4d7df"/><stop offset="1" stop-color="#6b6e78"/></linearGradient></defs>
      <ellipse cx="500" cy="658" rx="250" ry="10" fill="rgba(0,0,0,.4)"/>
      <path d="M440 584h120l14 54H426z" fill="url(#pSl)"/><path d="M290 638Q500 620 710 638L730 658Q500 670 270 658Z" fill="url(#pSl)"/>
      <rect x="0" y="0" width="1000" height="586" rx="20" fill="url(#pBd)" stroke="#7a7a83" stroke-width="2"/>
      <rect x="8" y="8" width="984" height="570" rx="14" fill="none" stroke="rgba(255,255,255,.14)" stroke-width="1.5"/>
      <text x="500" y="574" text-anchor="middle" font-size="13" fill="#9d9da6" font-family="Arial,Helvetica,sans-serif" letter-spacing="7">DREAMER</text>
      <circle cx="948" cy="574" r="6" fill="#4aa8ff" opacity=".3"/><circle cx="948" cy="574" r="3.2" fill="#6bbcff"/>` },

  /* 📽 pull-down screen with a projector on a table */
  projector: { label: '📽 Projector screen', VW: 1000, VH: 760, sx: 120, sy: 88, sw: 760, r: 2, art: (sx, sy, sw, sh) => `<defs>
      <linearGradient id="jWl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1d1538"/><stop offset="1" stop-color="#0b091b"/></linearGradient>
      <linearGradient id="jMt" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e5e7ee"/><stop offset=".5" stop-color="#9ca1ae"/><stop offset="1" stop-color="#5a5f6c"/></linearGradient>
      <linearGradient id="jBm" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgba(190,205,255,.05)"/><stop offset="1" stop-color="rgba(190,205,255,.38)"/></linearGradient>
      <linearGradient id="jPj" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6a6f7c"/><stop offset="1" stop-color="#2a2d36"/></linearGradient>
      <radialGradient id="jLn" cx=".4" cy=".35" r=".8"><stop offset="0" stop-color="#9fd6ff"/><stop offset=".5" stop-color="#2c6fb8"/><stop offset="1" stop-color="#061633"/></radialGradient></defs>
      <rect x="0" y="0" width="1000" height="760" rx="24" fill="url(#jWl)"/>
      <path d="M0 734H1000V736A24 24 0 0 1 976 760H24A24 24 0 0 1 0 736Z" fill="#08060e"/>
      <polygon points="492,618 508,618 ${sx + sw + 24},${sy + sh + 24} ${sx - 24},${sy + sh + 24}" fill="url(#jBm)"/>
      <line x1="150" y1="34" x2="150" y2="0" stroke="#8a8fa0" stroke-width="3"/><line x1="850" y1="34" x2="850" y2="0" stroke="#8a8fa0" stroke-width="3"/>
      <rect x="82" y="30" width="836" height="38" rx="19" fill="url(#jMt)"/><circle cx="82" cy="49" r="22" fill="#b9bdc9" stroke="#6a6f7c" stroke-width="3"/><circle cx="918" cy="49" r="22" fill="#b9bdc9" stroke="#6a6f7c" stroke-width="3"/>
      <rect x="${sx - 24}" y="${sy - 24}" width="${sw + 48}" height="${sh + 48}" fill="#050505"/>
      <rect x="480" y="${sy + sh + 28}" width="40" height="14" rx="5" fill="#2a2a30"/>
      <rect x="300" y="676" width="400" height="18" rx="6" fill="#2a2240"/><rect x="330" y="694" width="14" height="44" fill="#1b152e"/><rect x="656" y="694" width="14" height="44" fill="#1b152e"/>
      <rect x="385" y="616" width="230" height="60" rx="14" fill="url(#jPj)" stroke="#1a1c22" stroke-width="2"/>
      <circle cx="500" cy="636" r="22" fill="#0a0f1a" stroke="#8c93a6" stroke-width="5"/><circle cx="500" cy="636" r="13" fill="url(#jLn)"/>
      ${rep(5, i => `<rect x="560" y="${628 + i * 8}" width="38" height="3" rx="1.5" fill="#15171c"/>`)}<circle cx="408" cy="652" r="3.2" fill="#ff4040"/>` },

  /* 🎬 velvet curtains, gold trim, footlights */
  cinema: { label: '🎬 Cinema curtains', VW: 1000, VH: 650, sx: 150, sy: 118, sw: 700, r: 3, art: (sx, sy, sw, sh) => `<defs>
      <linearGradient id="cFd" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="36" y2="0" spreadMethod="repeat"><stop offset="0" stop-color="#4a0812"/><stop offset=".3" stop-color="#a8162a"/><stop offset=".5" stop-color="#cf2c40"/><stop offset=".75" stop-color="#8a0f20"/><stop offset="1" stop-color="#4a0812"/></linearGradient>
      <linearGradient id="cWd" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4f2e15"/><stop offset="1" stop-color="#1d1008"/></linearGradient>
      <linearGradient id="cSh" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="rgba(0,0,0,.45)"/><stop offset=".5" stop-color="rgba(0,0,0,0)"/><stop offset="1" stop-color="rgba(0,0,0,.35)"/></linearGradient>
      <radialGradient id="cLt"><stop offset="0" stop-color="#ffe2b0"/><stop offset="1" stop-color="#ffb860" stop-opacity="0"/></radialGradient></defs>
      <rect x="0" y="0" width="1000" height="650" rx="24" fill="#14091a"/>
      <path d="M0 524H1000V626A24 24 0 0 1 976 650H24A24 24 0 0 1 0 626Z" fill="url(#cWd)"/>
      ${rep(5, i => `<line x1="0" y1="${548 + i * 22}" x2="1000" y2="${548 + i * 22}" stroke="rgba(0,0,0,.35)" stroke-width="2"/>`)}
      ${rep(20, i => `<circle cx="${50 + i * 50}" cy="536" r="13" fill="url(#cLt)"/><circle cx="${50 + i * 50}" cy="536" r="4.5" fill="#fff1d6"/>`)}
      <path d="M0 0L170 0C170 90 138 200 128 524L0 524Z" fill="url(#cFd)"/><path d="M0 0L170 0C170 90 138 200 128 524L0 524Z" fill="url(#cSh)"/>
      <path d="M1000 0L830 0C830 90 862 200 872 524L1000 524Z" fill="url(#cFd)"/><path d="M1000 0L830 0C830 90 862 200 872 524L1000 524Z" fill="url(#cSh)" transform="translate(1000 0) scale(-1 1)"/>
      <path d="M0 410Q86 392 134 364" fill="none" stroke="#d9b45a" stroke-width="8" stroke-linecap="round"/><circle cx="134" cy="364" r="9" fill="#d9b45a"/><path d="M134 372v34" stroke="#d9b45a" stroke-width="5"/>
      <path d="M1000 410Q914 392 866 364" fill="none" stroke="#d9b45a" stroke-width="8" stroke-linecap="round"/><circle cx="866" cy="364" r="9" fill="#d9b45a"/><path d="M866 372v34" stroke="#d9b45a" stroke-width="5"/>
      <rect x="${sx - 12}" y="${sy - 12}" width="${sw + 24}" height="${sh + 24}" fill="#040404"/>
      <rect x="${sx - 7}" y="${sy - 7}" width="${sw + 14}" height="${sh + 14}" fill="none" stroke="#b8893a" stroke-width="4"/>
      <path d="M0 0H1000V70${rep(10, i => `A50 30 0 0 1 ${1000 - (i + 1) * 100} 70`)}Z" fill="url(#cFd)" stroke="#d9b45a" stroke-width="3"/>
      ${rep(11, i => `<circle cx="${i * 100}" cy="70" r="6" fill="#d9b45a"/>`)}<rect x="0" y="0" width="1000" height="10" fill="#d9b45a"/>` },

  /* 🕹 landscape arcade cabinet with joystick */
  arcade: { label: '🕹 Arcade cabinet', VW: 1000, VH: 960, sx: 138, sy: 148, sw: 724, r: 14, art: (sx, sy, sw, sh) => `<defs>
      <linearGradient id="aBd" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1e1146"/><stop offset="1" stop-color="#0d0722"/></linearGradient>
      <linearGradient id="aSd" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff2e97"/><stop offset=".5" stop-color="#7a3cff"/><stop offset="1" stop-color="#19d4ff"/></linearGradient>
      <linearGradient id="aCp" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#38267a"/><stop offset="1" stop-color="#190f40"/></linearGradient>
      <radialGradient id="aJb" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#ff9a9a"/><stop offset=".5" stop-color="#e8212b"/><stop offset="1" stop-color="#6a0b12"/></radialGradient>
      <filter id="aGl" x="-20%" y="-60%" width="140%" height="220%"><feGaussianBlur stdDeviation="7"/></filter>
      <clipPath id="aCl"><rect x="0" y="0" width="1000" height="960" rx="34"/></clipPath></defs>
      <rect x="0" y="0" width="1000" height="960" rx="34" fill="url(#aBd)"/>
      <g clip-path="url(#aCl)"><rect x="0" y="0" width="58" height="960" fill="url(#aSd)" opacity=".85"/><rect x="942" y="0" width="58" height="960" fill="url(#aSd)" opacity=".85"/></g>
      <rect x="0" y="0" width="1000" height="960" rx="34" fill="none" stroke="#6c4cd8" stroke-width="3"/>
      <rect x="92" y="22" width="816" height="96" rx="14" fill="#0a0418" stroke="#ff2e97" stroke-width="3"/>
      <text x="500" y="90" text-anchor="middle" font-size="68" font-weight="900" fill="#ff2e97" filter="url(#aGl)" font-family="Impact,'Arial Black',sans-serif" letter-spacing="14">DREAMER</text>
      <text x="500" y="90" text-anchor="middle" font-size="68" font-weight="900" fill="#fff" font-family="Impact,'Arial Black',sans-serif" letter-spacing="14">DREAMER</text>
      <rect x="${sx - 34}" y="${sy - 20}" width="${sw + 68}" height="${sh + 40}" rx="26" fill="#000" stroke="#3b2a74" stroke-width="4"/>
      <text x="500" y="604" text-anchor="middle" font-size="15" fill="#ffe14a" font-family="'Courier New',monospace" font-weight="700" letter-spacing="6">INSERT COIN TO CONTINUE</text>
      <polygon points="64,626 936,626 972,802 28,802" fill="url(#aCp)" stroke="#5b43a8" stroke-width="3"/><line x1="64" y1="630" x2="936" y2="630" stroke="rgba(255,255,255,.22)" stroke-width="3"/>
      <circle cx="250" cy="716" r="38" fill="#0a0a12" stroke="#666" stroke-width="3"/><line x1="250" y1="716" x2="232" y2="664" stroke="#c9ccd6" stroke-width="10" stroke-linecap="round"/><circle cx="228" cy="652" r="30" fill="url(#aJb)"/>
      ${['#ff3b3b', '#ffd24a', '#39d98a', '#3ba7ff', '#ffffff', '#ff2e97'].map((c, i) => { const x = 440 + (i % 3) * 82, y = 686 + Math.floor(i / 3) * 62; return `<circle cx="${x}" cy="${y}" r="31" fill="#0a0a12"/><circle cx="${x}" cy="${y}" r="25" fill="${c}"/><ellipse cx="${x - 7}" cy="${y - 9}" rx="9" ry="5" fill="rgba(255,255,255,.55)"/>`; }).join('')}
      <circle cx="770" cy="694" r="17" fill="#19d4ff" stroke="#0a0a12" stroke-width="4"/><circle cx="836" cy="694" r="17" fill="#ff2e97" stroke="#0a0a12" stroke-width="4"/>
      <text x="770" y="732" text-anchor="middle" font-size="13" fill="#cfd3ff" font-family="Arial,sans-serif" font-weight="700">1P</text><text x="836" y="732" text-anchor="middle" font-size="13" fill="#cfd3ff" font-family="Arial,sans-serif" font-weight="700">2P</text>
      <rect x="330" y="824" width="340" height="118" rx="12" fill="#0a0620" stroke="#777" stroke-width="3"/>
      ${[380, 576].map(x => `<rect x="${x}" y="842" width="44" height="64" rx="8" fill="#1a0f2e" stroke="#ff3b3b" stroke-width="3"/><rect x="${x + 16}" y="858" width="12" height="32" fill="#000"/><text x="${x + 22}" y="928" text-anchor="middle" font-size="14" fill="#ffd24a" font-family="Arial,sans-serif" font-weight="700">25¢</text>`).join('')}
      <text x="500" y="876" text-anchor="middle" font-size="22" fill="#ffe14a" font-family="'Courier New',monospace" font-weight="700">INSERT</text><text x="500" y="906" text-anchor="middle" font-size="22" fill="#ffe14a" font-family="'Courier New',monospace" font-weight="700">COIN</text>` },

  /* 💜 glowing neon outline */
  neon: { label: '💜 Neon glow', VW: 1000, VH: 589, sx: 30, sy: 30, sw: 940, r: 14, art: () => `<defs>
      <linearGradient id="nGr" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#19d4ff"/><stop offset=".5" stop-color="#a78bfa"/><stop offset="1" stop-color="#ff2e97"/></linearGradient>
      <filter id="nBl" x="-6%" y="-8%" width="112%" height="116%"><feGaussianBlur stdDeviation="9"/></filter></defs>
      <rect x="0" y="0" width="1000" height="589" rx="34" fill="#090519"/>
      <rect x="14" y="14" width="972" height="561" rx="24" fill="none" stroke="url(#nGr)" stroke-width="12" filter="url(#nBl)"/>
      <rect x="14" y="14" width="972" height="561" rx="24" fill="none" stroke="url(#nGr)" stroke-width="4"/>
      <rect x="21" y="21" width="958" height="547" rx="18" fill="none" stroke="#fff" stroke-opacity=".3" stroke-width="1.5"/>` }
};
function applyFrame() {
  const name = FRAMES[settings.frame] ? settings.frame : 'clean', F = FRAMES[name];
  tvWrap.dataset.frame = name;
  const props = ['--ar', '--sx', '--sy', '--sw', '--sh', '--r', '--rs'];
  if (name === 'clean') { props.forEach(p => tvFrame.style.removeProperty(p)); tvArt.innerHTML = ''; return; }
  const sh = F.sw * 9 / 16;       // the screen hole is always exactly 16:9
  tvFrame.style.setProperty('--ar', (F.VW / F.VH).toFixed(5));
  tvFrame.style.setProperty('--sx', (F.sx / F.VW * 100).toFixed(4) + '%');
  tvFrame.style.setProperty('--sy', (F.sy / F.VH * 100).toFixed(4) + '%');
  tvFrame.style.setProperty('--sw', (F.sw / F.VW * 100).toFixed(4) + '%');
  tvFrame.style.setProperty('--sh', (sh / F.VH * 100).toFixed(4) + '%');
  tvFrame.style.setProperty('--r', (F.r / F.VW * 100).toFixed(4));
  tvFrame.style.setProperty('--rs', (F.r / F.sw * 100).toFixed(3));     // corner radius as a % of the screen's own width, so corner overlays stay clear of the curve
  tvArt.setAttribute('viewBox', `0 0 ${F.VW} ${F.VH}`);
  tvArt.innerHTML = F.art(F.sx, F.sy, F.sw, sh);
}
/* what goes fullscreen: just the screen, or the whole set when "keep the frame" is on */
const fsTarget = () => (settings.frameFs && settings.frame !== 'clean') ? tvWrap : stage;

/* ------------------------------------------------------------------ screen filters (CRT, VHS, etc.) */
const FILTERS = ['crt', 'vhs', 'bw', 'amber', 'green', 'security', 'grid', 'snow', 'vintage'];
const FAMT = { 1: .6, 2: 1, 3: 1.5 };
const fltc = $('#fltc'), fctx = fltc.getContext('2d');
const fimg = fctx.createImageData(fltc.width, fltc.height), fbuf = new Uint32Array(fimg.data.buffer);
const flt = { raf: 0, last: 0, glitchAt: 0, glitchT0: 0, sec: -1 };
const NOISE_A = { crt: 7, vhs: 22, bw: 16, security: 24, vintage: 20, amber: 9, green: 9 };
function applyFilter() {
  const f = FILTERS.includes(settings.filter) ? settings.filter : 'off';
  stage.dataset.filter = f;
  stage.style.setProperty('--fi', FAMT[settings.filterAmt] || 1);
  picture.style.transform = '';
  cancelAnimationFrame(flt.raf); flt.raf = 0;
  fctx.clearRect(0, 0, fltc.width, fltc.height);
  flt.glitchT0 = 0; flt.glitchAt = performance.now() + 2500; flt.sec = -1;
  if (f !== 'off' && f !== 'grid') flt.raf = requestAnimationFrame(fltLoop);
}
function fltLoop(ts) {
  const f = settings.filter;
  if (!FILTERS.includes(f) || f === 'grid') { flt.raf = 0; return; }
  flt.raf = requestAnimationFrame(fltLoop);
  if (ts - flt.last < 55) return;               // ~18 fps is plenty for grain
  flt.last = ts;
  const W = fltc.width, H = fltc.height, a = FAMT[settings.filterAmt] || 1, R = Math.random;
  let alpha = f === 'snow' ? 62 + 40 * Math.sin(ts / 1300) + 16 * Math.sin(ts / 370) : NOISE_A[f] || 0;
  const A = clamp(Math.round(alpha * a), 0, 255) << 24;
  for (let i = 0; i < fbuf.length; i++) { const v = (R() * 256) | 0; fbuf[i] = A | (v << 16) | (v << 8) | v; }
  fctx.putImageData(fimg, 0, 0);
  let jitter = 0;
  if (f === 'vhs') {
    for (let i = 0; i < 10; i++) { const y = H - 1 - ((R() * 8) | 0), w = W * (.3 + R() * .7); fctx.fillStyle = `rgba(255,255,255,${(.15 + R() * .35) * Math.min(1, a)})`; fctx.fillRect(R() * (W - w), y, w, 1); }
    if (!flt.glitchT0 && ts > flt.glitchAt) flt.glitchT0 = ts;
    if (flt.glitchT0) {                           // an occasional tracking glitch sweeps up the screen
      const p = (ts - flt.glitchT0) / 700;
      if (p >= 1) { flt.glitchT0 = 0; flt.glitchAt = ts + 4000 + R() * 7000; }
      else {
        const y = H * (1 - p); fctx.fillStyle = `rgba(255,255,255,${.2 * Math.min(1, a)})`; fctx.fillRect(0, y, W, 9);
        for (let i = 0; i < 9; i++) { fctx.fillStyle = R() < .5 ? 'rgba(0,255,255,.3)' : 'rgba(255,0,70,.3)'; fctx.fillRect(R() * W * .6, y + R() * 10, W * (.1 + R() * .4), 1); }
        jitter = (R() - .5) * 9 * a;
      }
    }
    if (!jitter && R() < .3) jitter = (R() - .5) * 2.2 * a;
  } else if (f === 'snow') {
    if (R() < .12) { const y = R() * H, h = 3 + R() * 12; fctx.fillStyle = R() < .5 ? 'rgba(255,255,255,.35)' : 'rgba(0,0,0,.6)'; fctx.fillRect(0, y, W, h); }
    if (R() < .2) jitter = (R() - .5) * 6 * a;
  } else if (f === 'security') {
    if (R() < .06) { fctx.fillStyle = 'rgba(255,255,255,.1)'; fctx.fillRect(0, R() * H, W, 6 + R() * 8); }
    const d = new Date(), s = d.getSeconds();
    if (s !== flt.sec) {
      flt.sec = s; const p = n => String(n).padStart(2, '0');
      $('#osdTime').textContent = `${p(d.getMonth() + 1)}-${p(d.getDate())}-${d.getFullYear()}  ${p(d.getHours())}:${p(d.getMinutes())}:${p(s)}`;
    }
  }
  picture.style.transform = jitter ? `translateX(${jitter.toFixed(2)}px)` : '';
}
const FILTER_LABELS = [['🚫 Off', 'off'], ['📺 Old CRT', 'crt'], ['📼 VHS tape', 'vhs'], ['⚫ Black & white TV', 'bw'], ['🟧 Amber monitor', 'amber'],
  ['🟩 Green phosphor', 'green'], ['📹 Security cam', 'security'], ['🔳 Pixel grid (LED/LCD)', 'grid'], ['❄️ Weak antenna', 'snow'], ['🟤 Vintage sepia', 'vintage']];

/* ------------------------------------------------------------------ weather overlay (Open-Meteo, no key) */
const WX = { loc: null, data: null, last: 0, tried: 0, busy: false, msg: '', results: [] };
const wxEl = $('#wx');
try { WX.loc = JSON.parse(localStorage.getItem('dreamer.wxloc') || 'null'); } catch (e) {}
try { const c = JSON.parse(localStorage.getItem('dreamer.wx') || 'null'); if (c && c.data) { WX.data = c.data; WX.last = c.t || 0; } } catch (e) {}
const wxSaveLoc = () => { try { localStorage.setItem('dreamer.wxloc', JSON.stringify(WX.loc)); } catch (e) {} };
const wxSaveData = () => { try { localStorage.setItem('dreamer.wx', JSON.stringify({ t: WX.last, data: WX.data })); } catch (e) {} };

const WMO = { 0: ['Clear', 'clear'], 1: ['Mostly clear', 'clear'], 2: ['Partly cloudy', 'partly'], 3: ['Overcast', 'cloud'], 45: ['Fog', 'fog'], 48: ['Freezing fog', 'fog'],
  51: ['Light drizzle', 'rain'], 53: ['Drizzle', 'rain'], 55: ['Heavy drizzle', 'rain'], 56: ['Freezing drizzle', 'rain'], 57: ['Freezing drizzle', 'rain'],
  61: ['Light rain', 'rain'], 63: ['Rain', 'rain'], 65: ['Heavy rain', 'rain'], 66: ['Freezing rain', 'rain'], 67: ['Freezing rain', 'rain'],
  71: ['Light snow', 'snow'], 73: ['Snow', 'snow'], 75: ['Heavy snow', 'snow'], 77: ['Snow grains', 'snow'],
  80: ['Light showers', 'rain'], 81: ['Showers', 'rain'], 82: ['Heavy showers', 'rain'], 85: ['Snow showers', 'snow'], 86: ['Heavy snow showers', 'snow'],
  95: ['Thunderstorm', 'storm'], 96: ['Thunderstorm, hail', 'storm'], 99: ['Thunderstorm, hail', 'storm'] };
const wxInfo = code => WMO[code] || ['Weather', 'cloud'];

/* tiny hand-drawn icons (48x48) */
function wxIcon(kind, day) {
  const sun = (cx, cy, r) => `<g stroke="#ffd24a" stroke-width="3" stroke-linecap="round">${rep(8, i => { const a = i * Math.PI / 4; return `<line x1="${cx + Math.cos(a) * (r + 4)}" y1="${cy + Math.sin(a) * (r + 4)}" x2="${cx + Math.cos(a) * (r + 8)}" y2="${cy + Math.sin(a) * (r + 8)}"/>`; })}</g><circle cx="${cx}" cy="${cy}" r="${r}" fill="#ffd24a"/>`;
  const moonI = (cx, cy, r) => `<path d="M${cx + r * .35} ${cy - r}A${r} ${r} 0 1 0 ${cx + r} ${cy + r * .35}A${r * .8} ${r * .8} 0 0 1 ${cx + r * .35} ${cy - r}Z" fill="#fde6aa"/>`;
  const cloud = (dx = 0, dy = 0, col = '#e9edff') => `<path transform="translate(${dx} ${dy})" d="M13 34h22a7 7 0 0 0 .9-13.9A10 10 0 0 0 16.6 18 8 8 0 0 0 13 34z" fill="${col}"/>`;
  const body = {
    clear: day ? sun(24, 24, 9) : moonI(24, 24, 12),
    partly: (day ? sun(18, 17, 7) : moonI(17, 17, 9)) + cloud(2, 2),
    cloud: cloud(0, -2, '#dfe4f7') + `<path d="M8 36h22a6 6 0 0 0 .8-11.9A8.5 8.5 0 0 0 16 22a7 7 0 0 0-8 14z" fill="#b9c1de" transform="translate(4 -2)"/>`,
    fog: cloud(0, -4) + `<g stroke="#c9d0ea" stroke-width="3" stroke-linecap="round"><line x1="10" y1="34" x2="38" y2="34"/><line x1="14" y1="40" x2="34" y2="40"/></g>`,
    rain: cloud(0, -4, '#cfd6ee') + `<g stroke="#5fb4ff" stroke-width="3" stroke-linecap="round"><line x1="17" y1="34" x2="14" y2="42"/><line x1="25" y1="34" x2="22" y2="42"/><line x1="33" y1="34" x2="30" y2="42"/></g>`,
    snow: cloud(0, -4, '#d8def2') + `<g fill="#fff"><circle cx="16" cy="38" r="2.4"/><circle cx="25" cy="42" r="2.4"/><circle cx="33" cy="37" r="2.4"/></g>`,
    storm: cloud(0, -5, '#aeb6d2') + `<path d="M26 28l-7 10h5l-3 8 10-12h-6l4-6z" fill="#ffd24a"/>`
  }[kind] || '';
  return `<svg class="wi" viewBox="0 0 48 48" aria-hidden="true">${body}</svg>`;
}
const wxTemp = c => settings.wxUnit === 'f' ? c * 9 / 5 + 32 : c;
const wxSpeed = k => settings.wxUnit === 'f' ? k * 0.621371 : k;
function wxAgo(t) {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}
function wxRender() {
  wxEl.dataset.c = settings.wxCorner;
  const d = WX.data;
  if (!settings.wx || !d) { wxEl.classList.remove('on'); wxEl.innerHTML = ''; return; }
  const [label, kind] = wxInfo(d.code), t = Math.round(wxTemp(d.temp)), deg = settings.wxUnit === 'f' ? '°F' : '°C';
  const stale = Date.now() - WX.last > 90 * 60000;
  let html = wxIcon(kind, !!d.day) + `<div class="wt"><b>${t}°</b><span>${escapeHtml(label)}</span>`;
  if (settings.wxStyle === 'detailed') {
    const place = WX.loc && WX.loc.name ? `<span class="wd">${escapeHtml(WX.loc.name)}</span>` : '';
    html += `<span class="wd">Feels ${Math.round(wxTemp(d.feels))}° · Wind ${Math.round(wxSpeed(d.wind))} ${settings.wxUnit === 'f' ? 'mph' : 'km/h'} · ${Math.round(d.hum)}%</span>${place}`;
  }
  html += '</div>';
  wxEl.innerHTML = html; wxEl.title = `${t}${deg} ${label}`;
  wxEl.classList.toggle('stale', stale); wxEl.classList.add('on');
}
function wxStatusText() {
  if (WX.busy) return WX.msg || 'Working…';
  if (WX.msg) return WX.msg;
  if (!WX.loc) return 'No location yet. Press “Use my location”.';
  const place = WX.loc.name || `${WX.loc.lat}, ${WX.loc.lon}`;
  if (!WX.data) return `📍 ${place}\nNo weather loaded yet.`;
  const [label] = wxInfo(WX.data.code), deg = settings.wxUnit === 'f' ? '°F' : '°C';
  return `📍 ${place}\n${Math.round(wxTemp(WX.data.temp))}${deg}, ${label} · updated ${wxAgo(WX.last)}`;
}
function wxStatusUpdate() {
  const el = $('#wxStatus'); if (!el) return;
  const s = wxStatusText();
  if (el._s !== s) { el._s = s; el.innerHTML = s.split('\n').map((l, i) => i ? `<span>${escapeHtml(l)}</span>` : `<b>${escapeHtml(l)}</b>`).join('<br>'); }
}
async function wxFetch() {
  if (!WX.loc) return false;
  WX.tried = Date.now();
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${WX.loc.lat}&longitude=${WX.loc.lon}&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day&timezone=auto`;
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json(), c = j.current;
    if (!c) throw new Error('No data');
    WX.data = { temp: c.temperature_2m, feels: c.apparent_temperature, hum: c.relative_humidity_2m, code: c.weather_code, wind: c.wind_speed_10m, day: c.is_day };
    WX.last = Date.now(); wxSaveData();
    return true;
  } catch (e) {
    console.warn('Weather fetch failed', e);
    return false;
  }
}
async function wxRefresh(manualMsg) {
  if (WX.busy) return;
  WX.busy = true; WX.msg = manualMsg || ''; wxStatusUpdate();
  const ok = await wxFetch();
  WX.busy = false;
  WX.msg = ok ? '' : (WX.data ? 'Offline, so showing the last reading.' : 'Couldn’t reach the weather service. Check your connection.');
  wxRender(); wxStatusUpdate();
}
function weatherMaybeRefresh() {       // called from the heartbeat; re-checks every 15 minutes
  if (!settings.wx || !WX.loc || WX.busy) return;
  const now = Date.now();
  if (now - WX.last > 15 * 60000 && now - WX.tried > 2 * 60000 && navigator.onLine !== false) wxRefresh();
}
window.addEventListener('online', () => { if (settings.wx && WX.loc) wxRefresh(); });

async function wxReverse(lat, lon) {   // city name, used right after capturing the device location
  try {
    const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`);
    if (!r.ok) return '';
    const j = await r.json();
    const city = j.city || j.locality || '', reg = j.principalSubdivision || j.countryName || '';
    return [city, reg].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ');
  } catch (e) { return ''; }
}
function wxLocate() {
  if (!navigator.geolocation) { WX.msg = 'This browser can’t share a location. Search for a city instead.'; $('#wxSearch').open = true; wxStatusUpdate(); return; }
  WX.busy = true; WX.msg = 'Asking for your location… (look for the browser’s permission prompt)'; wxStatusUpdate();
  navigator.geolocation.getCurrentPosition(async pos => {
    const lat = +pos.coords.latitude.toFixed(2), lon = +pos.coords.longitude.toFixed(2);   // ~1 km precision is plenty for weather
    WX.loc = { lat, lon, name: '' }; wxSaveLoc(); WX.msg = 'Got it. Fetching the weather…'; wxStatusUpdate();
    WX.loc.name = await wxReverse(lat, lon); wxSaveLoc();
    WX.busy = false; await wxRefresh('Fetching the weather…');
  }, err => {
    WX.busy = false;
    WX.msg = err && err.code === 1 ? 'Location permission was blocked. Allow it in your browser’s site settings, or search for a city below.'
      : 'Couldn’t get your location. You can search for a city below.';
    $('#wxSearch').open = true; wxStatusUpdate();
  }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 });
}
async function wxFind() {
  const q = $('#wxQuery').value.trim(), box = $('#wxResults'); if (!q) return;
  box.innerHTML = '<span class="small">Searching…</span>';
  try {
    const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=5&language=en&format=json`);
    const j = await r.json(); WX.results = j.results || [];
    if (!WX.results.length) { box.innerHTML = '<span class="small">No matches. Try another spelling?</span>'; return; }
    box.innerHTML = '';
    WX.results.forEach(p => {
      const b = document.createElement('button'); b.textContent = [p.name, p.admin1, p.country].filter(Boolean).join(', ');
      b.addEventListener('click', async () => {
        WX.loc = { lat: +(+p.latitude).toFixed(2), lon: +(+p.longitude).toFixed(2), name: [p.name, p.admin1 || p.country].filter(Boolean).join(', ') }; wxSaveLoc();
        box.innerHTML = ''; $('#wxSearch').open = false; await wxRefresh('Fetching the weather…');
      });
      box.appendChild(b);
    });
  } catch (e) { box.innerHTML = '<span class="small">Couldn’t search right now (are you offline?).</span>'; }
}

/* ------------------------------------------------------------------ 3D transitions (real CSS 3D: no libraries, works offline) */
Object.assign(MIN_MS, { remote: 2800, clap: 2600, title3d: 2800, dice: 2400, cube: 1500, flip: 1400, shatter: 1700, tunnel: 1700 });
const t3 = (() => {
  const layer = $('#fx3d'), bg = $('#bg3d'), cam = $('#cam'), persp = $('#persp'), picture3 = $('#picture');
  const scene = document.createElement('div'); scene.className = 's3'; layer.appendChild(scene);
  const R = Math.random, c01 = x => clamp(x, 0, 1), lerp = (a, b, t) => a + (b - a) * t;
  const easeOut = x => 1 - Math.pow(1 - x, 3), easeIn = x => x * x * x, easeIO = x => x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  const back = x => { const k = 1.70158; return 1 + (k + 1) * Math.pow(x - 1, 3) + k * Math.pow(x - 1, 2); };
  let W = 1000, Hd = 562.5, raf = 0, st = null;

  /* the 3D scene is laid out in a 1000-unit-wide space and scaled to whatever size the screen is */
  function measure() {
    W = stage.clientWidth || 1000; const H = stage.clientHeight || 562;
    layer.style.setProperty('--k', W / 1000); Hd = 1000 * H / W; scene.style.height = Hd + 'px';
    persp.style.perspective = Math.round(W * 1.25) + 'px';
  }
  if (window.ResizeObserver) new ResizeObserver(measure).observe(stage);
  measure();

  const el = (cls, html, parent) => { const d = document.createElement('div'); d.className = cls; if (html) d.innerHTML = html; if (parent) parent.appendChild(d); return d; };
  const T3 = (x, y, z, rx, ry, rz, sc = 1) => `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,${z.toFixed(1)}px) rotateZ(${rz.toFixed(2)}deg) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) scale(${sc})`;
  const nextTitle = s => { const e = s.info && s.info.next && s.info.next(); return titleOf(e); };
  const setCam = (tr, vis, op) => { cam.style.transform = tr || ''; cam.style.visibility = vis || ''; cam.style.opacity = op == null ? '' : op; };
  function makeVoid(n = 70) {          // a dark starry void that shows where the picture used to be
    const v = el('cov void', '', bg); v.stars = [];
    for (let i = 0; i < n; i++) { const d = document.createElement('i'); d.style.left = (R() * 100) + '%'; d.style.top = (R() * 100) + '%'; d.style.opacity = (.25 + R() * .75).toFixed(2); v.appendChild(d); v.stars.push(d); }
    return v;
  }
  function wrapTitle(txt, per, maxLines) {
    const words = String(txt).toUpperCase().split(/\s+/), lines = []; let cur = '';
    for (const w of words) { if (cur && (cur + ' ' + w).length > per) { lines.push(cur); cur = w; } else cur = (cur ? cur + ' ' : '') + w; }
    if (cur) lines.push(cur);
    if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = lines[maxLines - 1].replace(/.?$/, '…'); }
    return lines;
  }
  function snapshot() {                // freeze the last frame of the old clip so it can be shattered
    const v = S.cur && S.cur.el; if (!v || v.readyState < 2 || !v.videoWidth) return null;
    try {
      const cw = 960, ch = Math.max(2, Math.round(960 * Hd / 1000)), cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
      const g = cv.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, cw, ch);
      const vw = v.videoWidth, vh = v.videoHeight, sc = settings.fit === 'cover' ? Math.max(cw / vw, ch / vh) : Math.min(cw / vw, ch / vh);
      g.drawImage(v, (cw - vw * sc) / 2, (ch - vh * sc) / 2, vw * sc, vh * sc);
      return cv.toDataURL('image/jpeg', .75);
    } catch (e) { return null; }
  }

  /* ---------- 🎛 a 3D remote flies in, aims at the screen and clicks CH▲ ---------- */
  function buildRemote(parent) {
    const o = el('o3 rm', '', parent), N = 11;
    for (let i = 0; i < N; i++) {       // stacked slabs = a rounded, thick body that holds up from any angle
      const s = el('sl', '', o), edge = (i === 0 || i === N - 1) ? '#5b6177' : (i === 1 || i === N - 2) ? '#40455a' : '#252833';
      s.style.transform = `translateZ(${((i - (N - 1) / 2) * 3.4).toFixed(2)}px)`; s.style.background = edge;
    }
    const f = el('rf', '', o); f.style.transform = 'translateZ(18px)';
    const b = (cls, l, t, w, h, txt) => { const d = el('b3 ' + cls, txt || '', f); d.style.left = l + 'px'; d.style.top = t + 'px'; d.style.width = w + 'px'; d.style.height = h + 'px'; return d; };
    const ir = el('ir', '', f);
    b('red', 22, 44, 36, 36, 'ON'); b('', 92, 44, 36, 36, 'MUTE').style.fontSize = '8px';
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) b('', 20 + c * 40, 100 + r * 36, 30, 28, String(r * 3 + c + 1));
    const dp = el('dp', '<span style="left:50px;top:8px">▲</span><span style="left:50px;top:86px">▼</span><span style="left:12px;top:47px">◀</span><span style="left:88px;top:47px">▶</span>', f);
    const ok = el('b3', 'OK', dp); ok.style.left = '30px'; ok.style.top = '30px'; ok.style.width = '50px'; ok.style.height = '50px';
    b('sq', 18, 372, 50, 40, 'V+'); b('sq', 18, 418, 50, 40, 'V−');
    const hot = b('sq hot', 82, 372, 50, 40, 'CH▲'); b('sq', 82, 418, 50, 40, 'CH▼');
    [['#e23a3a', 20], ['#3cc46a', 52], ['#e8c23a', 84], ['#3a7be2', 116]].forEach(([c, l]) => { const d = b('sq', l, 486, 26, 14, ''); d.style.background = c; d.style.borderRadius = '6px'; });
    const rings = [0, 1, 2].map(() => { const r = el('ring', '', o); r.style.transform = 'translateZ(18px)'; return r; });
    return { o, hot, ir, rings };
  }

  /* ---------- 🎬 a clapperboard claps with the next video's title on it ---------- */
  function buildClap(parent, title, level) {
    const o = el('o3 cp', '', parent);
    el('pl', '', o).style.transform = 'translateZ(-6px)'; el('pl', '', o).style.transform = 'translateZ(0px)';
    const lines = wrapTitle(title, 21, 3), fs = lines.length > 2 ? 19 : lines.length > 1 ? 23 : 28;
    const d = new Date(), date = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
    const cb = el('cb', `<div><small>PROD.</small>DREAMER</div><div><small>ROLL</small>A${String(level).padStart(2, '0')}</div><div><small>SCENE</small>${level}</div><div><small>TAKE</small>${1 + (level % 7)}</div>` +
      `<div class="wide ttl"><small>TITLE</small><span style="font-size:${fs}px">${escapeHtml(lines.join('\n'))}</span></div><div><small>DIR.</small>THE SANDMAN</div><div><small>DATE</small>${date}</div>`, o);
    el('arm', '', o); const stick = el('stick', '', o);
    return { o, stick, cb };
  }

  /* ---------- 🔠 extruded 3D title text of the next video ---------- */
  function buildTitle(parent, title) {
    const o = el('o3', '', parent), lines = wrapTitle(title, 15, 3), L = Math.max(...lines.map(l => l.length));
    const fs = clamp(Math.floor(860 / (L * .74)), 38, 128), blockH = lines.length * fs * 1.05, N = 14;
    const gold = [255, 210, 74], vio = [167, 139, 250], deep = [38, 18, 104], mix = (a, b, t) => `rgb(${a.map((v, i) => Math.round(lerp(v, b[i], t))).join(',')})`;
    const layers = (txt, size, topY, n, dz, glow) => {
      for (let i = n - 1; i >= 0; i--) {
        const d = el('tl3', '', o); d.textContent = txt; d.style.cssText = `left:-460px;width:920px;top:${topY}px;font-size:${size}px;line-height:1.05;transform:translateZ(${(-i * dz).toFixed(1)}px);` +
          (i === 0 ? `color:#fff8d6;text-shadow:0 0 ${glow}px rgba(255,210,74,.75)` : `color:${i < n * .45 ? mix(gold, vio, i / (n * .45)) : mix(vio, deep, (i - n * .45) / (n * .55))}`);
      }
    };
    layers('UP NEXT', 46, -blockH / 2 - 66, 7, 2.6, 14);
    layers(lines.join('\n'), fs, -blockH / 2, N, 2.8, 30);
    return { o };
  }

  /* ---------- 🎲 a die tumbles toward you until its face fills the screen ---------- */
  function buildDie(parent) {
    const o = el('o3 dc', '', parent);
    const P = { 1: [[50, 50]], 2: [[27, 27], [73, 73]], 3: [[27, 27], [50, 50], [73, 73]], 4: [[27, 27], [73, 27], [27, 73], [73, 73]], 5: [[27, 27], [73, 27], [50, 50], [27, 73], [73, 73]], 6: [[27, 22], [27, 50], [27, 78], [73, 22], [73, 50], [73, 78]] };
    const faces = [['translateZ(120px)', 5, '#8b6cff', '#d26ce6'], ['rotateY(180deg) translateZ(120px)', 2, '#19b5d8', '#5b6cff'], ['rotateY(90deg) translateZ(120px)', 3, '#ff6aa8', '#ff9b4d'],
      ['rotateY(-90deg) translateZ(120px)', 4, '#3fd98a', '#19b5d8'], ['rotateX(90deg) translateZ(120px)', 6, '#ffd24a', '#ff7a5c'], ['rotateX(-90deg) translateZ(120px)', 1, '#a78bfa', '#ff6aa8']];
    faces.forEach(([tr, n, c1, c2]) => {
      const f = el('fc', '', o); f.style.transform = tr; f.style.setProperty('--d1', c1); f.style.setProperty('--d2', c2);
      P[n].forEach(([x, y]) => { const sz = n === 1 ? 84 : 44, p = el('pip', '', f); p.style.width = p.style.height = sz + 'px'; p.style.left = `calc(${x}% - ${sz / 2}px)`; p.style.top = `calc(${y}% - ${sz / 2}px)`; });
    });
    return { o };
  }

  const KINDS = {
    remote: {
      outMs: 560,
      setup(s) {
        s.c = el('c3', '', scene); s.r = buildRemote(s.c);
        s.osd = el('chosd', 'CH ' + String(2 + ((R() * 97) | 0)).padStart(2, '0'), scene); s.fired = false;
      },
      frame(p, e, s) {
        const r = s.r, cT = s.ms * .54, u = c01(p / .32), b = back(u), eo = easeOut(u);
        let x = lerp(430, 170, b), y = lerp(620, 70, b), z = lerp(560, 80, eo), rx = lerp(88, 52, b), ry = lerp(-55, -10, eo), rz = lerp(45, 16, eo);
        if (p > .32) { const w = (e - s.ms * .32) / 1000; y += Math.sin(w * 2.3) * 5; rz += Math.sin(w * 1.7) * 1.6; ry += Math.sin(w * 1.3) * 2; }
        const pu = (e >= cT - 120 && e < cT + 260) ? Math.sin(Math.PI * c01((e - (cT - 120)) / 380)) : 0;      // aim-and-push
        z += 70 * pu; y -= 18 * pu;
        r.o.style.transform = T3(x, y, z, rx, ry, rz);
        r.hot.classList.toggle('press', e >= cT && e < cT + 230); r.ir.classList.toggle('on', e >= cT - 20 && e < cT + 520);
        r.rings.forEach((g, i) => { const a = (e - (cT + i * 100)) / 560; if (a < 0 || a > 1) g.style.opacity = 0; else { g.style.opacity = ((1 - a) * .9).toFixed(2); g.style.transform = `translateZ(18px) translateY(${(-a * 430).toFixed(0)}px) rotateX(90deg) scale(${(.35 + a * 2.6).toFixed(2)})`; } });
        if (!s.fired && e >= cT + 40) { s.fired = true; fx.begin('static', 1000, 0, null); s.osd.style.opacity = 1; }   // the screen changes channel
        s.cx = x; s.cy = y; s.cz = z; s.crx = rx; s.cry = ry; s.crz = rz;
      },
      exit(q, e, s) {
        const ee = easeIn(q); s.r.o.style.transform = T3((s.cx || 170) + 520 * ee, (s.cy || 70) + 420 * ee, (s.cz || 80) + 500 * ee, (s.crx || 52) + 20 * ee, s.cry || -10, (s.crz || 16) + 30 * ee);
        s.c.style.opacity = 1 - ee; s.osd.style.opacity = 1 - q;
      }
    },
    clap: {
      outMs: 600,
      setup(s) {
        s.cov = el('cov dark', '', scene); s.c = el('c3', '', scene);
        s.b = buildClap(s.c, nextTitle(s).toUpperCase(), s.level); s.flash = el('flash', '', scene);
      },
      frame(p, e, s) {
        const u = c01(p / .3), b = back(u), eo = easeOut(u), snapAt = s.ms * .58, hit = e - snapAt;
        let x = lerp(-160, 0, eo), y = lerp(-440, 10, b), z = lerp(620, 0, eo), rx = lerp(-40, 8, eo), ry = lerp(34, -15, eo), rz = lerp(-26, -3, eo);
        if (p > .3) { const w = (e - s.ms * .3) / 1000; y += Math.sin(w * 2.4) * 5; ry += Math.sin(w * 1.5) * 2.5; }
        if (hit >= 0) { const d = Math.exp(-hit / 150); z += 60 * d * Math.cos(hit / 34); y += 10 * d * Math.sin(hit / 30); }
        s.b.o.style.transform = T3(x, y, z, rx, ry, rz);
        const w2 = Math.max(0, e - s.ms * .3) / 1000, ang = hit < 0 ? -36 + 3 * Math.sin(w2 * 3.2) : lerp(-36, 0, easeIn(c01(hit / 70)));
        s.b.stick.style.transform = `translateZ(8px) rotateZ(${ang.toFixed(2)}deg)`;
        s.flash.style.opacity = hit >= 0 ? Math.max(0, 1 - hit / 340).toFixed(3) : 0;
        s.cov.style.opacity = c01((hit + 70) / 150);
        s.cx = x; s.cy = y; s.cz = z;
      },
      exit(q, e, s) {
        const ee = easeIn(q); s.b.o.style.transform = T3((s.cx || 0) - 140 * ee, (s.cy || 10) - 520 * ee, (s.cz || 0) + 600 * ee, 8 + 25 * ee, -15 - 20 * ee, -3 - 20 * ee);
        s.c.style.opacity = 1 - ee; s.cov.style.opacity = 1 - c01(q * 1.2);
      }
    },
    title3d: {
      outMs: 560,
      setup(s) {
        s.cov = el('cov grape', '', scene); s.shards = [];
        s.sc = el('c3', '', scene);
        for (let i = 0; i < 16; i++) { const d = el('shard', '', s.sc); d.base = [(R() - .5) * 1040, (R() - .5) * Math.max(560, Hd) * 1.1, -700 + R() * 900, R() * 360, .5 + R() * 1.2]; s.shards.push(d); }
        s.c = el('c3', '', scene); s.t = buildTitle(s.c, nextTitle(s)).o;
      },
      frame(p, e, s) {
        s.cov.style.opacity = c01(p / .22);
        const u = c01(p / .42), eo = easeOut(u); let z = lerp(-1200, 0, eo), ry = lerp(-85, -12, eo), rx = lerp(20, 6, eo);
        if (p > .42) { const w = (e - s.ms * .42) / 1000; ry = -12 + 18 * Math.sin(w * 1.8); rx = 6 + 4 * Math.sin(w * 1.2); }
        s.t.style.transform = `translate3d(0,0,${z.toFixed(1)}px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`; s.c.style.opacity = c01(p / .12);
        s.shards.forEach((d, i) => { const [x, y, zz, a, sp] = d.base, t = e / 1000; d.style.transform = `translate3d(${x}px,${y}px,${zz + Math.sin(t * sp + i) * 40}px) rotateX(${a + t * 50 * sp}deg) rotateY(${a * 2 + t * 70 * sp}deg)`; d.style.opacity = c01(p / .3) * .9; });
        s.tz = z; s.try = ry; s.trx = rx;
      },
      exit(q, e, s) {
        const ee = easeIn(q); s.t.style.transform = `translate3d(0,0,${((s.tz || 0) + 820 * ee).toFixed(1)}px) rotateX(${s.trx || 6}deg) rotateY(${s.try || -12}deg)`;
        s.c.style.opacity = 1 - ee; s.sc.style.opacity = 1 - q; s.cov.style.opacity = 1 - c01(q * 1.2);
      }
    },
    dice: {
      outMs: 520,
      setup(s) {
        s.cov = el('cov grape', '', scene); s.c = el('c3', '', scene); s.d = buildDie(s.c).o;
        const need = Math.min(2.7, Hd / 240 * .92); s.zF = 900 - 900 / need - 120;      // big and readable (the purple backdrop does the covering)
      },
      frame(p, e, s) {
        const u = c01(p / .72), e1 = easeOut(u), e2 = u * u * (3 - 2 * u), bounce = -Math.abs(Math.sin(u * Math.PI * 3.2)) * (1 - u) * 200;
        s.d.style.transform = T3(lerp(-380, 0, e1), lerp(230, 0, e1) + bounce, lerp(-500, s.zF, e2), lerp(900, 0, e1), lerp(-720, 0, e1), lerp(360, 0, e1));
        s.cov.style.opacity = c01((p - .5) / .2);
      },
      exit(q, e, s) {
        const ee = easeIn(q); s.d.style.transform = T3(0, 0, s.zF + 140 * ee, 0, 0, 0); s.c.style.opacity = 1 - ee; s.cov.style.opacity = 1 - c01(q * 1.2);
      }
    },
    cube: {          // the picture is a face of a cube that turns away; the next clip turns in on the neighbouring face
      outMs: 700,
      setup(s) { s.v = makeVoid(); },
      frame(p, e, s) {
        const a = -90 * easeIO(c01(p / .58));
        setCam(`translateZ(${-W / 2}px) rotateY(${a.toFixed(2)}deg) translateZ(${W / 2}px)`, a <= -89.5 ? 'hidden' : 'visible'); s.v.style.opacity = c01(p / .4);
      },
      exit(q, e, s) {
        const a = 90 * (1 - easeOut(q)); setCam(`translateZ(${-W / 2}px) rotateY(${a.toFixed(2)}deg) translateZ(${W / 2}px)`, 'visible'); s.v.style.opacity = 1 - c01(q * 1.3);
      }
    },
    flip: {
      outMs: 650,
      setup(s) { s.v = makeVoid(50); },
      frame(p, e, s) {
        const u = c01(p / .5), a = 90 * easeIO(u);
        setCam(`rotateY(${a.toFixed(2)}deg) scale(${(1 - .12 * Math.sin(u * Math.PI)).toFixed(3)})`, a >= 89.5 ? 'hidden' : 'visible'); s.v.style.opacity = c01(p / .35);
      },
      exit(q, e, s) {
        const a = -90 * (1 - easeOut(q)); setCam(`rotateY(${a.toFixed(2)}deg) scale(${(1 - .12 * Math.sin((1 - easeOut(q)) * Math.PI / 1)).toFixed(3)})`, 'visible'); s.v.style.opacity = 1 - c01(q * 1.3);
      }
    },
    shatter: {
      outMs: 650,
      setup(s) {
        s.v = makeVoid(60); s.tiles = []; const snap = snapshot(), cols = 8, rows = 5, tw = 1000 / cols, th = Hd / rows;
        s.tg = el('c3', '', scene); s.tg.style.left = '0'; s.tg.style.top = '0';
        const fl = getComputedStyle(picture3).filter; if (fl && fl !== 'none') s.tg.style.filter = fl;
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
          const d = el('tile', '', s.tg), cx = (c + .5) * tw - 500, cy = (r + .5) * th - Hd / 2;
          d.style.cssText = `left:${c * tw}px;top:${r * th}px;width:${tw + .6}px;height:${th + .6}px;` + (snap ? `background-image:url(${snap});background-size:1000px ${Hd}px;background-position:-${c * tw}px -${r * th}px;` : 'display:none;');
          d.v = [cx * (1.1 + R() * .9), cy * (1.1 + R() * .9), 220 + R() * 620, (R() - .5) * 540, (R() - .5) * 540, (R() - .5) * 360];
          d.delay = Math.hypot(cx, cy * 1.6) / 640 * .35; s.tiles.push(d);
        }
        stage.classList.add('hide3d');             // the live picture steps aside; the frozen tiles take over
      },
      frame(p, e, s) {
        s.v.style.opacity = c01(p / .3);
        s.tiles.forEach(d => { const k = easeIn(c01((p / .66 - d.delay) / (1 - d.delay))), v = d.v;
          d.style.transform = `translate3d(${(v[0] * k).toFixed(1)}px,${(v[1] * k).toFixed(1)}px,${(v[2] * k).toFixed(1)}px) rotateX(${(v[3] * k).toFixed(1)}deg) rotateY(${(v[4] * k).toFixed(1)}deg) rotateZ(${(v[5] * k).toFixed(1)}deg)`;
          d.style.opacity = (1 - k * k).toFixed(3); });
      },
      beginExit(s) { stage.classList.remove('hide3d'); s.tg.style.display = 'none'; },
      exit(q, e, s) {
        const k = easeOut(q); setCam(`scale(${(.84 + .16 * k).toFixed(3)}) rotateX(${(12 * (1 - k)).toFixed(2)}deg)`, 'visible', k.toFixed(3)); s.v.style.opacity = 1 - c01(q * 1.3);
      }
    },
    tunnel: {        // the picture is sucked away down a starfield tunnel, the next clip flies out of it
      outMs: 650,
      setup(s) { s.v = makeVoid(90); s.v.stars.forEach((d, i) => { d.a = R() * Math.PI * 2; d.ph = R(); d.sp = .6 + (i % 3) * .3; }); },
      frame(p, e, s) {
        const u = c01(p / .7), k = easeIn(u);
        setCam(`translateZ(${(-W * 2.4 * k).toFixed(0)}px) rotateZ(${(60 * k).toFixed(1)}deg)`, u >= 1 ? 'hidden' : 'visible', (1 - k).toFixed(3));
        s.v.style.opacity = c01(p / .25);
        s.v.stars.forEach(d => { const r = (d.ph + e * .0009 * d.sp * (1 + 1.6 * p)) % 1, rad = r * r * 62; d.style.left = (50 + Math.cos(d.a) * rad) + '%'; d.style.top = (50 + Math.sin(d.a) * rad * .75) + '%'; d.style.transform = `scale(${(.4 + r * 3.4).toFixed(2)})`; d.style.opacity = r.toFixed(2); });
      },
      exit(q, e, s) {
        const k = easeOut(q); setCam(`translateZ(${(W * .9 * (1 - k)).toFixed(0)}px) rotateZ(${(-50 * (1 - k)).toFixed(1)}deg)`, 'visible', c01(q * 1.6).toFixed(3)); s.v.style.opacity = 1 - c01(q * 1.3);
      }
    }
  };

  function finish() {
    cancelAnimationFrame(raf); raf = 0; const s = st; st = null;
    if (s) { try { const K = KINDS[s.kind]; K.cleanup && K.cleanup(s); } catch (e) {} }
    scene.innerHTML = ''; bg.innerHTML = ''; setCam('', '', null); stage.classList.remove('hide3d'); layer.classList.remove('on');
  }
  function loop(ts) {
    if (!st) return;
    const K = KINDS[st.kind];
    try {
      if (st.mode === 'in') { const e = ts - st.t0; K.frame(clamp(e / st.ms, 0, 1), e, st); }
      else { const q = clamp((ts - st.outT0) / K.outMs, 0, 1); K.exit(q, ts - st.t0, st); if (q >= 1) { finish(); return; } }
    } catch (err) { console.warn('3D transition problem', err); finish(); return; }
    raf = requestAnimationFrame(loop);
  }
  return {
    begin(kind, ms, level, info) {
      finish(); measure();
      st = { kind, ms, level, info, t0: performance.now(), mode: 'in', outT0: 0 };
      layer.classList.add('on');
      try { KINDS[kind].setup(st); } catch (err) { console.warn('3D transition setup problem', err); finish(); return; }
      raf = requestAnimationFrame(loop);
    },
    end() {
      if (!st || st.mode === 'out') return;
      const K = KINDS[st.kind]; st.mode = 'out'; st.outT0 = performance.now();
      try { K.beginExit && K.beginExit(st); K.exit(0, st.outT0 - st.t0, st); } catch (err) { finish(); }
    },
    kill() { finish(); },
    /* test hook: jump straight to a point in a transition (pFrac 0-1 while playing, or exitQ 0-1 for the exit) */
    scrub(kind, ms, pFrac, exitQ, level, info) {
      finish(); measure(); st = { kind, ms, level: level || 4, info, t0: performance.now() - ms * (pFrac || 1), mode: 'in', outT0: 0 };
      layer.classList.add('on'); const K = KINDS[kind]; K.setup(st); K.frame(clamp(pFrac, 0, 1), ms * pFrac, st);
      if (exitQ != null) { st.mode = 'out'; K.beginExit && K.beginExit(st); K.exit(exitQ, ms * pFrac, st); }
    },
    get active() { return !!st; }
  };
})();

/* ------------------------------------------------------------------ wake lock, media keys, fullscreen */
async function acquireWake() {
  if (!settings.wake || !('wakeLock' in navigator) || S.wake) return;
  try { S.wake = await navigator.wakeLock.request('screen'); S.wake.addEventListener('release', () => { S.wake = null; }); } catch (e) {}
}
function releaseWake() { try { S.wake && S.wake.release(); } catch (e) {} S.wake = null; }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.running) acquireWake(); });

function mediaSession() {
  if (!('mediaSession' in navigator) || !S.cur) return;
  const name = S.cur.entry.name.replace(/\.[^.]+$/, '');
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: name, artist: 'Dreamer', album: S.rootName || '' });
    navigator.mediaSession.setActionHandler('nexttrack', skip);
    navigator.mediaSession.setActionHandler('previoustrack', goPrev);
    navigator.mediaSession.setActionHandler('play', () => { if (S.paused) togglePause(); });
    navigator.mediaSession.setActionHandler('pause', () => { if (!S.paused) togglePause(); });
  } catch (e) {}
}
const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;
function toggleFull() {
  if (fsEl()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  else { const t = fsTarget(), f = t.requestFullscreen || t.webkitRequestFullscreen; if (f) f.call(t); }
}
let cursorT = 0;
function onFsChange() {
  const on = fsEl();
  $('#btnFull').textContent = on ? '⛶ Exit fullscreen' : '⛶ Fullscreen';
  [stage, tvWrap].forEach(el => el.classList.remove('idleCursor'));
  if (on) on.classList.add('idleCursor');
}
document.addEventListener('fullscreenchange', onFsChange);
document.addEventListener('webkitfullscreenchange', onFsChange);
[stage, tvWrap].forEach(el => el.addEventListener('mousemove', () => {
  const f = fsEl(); if (!f) return;
  f.classList.remove('idleCursor'); clearTimeout(cursorT);
  cursorT = setTimeout(() => { const g = fsEl(); if (g) g.classList.add('idleCursor'); }, 1500);
}));
stage.addEventListener('dblclick', toggleFull);
let tPrev = false;     // a transition preview is playing
stage.addEventListener('click', () => {
  if ($('#tapResume').hidden === false) { $('#tapResume').hidden = true; if (S.cur) playEl(S.cur.el); return; }
  if (!S.running && !fsEl() && !banner.preview && !tPrev) startSession();
});

/* keep our state in sync if the user presses a hardware media key / the browser pauses us */
for (const v of [vids.A, vids.B]) {
  v.addEventListener('pause', () => { if (S.running && S.phase === 'playing' && S.cur && v === S.cur.el && !v.ended && !S.paused) { S.paused = true; flashPause(true); ui(); } });
  v.addEventListener('play', () => { if (S.running && S.phase === 'playing' && S.cur && v === S.cur.el && S.paused) { S.paused = false; flashPause(false); ui(); } });
}

/* ------------------------------------------------------------------ color themes for the app itself */
const THEMES = [
  { id: 'dream', name: 'Midnight Violet', a: '#7c5cf0', b: '#c15bd8', bg: '#0b0820' },
  { id: 'ocean', name: 'Deep Ocean', a: '#0ea5e9', b: '#14b8a6', bg: '#04121c' },
  { id: 'sunset', name: 'Sunset', a: '#f97316', b: '#db2777', bg: '#1a0b14' },
  { id: 'forest', name: 'Forest', a: '#16a34a', b: '#65a30d', bg: '#07130d' },
  { id: 'rose', name: 'Rosé', a: '#ec4899', b: '#f43f5e', bg: '#1b0a17' },
  { id: 'cyber', name: 'Neon Arcade', a: '#06b6d4', b: '#ff2e97', bg: '#05030d' },
  { id: 'mono', name: 'Graphite', a: '#94a3b8', b: '#475569', bg: '#0e0f12' },
  { id: 'daylight', name: 'Daylight', a: '#7c5cf0', b: '#f0a92e', bg: '#f4f1ff' }
];
function applyTheme() {
  const t = THEMES.find(x => x.id === settings.theme) || THEMES[0];
  document.documentElement.setAttribute('data-theme', t.id);
  const m = document.querySelector('meta[name=theme-color]'); if (m) m.setAttribute('content', t.bg);
  document.querySelectorAll('#themes .sw').forEach(b => { const on = b.dataset.id === t.id; b.classList.toggle('sel', on); b.setAttribute('aria-checked', on); });
}
function buildThemes() {
  const box = $('#themes'); box.innerHTML = '';
  THEMES.forEach(t => {
    const b = document.createElement('button'); b.className = 'sw'; b.dataset.id = t.id; b.title = t.name; b.setAttribute('role', 'radio'); b.setAttribute('aria-label', t.name + ' theme');
    b.style.setProperty('--sa', t.a); b.style.setProperty('--sb', t.b); b.style.setProperty('--swbg', t.bg);
    b.addEventListener('click', () => { settings.theme = t.id; save(); applyTheme(); b.blur(); });
    box.appendChild(b);
  });
}

/* ------------------------------------------------------------------ UI */
function ui() {
  const run = S.running;
  $('#btnPlay').hidden = run; $('#btnPlay').disabled = tPrev;
  $('#btnPause').hidden = !run; $('#btnPause').textContent = S.paused ? '▶ Resume' : '⏸ Pause';
  $('#btnPrev').disabled = !run; $('#btnSkip').disabled = !run; $('#btnStop').disabled = !run;
  $('#btnRescan').disabled = !(S.dirHandle || S.rawFiles);
  const pb = $('#btnBannerPreview');
  pb.disabled = run; pb.textContent = banner.preview ? '⏹ Stop preview' : '👁 Preview this banner';
  $('#btnTransPreview').disabled = run || tPrev; $('#btnTransPreview').textContent = tPrev ? '…previewing' : '👁 Preview this transition';
  $('#bannerNote').textContent = run ? 'Preview works when no session is running. During a session, the banner shows up on its own near the end of each clip.' :
    settings.bannerStyle === 'off' ? 'Banner is off. Pick a style above, or hit Preview to see the Lower third.' : '';
  $('#idleText').textContent = S.lib.length ? `${S.lib.length} video${S.lib.length === 1 ? '' : 's'} ready. Click here or press Start dreaming.` : 'Pick a folder to begin dreaming';
  const c = S.cur, clipOf = S.clips + (settings.maxClips ? ' / ' + settings.maxClips : ' / ∞');
  if (run && c) {
    const elapsed = c.el.currentTime - c.start, left = settings.clipSec - elapsed;
    $('#npName').textContent = c.entry.name;
    $('#npPath').textContent = c.entry.path;
    $('#stClip').textContent = clipOf + (S.hi < S.hist.length - 1 ? ' (replaying)' : '');
    $('#stLeft').textContent = S.phase === 'transition' ? '…tuning' : S.paused ? '⏸ paused' : fmt(Math.min(left, c.dur - c.el.currentTime));
    $('#stStart').textContent = fmt(c.start) + ' of ' + fmt(c.dur);
    $('#clipBar').style.width = clamp(elapsed / settings.clipSec * 100, 0, 100) + '%';
  } else if (!run) {
    $('#npName').textContent = S.phase === 'ended' ? 'Session finished' : 'Nothing playing yet';
    $('#npPath').innerHTML = '&nbsp;'; $('#stClip').textContent = '–'; $('#stLeft').textContent = '–'; $('#stStart').textContent = '–'; $('#clipBar').style.width = '0';
  }
  if (run) {
    const lim = settings.sessionMin * 60;
    $('#stSession').textContent = fmt(S.sessionMs / 1000) + (lim ? ' / ' + fmt(lim) : ' / ∞');
    if (!c) { $('#npName').textContent = 'Tuning in…'; $('#stClip').textContent = clipOf; }
  } else $('#stSession').textContent = '–';
  if (settings.wx) { wxStatusUpdate(); if (WX.data && wxEl.classList.contains('on') && wxEl._m !== Math.floor(Date.now() / 60000)) { wxEl._m = Math.floor(Date.now() / 60000); wxRender(); } }
}
function renderSkipped() {
  const box = $('#skipped');
  if (!S.bad.size) { box.hidden = true; return; }
  box.hidden = false;
  $('#skippedSum').textContent = `${S.bad.size} file${S.bad.size === 1 ? '' : 's'} skipped (browser can't play them)`;
  $('#skippedList').innerHTML = [...S.bad].map(([e, why]) => `${escapeHtml(e.path)}<br><i>${escapeHtml(why)}</i>`).join('<hr style="border:0;border-top:1px solid #fff2">');
}

function setVolume(v) {
  settings.volume = clamp(v, 0, 1); if (settings.volume > 0) settings.muted = false;
  save(); syncVolumeUI(); applyVolume();
}
function syncVolumeUI() {
  $('#volume').value = Math.round(settings.volume * 100);
  $('#volLabel').textContent = settings.muted ? 'Muted' : Math.round(settings.volume * 100) + '%';
  $('#btnMute').textContent = settings.muted || settings.volume === 0 ? '🔇' : settings.volume < .4 ? '🔈' : '🔊';
}
$('#volume').addEventListener('input', e => setVolume(e.target.value / 100));
$('#volume').addEventListener('change', e => e.target.blur());
$('#btnMute').addEventListener('click', toggleMute);
function toggleMute() { settings.muted = !settings.muted; save(); syncVolumeUI(); applyVolume(); }

/* try a transition without starting a session */
function previewTransition() {
  if (S.running || tPrev || banner.preview) return;
  const kind = pickKind(); if (kind === 'cut') return;
  initAudio();
  const ms = Math.max(settings.transMs, MIN_MS[kind] || 0), nx = S.lib.length ? S.lib[Math.floor(Math.random() * S.lib.length)] : { name: 'The Great Dream (Director’s Cut).mp4', path: 'Dreamer/The Great Dream.mp4' };
  const info = { next: () => nx, prev: null, lib: S.lib, root: S.rootName };
  tPrev = true; stage.classList.add('previewT', 'inTrans'); ui();
  if (D3.includes(kind)) t3.begin(kind, ms, 7, info); else fx.begin(kind, ms, 7, info);
  playTransitionSound(kind, ms);
  setTimeout(() => {
    fx.end(); t3.end();
    setTimeout(() => { stage.classList.remove('previewT', 'inTrans'); tPrev = false; ui(); }, 900);
  }, ms);
}

/* chip groups */
function chipGroup(el, { options, get, set, units }) {
  function sel() {
    const cur = get(); let matched = false;
    el.querySelectorAll('.chip[data-v]').forEach(b => { const on = String(cur) === b.dataset.v; b.classList.toggle('sel', on); matched = matched || on; });
    const cb = el.querySelector('.chip.custom'); if (cb) cb.classList.toggle('sel', !matched);
    const box = el.querySelector('.customBox'); if (box) box.hidden = matched && !el._open;
  }
  el.innerHTML = '';
  options.forEach(o => {
    if (o.head) { const h = document.createElement('div'); h.className = 'chipHead'; h.textContent = o.head; el.appendChild(h); return; }
    const b = document.createElement('button'); b.className = 'chip'; b.textContent = o.label; b.dataset.v = String(o.value);
    b.addEventListener('click', () => { el._open = false; set(o.value); sel(); }); el.appendChild(b);
  });
  if (units) {
    const cb = document.createElement('button'); cb.className = 'chip custom'; cb.textContent = 'Custom'; el.appendChild(cb);
    const box = document.createElement('div'); box.className = 'customBox';
    const inp = document.createElement('input'); inp.type = 'number'; inp.min = '1'; inp.step = '1'; inp.inputMode = 'numeric';
    const us = document.createElement('select'); units.forEach((u, i) => { const op = document.createElement('option'); op.value = i; op.textContent = u.label; us.appendChild(op); });
    box.append(inp, us); el.appendChild(box);
    const fill = () => {
      const v = get() || units[0].mult; let idx = 0;
      units.forEach((u, i) => { if (v % u.mult === 0) idx = i; });
      us.value = idx; inp.value = Math.max(1, Math.round(v / units[idx].mult));
    };
    const push = () => { const n = Math.max(1, Math.floor(+inp.value || 1)); set(n * units[+us.value].mult); sel(); };
    inp.addEventListener('input', push); us.addEventListener('change', push);
    cb.addEventListener('click', () => { el._open = true; fill(); push(); box.hidden = false; inp.focus(); inp.select(); });
    fill();
  }
  sel();
}
const opts = arr => arr.map(([label, value]) => ({ label, value }));
function buildChips() {
  chipGroup($('#chipsClip'), {
    options: opts([['10s', 10], ['20s', 20], ['30s', 30], ['1 min', 60], ['2 min', 120], ['5 min', 300], ['10 min', 600], ['30 min', 1800]]),
    get: () => settings.clipSec, set: v => { settings.clipSec = v; save(); },
    units: [{ label: 'seconds', mult: 1 }, { label: 'minutes', mult: 60 }, { label: 'hours', mult: 3600 }]
  });
  chipGroup($('#chipsSession'), {
    options: opts([['∞ Unlimited', 0], ['30 min', 30], ['1 hour', 60], ['2 hours', 120], ['3 hours', 180], ['4 hours', 240], ['6 hours', 360], ['8 hours', 480]]),
    get: () => settings.sessionMin, set: v => { settings.sessionMin = v; save(); refreshForever(); },
    units: [{ label: 'minutes', mult: 1 }, { label: 'hours', mult: 60 }]
  });
  chipGroup($('#chipsCount'), {
    options: opts([['∞ Unlimited', 0], ['10', 10], ['25', 25], ['50', 50], ['100', 100], ['250', 250]]),
    get: () => settings.maxClips, set: v => { settings.maxClips = v; save(); refreshForever(); },
    units: [{ label: 'clips', mult: 1 }]
  });
  chipGroup($('#chipsTrans'), {
    options: [
      { head: 'Classic TV' },
      ...opts([['📺 Static TV', 'static'], ['💡 Flicker', 'flicker'], ['🎨 No signal', 'bars'], ['🌌 Dreamy', 'dream'], ['⬛ Fade', 'fade'],
        ['↕ Vertical hold', 'roll'], ['🟦 VCR blue screen', 'bluescreen'], ['📻 Tuning dial', 'tuner'], ['🧲 Degauss', 'degauss'], ['🎯 Test card', 'testcard'], ['⏪ VCR rewind', 'rewind'], ['✂️ Instant cut', 'cut']]),
      { head: '3D pack' },
      ...opts([['🎛 Remote click', 'remote'], ['🎬 Clapperboard', 'clap'], ['🔠 3D title', 'title3d'], ['🎲 Tumbling die', 'dice'], ['🧊 Cube turn', 'cube'], ['🃏 Card flip', 'flip'], ['💥 Shatter', 'shatter'], ['🌀 Star tunnel', 'tunnel']]),
      { head: 'Gamer pack' },
      ...opts([['👾 Glitch', 'glitch'], ['🧱 Pixel dissolve', 'pixel'], ['🔌 CRT power-off', 'crt'], ['🟩 Matrix rain', 'matrix'], ['⏳ Loading screen', 'loading'],
        ['🪙 Insert coin', 'coin'], ['🌆 Synthwave', 'synth'], ['🚀 Warp speed', 'warp'], ['🏓 Pong', 'pong'], ['⭕ Iris wipe', 'iris']]),
      { head: 'TV Guide pack (shows your video titles)' },
      ...opts([['📋 Channel guide', 'guide'], ['🔁 Channel surf', 'surf'], ['📣 Coming up next', 'upnext'], ['📟 Teletext', 'teletext'], ['📡 Please stand by', 'standby']]),
      { head: 'Mix it up (shuffles within a category)' },
      ...opts([['📺 Classic mix', 'classic'], ['🧊 3D mix', 'mix3d'], ['🎮 Gamer mix', 'gamer'], ['📋 TV Guide mix', 'tvmix'], ['🎲 Surprise me (all)', 'random']])
    ],
    get: () => settings.transition, set: v => { settings.transition = v; save(); }
  });
  chipGroup($('#chipsTransLen'), {
    options: opts([['0.5s', 500], ['1s', 1000], ['1.5s', 1500], ['2s', 2000], ['3s', 3000], ['5s', 5000]]),
    get: () => settings.transMs, set: v => { settings.transMs = v; save(); }
  });
  chipGroup($('#chipsBanner'), {
    options: opts([['🚫 Off', 'off'], ['📰 Lower third', 'lower'], ['🔔 Corner bug', 'bug'], ['📜 Bottom crawl', 'crawl'], ['🖼 Squeeze-back', 'squeeze'], ['🎨 Cartoon bumper', 'toon'],
      ['📼 VCR on-screen', 'vcr'], ['📺 Mini guide', 'strip'], ['🕹 Arcade stage', 'arcade'], ['🎲 Surprise me', 'random']]),
    get: () => settings.bannerStyle, set: v => { settings.bannerStyle = v; save(); ui(); }
  });
  chipGroup($('#chipsBannerSec'), {
    options: opts([['5s', 5], ['8s', 8], ['12s', 12], ['20s', 20]]),
    get: () => settings.bannerSec, set: v => { settings.bannerSec = v; save(); }
  });
  chipGroup($('#chipsFrame'), {
    options: Object.entries(FRAMES).map(([value, f]) => ({ label: f.label, value })),
    get: () => settings.frame, set: v => { settings.frame = v; save(); applyFrame(); }
  });
  chipGroup($('#chipsFilter'), {
    options: opts(FILTER_LABELS),
    get: () => settings.filter, set: v => { settings.filter = v; save(); applyFilter(); }
  });
  chipGroup($('#chipsFilterAmt'), {
    options: opts([['Light', 1], ['Medium', 2], ['Strong', 3]]),
    get: () => settings.filterAmt, set: v => { settings.filterAmt = v; save(); applyFilter(); }
  });
  chipGroup($('#chipsWxCorner'), {
    options: opts([['↖ Top left', 'tl'], ['↗ Top right', 'tr'], ['↙ Bottom left', 'bl'], ['↘ Bottom right', 'br']]),
    get: () => settings.wxCorner, set: v => { settings.wxCorner = v; save(); wxRender(); }
  });
  chipGroup($('#chipsWxUnit'), {
    options: opts([['°F / mph', 'f'], ['°C / km/h', 'c']]),
    get: () => settings.wxUnit, set: v => { settings.wxUnit = v; save(); wxRender(); wxStatusUpdate(); }
  });
  chipGroup($('#chipsWxStyle'), {
    options: opts([['Compact', 'compact'], ['Detailed', 'detailed']]),
    get: () => settings.wxStyle, set: v => { settings.wxStyle = v; save(); wxRender(); }
  });
  chipGroup($('#chipsFit'), {
    options: opts([['Fit (no cropping)', 'contain'], ['Fill (crop edges)', 'cover']]),
    get: () => settings.fit, set: v => { settings.fit = v; save(); stage.className = stage.className.replace(/fit-\w+/, 'fit-' + v); }
  });
}
function refreshForever() {
  const forever = !settings.sessionMin && !settings.maxClips;
  $('#foreverNote').textContent = forever ? '♾️ No limits: Dreamer runs until you press Stop.' : '';
  $('#btnForever').classList.toggle('on', forever);
}
$('#btnForever').addEventListener('click', e => {
  e.currentTarget.blur(); settings.sessionMin = 0; settings.maxClips = 0; save(); buildChips(); refreshForever();
});
$('#btnBannerPreview').addEventListener('click', e => { e.currentTarget.blur(); previewBanner(); });
$('#btnTransPreview').addEventListener('click', e => { e.currentTarget.blur(); previewTransition(); });
$('#btnWxLoc').addEventListener('click', e => { e.currentTarget.blur(); WX.msg = ''; wxLocate(); });
$('#btnWxFind').addEventListener('click', e => { e.currentTarget.blur(); wxFind(); });
$('#wxQuery').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); wxFind(); } });
function bindChecks() {
  const map = { '#optSub': 'subfolders', '#optFade': 'fadeEnd', '#optTransSound': 'transSound', '#optWake': 'wake', '#optBannerSound': 'bannerSound', '#optFrameFs': 'frameFs', '#optWx': 'wx' };
  for (const [sel, key] of Object.entries(map)) {
    const el = $(sel); el.checked = !!settings[key];
    el.addEventListener('change', () => {
      settings[key] = el.checked; save();
      if (key === 'subfolders' && (S.dirHandle || S.rawFiles)) { const was = S.running; if (was) stopSession(); rescan(); }
      if (key === 'wake') { if (el.checked && S.running) acquireWake(); else releaseWake(); }
      if (key === 'wx') {
        $('#wxBody').hidden = !el.checked; wxRender(); wxStatusUpdate();
        if (el.checked) { if (!WX.loc) { WX.msg = ''; wxLocate(); } else if (Date.now() - WX.last > 10 * 60000) wxRefresh(); }
      }
    });
  }
}

/* buttons + keys */
$('#btnPlay').addEventListener('click', e => { e.currentTarget.blur(); togglePause(); });      // idle: starts a session
$('#btnPause').addEventListener('click', e => { e.currentTarget.blur(); togglePause(); });
$('#btnPrev').addEventListener('click', e => { e.currentTarget.blur(); goPrev(); });
$('#btnSkip').addEventListener('click', e => { e.currentTarget.blur(); skip(); });
$('#btnStop').addEventListener('click', e => { e.currentTarget.blur(); stopSession(); });
$('#btnFull').addEventListener('click', e => { e.currentTarget.blur(); toggleFull(); });
$('#btnFolder').addEventListener('click', e => { e.currentTarget.blur(); chooseFolder(); });
$('#btnRescan').addEventListener('click', e => { e.currentTarget.blur(); if (S.running) stopSession(); rescan(); });
window.addEventListener('keydown', e => {
  const t = e.target, tag = t && t.tagName, ty = (t && t.type) || '';
  const toggleLike = tag === 'INPUT' && (ty === 'checkbox' || ty === 'radio' || ty === 'button');
  if (tag === 'SELECT' || tag === 'TEXTAREA' || (tag === 'INPUT' && !toggleLike)) return;   // typing or dragging a slider: leave the keys alone
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  if (toggleLike && k === ' ') return;                                                      // Space belongs to the checkbox you're on
  if (k === ' ' || k === 'k') { e.preventDefault(); togglePause(); }
  else if (k === 'n' || k === 'N' || k === 'ArrowRight') { e.preventDefault(); skip(); }
  else if (k === 'p' || k === 'P' || k === 'ArrowLeft') { e.preventDefault(); goPrev(); }
  else if (k === 'f' || k === 'F') { e.preventDefault(); toggleFull(); }
  else if (k === 'm' || k === 'M') { e.preventDefault(); toggleMute(); }
  else if (k === 'ArrowUp') { e.preventDefault(); setVolume(settings.volume + .05); }
  else if (k === 'ArrowDown') { e.preventDefault(); setVolume(settings.volume - .05); }
});

/* install + service worker */
let deferred = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; $('#btnInstall').hidden = false; });
$('#btnInstall').addEventListener('click', async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $('#btnInstall').hidden = true; });
window.addEventListener('appinstalled', () => { $('#btnInstall').hidden = true; });
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});

/* ------------------------------------------------------------------ boot */
async function boot() {
  stage.className = 'fit-' + settings.fit;
  if (!CLASSIC.concat(GAME, GUIDE, D3, ['cut', 'random', 'gamer', 'tvmix', 'classic', 'mix3d']).includes(settings.transition)) settings.transition = 'static';
  if (settings.bannerStyle !== 'off' && settings.bannerStyle !== 'random' && !BANNERS.includes(settings.bannerStyle)) settings.bannerStyle = 'off';
  if (!FRAMES[settings.frame]) settings.frame = 'clean';
  if (settings.filter !== 'off' && !FILTERS.includes(settings.filter)) settings.filter = 'off';
  if (!THEMES.some(t => t.id === settings.theme)) settings.theme = 'dream';
  buildThemes(); applyTheme();
  buildChips(); bindChecks(); syncVolumeUI(); refreshForever();
  applyFrame(); applyFilter();
  $('#wxBody').hidden = !settings.wx; wxRender(); wxStatusUpdate();
  if (settings.wx && WX.loc && Date.now() - WX.last > 10 * 60000) wxRefresh();
  ui();
  $('#browserNote').textContent = window.showDirectoryPicker
    ? 'Dreamer remembers your folder. Next time you may need to click Reconnect to re-allow access.'
    : "This browser can't remember folders between visits, so you'll re-pick it each time. Chrome or Edge can remember it.";
  if (window.showDirectoryPicker) {
    try {
      const h = await DB.get('dir');
      if (h) {
        const perm = await h.queryPermission({ mode: 'read' });
        if (perm === 'granted') { S.dirHandle = h; S.rootName = h.name; await rescan(); }
        else {
          const b = $('#btnReconnect'); b.hidden = false; b.textContent = `↻ Reconnect “${h.name}”`;
          b.onclick = async () => {
            try { if ((await h.requestPermission({ mode: 'read' })) === 'granted') await useHandle(h); } catch (e) { console.error(e); }
          };
        }
      }
    } catch (e) { console.warn(e); }
  }
}
window.Dreamer = { S, settings, tick, fx, t3, banner, WX, applyFrame, applyFilter, applyTheme, wxRender, goPrev, skip, togglePause, previewTransition };
boot();
})();
