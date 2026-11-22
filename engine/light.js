// vn-engine 2D lighting. Loaded on demand the first time a LightMap is drawn.
// The model comes from jade-vault's Vault Loci map: a darkness layer that lights cut holes in
// (destination-out), an additive colour pass on top (lighter), shadows as a ray-cast visibility
// polygon against rectangle occluders, soft edges by blur, per-light flicker, and dust motes.
//
// A LightMap spec (built in Python, see prelude.py) looks like:
//   {k:'lightmap', ambient:'#07000b', dark:0.84, blur:8, lights:[...], occluders:[[x0,y0,x1,y1,bleed],...], dust:0}
// and each light:
//   {x, y, radius, color:'#ff5030', intensity:1, cut:1, tint:0.34, flicker:0, seed:0, shadows:false,
//    cone:null | [direction_deg, spread_deg], falloff:0.35, dust:false}
// Coordinates are in the LightMap's own box (its top-left is 0,0), so a LightMap added inside a
// scrolling viewport moves with the world.

const RAYS = 220;
let dark = null, dctx = null;
const motes = new Map();   // light key -> particles

function rgb(c) {
  let s = String(c || '#000').replace('#', '');
  if (s.length <= 4) s = [...s].map((x) => x + x).join('');
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16) || 0).join(',');
}
function flick(L, i, t) {
  const f = L.flicker || 0; if (!f) return 1;
  const s = (L.seed ?? i) * 1.7;
  return 1 - f + f * (0.5 + 0.5 * Math.sin(t * (5 + (i % 7)) + s) * Math.sin(t * 2.3 + s) + 0.25 * Math.sin(t * 17 + s * 3));
}
function radial(c, x, y, r, col, a, falloff = 0.35) {
  if (r <= 0 || a <= 0) return;
  const g = c.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `rgba(${col},${Math.min(1, a)})`); g.addColorStop(falloff, `rgba(${col},${Math.min(1, a) * 0.5})`); g.addColorStop(1, `rgba(${col},0)`);
  c.fillStyle = g; c.fillRect(x - r, y - r, r * 2, r * 2);
}
// visibility polygon from (ox, oy) out to radius R against axis-aligned rectangles [x0,y0,x1,y1,bleed]
function visPoly(ox, oy, R, occ, cone) {
  const rs = occ.filter((r) => r[2] > ox - R && r[0] < ox + R && r[3] > oy - R && r[1] < oy + R && !(ox > r[0] && ox < r[2] && oy > r[1] && oy < r[3]));
  let a0 = 0, a1 = Math.PI * 2, n = RAYS;
  if (cone) { const d = (cone[0] * Math.PI) / 180, s = (cone[1] * Math.PI) / 180; a0 = d - s / 2; a1 = d + s / 2; n = Math.max(12, Math.round((RAYS * s) / (Math.PI * 2))); }
  const pts = cone ? [[ox, oy]] : [];
  for (let i = 0; i <= n; i++) {
    if (!cone && i === n) break;
    const a = a0 + ((a1 - a0) * i) / n, dx = Math.cos(a), dy = Math.sin(a); let t = R;
    for (const r of rs) {
      let t0 = 0, t1 = 1e9, bad = false;
      if (Math.abs(dx) < 1e-9) { if (ox < r[0] || ox > r[2]) bad = true; } else { let p = (r[0] - ox) / dx, q = (r[2] - ox) / dx; if (p > q) [p, q] = [q, p]; t0 = Math.max(t0, p); t1 = Math.min(t1, q); }
      if (!bad) { if (Math.abs(dy) < 1e-9) { if (oy < r[1] || oy > r[3]) bad = true; } else { let p = (r[1] - oy) / dy, q = (r[3] - oy) / dy; if (p > q) [p, q] = [q, p]; t0 = Math.max(t0, p); t1 = Math.min(t1, q); } }
      if (!bad && t0 <= t1 && t0 >= 0) { const e = t0 + (r[4] || 0); if (e < t) t = e; }
    }
    pts.push([ox + dx * t, oy + dy * t]);
  }
  return pts;
}
function shape(c, L, poly, blur, dpr) {
  if (!poly) { c.fillRect(L.x - L.radius, L.y - L.radius, L.radius * 2, L.radius * 2); return; }
  c.save(); if (blur && 'filter' in c) c.filter = `blur(${blur * dpr}px)`;
  c.beginPath(); poly.forEach((p, i) => (i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1]))); c.closePath(); c.fill(); c.restore();
}

// Draw the lightmap onto context g, its box at (bx, by) size (bw, bh), clipped to the canvas (cw, ch).
export function drawLightMap(g, spec, bx, by, bw, bh, t, cw, ch) {
  const dpr = 1;
  if (!dark || dark.width !== cw || dark.height !== ch) { dark = document.createElement('canvas'); dark.width = cw; dark.height = ch; dctx = dark.getContext('2d'); }
  const lights = (spec.lights || []).filter((L) => L && L.x + L.radius + bx > 0 && L.x - L.radius + bx < cw && L.y + L.radius + by > 0 && L.y - L.radius + by < ch);
  const occ = spec.occluders || [], blur = spec.blur ?? 8;
  const polys = lights.map((L) => (L.shadows || L.cone ? visPoly(L.x, L.y, L.radius, L.shadows ? occ : [], L.cone) : null));
  const k = lights.map((L, i) => (L.intensity ?? 1) * flick(L, i, t));
  // 1. darkness with holes
  dctx.setTransform(1, 0, 0, 1, 0, 0); dctx.globalCompositeOperation = 'source-over'; dctx.filter = 'none';
  dctx.clearRect(0, 0, cw, ch);
  dctx.fillStyle = `rgba(${rgb(spec.ambient)},${spec.dark ?? 0.7})`;
  dctx.fillRect(Math.max(0, bx), Math.max(0, by), Math.min(cw, bx + bw) - Math.max(0, bx), Math.min(ch, by + bh) - Math.max(0, by));
  dctx.translate(bx, by); dctx.globalCompositeOperation = 'destination-out';
  lights.forEach((L, i) => {
    const r = L.radius * (L.cutscale ?? 1.15), a = Math.min(1, (L.cut ?? 1) * k[i]);
    const gr = dctx.createRadialGradient(L.x, L.y, 0, L.x, L.y, r);
    gr.addColorStop(0, `rgba(0,0,0,${a})`); gr.addColorStop(L.falloff ?? 0.45, `rgba(0,0,0,${a * 0.72})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
    dctx.fillStyle = gr; shape(dctx, Object.assign({}, L, { radius: r }), polys[i], blur, dpr);
  });
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'source-over'; g.drawImage(dark, 0, 0); g.restore();
  // 2. coloured light, additive
  g.save(); g.translate(bx, by); g.globalCompositeOperation = 'lighter';
  lights.forEach((L, i) => {
    const a = (L.tint ?? 0.34) * k[i]; if (a <= 0) return;
    const gr = g.createRadialGradient(L.x, L.y, 0, L.x, L.y, L.radius), col = rgb(L.color || '#fff');
    gr.addColorStop(0, `rgba(${col},${Math.min(1, a)})`); gr.addColorStop(L.falloff ?? 0.35, `rgba(${col},${Math.min(1, a) * 0.5})`); gr.addColorStop(1, `rgba(${col},0)`);
    g.fillStyle = gr; shape(g, L, polys[i], blur, dpr);
    if (L.core) radial(g, L.x, L.y, L.core, col, Math.min(1, k[i]), 0.4);
  });
  // 3. dust in the light
  lights.forEach((L, i) => {
    if (!L.dust) return;
    const key = L.id || `${Math.round(L.x)},${Math.round(L.y)}`;
    let ps = motes.get(key); if (!ps) { ps = Array.from({ length: L.dust === true ? 24 : L.dust }, () => ({ init: false, ph: Math.random() * 6.28 })); motes.set(key, ps); }
    const R = L.radius * 0.8;
    for (const d of ps) {
      if (!d.init || Math.hypot(d.x - L.x, d.y - L.y) > R) { const a = Math.random() * 6.28, r = Math.sqrt(Math.random()) * R; d.x = L.x + Math.cos(a) * r; d.y = L.y + Math.sin(a) * r; d.vx = (Math.random() - 0.5) * 0.15; d.vy = -0.05 - Math.random() * 0.15; d.init = true; }
      d.x += d.vx + Math.sin(t * 0.7 + d.ph) * 0.1; d.y += d.vy;
      const f = 1 - Math.hypot(d.x - L.x, d.y - L.y) / R; if (f <= 0) continue;
      g.fillStyle = `rgba(${rgb(L.color || '#fff')},${f * 0.6 * (0.4 + 0.6 * (0.5 + 0.5 * Math.sin(t * 2 + d.ph)))})`; g.fillRect(d.x, d.y, 2.2, 2.2);
    }
  });
  g.restore();
}
