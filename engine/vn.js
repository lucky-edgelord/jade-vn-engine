// vn-engine runtime core. Plain JS + MicroPython (WebAssembly) for the store and game logic.
// Loads game.json (compiled by tools/vnc.py), an optional sprite atlas and an optional packed audio bank.
// Optional parts are separate modules loaded the first time a game uses them:
//   fx.js     WebGL post-processing (glitch / mosh effects)   - first renpy.fx(), Glitch transition
//   light.js  2D lighting (LightMap displayable)               - first LightMap drawn
// Every engine file is resolved relative to this module, so the engine can be served from a CDN
// while the game's own files come from the page's folder.
import { loadMicroPython } from './vendor/micropython.mjs';

export const VERSION = '0.1.0';
const ENGINE = new URL('./', import.meta.url).href;
const mods = {};
function lazy(name) { return mods[name] || (mods[name] = import(ENGINE + name + '.js').catch((e) => { console.warn('vn: could not load ' + name, e); mods[name] = null; return null; })); }
let lightMod = null;
// interactive widgets: displayable kind -> lazy module. A module exports create(env, kind) -> instance with
// draw(g, spec, x, y, w, h, t, dt), and optional pointer(type, x, y) / key(type, key) returning true when handled.
const WIDGETS = { tilemap: 'tiles', mapview: 'tiles', tour: 'tour' };
const widgetMods = {}, widgetInst = {};
let widgetHits = [], kbWidget = null;
const dataCache = {};
function widgetEnv(inst) {
  return {
    W: () => W, H: () => H, now,
    // read game data registered with register_data() (maps, tours) once and cache it
    data(name) { if (!(name in dataCache)) { const r = JSON.parse(PY._eval(`_DATA.get(${JSON.stringify(name)})`)); dataCache[name] = r.ok ? r.v : null; } return dataCache[name]; },
    image: (src) => (typeof src === 'string' && atlas[src.split(':')[0]] ? null : fileImg(src)),
    sprite: (name) => spriteOf(name), sheets: () => sheets,
    drawDisp: (d, x, y, w, h) => drawDisp(d, x, y, w, h),
    light: () => lightMod || (lazy('light').then((m) => { lightMod = m; }), null),
    // send an event to the game: sets _widget_event, writes `state` back into the named store dict, runs the action
    emit(evt) {
      const sp = inst.spec || {};
      const lit = (v) => `json.loads(${JSON.stringify(JSON.stringify(v))})`;
      const name = JSON.stringify(sp.state_name || '');
      const st = evt.state ? `\nif ${name} in globals() and isinstance(globals()[${name}], dict): globals()[${name}].update(${lit(evt.state)})` : '';
      pyCall('_exec', `_widget_event = ${lit(evt)}${st}`);
      if (evt.quiet) { dirty = true; return; }
      runAction(inst.action);
    },
    redraw() { dirty = true; },
    sound: (n) => play('sound', n, {}),
  };
}
function drawWidget(d, x, y, w, h, action) {
  const name = WIDGETS[d.k];
  if (!widgetMods[name]) { widgetMods[name] = 'loading'; lazy(name).then((m) => { widgetMods[name] = m; dirty = true; }); }
  const m = widgetMods[name];
  if (!m || m === 'loading') { g.fillStyle = '#000'; g.fillRect(x, y, w, h); return null; }
  const id = d.k + ':' + (d.id || '');
  let inst = widgetInst[id];
  if (!inst) { inst = widgetInst[id] = { kind: d.k }; inst.obj = m.create(widgetEnv(inst), d.k); }
  inst.spec = d; inst.action = action; inst.r = [x, y, w, h];
  const t = now(); inst.obj.draw(g, d, x, y, w, h, t, Math.min(0.1, t - (inst.last || t))); inst.last = t;
  return inst;
}

const VN = (window.VN = window.VN || {});
VN.VERSION = VERSION; VN.ENGINE = ENGINE;
let W = 1280, H = 720;
let cv, out, g, G, PY = {}, mp;
let atlas = {}, sheets = [], aidx = {}, abuf = null, actx = null;
const files = {};                      // path -> Image
const VM = { pc: 0, stack: [], wait: null, label: null, running: false, ctx: 'menu' };
const layers = { master: [], overlay: [] };
let screens = [];                      // [{name, kind}] kind: shown|say|choice|call|menu|notify
let trees = {}, dirty = true, scrInfo = {};
let say = null;                        // {who, what, tok, shown, ...}
let snaps = [], cur = null;            // rollback history; cur = snapshot for the current interaction
let skip = false, auto = false, hideUI = false, voicePending = null;
let prefs = {}, cfg = {}, imgs = {}, persistDirty = false;
let seenLines = new Set();
const KEY = (k) => 'vn:' + (cfg.name || 'game') + ':' + k;
const now = () => performance.now() / 1000;
const T0 = now();
let lastFrame = now(), hover = null, press = null, mouse = [0, 0];
let trans = null, shake = null, notify = null;
const timers = {}, vports = {}, drags = {};
let clickables = [], keys = [];
let fx = null;

// ------------------------------------------------------------------ python bridge
function pyCall(fn, ...a) {
  const r = PY[fn](...a);
  drain();
  return r;
}
function pyJ(fn, ...a) { return JSON.parse(pyCall(fn, ...a)); }
function drain() {
  const c = JSON.parse(PY._drain());
  for (const x of c) command(x);
}
function command(c) {
  const [op, ...a] = c;
  if (op === 'notify') showNotify(a[0]);
  else if (op === 'play') play(a[0], a[1], a[2] || {});
  else if (op === 'stop') stop(a[0], a[1] || {});
  else if (op === 'refresh') dirty = true;
  else if (op === 'show_screen') showScreen(a[0], 'shown');
  else if (op === 'hide_screen') hideScreen(a[0]);
  else if (op === 'show_menu') { showScreen(a[0], 'menu'); }
  else if (op === 'shake') shake = { t0: now(), t: a[0], amp: a[1], axis: a[2] };
  else if (op === 'flash') startTrans({ k: 'fade', o: 0.05, h: 0, i: a[1], color: a[0] }, false);
  else if (op === 'fx') withFX((f) => f.set(a[0], a[1] || {}));
  else if (op === 'fx_off') { if (fx) fx.off(a[0]); }
  else if (op === 'analog') { analogWant = a[0]; applyAnalog(); }
  else if (op === 'save') saveSlot(a[0]);
  else if (op === 'load') loadSlot(a[0]);
  else if (op === 'delete_save') { localStorage.removeItem(KEY('slot:' + a[0])); dirty = true; }
  else if (op === 'rollback') rollback();
  else if (op === 'skip') { skip = !skip; auto = false; }
  else if (op === 'auto') { auto = !auto; skip = false; }
  else if (op === 'hide_ui') hideUI = true;
  else if (op === 'main_menu') mainMenu();
  else if (op === 'start') startGame(a[0]);
  else if (op === 'quit') mainMenu();
  else if (op === 'fullscreen') { try { document.fullscreenElement ? document.exitFullscreen() : out.requestFullscreen(); } catch (e) {} }
  else if (op === 'prefs') { prefs = pyJ('_prefs_dump'); try { localStorage.setItem(KEY('prefs'), JSON.stringify(prefs)); } catch (e) {} mixers(); dirty = true; }
  else if (op === 'channel') channels[a[0]] = Object.assign(channels[a[0]] || {}, a[1]);
}
// result of a guarded python call: {ok, v} or {ctl, arg}
function control(r) {
  if (!r || r.ok) return false;
  const k = r.ctl, a = r.arg;
  if (k === 'jump') { endCalls(); jumpLabel(a); return true; }
  if (k === 'call') { endCalls(); VM.stack.push(VM.pc); jumpLabel(a); return true; }
  if (k === 'return') { doReturn(a); return true; }
  if (k === 'say') { beginSay(JSON.parse(a[0]), null, VM.pc - 1); return true; }
  if (k === 'pause') { VM.wait = { kind: 'pause', until: a == null ? Infinity : now() + a }; return true; }
  return false;
}
function jumpLabel(l) {
  if (!(l in G.labels)) { error('no such label: ' + l); return; }
  VM.pc = G.labels[l]; VM.wait = null; say = null; dropTransient(); if (!VM.running) { VM.running = true; VM.ctx = 'game'; }
  setTimeout(run, 0);
}
function endCalls() { screens = screens.filter((s) => s.kind !== 'call' && s.kind !== 'menu'); dirty = true; }
function doReturn(v) {
  const w = VM.wait;
  if (w && w.kind === 'menu') { const i = v; hideScreen('choice'); say = null; dropKind('say'); VM.wait = null; VM.pc = w.targets[i]; run(); return; }
  if (w && w.kind === 'call') { hideScreen(w.name); pyCall('_set_return', JSON.stringify(v === undefined ? null : v)); VM.wait = null; run(); return; }
  const m = [...screens].reverse().find((s) => s.kind === 'menu');
  if (m) { hideScreen(m.name); return; }
}

// ------------------------------------------------------------------ boot
VN.boot = async function (opts = {}) {
  out = opts.canvas || document.querySelector('canvas');
  const base = opts.base || '';
  const status = (t) => { const c = out.getContext('2d'); if (!c) return; c.fillStyle = '#000'; c.fillRect(0, 0, out.width, out.height); c.fillStyle = '#ccc'; c.font = '24px sans-serif'; c.fillText(t, 30, 50); };
  try {
    status('loading…');
    const [game, prelude] = await Promise.all([xhr(base + 'game.json', 'json'), xhr(ENGINE + 'prelude.py', 'text')]);
    G = game;
    mp = await loadMicroPython({ heapsize: 16 * 1024 * 1024, stdout: (l) => console.log('[py]', l), stderr: (l) => console.warn('[py]', l) });
    mp.runPython(prelude);
    for (const f of ['_drain', '_exec', '_eval', '_evals', '_cond', '_say', '_menu', '_render', '_act', '_set_screen_args', '_store_dump', '_store_load',
      '_persist_dump', '_persist_load', '_prefs_dump', '_prefs_load', '_images_json', '_trans', '_screen_info', '_seen', '_set_return', '_config_json',
      '_history_add', '_history_pop', '_forget_scope']) PY[f] = mp.globals.get(f);
    try { const p = localStorage.getItem(KEY('persistent')); } catch (e) {}
    const r = JSON.parse(PY._exec(G.init)); if (!r.ok) throw new Error('init failed');
    drain();
    cfg = JSON.parse(PY._config_json());
    W = cfg.screen_width; H = cfg.screen_height;
    try { const p = localStorage.getItem(KEY('persistent')); if (p) PY._persist_load(p); } catch (e) { console.warn(e); }
    try { const p = localStorage.getItem(KEY('prefs')); if (p) PY._prefs_load(p); } catch (e) {}
    try { const s = localStorage.getItem(KEY('seen')); if (s) seenLines = new Set(JSON.parse(s)); } catch (e) {}
    prefs = pyJ('_prefs_dump');
    imgs = pyJ('_images_json');
    scrInfo = pyJ('_screen_info');
    await Promise.all([loadAtlas(base, cfg.atlas), loadAudio(base, cfg.audio_pack), loadFonts(base, cfg.fonts)]);
    cv = document.createElement('canvas'); cv.width = W; cv.height = H; g = cv.getContext('2d');
    out.width = W; out.height = H;
    out.__ctx2d = out.getContext('2d');
    input();
    VN.state = { VM, screens: () => screens, layers, say: () => say, py: (c) => JSON.parse(PY._eval(c)), exec: (c) => control(JSON.parse(pyCall('_exec', c))), trees: () => trees, fx: () => fx, cfg: () => cfg };
    mainMenu();
    requestAnimationFrame(frame);
  } catch (e) { console.error(e); status('error: ' + e.message); VN.error = String(e); }
};
function error(m) { console.error(m); VN.error = m; showNotify('error: ' + m); }
function xhr(u, type) {
  return new Promise((ok, no) => {
    const x = new XMLHttpRequest(); x.open('GET', u); x.responseType = type;
    x.onload = () => ((x.status === 200 || x.status === 0) && x.response != null ? ok(x.response) : no(new Error(u + ' ' + x.status)));
    x.onerror = () => no(new Error('net ' + u)); x.send();
  });
}
async function loadAtlas(base, name) {
  if (!name) return;
  try { atlas = await xhr(base + name, 'json'); } catch (e) { return; }
  let n = 0; for (const k in atlas) for (const f of atlas[k].frames) n = Math.max(n, f.s + 1);
  const ext = atlas.__ext || 'avif';
  sheets = await Promise.all([...Array(n)].map((_, i) => imgLoad(base + 'art' + i + '.' + (atlas.__exts ? atlas.__exts[i] : ext))));
}
async function loadAudio(base, name) {
  if (!name) return;
  try { aidx = await xhr(base + name, 'json'); } catch (e) { return; }
  VN._audioBase = base;
}
async function loadFonts(base, fonts) {
  // config.fonts = {"Family": "file.woff2"} or {"Family": [{"src": "a.woff2", "weight": "700", "style": "italic"}, ...]}
  const jobs = [];
  for (const k in fonts || {}) {
    const list = Array.isArray(fonts[k]) ? fonts[k] : [typeof fonts[k] === 'string' ? { src: fonts[k] } : fonts[k]];
    for (const v of list) jobs.push((async () => { try { const f = new FontFace(k, 'url(' + base + v.src + ')', { weight: v.weight || 'normal', style: v.style || 'normal' }); await f.load(); document.fonts.add(f); } catch (e) { console.warn('font', k, e); } })());
  }
  await Promise.all(jobs);
}
function imgLoad(u) { return new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('image ' + u)); i.src = u; }); }
function fileImg(p) {
  if (files[p]) return files[p].ready ? files[p] : null;
  const i = new Image(); files[p] = i; i.onload = () => { i.ready = true; dirty = true; }; i.src = p; return null;
}

// ------------------------------------------------------------------ main menu / start
// call a store function if the game defines one (on_rollback, on_skip, ...)
function hook(name, arg) { try { const r = JSON.parse(pyCall('_exec', `if '${name}' in globals() and ${name}: ${name}(${arg === undefined ? '' : JSON.stringify(arg)})`)); control(r); } catch (e) { console.warn(e); } dirty = true; }
let lastSkip = false;
function mainMenu() {
  VM.running = false; VM.wait = null; VM.ctx = 'menu'; VM.stack = []; say = null; snaps = []; cur = null;
  layers.master = []; screens = []; stopAll(); dirty = true;
  if (cfg.main_menu_label && G.labels[cfg.main_menu_label] != null) { startGame(cfg.main_menu_label, true); return; }
  if (scrInfo.main_menu) { showScreen('main_menu', 'menu'); if (cfg.main_menu_music) play('music', cfg.main_menu_music, { loop: true }); }
  else startGame(cfg.start_label || 'start');
}
function startGame(label, keepMenu) {
  screens = keepMenu ? screens : [];
  layers.master = []; say = null; snaps = []; VM.stack = [];
  const r = JSON.parse(pyCall('_exec', G.defaults)); if (!r.ok) error('defaults failed');
  VM.running = true; VM.ctx = 'game'; VM.wait = null; VM.pc = G.labels[label || 'start'] ?? 0;
  stop('music', { fadeout: 0.5 }); dirty = true; run();
}

// ------------------------------------------------------------------ VM
function run() {
  let n = 0;
  while (VM.running && !VM.wait && n++ < 50000) {
    const pc = VM.pc, op = G.code[VM.pc++];
    if (!op) { mainMenu(); return; }
    try { step(op, pc); } catch (e) { error(`op ${pc} ${op[0]}: ${e.message || e}`); VM.wait = { kind: 'error' }; }
  }
  dirty = true;
}
function evalPy(x) { const r = JSON.parse(pyCall('_eval', x)); if (r.ok) return r.v; control(r); return undefined; }
function val(v) { return v && typeof v === 'object' && 'e' in v ? evalPy(v.e) : v; }
function step(op, pc) {
  switch (op[0]) {
    case 'label': VM.label = op[1]; pyCall('_seen', op[1]); break;
    case 'say': {
      const info = JSON.parse(pyCall('_say', op[1], op[2], true));
      beginSay(info, op[3], pc);
      if (op[4]) startTrans(JSON.parse(pyCall('_trans', op[4])), false);
      break;
    }
    case 'py': { const r = JSON.parse(pyCall('_exec', op[1])); if (!r.ok) control(r); break; }
    case 'jf': if (!pyCall('_cond', op[1])) VM.pc = op[2]; break;
    case 'jmp': VM.pc = op[1]; break;
    case 'jmpl': VM.pc = G.labels[op[1]]; break;
    case 'jmpx': { const l = evalPy(op[1]); if (!(l in G.labels)) throw new Error('no label ' + l); VM.pc = G.labels[l]; break; }
    case 'call': VM.stack.push(VM.pc); VM.pc = G.labels[op[1]]; break;
    case 'callx': { const l = evalPy(op[1]); VM.stack.push(VM.pc); VM.pc = G.labels[l]; break; }
    case 'ret': if (op[1]) pyCall('_exec', '_return = ' + op[1]); if (VM.stack.length) VM.pc = VM.stack.pop(); else mainMenu(); break;
    case 'menu': beginMenu(op, pc); break;
    case 'scene': layers[op[1].layer || 'master'] = []; if (op[1].img || op[1].expr) showImage(op[1]); break;
    case 'show': showImage(op[1]); break;
    case 'hide': layers[op[2] || 'master'] = (layers[op[2] || 'master'] || []).filter((x) => x.tag !== op[1]); break;
    case 'with': { const t = JSON.parse(pyCall('_trans', op[1])); if (t) startTrans(t, !skip); break; }
    case 'play': play(op[1], val(op[2]), Object.fromEntries(Object.entries(op[3] || {}).map(([k, v]) => [k, val(v)]))); break;
    case 'stop': stop(op[1], op[2] || {}); break;
    case 'voice': voicePending = val(op[1]); break;
    case 'pause': snapshot(pc); VM.wait = { kind: 'pause', until: op[1] == null ? Infinity : now() + (skip ? 0 : op[1]) }; break;
    case 'window': VM.window = op[1] !== 'hide'; break;
    case 'sshow': if (op[2]) pyCall('_set_screen_args', op[1], JSON.stringify(evalPy(op[2]))); else pyCall('_set_screen_args', op[1], ''); showScreen(op[1], 'shown'); if (op[3]) startTrans(JSON.parse(pyCall('_trans', op[3])), false); break;
    case 'shide': hideScreen(op[1]); if (op[2]) startTrans(JSON.parse(pyCall('_trans', op[2])), false); break;
    case 'scall':
      snapshot(pc);
      pyCall('_set_screen_args', op[1], op[2] ? JSON.stringify(evalPy(op[2])) : '');
      PY._forget_scope(op[1]);
      showScreen(op[1], 'call'); VM.wait = { kind: 'call', name: op[1] }; say = null; dropKind('say');
      if (op[3]) startTrans(JSON.parse(pyCall('_trans', op[3])), false);
      break;
    case 'end': mainMenu(); break;
    default: throw new Error('unknown op ' + op[0]);
  }
}

// ------------------------------------------------------------------ interactions: say / menu
function beginSay(info, lineId, pc) {
  snapshot(pc);
  const what = info.what;
  say = { info, lineId, tok: parseText(what), shown: 0, pos: 0, t: now(), waitUntil: 0, done: false, acc: 0, cps: prefs.text_cps || 45 };
  pyCall('_set_screen_args', 'say', JSON.stringify({ who: info.who, what }));
  PY._history_add(info.who, stripTags(what));
  dropKind('say'); showScreen('say', 'say');
  if (voicePending) { stop('voice'); play('voice', voicePending, {}); voicePending = null; } else if (!skip) stop('voice');
  say.seen = lineId ? seenLines.has(lineId) : true;
  if (lineId) { seenLines.add(lineId); persistDirty = true; }
  VM.wait = { kind: 'say' };
}
function beginMenu(op, pc) {
  snapshot(pc);
  if (op[2]) {
    const s = op[2]; const info = JSON.parse(pyCall('_say', s[1], s[2], true));
    say = { info, tok: parseText(info.what), shown: 1e9, done: true, t: now(), menu: true };
    pyCall('_set_screen_args', 'say', JSON.stringify({ who: info.who, what: info.what })); showScreen('say', 'say');
  }
  const vis = JSON.parse(pyCall('_menu', JSON.stringify(op[1].map((x) => [x[0], x[1]]))));
  const targets = {}; vis.forEach((i) => (targets[i] = op[1][i][2]));
  showScreen('choice', 'choice'); skip = false;
  VM.wait = { kind: 'menu', targets };
}
function advance() {
  const w = VM.wait; if (!w) return;
  if (w.kind === 'say') {
    if (!say.done) { revealToWait(); return; }
    finishSay(); return;
  }
  if (w.kind === 'pause') { VM.wait = null; run(); return; }
  if (w.kind === 'with') { trans = null; VM.wait = null; run(); }
}
function finishSay() {
  if (!skip) play('sound', '__click__', {});
  say = null; dropKind('say'); VM.wait = null; run();
}

// ------------------------------------------------------------------ rollback / save / load
function snapshot(pc) {
  cur = {
    pc, stack: [...VM.stack], label: VM.label, layers: JSON.parse(JSON.stringify(layers, (k, v) => (k === 'st' ? undefined : v))),
    screens: screens.filter((s) => s.kind === 'shown').map((s) => s.name), music: musicState(),
    store: PY._store_dump(), when: Date.now(),
  };
  snaps.push(cur); if (snaps.length > 100) snaps.shift();
  try { if (persistDirty) { localStorage.setItem(KEY('persistent'), PY._persist_dump()); localStorage.setItem(KEY('seen'), JSON.stringify([...seenLines])); persistDirty = false; } } catch (e) {}
}
function restore(s) {
  VM.running = true; VM.ctx = 'game'; VM.wait = null; say = null; trans = null;
  VM.pc = s.pc; VM.stack = [...s.stack]; VM.label = s.label;
  layers.master = s.layers.master || []; layers.overlay = s.layers.overlay || [];
  for (const L of Object.values(layers)) for (const x of L) x.t0 = now();
  screens = s.screens.map((n) => ({ name: n, kind: 'shown' }));
  pyCall('_store_load', s.store);
  restoreMusic(s.music); dirty = true;
}
function rollback() {
  if (VM.ctx !== 'game' || snaps.length < 2) return;
  snaps.pop(); const s = snaps.pop(); PY._history_pop(); PY._history_pop();
  skip = false; restore(s); hook('on_rollback'); run();
}
function saveSlot(slot) {
  if (!cur) return;
  const thumb = document.createElement('canvas'); thumb.width = 192; thumb.height = Math.round(192 * H / W);
  try { thumb.getContext('2d').drawImage(cv, 0, 0, thumb.width, thumb.height); } catch (e) {}
  const meta = { when: Date.now(), label: cur.label, text: say ? stripTags(say.info.what).slice(0, 80) : '', thumb: thumb.toDataURL('image/jpeg', 0.6) };
  try { localStorage.setItem(KEY('slot:' + slot), JSON.stringify({ meta, snap: cur })); showNotify('Saved'); } catch (e) { showNotify('Save failed: ' + e.message); }
  dirty = true;
}
function loadSlot(slot) {
  let d; try { d = JSON.parse(localStorage.getItem(KEY('slot:' + slot))); } catch (e) {}
  if (!d) { showNotify('Empty slot'); return; }
  screens = []; pyCall('_exec', G.defaults); restore(d.snap); snaps = [d.snap]; run();
}
VN.slots = () => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith(KEY('slot:'))) { try { o[k.slice(KEY('slot:').length)] = JSON.parse(localStorage.getItem(k)).meta; } catch (e) {} } } return o; };

// ------------------------------------------------------------------ images on layers
function showImage(spec) {
  const L = layers[spec.layer || 'master'] || (layers[spec.layer] = []);
  let name = spec.img, disp;
  if (spec.expr) { disp = evalPy(spec.expr); name = typeof disp === 'string' ? disp : null; }
  const tag = spec.tag || (name ? name.split(' ')[0] : 'expr');
  if (name) disp = resolveName(name, tag, L);
  let e = L.find((x) => x.tag === tag);
  const at = spec.at ? spec.at : null;
  if (e) { e.disp = disp; e.name = name; if (at) { e.at = at; e.t0 = now(); } }
  else { e = { tag, name, disp, at: at || [], t0: now(), z: spec.zorder || 0 }; L.push(e); }
  if (spec.zorder != null) e.z = spec.zorder;
  if (spec.behind) { const i = L.indexOf(e); L.splice(i, 1); const j = L.findIndex((x) => spec.behind.includes(x.tag)); L.splice(j < 0 ? L.length : j, 0, e); }
  L.sort((a, b) => a.z - b.z);
}
function resolveName(name, tag, L) {
  if (imgs[name]) return imgs[name];
  // attribute replacement: "lneta lean" when only "lneta lean" exists, or the tag plus new attributes
  const keys = Object.keys(imgs).filter((k) => k.split(' ')[0] === tag);
  const want = name.split(' ').slice(1);
  const hit = keys.find((k) => want.every((w) => k.split(' ').includes(w)));
  if (hit) return imgs[hit];
  return name;
}

// ------------------------------------------------------------------ screens
function showScreen(name, kind) {
  if (!scrInfo[name] && kind !== 'say') { if (name !== 'say' && name !== 'choice') error('no screen ' + name); }
  const tag = scrInfo[name] ? scrInfo[name].tag : name;
  screens = screens.filter((s) => s.name !== name && !(scrInfo[s.name] && scrInfo[s.name].tag === tag && tag !== s.name));
  screens.push({ name, kind, t0: now() }); dirty = true;
}
function hideScreen(name) { screens = screens.filter((s) => s.name !== name); dirty = true; PY._forget_scope(name); }
function dropKind(k) { screens = screens.filter((s) => s.kind !== k); dirty = true; }
function dropTransient() { screens = screens.filter((s) => s.kind === 'shown' || s.kind === 'menu'); dirty = true; }
function orderedScreens() {
  return screens.map((s, i) => [s, i]).sort((a, b) => ((scrInfo[a[0].name] || {}).zorder || 0) - ((scrInfo[b[0].name] || {}).zorder || 0) || a[1] - b[1]).map((x) => x[0]);
}
function renderScreens() {
  const names = orderedScreens().map((s) => s.name).filter((n) => scrInfo[n]);
  trees = JSON.parse(pyCall('_render', JSON.stringify(names)));
  dirty = false;
}

// ------------------------------------------------------------------ lazy WebGL effects
// The visible canvas stays 2D; the first effect loads fx.js and lays a WebGL canvas over it,
// shown only while an effect is running.
let fxCanvas = null, fxWait = null;
function withFX(f) {
  if (prefs.fx === false) return;
  if (fx) { f(fx); return; }
  if (fxWait) { fxWait.push(f); return; }
  fxWait = [f];
  lazy('fx').then((m) => {
    if (!m) { fxWait = null; return; }
    fxCanvas = document.createElement('canvas'); fxCanvas.width = W; fxCanvas.height = H;
    fxCanvas.className = out.className; fxCanvas.style.cssText = out.style.cssText; fxCanvas.style.display = 'none';
    fxCanvas.style.pointerEvents = 'none'; fxCanvas.style.position = 'absolute'; fxCanvas.style.left = '0'; fxCanvas.style.top = '0';
    out.parentNode.insertBefore(fxCanvas, out.nextSibling);
    fx = m.FX.create(fxCanvas, cv);
    const q = fxWait; fxWait = null; if (fx) q.forEach((g) => g(fx));
  });
}

// ------------------------------------------------------------------ transitions & effects
function startTrans(t, blocking) {
  if (!t) return;
  if (t.k === 'multi') { for (const x of t.list) startTrans(x, false); if (blocking) VM.wait = { kind: 'with', until: now() + Math.max(...t.list.map(dur)) }; return; }
  if (t.k === 'shake') { shake = { t0: now(), t: t.t, amp: t.amp, axis: t.axis }; }
  else {
    const old = document.createElement('canvas'); old.width = W; old.height = H; old.getContext('2d').drawImage(cv, 0, 0);
    trans = Object.assign({ t0: now(), old }, t);
    if (t.k === 'glitch') withFX((f) => f.pulse('glitch', t.t, t.s || 1));
  }
  if (blocking && !skip) VM.wait = { kind: 'with', until: now() + dur(t) };
}
function dur(t) { return t.k === 'fade' ? t.o + t.h + t.i : t.t || 0; }
function drawTrans() {
  if (!trans) return;
  const p = now() - trans.t0;
  if (trans.k === 'dissolve' || trans.k === 'glitch') {
    const a = 1 - p / trans.t; if (a <= 0) { trans = null; return; }
    g.globalAlpha = a; g.drawImage(trans.old, 0, 0); g.globalAlpha = 1;
  } else if (trans.k === 'fade') {
    const { o, h, i, color } = trans;
    if (p < o) { g.drawImage(trans.old, 0, 0); g.globalAlpha = p / o; g.fillStyle = color; g.fillRect(0, 0, W, H); g.globalAlpha = 1; }
    else if (p < o + h) { g.fillStyle = color; g.fillRect(0, 0, W, H); }
    else if (p < o + h + i) { g.globalAlpha = 1 - (p - o - h) / i; g.fillStyle = color; g.fillRect(0, 0, W, H); g.globalAlpha = 1; }
    else trans = null;
  } else trans = null;
}
function showNotify(m) {
  if (scrInfo.notify) { pyCall('_set_screen_args', 'notify', JSON.stringify({ message: m })); showScreen('notify', 'notify'); notify = { t: now() + 2.6 }; }
  else notify = { t: now() + 2.6, m };
}

// ------------------------------------------------------------------ ATL
const WARP = {
  linear: (t) => t, ease: (t) => 0.5 - Math.cos(Math.PI * t) / 2, easein: (t) => 1 - Math.cos((t * Math.PI) / 2), easeout: (t) => Math.sin((t * Math.PI) / 2),
  ease_quad: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2), ease_back: (t) => { const c = 1.70158; return t * t * ((c + 1) * t - c); },
  ease_bounce: (t) => { const n = 7.5625, d = 2.75; if (t < 1 / d) return n * t * t; if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75; if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375; return n * (t -= 2.625 / d) * t + 0.984375; },
  ease_elastic: (t) => (t === 0 || t === 1 ? t : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
};
const BUILTIN_AT = {
  left: { xpos: 0, xanchor: 0, ypos: 1, yanchor: 1 }, right: { xpos: 1, xanchor: 1, ypos: 1, yanchor: 1 }, center: { xpos: 0.5, xanchor: 0.5, ypos: 1, yanchor: 1 },
  truecenter: { xpos: 0.5, xanchor: 0.5, ypos: 0.5, yanchor: 0.5 }, topleft: { xpos: 0, xanchor: 0, ypos: 0, yanchor: 0 }, topright: { xpos: 1, xanchor: 1, ypos: 0, yanchor: 0 },
  top: { xpos: 0.5, xanchor: 0.5, ypos: 0, yanchor: 0 },
  offscreenleft: { xpos: 0, xanchor: 1, ypos: 1, yanchor: 1 }, offscreenright: { xpos: 1, xanchor: 0, ypos: 1, yanchor: 1 },
  default: { xpos: 0.5, xanchor: 0.5, ypos: 1, yanchor: 1 },
};
const ALIAS = { xalign: ['xpos', 'xanchor'], yalign: ['ypos', 'yanchor'], xcenter: ['xpos'], ycenter: ['ypos'] };
function setP(P, k, v) {
  if (k === 'align' && Array.isArray(v)) { setP(P, 'xalign', v[0]); setP(P, 'yalign', v[1]); return; }
  if (k === 'pos' && Array.isArray(v)) { P.xpos = v[0]; P.ypos = v[1]; return; }
  if (k === 'anchor' && Array.isArray(v)) { P.xanchor = v[0]; P.yanchor = v[1]; return; }
  if (k === 'xcenter') { P.xpos = v; P.xanchor = 0.5; return; }
  if (k === 'ycenter') { P.ypos = v; P.yanchor = 0.5; return; }
  if (ALIAS[k]) { for (const a of ALIAS[k]) P[a] = v; return; }
  P[k] = v;
}
function atlNum(v) { return v && typeof v === 'object' && 'e' in v ? Number(evalPy(v.e)) : v; }
// run steps for elapsed time t, mutating props; returns {used, done}
function atlRun(steps, t, P, depth = 0) {
  let time = 0;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.set) { for (const k in s.set) setP(P, k, atlNum(s.set[k])); continue; }
    if (s.show !== undefined) { P.__child = s.show; continue; }
    if (s.pause !== undefined) { const d = atlNum(s.pause); if (t - time < d) return { used: t, done: false }; time += d; continue; }
    if (s.interp) {
      const d = atlNum(s.t), f = WARP[s.interp] || WARP.linear, p = d > 0 ? Math.min(1, (t - time) / d) : 1;
      for (const k0 in s.props) {
        const to = atlNum(s.props[k0]);
        if (typeof to !== 'number') { if (p >= 1) setP(P, k0, to); continue; }
        const ks = ALIAS[k0] && k0 !== 'xcenter' && k0 !== 'ycenter' ? ALIAS[k0] : [k0 === 'xcenter' ? 'xpos' : k0 === 'ycenter' ? 'ypos' : k0];
        for (const k of ks) { const from = typeof P[k] === 'number' ? P[k] : defProp(k); P[k] = from + (to - from) * f(Math.max(0, p)); }
        if (k0 === 'xcenter') P.xanchor = 0.5; if (k0 === 'ycenter') P.yanchor = 0.5;
      }
      if (t - time < d) return { used: t, done: false };
      time += d; continue;
    }
    if (s.block) { const r = atlRun(s.block, t - time, P, depth + 1); if (!r.done) return { used: t, done: false }; time += r.used; continue; }
    if (s.repeat !== undefined) {
      const cyc = time; if (cyc <= 0) return { used: t, done: false };
      const n = s.repeat; const k = Math.floor(t / cyc);
      if (n == null || k < n) return atlRun(steps.slice(0, i), t - k * cyc, P, depth);
      continue;
    }
  }
  return { used: time, done: true };
}
function defProp(k) { return { zoom: 1, xzoom: 1, yzoom: 1, alpha: 1, rotate: 0, xoffset: 0, yoffset: 0 }[k] ?? 0; }
function atlProps(names, t0, init) {
  const P = Object.assign({}, init || {});
  for (const n of names || []) {
    if (BUILTIN_AT[n]) Object.assign(P, BUILTIN_AT[n]);
    else if (G.transforms[n]) atlRun(G.transforms[n], now() - t0, P);
    else if (typeof n === 'object' && n) Object.assign(P, n);
  }
  return P;
}

// ------------------------------------------------------------------ displayables
function spriteOf(name) {
  if (typeof name !== 'string') return null;
  let n = name, fi = 0; const m = /^(.*):(\d+)$/.exec(name); if (m) { n = m[1]; fi = +m[2]; }
  const s = atlas[n]; if (!s) return null; return { s, f: s.frames[fi] || s.frames[0], fi };
}
function dispSize(d, box) {
  if (d == null) return [0, 0];
  if (typeof d === 'string') {
    if (imgs[d] && imgs[d] !== d) return dispSize(imgs[d], box);
    const sp = spriteOf(d); if (sp) return [sp.s.w, sp.s.h];
    if (/\.\w+$/.test(d) || d.startsWith('data:')) { const i = fileImg(d); return i ? [i.naturalWidth, i.naturalHeight] : [0, 0]; }
    return [0, 0];
  }
  if (d.k === 'solid' || d.k === 'grad' || d.k === 'radial' || d.k === 'lightmap' || WIDGETS[d.k]) return d.xysize || [box ? box[2] : W, box ? box[3] : H];
  if (d.k === 'img') { const i = fileImg(d.src); return i ? [i.naturalWidth, i.naturalHeight] : [0, 0]; }
  if (d.k === 'xf') { const s = dispSize(d.child, box); return [s[0] * (d.zoom || 1), s[1] * (d.zoom || 1)]; }
  if (d.k === 'atl') { const P = {}; atlRun(G.transforms[d.atl] || [], now() - T0, P); return dispSize(P.__child, box); }
  if (d.k === 'text') { const L = textLayout(d.v, styleOf(d), d.xmaximum || W); return [L.w, L.h]; }
  return [0, 0];
}
function drawDisp(d, x, y, w, h, t0) {
  if (d == null) return;
  if (typeof d === 'string') {
    if (imgs[d] && imgs[d] !== d) return drawDisp(imgs[d], x, y, w, h, t0);
    const sp = spriteOf(d);
    if (sp) { const f = sp.f, sx = w / sp.s.w, sy = h / sp.s.h; if (f.dw > 1 || f.dh > 1) g.drawImage(sheets[f.s], f.x, f.y, f.w, f.h, x + f.ox * sx, y + f.oy * sy, f.dw * sx, f.dh * sy); return; }
    if (/\.\w+$/.test(d) || d.startsWith('data:')) { const i = fileImg(d); if (i) g.drawImage(i, x, y, w, h); }
    return;
  }
  if (d.k === 'solid') { g.fillStyle = cssColor(d.color); if (d.radius === 'circle') { g.beginPath(); g.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, 7); g.fill(); } else g.fillRect(x, y, w, h); return; }
  if (d.k === 'radial') {   // elliptical, fitted to the box, so it never shows a hard edge
    const gr = g.createRadialGradient(0, 0, 0, 0, 0, 1);
    for (const [o, c] of d.stops) gr.addColorStop(o, cssColor(c));
    g.save(); g.translate(x + w / 2, y + h / 2); g.scale(w / 2, h / 2); g.fillStyle = gr; g.fillRect(-1, -1, 2, 2); g.restore(); return;
  }
  if (d.k === 'grad') {
    const gr = d.vertical === false ? g.createLinearGradient(x, 0, x + w, 0) : g.createLinearGradient(0, y, 0, y + h);
    for (const [o, c] of d.stops) gr.addColorStop(o, cssColor(c)); g.fillStyle = gr; g.fillRect(x, y, w, h); return;
  }
  if (d.k === 'img') { const i = fileImg(d.src); if (i) g.drawImage(i, x, y, w, h); return; }
  if (d.k === 'lightmap') {
    if (!lightMod) { lazy('light').then((m) => { lightMod = m; dirty = true; }); g.fillStyle = cssColor(d.ambient || '#000'); g.globalAlpha *= d.dark ?? 0.7; g.fillRect(x, y, w, h); g.globalAlpha = 1; return; }
    const m = g.getTransform(); lightMod.drawLightMap(g, d, m.e + x, m.f + y, w, h, now(), W, H); return;
  }
  if (d.k === 'xf') { g.save(); if (d.alpha != null) g.globalAlpha *= d.alpha; if (d.blend) g.globalCompositeOperation = BLEND[d.blend] || d.blend; drawDisp(d.child, x, y, w, h, t0); g.restore(); return; }
  if (d.k === 'atl') { const P = {}; atlRun(G.transforms[d.atl] || [], now() - (t0 || T0), P); drawDisp(P.__child, x, y, w, h, t0); return; }
  if (d.k === 'text') { drawText(textLayout(d.v, styleOf(d), d.xmaximum || w || W), x, y, 1e9, styleOf(d)); }
}
const BLEND = { multiply: 'multiply', screen: 'screen', add: 'lighter', additive: 'lighter', overlay: 'overlay', normal: 'source-over', darken: 'darken', lighten: 'lighten', color: 'color', 'color-dodge': 'color-dodge', hue: 'hue', saturation: 'saturation', difference: 'difference' };
function cssColor(c) {
  if (typeof c !== 'string') return '#000';
  const m = /^#([0-9a-f]{3,4})$/i.exec(c); if (m) { const h = m[1]; return '#' + [...h].map((x) => x + x).join(''); }
  return c;
}
// a positioned, transformed image on a layer
function drawPlaced(d, P, t0, box) {
  const [bx, by, bw, bh] = box || [0, 0, W, H];
  if (P.__child !== undefined && P.__child !== null) d = P.__child;
  const [iw, ih] = dispSize(d, box);
  let w = (P.xsize ?? iw) * (P.zoom ?? 1) * (P.xzoom ?? 1), h = (P.ysize ?? ih) * (P.zoom ?? 1) * (P.yzoom ?? 1);
  const xpos = P.xpos ?? 0, ypos = P.ypos ?? 0, xan = P.xanchor ?? 0, yan = P.yanchor ?? 0;
  const x = bx + rel(xpos, bw) - rel(xan, w) + (P.xoffset || 0), y = by + rel(ypos, bh) - rel(yan, h) + (P.yoffset || 0);
  g.save();
  if (P.alpha != null) g.globalAlpha *= Math.max(0, Math.min(1, P.alpha));
  if (P.blend) g.globalCompositeOperation = BLEND[P.blend] || P.blend;
  const filt = [];
  if (P.brightness != null) filt.push(`brightness(${1 + P.brightness})`);
  if (P.blur) filt.push(`blur(${P.blur}px)`);
  if (P.saturate != null) filt.push(`saturate(${P.saturate})`);
  if (filt.length) g.filter = filt.join(' ');
  if (P.rotate) { g.translate(x + w / 2, y + h / 2); g.rotate((P.rotate * Math.PI) / 180); g.translate(-(x + w / 2), -(y + h / 2)); }
  if (P.tint) drawTinted(d, x, y, w, h, P.tint, t0); else drawDisp(d, x, y, w, h, t0);
  g.restore();
  return [x, y, w, h];
}
function rel(v, s) { return num(v, s); }
const tintCache = new Map();
function drawTinted(d, x, y, w, h, tint, t0) {
  const key = JSON.stringify(d) + tint + w + 'x' + h;
  let c = tintCache.get(key);
  if (!c) {
    c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
    const gg = c.getContext('2d'), save = g; g = gg; drawDisp(d, 0, 0, c.width, c.height, t0); g = save;
    gg.globalCompositeOperation = 'multiply'; gg.fillStyle = tint; gg.fillRect(0, 0, c.width, c.height);
    gg.globalCompositeOperation = 'destination-in'; g = gg; drawDisp(d, 0, 0, c.width, c.height, t0); g = save;
    if (tintCache.size > 64) tintCache.clear(); tintCache.set(key, c);
  }
  g.drawImage(c, x, y, w, h);
}

// ------------------------------------------------------------------ text: tags, layout, typewriter
function stripTags(s) { return String(s || '').replace(/\{[^{}]*\}/g, ''); }
function parseText(s) {
  // -> tokens: {c, st} chars, {w:t} waits, {nw}, {fast}
  const out = [], stack = [{}]; let i = 0; s = String(s ?? '');
  while (i < s.length) {
    if (s[i] === '{' && s[i + 1] === '{') { out.push({ c: '{', st: stack[stack.length - 1] }); i += 2; continue; }
    if (s[i] === '{') {
      const j = s.indexOf('}', i); if (j < 0) { out.push({ c: s[i], st: stack[stack.length - 1] }); i++; continue; }
      const tag = s.slice(i + 1, j); i = j + 1;
      const [name, arg] = tag.split('=');
      const top = stack[stack.length - 1];
      if (name === 'w') out.push({ w: arg ? parseFloat(arg) : Infinity });
      else if (name === 'p') { out.push({ w: arg ? parseFloat(arg) : Infinity }); out.push({ c: '\n', st: top }); }
      else if (name === 'nw') out.push({ nw: true });
      else if (name === 'fast') out.push({ fast: true });
      else if (name[0] === '/') { if (stack.length > 1) stack.pop(); }
      else if (name === 'b') stack.push(Object.assign({}, top, { b: true }));
      else if (name === 'i') stack.push(Object.assign({}, top, { i: true }));
      else if (name === 'u') stack.push(Object.assign({}, top, { u: true }));
      else if (name === 'color') stack.push(Object.assign({}, top, { color: arg }));
      else if (name === 'alpha') stack.push(Object.assign({}, top, { alpha: parseFloat(arg) }));
      else if (name === 'size') stack.push(Object.assign({}, top, { size: arg }));
      else if (name === 'cps') stack.push(Object.assign({}, top, { cps: arg }));
      else if (name === 'shake') stack.push(Object.assign({}, top, { shake: parseFloat(arg || '2') }));
      else if (name === 'wave') stack.push(Object.assign({}, top, { wave: parseFloat(arg || '3') }));
      else if (name === 'glitch') stack.push(Object.assign({}, top, { glitch: parseFloat(arg || '1') }));
      else stack.push(Object.assign({}, top));
      continue;
    }
    out.push({ c: s[i], st: stack[stack.length - 1] }); i++;
  }
  return out;
}
function styleOf(n) {
  return {
    font: n.font || (n.text_font) || cfg.__font || guiGet('font'), size: n.size || n.text_size || guiGet('text_size'), color: n.color || n.text_color || '#fff',
    bold: n.bold || n.text_bold, italic: n.italic || n.text_italic, outlines: n.outlines ?? n.text_outlines, outline_color: n.outline_color || '#000', align: n.text_align ?? n.text_xalign ?? 0,
    line_spacing: n.line_spacing || 0, shadow: n.shadow,
  };
}
let GUI = null;
function guiGet(k) { if (!GUI) { try { GUI = JSON.parse(PY._eval('{k: v for k, v in gui.__dict__.items()}')).v; } catch (e) { GUI = {}; } } return GUI[k]; }
function fontStr(st, base) {
  let size = base.size; if (st.size) { const s = String(st.size); size = s[0] === '+' || s[0] === '-' ? base.size + parseFloat(s) : s[0] === '*' ? base.size * parseFloat(s.slice(1)) : parseFloat(s); }
  return [(st.i || base.italic) ? 'italic' : '', (st.b || base.bold) ? 'bold' : '', size + 'px', base.font || 'sans-serif'].join(' ').trim();
}
const layoutCache = new Map();
function textLayout(s, base, maxW) {
  const key = s + '|' + JSON.stringify(base) + '|' + maxW;
  const hit = layoutCache.get(key); if (hit) return hit;
  const tok = typeof s === 'string' ? parseText(s) : s;
  const lines = [[]]; let x = 0, word = [], wordW = 0, lh = base.size * 1.25 + (base.line_spacing || 0);
  const flush = () => {
    if (x + wordW > maxW && lines[lines.length - 1].length) { lines.push([]); x = 0; while (word.length && word[0].c === ' ') { wordW -= word[0].w; word.shift(); } }
    for (const ch of word) { ch.x = x; x += ch.w; lines[lines.length - 1].push(ch); }
    word = []; wordW = 0;
  };
  let idx = 0;
  for (const t of tok) {
    if (t.c === undefined) { (word.length ? word : lines[lines.length - 1]).push(Object.assign({ idx, x: 0, w: 0 }, t)); continue; }
    if (t.c === '\n') { flush(); lines.push([]); x = 0; idx++; continue; }
    g.font = fontStr(t.st, base); const w = g.measureText(t.c).width;
    const ch = { c: t.c, st: t.st, w, idx: idx++, font: g.font };
    if (t.c === ' ') { flush(); word.push(ch); wordW += w; flush(); } else { word.push(ch); wordW += w; }
  }
  flush();
  let mw = 0; for (const L of lines) { const e = L.filter((c) => c.c !== undefined).pop(); if (e) mw = Math.max(mw, e.x + e.w); }
  const L = { lines, w: Math.min(maxW, mw), h: lines.length * lh, lh, count: idx, base };
  if (layoutCache.size > 400) layoutCache.clear(); layoutCache.set(key, L);
  return L;
}
function drawText(L, x, y, shown, base) {
  const t = now();
  g.textBaseline = 'alphabetic';
  for (let li = 0; li < L.lines.length; li++) {
    const line = L.lines[li]; const lw = line.length ? Math.max(...line.filter((c) => c.c !== undefined).map((c) => c.x + c.w), 0) : 0;
    const ox = x + (L.w - lw) * (base.align || 0), oy = y + li * L.lh + base.size;
    for (const ch of line) {
      if (ch.c === undefined || ch.idx >= shown) continue;
      g.font = ch.font; let dx = 0, dy = 0;
      if (ch.st.shake) { dx = (Math.random() - 0.5) * ch.st.shake; dy = (Math.random() - 0.5) * ch.st.shake; }
      if (ch.st.wave) dy = Math.sin(t * 6 + ch.idx * 0.5) * ch.st.wave;
      if (ch.st.glitch && Math.random() < 0.08 * ch.st.glitch) dx = (Math.random() - 0.5) * 12 * ch.st.glitch;
      const cx = ox + ch.x + dx, cy = oy + dy;
      if (ch.st.alpha != null) g.globalAlpha = ch.st.alpha;
      if (base.outlines) { g.lineJoin = 'round'; g.lineWidth = base.outlines * 2; g.strokeStyle = cssColor(base.outline_color); g.strokeText(ch.c, cx, cy); }
      if (base.shadow) { g.fillStyle = 'rgba(0,0,0,.6)'; g.fillText(ch.c, cx + 2, cy + 2); }
      g.fillStyle = cssColor(ch.st.color || base.color); g.fillText(ch.c, cx, cy);
      if (ch.st.alpha != null) g.globalAlpha = 1;
    }
  }
}
function sayTick(dt) {
  if (!say || say.done) return;
  if (skip) { while (!say.done) revealToWait(); return; }
  const cps = skip ? 1e6 : (prefs.text_cps || 0) <= 0 ? 1e6 : prefs.text_cps;
  if (say.waitUntil > now()) return;
  say.acc += dt * cps;
  while (say.acc >= 1 && !say.done) {
    const t = say.tok[say.pos || 0]; if (!t) { say.done = true; break; }
    say.pos = (say.pos || 0) + 1;
    if (t.c !== undefined) { say.shown++; say.acc -= t.st && t.st.cps ? 1 / parseFloat(String(t.st.cps).replace('*', '')) : 1; }
    else if (t.w !== undefined) { if (t.w === Infinity) { say.paused = true; say.acc = 0; return; } say.waitUntil = now() + t.w; say.acc = 0; return; }
    else if (t.fast) { say.shown = 0; for (let k = 0; k < say.pos; k++) if (say.tok[k].c !== undefined) say.shown++; }
    else if (t.nw) { say.nw = true; }
  }
  if ((say.pos || 0) >= say.tok.length) { say.done = true; say.doneAt = now(); }
}
function revealToWait() {
  if (!say) return;
  say.paused = false; say.waitUntil = 0;
  while ((say.pos || 0) < say.tok.length) {
    const t = say.tok[say.pos]; say.pos++;
    if (t.c !== undefined) say.shown++;
    else if (t.w === Infinity) return;
  }
  say.done = true; say.doneAt = now();
}

// ------------------------------------------------------------------ screen layout + draw
// Every node is laid out into a box [x, y, w, h] relative to its parent box.
function num(v, s) { return typeof v === 'number' ? (Math.abs(v) <= 1 && v !== 0 ? v * s : v) : 0; }
function placement(n, pw, ph, w, h) {
  let xpos = n.xpos, ypos = n.ypos, xan = n.xanchor, yan = n.yanchor;
  if (n.pos) { xpos = n.pos[0]; ypos = n.pos[1]; }
  if (n.align) { xpos = xan = n.align[0]; ypos = yan = n.align[1]; }
  if (n.xalign != null) xpos = xan = n.xalign;
  if (n.yalign != null) ypos = yan = n.yalign;
  if (n.xcenter != null) { xpos = n.xcenter; xan = 0.5; }
  if (n.ycenter != null) { ypos = n.ycenter; yan = 0.5; }
  if (n.anchor) { xan = n.anchor[0]; yan = n.anchor[1]; }
  if (n.area) return [n.area[0], n.area[1]];
  let x = num(xpos ?? 0, pw) - num(xan ?? 0, w), y = num(ypos ?? 0, ph) - num(yan ?? 0, h);
  if (n.offset) { x += n.offset[0]; y += n.offset[1]; }
  return [x + (n.xoffset || 0), y + (n.yoffset || 0)];
}
function pad(n) {
  const p = n.padding ?? null; let l = 0, t = 0, r = 0, b = 0;
  if (Array.isArray(p)) { if (p.length === 2) { l = r = p[0]; t = b = p[1]; } else [l, t, r, b] = p; } else if (typeof p === 'number') l = t = r = b = p;
  if (n.xpadding != null) l = r = n.xpadding; if (n.ypadding != null) t = b = n.ypadding;
  if (n.k === 'textbutton' && p == null && n.xpadding == null) { l = r = 14; t = b = 6; }
  return [l, t, r, b];
}
function measure(n, pw, ph) {
  // returns [w, h] (content size including padding)
  if (n.area) return [n.area[2], n.area[3]];
  let w = n.xysize ? n.xysize[0] : n.xsize, h = n.xysize ? n.xysize[1] : n.ysize;
  if (n.xfill) w = pw; if (n.yfill) h = ph;
  const [pl, pt, pr, pb] = pad(n);
  const k = n.k;
  if (w != null && h != null && k !== 'text') return [num(w, pw), num(h, ph)];
  let cw = 0, ch = 0;
  if (k === 'text' || k === 'label' || k === 'textbutton') {
    const st = styleOf(n); const L = textLayout(textOf(n), st, num(n.xmaximum ?? (w ?? pw), pw) - pl - pr);
    cw = L.w; ch = L.h; n.__L = L;
  } else if (k === 'add' || k === 'image') {
    const P = atlProps(n.at, n.__t0 || T0); const s = dispSize(P.__child ?? n.img); cw = s[0] * (n.zoom ?? P.zoom ?? 1); ch = s[1] * (n.zoom ?? P.zoom ?? 1);
  } else if (k === 'imagebutton') { const s = dispSize(n.idle); cw = s[0] * (n.zoom || 1); ch = s[1] * (n.zoom || 1); }
  else if (k === 'hbox' || k === 'vbox' || k === 'grid') {
    const sp = n.spacing || 0; const kids = n.c || [];
    if (k === 'grid') {
      const cols = n.cols || 1; let colW = 0, rowH = 0; for (const c of kids) { const s = measure(c, pw, ph); colW = Math.max(colW, s[0]); rowH = Math.max(rowH, s[1]); }
      const rows = Math.ceil(kids.length / cols); cw = cols * colW + (cols - 1) * (n.xspacing ?? sp); ch = rows * rowH + (rows - 1) * (n.yspacing ?? sp); n.__cell = [colW, rowH];
    } else for (const c of kids) { const s = measure(c, pw, ph); if (k === 'hbox') { cw += s[0] + sp; ch = Math.max(ch, s[1]); } else { ch += s[1] + sp; cw = Math.max(cw, s[0]); } }
    if (kids.length) { if (k === 'hbox') cw -= sp; else if (k === 'vbox') ch -= sp; }
  } else if (k === 'fixed' || k === 'viewport' || k === 'side') { cw = pw; ch = ph; }
  else if (k === 'frame' || k === 'window' || k === 'button') {
    for (const c of n.c || []) { const s = measure(c, pw - pl - pr, ph - pt - pb); const p = placement(c, 0, 0, s[0], s[1]); cw = Math.max(cw, Math.max(0, p[0]) + s[0]); ch = Math.max(ch, Math.max(0, p[1]) + s[1]); }
    if (n.background && !(n.c || []).length) { const s = dispSize(n.background); cw = s[0]; ch = s[1]; }
  } else if (k === 'bar' || k === 'vbar' || k === 'dragbar') { cw = pw; ch = 24; }
  return [w != null ? num(w, pw) : cw + pl + pr, h != null ? num(h, ph) : ch + pt + pb];
}
function textOf(n) { return n.v == null ? '' : String(n.v); }
function drawScreens(under) {
  if (under) { clickables = []; keys = []; clickables.modalAt = null; widgetHits = []; }
  for (const s of orderedScreens()) {
    if (((scrInfo[s.name] || {}).layer === 'master') !== !!under) continue;
    if (hideUI && s.kind !== 'menu' && s.kind !== 'call') continue;
    const tree = trees[s.name]; if (!tree) continue;
    const info = scrInfo[s.name] || {};
    const base = clickables.length;
    for (const n of tree) drawNode(n, [0, 0, W, H], s);
    if (info.modal) clickables.modalAt = base;
  }
}
function nodeKey(scr, n) { return scr.name + '|' + n.ln + '|' + (n.id || ''); }
function drawNode(n, box, scr) {
  const [bx, by, bw, bh] = box;
  const [w, h] = measure(n, bw, bh);
  const [px, py] = placement(n, bw, bh, w, h);
  const x = bx + px, y = by + py;
  const k = n.k, nk = nodeKey(scr, n);
  const isBtn = k === 'button' || k === 'textbutton' || k === 'imagebutton' || k === 'hotspot' || (k === 'mousearea');
  const hov = hover && hover.key === nk;
  const sens = n.sens !== false;
  const P = n.at ? atlProps(n.at, scr.t0) : null;
  g.save();
  if (n.alpha != null) g.globalAlpha *= n.alpha;
  if (P && P.alpha != null) g.globalAlpha *= P.alpha;
  if (n.blend) g.globalCompositeOperation = BLEND[n.blend] || n.blend;
  let ox = 0, oy = 0; if (P) { ox = (P.xoffset || 0); oy = (P.yoffset || 0); }
  const X = x + ox, Y = y + oy;
  // backgrounds
  let bg = n.background; if (n.sel && n.selected_background) bg = n.selected_background; if (hov && sens && n.hover_background) bg = n.hover_background; if (!sens && n.insensitive_background) bg = n.insensitive_background;
  if (bg != null) drawDisp(bg, X, Y, w, h, scr.t0);
  const [pl, pt, pr, pb] = pad(n);
  if (k === 'text' || k === 'label' || k === 'textbutton') {
    const st = styleOf(n);
    if (k === 'textbutton') {
      st.color = cssColor(n.text_color || gui('idle_color'));
      if (n.sel) st.color = n.text_selected_color || gui('selected_color');
      if (hov && sens) st.color = n.text_hover_color || gui('hover_color');
      if (!sens) st.color = n.text_insensitive_color || gui('insensitive_color');
    } else if (n.hover_color && hov) st.color = n.hover_color;
    const L = textLayout(textOf(n), st, w - pl - pr);
    const isWhat = n.id === 'what' && say && scr.kind === 'say';
    drawText(L, X + pl + (w - pl - pr - L.w) * (st.align || 0), Y + pt, isWhat ? say.shown : 1e9, st);
    if (isWhat && say.done && !say.menu && n.ctc !== false) { const last = L.lines[L.lines.length - 1]; const lx = last.length ? last[last.length - 1].x + last[last.length - 1].w : 0; g.fillStyle = cssColor(gui('accent')); g.font = `${st.size}px sans-serif`; g.fillText('♥', X + pl + lx + 10, Y + pt + (L.lines.length - 1) * L.lh + st.size + Math.sin(now() * 5) * 3); }
  } else if ((k === 'add' || k === 'image') && n.img && WIDGETS[n.img.k]) {
    const inst = drawWidget(n.img, X, Y, w, h, n.action);
    if (inst && (inst.obj.pointer || inst.obj.key)) { widgetHits.push(inst); clickables.push({ key: nk, r: [X, Y, w, h], widget: inst, sens: true }); }
  } else if (k === 'add' || k === 'image') {
    const PP = Object.assign({}, P || {}, { xpos: 0, ypos: 0, xanchor: 0, yanchor: 0, xoffset: 0, yoffset: 0, alpha: null });
    if (n.zoom != null) PP.zoom = n.zoom; if (n.tint) PP.tint = n.tint;
    drawPlaced(n.img, PP, scr.t0, [X, Y, w, h]);
  } else if (k === 'imagebutton') {
    let im = n.idle; if (n.sel && n.selected_idle) im = n.selected_idle; if (hov && sens && n.hover) im = n.sel && n.selected_hover ? n.selected_hover : n.hover; if (!sens && n.insensitive) im = n.insensitive;
    if (hov && sens && n.hover_tint) drawTinted(im, X, Y, w, h, n.hover_tint, scr.t0); else drawDisp(im, X, Y, w, h, scr.t0);
  } else if (k === 'bar' || k === 'vbar') {
    const v = Array.isArray(n.value) ? n.value[0] : n.value || 0, r = n.range || 1;
    g.fillStyle = cssColor(n.bar_background_color || '#0008'); g.fillRect(X, Y, w, h);
    g.fillStyle = cssColor(n.bar_color || gui('accent')); g.fillRect(X, Y, w * Math.max(0, Math.min(1, v / r)), h);
  } else if (k === 'dragbar') drawDragbar(n, X, Y, w, h, nk);
  else if (k === 'key') keys.push({ key: n.key, a: n.action, scr });
  else if (k === 'timer') timerNode(n, nk);
  // children
  if (n.c && n.c.length) {
    const inner = [X + pl, Y + pt, w - pl - pr, h - pt - pb];
    if (k === 'viewport') drawViewport(n, inner, scr, nk);
    else if (k === 'hbox' || k === 'vbox') { let cx = inner[0], cy = inner[1]; for (const c of n.c) { const s = measure(c, inner[2], inner[3]); drawNode(Object.assign({}, c, flowPos(c, k)), [cx, cy, k === 'hbox' ? s[0] : inner[2], k === 'vbox' ? s[1] : inner[3]], scr); if (k === 'hbox') cx += s[0] + (n.spacing || 0); else cy += s[1] + (n.spacing || 0); } }
    else if (k === 'grid') { const cols = n.cols || 1, [cw, ch] = n.__cell || [0, 0]; n.c.forEach((c, i) => drawNode(c, [inner[0] + (i % cols) * (cw + (n.xspacing ?? n.spacing ?? 0)), inner[1] + Math.floor(i / cols) * (ch + (n.yspacing ?? n.spacing ?? 0)), cw, ch], scr)); }
    else for (const c of n.c) drawNode(c, inner, scr);
  }
  g.restore();
  if ((isBtn || n.action != null && n.action >= 0 && k !== 'key' && k !== 'timer' && k !== 'dragbar' && !(n.img && WIDGETS[n.img.k])) && k !== 'text') {
    let r = [X, Y, w, h]; if (k === 'hotspot' && n.area) r = [bx + n.area[0], by + n.area[1], n.area[2], n.area[3]];
    clickables.push({ key: nk, r, a: n.action, sens, hovered: n.hovered, unhovered: n.unhovered, alt: n.alternate, mouse: k === 'mousearea', tooltip: n.tooltip, n });
  }
  if (k === 'dragbar') clickables.push({ key: nk, r: [X, Y, w, h], drag: n, sens });
}
function flowPos(c, k) { return k === 'hbox' ? { xpos: 0, xanchor: 0, xalign: undefined } : { ypos: 0, yanchor: 0, yalign: undefined }; }
function gui(k) { return guiGet(k); }
function drawViewport(n, inner, scr, nk) {
  const [x, y, w, h] = inner, cs = n.child_size || [w, h];
  const st = vports[nk] || (vports[nk] = { x: 0, y: 0 });
  if (n.xinitial != null && !st.dragging) st.x = num(n.xinitial, Math.max(0, cs[0] - w)) || 0;
  if (n.yinitial != null && !st.dragging) st.y = num(n.yinitial, Math.max(0, cs[1] - h)) || 0;
  st.x = Math.max(0, Math.min(cs[0] - w, st.x)); st.y = Math.max(0, Math.min(cs[1] - h, st.y));
  st.max = [cs[0] - w, cs[1] - h]; st.n = n; st.box = inner;
  g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip();
  const before = clickables.length;
  for (const c of n.c) drawNode(c, [x - st.x, y - st.y, cs[0], cs[1]], scr);
  g.restore();
  // clip child hit rects to the viewport
  for (let i = before; i < clickables.length; i++) { const c = clickables[i]; if (!c) continue; c.clip = inner; }
  if (n.draggable) clickables.splice(before, 0, { key: nk, r: inner, vp: st, sens: true, n });
}
function timerNode(n, nk) {
  const st = timers[nk] || (timers[nk] = { t0: now() });
  st.seen = true;
  if (now() - st.t0 >= (n.t || 0)) {
    st.t0 = now();
    if (!n.repeat) st.fired = (st.fired || 0) + 1;
    if (n.repeat || st.fired === 1) setTimeout(() => runAction(n.action), 0);
  }
}
function drawDragbar(n, x, y, w, h, nk) {
  const d = drags[nk];
  if (n.background != null) drawDisp(n.background, x, y, w, h); else { g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(x, y, w, h); }
  const p = d ? Math.max(0, Math.min(1, (d.max - x) / w)) : 0;
  g.fillStyle = cssColor(n.bar_color || gui('accent')); g.globalAlpha *= 0.55; g.fillRect(x, y, w * p, h); g.globalAlpha /= 0.55;
  if (n.progress != null) n.__p = p;
}

// ------------------------------------------------------------------ input
function toCanvas(e) {
  const r = out.getBoundingClientRect(), s = Math.min(r.width / W, r.height / H), ox = (r.width - W * s) / 2, oy = (r.height - H * s) / 2;
  return [(e.clientX - r.left - ox) / s, (e.clientY - r.top - oy) / s];
}
function hit(x, y) {
  for (let i = clickables.length - 1; i >= 0; i--) {
    const c = clickables[i];
    if (clickables.modalAt != null && i < clickables.modalAt) return { modal: true };
    const [rx, ry, rw, rh] = c.r;
    if (x >= rx && x < rx + rw && y >= ry && y < ry + rh && (!c.clip || (x >= c.clip[0] && x < c.clip[0] + c.clip[2] && y >= c.clip[1] && y < c.clip[1] + c.clip[3]))) {
      if (c.mouse) continue;
      return c;
    }
  }
  return null;
}
function runAction(i) {
  if (i == null || i < 0) return;
  const r = JSON.parse(pyCall('_act', i));
  dirty = true;
  if (!control(r)) { /* plain action */ }
}
function input() {
  out.addEventListener('contextmenu', (e) => e.preventDefault());
  out.addEventListener('pointerdown', (e) => {
    unlockAudio();
    const [x, y] = toCanvas(e); mouse = [x, y];
    try { out.setPointerCapture(e.pointerId); } catch (_) {}
    if (e.button === 2) { if (hideUI) { hideUI = false; return; } const c = hit(x, y); if (c && c.alt != null) runAction(c.alt); else if (VM.ctx === 'game' && scrInfo.game_menu) command(['show_menu', 'game_menu']); return; }
    if (hideUI) { hideUI = false; return; }
    const c = hit(x, y);
    press = { x, y, sx: x, sy: y, c, t: now(), moved: false };
    if (c && c.widget && c.widget.obj.pointer) { press.widget = c.widget; c.widget.obj.pointer('down', x - c.r[0], y - c.r[1]); return; }
    if (c && c.drag) { const st = drags[c.key] = { x0: x, max: x, t0: now(), r: c.r, n: c.drag, ok: x <= c.r[0] + c.r[2] * 0.15 }; press.drag = st; }
    if (c && c.vp) { press.vp = c.vp; press.vx = c.vp.x; press.vy = c.vp.y; }
  });
  out.addEventListener('pointermove', (e) => {
    const [x, y] = toCanvas(e); mouse = [x, y];
    if (press && press.widget) { const r = press.widget.r; press.widget.obj.pointer && press.widget.obj.pointer('move', x - r[0], y - r[1]); return; }
    if (press) {
      if (Math.abs(x - press.sx) + Math.abs(y - press.sy) > 10) press.moved = true;
      if (press.drag) press.drag.max = Math.max(press.drag.max, x);
      if (press.vp && press.moved) { press.vp.dragging = true; press.vp.x = Math.max(0, Math.min(press.vp.max[0], press.vx - (x - press.sx))); press.vp.y = Math.max(0, Math.min(press.vp.max[1], press.vy - (y - press.sy))); }
      else if (press.vp === undefined && press.c && press.c.clip && press.moved) {
        // started on a button inside a draggable viewport: hand the drag to the viewport
        const vpc = clickables.find((k) => k && k.vp && k.r === press.c.clip); if (vpc) { press.vp = vpc.vp; press.vx = vpc.vp.x; press.vy = vpc.vp.y; press.c = null; }
      }
    }
    const c = hit(x, y); const nk = c && c.key;
    if ((hover && hover.key) !== nk) {
      if (hover && hover.unhovered != null) runAction(hover.unhovered);
      hover = c && !c.modal ? c : null;
      if (hover && hover.hovered != null) runAction(hover.hovered);
      out.style.cursor = hover && (hover.a != null && hover.a >= 0 || hover.drag) ? 'pointer' : 'default';
    }
  });
  out.addEventListener('pointerup', (e) => {
    const [x, y] = toCanvas(e); const p = press; press = null; if (!p) return;
    if (p.widget) { const r = p.widget.r; p.widget.obj.pointer && p.widget.obj.pointer('up', x - r[0], y - r[1]); return; }
    if (p.drag) { finishDrag(p.drag); return; }
    if (p.vp && p.vp.dragging) { p.vp.dragging = false; syncViewport(p.vp); return; }
    const c = hit(x, y);
    if (c && c.modal) return;
    if (c && p.c && c.key === p.c.key && !c.vp && !c.drag) {
      if (c.sens !== false && c.a != null && c.a >= 0) { play('sound', '__click__', {}); runAction(c.a); }
      return;
    }
    if (p.moved) return;
    if (c && !c.vp) return;
    if (modalUp()) return;
    if (skip) { skip = false; return; }
    advance();
  });
  out.addEventListener('wheel', (e) => { if (e.deltaY < 0) rollback(); else if (VM.wait && VM.wait.kind === 'say' && snaps.length) advance(); }, { passive: true });
  addEventListener('keydown', (e) => {
    unlockAudio();
    const k = e.key;
    for (const b of [...keys].reverse()) { if (keyMatch(b.key, e)) { e.preventDefault(); runAction(b.a); return; } }
    const wtop = topWidget(); if (wtop && wtop.obj.key && wtop.obj.key('down', k)) { e.preventDefault(); return; }
    if (k === ' ' || k === 'Enter') { e.preventDefault(); if (!modalUp()) advance(); }
    else if (k === 'Control') skip = true;
    else if (k === 'Escape') { if (VM.ctx === 'game' && scrInfo.game_menu) { const m = screens.find((s) => s.kind === 'menu'); if (m) hideScreen(m.name); else command(['show_menu', 'game_menu']); } }
    else if (k === 'h' || k === 'H') hideUI = !hideUI;
    else if (k === 'PageUp' || k === 'ArrowUp' && e.altKey) rollback();
    else if (k === 'a' || k === 'A') auto = !auto;
  });
  addEventListener('keyup', (e) => { if (e.key === 'Control') skip = false; const w = topWidget(); if (w && w.obj.key) w.obj.key('up', e.key); });
}
function topWidget() {
  // the last widget drawn that isn't covered by a modal screen above it
  for (let i = clickables.length - 1; i >= 0; i--) { if (clickables.modalAt != null && i < clickables.modalAt) return null; const c = clickables[i]; if (c && c.widget && c.widget.obj.key) return c.widget; }
  return null;
}
function modalUp() { return screens.some((s) => s.kind !== 'say' && scrInfo[s.name] && scrInfo[s.name].modal); }
function keyMatch(spec, e) {
  const list = Array.isArray(spec) ? spec : [spec];
  return list.some((s) => {
    if (!s) return false; s = String(s);
    const m = { K_ESCAPE: 'Escape', K_RETURN: 'Enter', K_SPACE: ' ', K_LEFT: 'ArrowLeft', K_RIGHT: 'ArrowRight', K_UP: 'ArrowUp', K_DOWN: 'ArrowDown', K_TAB: 'Tab', K_BACKSPACE: 'Backspace', game_menu: 'Escape', dismiss: 'Enter' }[s];
    if (m) return e.key === m;
    if (s.startsWith('K_')) return e.key.toLowerCase() === s.slice(2).toLowerCase();
    return e.key === s;
  });
}
function finishDrag(d) {
  const n = d.n, elapsed = now() - d.t0, r = d.r;
  const covered = (d.max - r[0]) / r[2];
  const fail = !d.ok ? 'start' : covered < 0.94 ? 'short' : elapsed < (n.min_time || 0) ? 'fast' : null;
  delete drags[Object.keys(drags).find((k) => drags[k] === d)];
  pyCall("_exec", `_drag_result = ${fail ? JSON.stringify(fail) : "None"}`);
  if (fail) { if (n.fail_action != null) runAction(n.fail_action); } else runAction(n.action);
  dirty = true;
}
function syncViewport(vp) { if (vp.n && vp.n.scrollx) pyCall('_exec', `${vp.n.scrollx} = ${Math.round(vp.x)}`); dirty = true; }
VN.scrollViewport = (dx) => { for (const k in vports) { const v = vports[k]; v.x = Math.max(0, Math.min(v.max[0], v.x + dx)); syncViewport(v); } };

// ------------------------------------------------------------------ audio
const channels = { music: { loop: true, mixer: 'music' }, sound: { loop: false, mixer: 'sfx' }, voice: { loop: false, mixer: 'voice' }, ambient: { loop: true, mixer: 'sfx' }, ambient2: { loop: true, mixer: 'sfx' } };
const playing = {};   // channel -> {src, gain, file, loop}
const decoded = new Map();
let mixGains = {};
function unlockAudio() {
  if (!actx) {
    const A = window.AudioContext || window.webkitAudioContext; if (!A) return; actx = new A();
    for (const m of ['music', 'sfx', 'voice']) { const gn = actx.createGain(); gn.connect(actx.destination); mixGains[m] = gn; }
    mixers(); setTimeout(applyAnalog, 0);
    if (VN._audioBase !== undefined && Object.keys(aidx).length) xhr(VN._audioBase + (aidx.__bin || 'audio.bin'), 'arraybuffer').then((b) => { abuf = b; VN.audioBytes = b.byteLength; for (const c in pendingPlay) { const p = pendingPlay[c]; delete pendingPlay[c]; play(c, p[0], p[1]); } });
  }
  if (actx.state === 'suspended') actx.resume();
}
const pendingPlay = {};
// generated tape/CRT background noise (analog.js), applied once audio is unlocked
let analog = null, analogWant = null, analogLoading = false;
function applyAnalog() {
  if (!actx || analogWant == null) return;
  if (!analog) {
    if (analogLoading) return; analogLoading = true;
    lazy('analog').then((m) => { if (m) { analog = m.create(actx, mixGains.sfx); applyAnalog(); } });
    return;
  }
  if (analogWant === false) analog.off(); else analog.set(analogWant);
}
function mixers() { if (!actx) return; for (const m in mixGains) mixGains[m].gain.value = prefs[m] ?? 1; }
function decode(name) {
  if (decoded.has(name)) return decoded.get(name);
  let p;
  if (aidx[name] && abuf) { const e = aidx[name]; p = actx.decodeAudioData(abuf.slice(e[0], e[0] + e[1])); }
  else if (/\.\w+$/.test(name)) p = xhr(name, 'arraybuffer').then((b) => actx.decodeAudioData(b));
  else return Promise.resolve(null);
  p = p.catch(() => null); decoded.set(name, p);
  if (decoded.size > 40) decoded.delete(decoded.keys().next().value);
  return p;
}
function play(ch, file, o) {
  if (file === '__click__') { if (cfg.click_sound) file = cfg.click_sound; else return; }
  if (Array.isArray(file)) file = file[0];
  if (!file) return;
  const C = channels[ch] || (channels[ch] = { loop: false, mixer: 'sfx' });
  if (o.if_changed && playing[ch] && playing[ch].file === file) return;
  if (!actx) { if (C.loop || o.loop) pendingPlay[ch] = [file, o]; return; }
  if (!abuf && aidx[file]) { pendingPlay[ch] = [file, o]; return; }
  const loop = o.loop ?? C.loop;
  if (ch !== 'sound' || loop) stop(ch, { fadeout: o.fadeout || (ch === 'music' ? 0.4 : 0) });
  const want = { file, loop };
  if (ch !== 'sound' || loop) playing[ch] = want;
  decode(file).then((buf) => {
    if (!buf) return;
    if ((ch !== 'sound' || loop) && playing[ch] !== want) return;
    const s = actx.createBufferSource(); s.buffer = buf; s.loop = !!loop;
    const gn = actx.createGain(); gn.gain.value = o.volume ?? 1; s.connect(gn); gn.connect(mixGains[C.mixer] || mixGains.sfx);
    if (o.fadein) { gn.gain.setValueAtTime(0, actx.currentTime); gn.gain.linearRampToValueAtTime(o.volume ?? 1, actx.currentTime + o.fadein); }
    s.start(); want.src = s; want.gain = gn; want.dur = buf.duration; want.t0 = now();
    s.onended = () => { if (playing[ch] === want && !loop) delete playing[ch]; };
    if (ch === 'sound' && !loop) { /* fire and forget */ }
  });
}
function stop(ch, o = {}) {
  delete pendingPlay[ch];
  const p = playing[ch]; if (!p) return; delete playing[ch];
  if (!p.src) return;
  const f = o.fadeout || 0;
  try { if (f && actx) { p.gain.gain.setValueAtTime(p.gain.gain.value, actx.currentTime); p.gain.gain.linearRampToValueAtTime(0, actx.currentTime + f); p.src.stop(actx.currentTime + f); } else p.src.stop(); } catch (e) {}
}
function stopAll() { for (const c of Object.keys(playing)) stop(c); if (analog) analog.off(); analogWant = null; }
function musicState() { const o = {}; for (const c in playing) if (playing[c].loop) o[c] = playing[c].file; return o; }
function restoreMusic(m) { for (const c of Object.keys(playing)) if (playing[c].loop && m[c] !== playing[c].file) stop(c, { fadeout: 0.3 }); for (const c in m) if (!playing[c] || playing[c].file !== m[c]) play(c, m[c], { loop: true }); }
VN.audio = () => ({ playing: Object.fromEntries(Object.entries(playing).map(([k, v]) => [k, v.file])), bytes: VN.audioBytes });

// ------------------------------------------------------------------ frame
function frame() {
  requestAnimationFrame(frame);
  const t = now(), dt = Math.min(0.1, t - lastFrame); lastFrame = t;
  if (skip !== lastSkip && PY._exec) { lastSkip = skip; pyCall('_exec', `_skipping = ${skip ? 'True' : 'False'}`); hook('on_skip', skip); }
  // waits
  const w = VM.wait;
  if (w) {
    if (w.kind === 'pause' && t >= w.until) { VM.wait = null; run(); }
    else if (w.kind === 'with' && t >= w.until) { VM.wait = null; run(); }
    else if (w.kind === 'say' && say) {
      sayTick(dt);
      if (say.done && say.nw) { finishSay(); }
      else if (say.done && skip && (say.seen || prefs.skip_unseen) && t - (say.doneAt || 0) > 0.04) finishSay();
      else if (say.done && skip && !(say.seen || prefs.skip_unseen)) skip = false;
      else if (say.done && auto && !playing.voice && t - say.doneAt > (prefs.auto_delay || 1.5) + stripTags(say.info.what).length * 0.012) finishSay();
    }
  }
  if (notify && t > notify.t) { notify = null; dropKind('notify'); }
  if (dirty) renderScreens();
  g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; g.filter = 'none';
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  if (shake) { const p = (t - shake.t0) / shake.t; if (p >= 1) shake = null; else { const a = shake.amp * (1 - p) * Math.sin(t * 60); g.translate(shake.axis === 'h' ? a : 0, shake.axis === 'h' ? 0 : a); } }
  drawScreens(true);
  for (const L of ['master', 'overlay']) for (const e of layers[L] || []) drawPlaced(e.disp, atlProps(e.at, e.t0, BUILTIN_AT.default), e.t0);
  drawScreens(false);
  if (notify && notify.m) { g.font = '22px sans-serif'; const tw = g.measureText(notify.m).width; g.fillStyle = 'rgba(0,0,0,.7)'; g.fillRect(20, 20, tw + 30, 42); g.fillStyle = '#fff'; g.fillText(notify.m, 35, 48); }
  drawTrans();
  g.setTransform(1, 0, 0, 1, 0, 0);
  // the WebGL canvas sits on top of the 2D one (which keeps receiving input) while an effect runs
  if (fx && fxCanvas && prefs.fx !== false && fx.busy()) { if (fxCanvas.style.display === 'none') fxCanvas.style.display = ''; fx.render(t); }
  else { if (fxCanvas && fxCanvas.style.display !== 'none') fxCanvas.style.display = 'none'; out.__ctx2d.drawImage(cv, 0, 0); }
  // drop timers whose nodes disappeared
  for (const k in timers) { if (!timers[k].seen) delete timers[k]; else timers[k].seen = false; }
}
VN.skip = (v, all) => { skip = v; if (all) prefs.skip_unseen = true; };
VN.advance = advance;
VN.refresh = () => { dirty = true; };
VN.rollback = rollback;
VN.widgets = () => widgetInst;
