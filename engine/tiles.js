// vn-engine top-down tile scroller (TileMap) and map mode (MapView). Loaded on first use.
// Grid movement with smooth steps (like the old 8/16-bit RPGs), 4-way walking sprites, NPCs,
// tap-to-walk with path finding, drag as a virtual stick, keyboard (arrows/WASD + Enter/Space/Z),
// animated tiles, tiles drawn above the characters, and optional lighting through light.js
// where wall tiles cast shadows.
const DIRS = { down: [0, 1], left: [-1, 0], right: [1, 0], up: [0, -1] };
const KEYDIR = { ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', s: 'down', a: 'left', d: 'right', w: 'up', S: 'down', A: 'left', D: 'right', W: 'up' };

export function create(env, kind) { return kind === 'mapview' ? mapView(env) : tileMap(env); }

// an image source: atlas sprite name ("name" or "name:frame") or a file path
function source(env, src) {
  const sp = env.sprite(src);
  if (sp) { const f = sp.f; return { img: env.sheets()[f.s], x: f.x, y: f.y, sx: f.w / Math.max(1, f.dw), sy: f.h / Math.max(1, f.dh) }; }
  const im = env.image(src); return im ? { img: im, x: 0, y: 0, sx: 1, sy: 1 } : null;
}

function tileMap(env) {
  const S = { px: 0, py: 0, tx: 0, ty: 0, face: 'down', moving: false, walk: 0, rev: null, held: [], path: [], npcs: {}, bumped: false, stick: null, pdown: null };
  let spec = null, map = null;
  const solidAt = (x, y) => {
    if (!map || x < 0 || y < 0 || x >= map.w || y >= map.h) return true;
    if (map.solid[y * map.w + x]) return true;
    for (const id in S.npcs) { const n = S.npcs[id]; if (n.solid !== false && Math.round(n.x) === x && Math.round(n.y) === y) return true; }
    return false;
  };
  const npcAt = (x, y) => { for (const id in S.npcs) { const n = S.npcs[id]; if (Math.round(n.x) === x && Math.round(n.y) === y) return id; } return null; };
  const charAt = (x, y) => (map && x >= 0 && y >= 0 && x < map.w && y < map.h ? map.chars[y * map.w + x] : '');
  const stateOut = () => ({ x: S.tx, y: S.ty, face: S.face });
  function sync() {
    const st = spec.st || {};
    if (st.rev !== S.rev || S.rev === null) {
      S.rev = st.rev ?? 0; S.px = S.tx = st.x ?? 0; S.py = S.ty = st.y ?? 0; S.face = st.face || 'down'; S.moving = false; S.path = [];
    }
    const seen = {};
    for (const n of spec.npcs || []) {
      seen[n.id] = 1;
      const cur = S.npcs[n.id];
      if (!cur || cur.home !== `${n.x},${n.y}`) S.npcs[n.id] = Object.assign({}, n, { home: `${n.x},${n.y}`, tx: n.x, ty: n.y, face: n.face || 'down', walk: 0, next: 1 + Math.random() * 2 });
      else Object.assign(cur, { sprite: n.sprite, solid: n.solid, wander: n.wander, label: n.label });
    }
    for (const id in S.npcs) if (!seen[id]) delete S.npcs[id];
  }
  function tryStep(dir) {
    if (spec.frozen) return false;
    S.face = dir; const [dx, dy] = DIRS[dir], nx = S.tx + dx, ny = S.ty + dy;
    if (solidAt(nx, ny)) {
      if (!S.bumped) { S.bumped = true; const npc = npcAt(nx, ny), ch = charAt(nx, ny); env.emit({ type: 'bump', x: nx, y: ny, tile: ch, npc, state: stateOut(), quiet: !(npc || (map.bump || '').includes(ch)) }); }
      return false;
    }
    S.bumped = false; S.tx = nx; S.ty = ny; S.moving = true; return true;
  }
  function interact() {
    if (spec.frozen) return;
    const [dx, dy] = DIRS[S.face], fx = S.tx + dx, fy = S.ty + dy;
    const npc = npcAt(fx, fy);
    if (npc) { const n = S.npcs[npc]; n.face = { down: 'up', up: 'down', left: 'right', right: 'left' }[S.face]; }
    env.emit({ type: 'interact', x: fx, y: fy, tile: charAt(fx, fy), npc, here: charAt(S.tx, S.ty), state: stateOut() });
  }
  function bfs(gx, gy, adjacent) {
    const w = map.w, h = map.h, prev = new Int32Array(w * h).fill(-1), start = S.ty * w + S.tx;
    const q = [start]; prev[start] = start;
    while (q.length) {
      const c = q.shift(), cx = c % w, cy = (c / w) | 0;
      if ((!adjacent && cx === gx && cy === gy) || (adjacent && Math.abs(cx - gx) + Math.abs(cy - gy) === 1)) {
        const path = []; let k = c; while (k !== start) { path.unshift([k % w, (k / w) | 0]); k = prev[k]; } return path;
      }
      for (const [dx, dy] of Object.values(DIRS)) {
        const nx = cx + dx, ny = cy + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx; if (prev[ni] >= 0 || solidAt(nx, ny)) continue; prev[ni] = c; q.push(ni);
      }
      if (q.length > w * h) break;
    }
    return null;
  }
  function update(dt) {
    const sp = spec.speed || 5;
    if (S.moving) {
      const d = sp * dt, ddx = S.tx - S.px, ddy = S.ty - S.py, dist = Math.hypot(ddx, ddy);
      S.walk += dt * sp;
      if (dist <= d) {
        S.px = S.tx; S.py = S.ty; S.moving = false;
        env.emit({ type: 'step', x: S.tx, y: S.ty, tile: charAt(S.tx, S.ty), state: stateOut() });
      } else { S.px += (ddx / dist) * d; S.py += (ddy / dist) * d; }
    }
    if (!S.moving && !spec.frozen) {
      const dir = S.stick || S.held[S.held.length - 1];
      if (dir) { S.path = []; tryStep(dir); }
      else if (S.path.length) {
        const [nx, ny] = S.path.shift(); const dir2 = nx > S.tx ? 'right' : nx < S.tx ? 'left' : ny > S.ty ? 'down' : 'up';
        if (!tryStep(dir2)) S.path = [];
        if (!S.path.length && S.after) { const a = S.after; S.after = null; if (!S.moving) { S.face = a; interact(); } else S.pending = a; }
      } else if (S.pending) { S.face = S.pending; S.pending = null; interact(); }
    }
    // NPCs wander
    for (const id in S.npcs) {
      const n = S.npcs[id];
      if (n.x !== n.tx || n.y !== n.ty) {
        const d = 2.5 * dt, ddx = n.tx - n.x, ddy = n.ty - n.y, dist = Math.hypot(ddx, ddy); n.walk += dt * 2.5;
        if (dist <= d) { n.x = n.tx; n.y = n.ty; } else { n.x += (ddx / dist) * d; n.y += (ddy / dist) * d; }
        continue;
      }
      if (!n.wander || spec.frozen) continue;
      n.next -= dt; if (n.next > 0) continue; n.next = 1.5 + Math.random() * 2.5;
      const dir = Object.keys(DIRS)[(Math.random() * 4) | 0], [dx, dy] = DIRS[dir], nx = n.tx + dx, ny = n.ty + dy;
      n.face = dir; const [hx, hy] = n.home.split(',').map(Number);
      if (Math.abs(nx - hx) + Math.abs(ny - hy) > (n.wander === true ? 3 : n.wander)) continue;
      if (!solidAt(nx, ny) && !(nx === S.tx && ny === S.ty) && !(nx === Math.round(S.px) && ny === Math.round(S.py))) { n.tx = nx; n.ty = ny; }
    }
  }
  function drawChar(g, sheet, x, y, face, walk, moving, T) {
    if (!sheet) { g.fillStyle = '#f6c'; g.fillRect(x + T * 0.2, y + T * 0.1, T * 0.6, T * 0.85); return; }
    const src = source(env, sheet.src); if (!src) return;
    const sz = sheet.size, row = (sheet.row0 || 0) + Math.max(0, (sheet.rows || ['down', 'left', 'right', 'up']).indexOf(face));
    const cols = sheet.cols || 3, cyc = cols >= 3 ? [0, 1, 2, 1] : cols === 2 ? [0, 1] : [0];
    const fr = moving ? cyc[Math.floor(walk * 2) % cyc.length] : (cols >= 3 ? 1 : 0);
    const sc = (sheet.scale || T / sz);
    const dw = sz * sc, dh = sz * sc;
    g.drawImage(src.img, src.x + fr * sz * src.sx, src.y + row * sz * src.sy, sz * src.sx, sz * src.sy, x + (T - dw) / 2, y + T - dh, dw, dh);
  }
  return {
    draw(g, sp, X, Y, Wd, Hd, t, dt) {
      spec = sp; map = env.data(sp.map); if (!map) { g.fillStyle = '#000'; g.fillRect(X, Y, Wd, Hd); return; }
      sync(); update(dt);
      const T = sp.tile || 48, mw = map.w * T, mh = map.h * T;
      let cx = (S.px + 0.5) * T - Wd / 2, cy = (S.py + 0.5) * T - Hd / 2;
      cx = mw <= Wd ? (mw - Wd) / 2 : Math.max(0, Math.min(mw - Wd, cx)); cy = mh <= Hd ? (mh - Hd) / 2 : Math.max(0, Math.min(mh - Hd, cy));
      cx = Math.round(cx); cy = Math.round(cy);
      S.cam = [cx, cy, T, X, Y];
      g.save(); g.beginPath(); g.rect(X, Y, Wd, Hd); g.clip(); g.imageSmoothingEnabled = false;
      g.fillStyle = map.bg || '#000'; g.fillRect(X, Y, Wd, Hd);
      const ts = sp.tileset, src = ts && source(env, ts.src);
      const x0 = Math.max(0, Math.floor(cx / T)), y0 = Math.max(0, Math.floor(cy / T)), x1 = Math.min(map.w, Math.ceil((cx + Wd) / T) + 1), y1 = Math.min(map.h, Math.ceil((cy + Hd) / T) + 1);
      const top = new Set(map.top || []), anim = map.anim || {}, af = Math.floor(t * 4);
      const tile = (li) => {
        const L = map.layers[li];
        for (let ty = y0; ty < y1; ty++) for (let tx = x0; tx < x1; tx++) {
          let v = L[ty * map.w + tx]; if (v == null || v < 0) continue;
          if (anim[v]) v = anim[v][af % anim[v].length];
          const dx = X + tx * T - cx, dy = Y + ty * T - cy;
          if (src) { const c = ts.cols || 8, s = ts.size || 16; g.drawImage(src.img, src.x + (v % c) * s * src.sx, src.y + Math.floor(v / c) * s * src.sy, s * src.sx, s * src.sy, dx, dy, T + 0.5, T + 0.5); }
          else { g.fillStyle = `hsl(${(v * 47) % 360},40%,40%)`; g.fillRect(dx, dy, T, T); }
        }
      };
      map.layers.forEach((_, li) => { if (!top.has(li)) tile(li); });
      // characters, back to front
      const ents = Object.values(S.npcs).map((n) => ({ y: n.y, f: () => drawChar(g, n.sprite, X + n.x * T - cx, Y + n.y * T - cy, n.face, n.walk, n.x !== n.tx || n.y !== n.ty, T) }));
      ents.push({ y: S.py, f: () => drawChar(g, sp.player, X + S.px * T - cx, Y + S.py * T - cy, S.face, S.walk, S.moving || !!(S.stick || S.held.length || S.path.length), T) });
      ents.sort((a, b) => a.y - b.y).forEach((e) => e.f());
      map.layers.forEach((_, li) => { if (top.has(li)) tile(li); });
      // tap target marker
      if (S.path.length) { const [gx, gy] = S.path[S.path.length - 1]; g.strokeStyle = 'rgba(255,255,255,.6)'; g.lineWidth = 2; g.strokeRect(X + gx * T - cx + 4, Y + gy * T - cy + 4, T - 8, T - 8); }
      // lighting
      const Lsp = sp.light;
      if (Lsp) {
        const lm = env.light();
        if (lm) {
          const lights = (Lsp.lights || []).map((l) => Object.assign({}, l, { x: (l.x + 0.5) * T, y: (l.y + 0.5) * T, radius: (l.radius || 4) * T }));
          if (Lsp.player) lights.push(Object.assign({ color: '#ffd9a0', cut: 1, tint: 0.2, flicker: 0.05, id: 'player' }, Lsp.player, { x: (S.px + 0.5) * T, y: (S.py + 0.5) * T, radius: (Lsp.player.radius || 4) * T }));
          const occ = [];
          if (lights.some((l) => l.shadows)) for (let ty = y0; ty < y1; ty++) { let run = -1; for (let tx = x0; tx <= x1; tx++) { const s2 = tx < x1 && map.solid[ty * map.w + tx] && !(map.see || []).includes(map.chars[ty * map.w + tx]); if (s2 && run < 0) run = tx; if (!s2 && run >= 0) { occ.push([run * T, ty * T, tx * T, (ty + 1) * T, T * 0.35]); run = -1; } } }
          lm.drawLightMap(g, { ambient: Lsp.ambient || '#000', dark: Lsp.dark ?? 0.85, blur: Lsp.blur ?? 6, lights, occluders: occ }, X - cx, Y - cy, mw, mh, t, env.W(), env.H());
        }
      }
      g.restore();
    },
    pointer(type, x, y) {
      if (!S.cam || !map) return;
      if (type === 'down') { S.pdown = { x, y, t: performance.now() }; return; }
      if (!S.pdown) return;
      const dx = x - S.pdown.x, dy = y - S.pdown.y;
      if (type === 'move') { if (Math.hypot(dx, dy) > 24) S.stick = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'); return; }
      if (type === 'up') {
        const wasStick = S.stick; S.stick = null; S.pdown = null; if (wasStick) return;
        const [cx, cy, T] = S.cam, gx = Math.floor((x + cx) / T), gy = Math.floor((y + cy) / T);
        if (gx === S.tx && gy === S.ty) { interact(); return; }
        const adj = Math.abs(gx - S.tx) + Math.abs(gy - S.ty) === 1;
        if (solidAt(gx, gy)) {
          const face = (a, b) => (a > S.tx ? 'right' : a < S.tx ? 'left' : b > S.ty ? 'down' : 'up');
          if (adj) { S.face = face(gx, gy); interact(); return; }
          const p = bfs(gx, gy, true); if (p && p.length) { S.path = p; const [lx, ly] = p[p.length - 1]; S.after = gx > lx ? 'right' : gx < lx ? 'left' : gy > ly ? 'down' : 'up'; }
          return;
        }
        const p = bfs(gx, gy, false); if (p) { S.path = p; S.after = null; }
      }
    },
    key(type, k) {
      if (KEYDIR[k]) { const d = KEYDIR[k]; S.held = S.held.filter((x) => x !== d); if (type === 'down') { S.held.push(d); S.bumped = false; } return true; }
      if (type === 'down' && (k === 'Enter' || k === ' ' || k === 'z' || k === 'Z')) { if (!S.moving) interact(); return true; }
      return false;
    },
  };
}

// ---------------------------------------------------------------- map mode
const cache = new Map();
function mapView(env) {
  return {
    draw(g, sp, X, Y, Wd, Hd, t) {
      const map = env.data(sp.map); if (!map) return;
      let c = cache.get(sp.map + '|' + JSON.stringify(sp.colors || ''));
      if (!c) {
        c = document.createElement('canvas'); c.width = map.w; c.height = map.h; const cx = c.getContext('2d'), id = cx.createImageData(map.w, map.h);
        const cols = Object.assign({}, map.colors || {}, sp.colors || {});
        const rgb = (s) => { s = String(s).replace('#', ''); if (s.length <= 4) s = [...s].map((q) => q + q).join(''); return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)); };
        for (let i = 0; i < map.w * map.h; i++) {
          const ch = map.chars[i]; let col = cols[ch];
          const v = col ? rgb(col) : map.solid[i] ? [60, 60, 70] : [110, 120, 100];
          id.data.set([v[0], v[1], v[2], ch === ' ' ? 0 : 255], i * 4);
        }
        cx.putImageData(id, 0, 0); cache.set(sp.map + '|' + JSON.stringify(sp.colors || ''), c);
      }
      const st = sp.st || {}, px = st.x || 0, py = st.y || 0;
      let sx = 0, sy = 0, sw = map.w, sh = map.h;
      if (sp.radius) { sw = sh = sp.radius * 2 + 1; sx = px - sp.radius; sy = py - sp.radius; }
      const s = Math.min(Wd / sw, Hd / sh), ox = X + (Wd - sw * s) / 2, oy = Y + (Hd - sh * s) / 2;
      g.save(); g.beginPath(); g.rect(ox, oy, sw * s, sh * s); g.clip(); g.imageSmoothingEnabled = false;
      g.fillStyle = '#000'; g.fillRect(ox, oy, sw * s, sh * s);
      g.drawImage(c, ox - sx * s, oy - sy * s, map.w * s, map.h * s);
      const at = (x, y) => [ox + (x - sx + 0.5) * s, oy + (y - sy + 0.5) * s];
      g.font = `${Math.max(12, Math.min(20, s * 1.4))}px sans-serif`; g.textAlign = 'center';
      for (const m of sp.markers || []) {
        const [mx, my] = at(m.x, m.y); g.fillStyle = m.color || '#ffd34a'; g.beginPath(); g.arc(mx, my, Math.max(3, s * 0.45), 0, 7); g.fill();
        if (m.label) { g.lineWidth = 3; g.strokeStyle = '#000'; g.strokeText(m.label, mx, my - Math.max(6, s)); g.fillStyle = '#fff'; g.fillText(m.label, mx, my - Math.max(6, s)); }
      }
      const [qx, qy] = at(px, py), blink = 0.5 + 0.5 * Math.sin(t * 6);
      g.fillStyle = `rgba(255,60,90,${0.6 + 0.4 * blink})`; g.beginPath(); g.arc(qx, qy, Math.max(4, s * 0.6), 0, 7); g.fill();
      g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke();
      g.restore(); g.textAlign = 'left';
      g.strokeStyle = 'rgba(255,255,255,.8)'; g.lineWidth = 2; g.strokeRect(ox, oy, sw * s, sh * s);
    },
  };
}
