// vn-engine faux-3D interiors (Tour): walk through snapshots the way online real-estate tours do.
// Loaded on first use. "pano" nodes are 360° equirectangular photos you drag to look around in
// (rendered with perspective, column by column; yaw 0 = the middle of the photo, 90 = a quarter turn right); "flat" nodes are ordinary photos you pan across.
// Floor arrows glide you into the next snapshot; info points send events to the game.
const R = Math.PI / 180;

export function create(env) {
  const S = { node: null, yaw: 0, pitch: 0, rev: null, vyaw: 0, held: {}, drag: null, tr: null, hover: null, hs: [], dirty: true, last: '' };
  let spec = null, tour = null;
  const views = [document.createElement('canvas'), document.createElement('canvas')];   // current, incoming
  const node = (id) => tour && tour.nodes[id];
  const img = (n) => n && env.image(n.src);
  function sync() {
    const st = spec.st || {};
    if (st.rev !== S.rev || S.node === null) {
      S.rev = st.rev ?? 0; S.node = st.node || tour.start || Object.keys(tour.nodes)[0];
      const n = node(S.node); S.yaw = st.yaw ?? (n && n.yaw) ?? 0; S.pitch = 0; S.tr = null; S.dirty = true;
    }
  }
  // ---------------------------------------------------------------- rendering one node into a canvas
  function render(c, n, yaw, pitch, w, h) {
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
    const im = img(n); if (!im) return false;
    const fov = (n.fov || 80) * R, f = w / 2 / Math.tan(fov / 2), cx = w / 2, cy = h / 2 + f * Math.tan(pitch * R);
    if ((n.kind || 'pano') === 'flat') {
      const sc = Math.max(w / im.naturalWidth, h / im.naturalHeight) * (n.zoom || 1.15), iw = im.naturalWidth * sc, ih = im.naturalHeight * sc;
      const rx = (iw - w) / 2, ry = (ih - h) / 2, range = n.range || 40;
      const ox = -rx - Math.max(-1, Math.min(1, yaw / range)) * rx, oy = -ry + Math.max(-1, Math.min(1, pitch / 20)) * ry;
      g.drawImage(im, ox, oy, iw, ih); c.flat = { ox, oy, iw, ih }; return true;
    }
    const iw = im.naturalWidth, ih = im.naturalHeight, step = 2, bands = 10, latMax = 85 * R;
    for (let sx = 0; sx < w; sx += step) {
      const a = Math.atan((sx + step / 2 - cx) / f), lon = yaw * R + a, ca = Math.cos(a);
      const u = (((lon / (2 * Math.PI) + 0.5) % 1) + 1) % 1 * iw, uw = Math.max(1, (iw * step) / (f / ca) / (2 * Math.PI) * 1.02);
      for (let b = 0; b < bands; b++) {
        const l0 = latMax - (2 * latMax * b) / bands, l1 = latMax - (2 * latMax * (b + 1)) / bands;
        const y0 = cy - (f * Math.tan(Math.max(-1.45, Math.min(1.45, l0)))) / ca, y1 = cy - (f * Math.tan(Math.max(-1.45, Math.min(1.45, l1)))) / ca;
        if (y1 < 0 || y0 > h) continue;
        const v0 = (0.5 - l0 / Math.PI) * ih, v1 = (0.5 - l1 / Math.PI) * ih;
        g.drawImage(im, Math.min(iw - uw, u), v0, uw, v1 - v0, sx, y0, step + 0.6, y1 - y0 + 0.6);
      }
    }
    return true;
  }
  // screen position of a hotspot in the current view, or null when behind you
  function project(n, h, w, hh) {
    const fov = (n.fov || 80) * R, f = w / 2 / Math.tan(fov / 2);
    if ((n.kind || 'pano') === 'flat') { const fl = views[0].flat; if (!fl) return null; return [fl.ox + h.x * fl.iw, fl.oy + h.y * fl.ih, 1]; }
    let d = (((h.yaw - S.yaw) % 360) + 540) % 360 - 180; if (Math.abs(d) > 80) return null;
    const a = d * R, cy = hh / 2 + f * Math.tan(S.pitch * R);
    return [w / 2 + f * Math.tan(a), cy - (f * Math.tan((h.pitch || 0) * R)) / Math.cos(a), 1 / Math.cos(a)];
  }
  function go(h) {
    const to = node(h.to); if (!to || S.tr) return;
    const arriveYaw = h.face ?? (to.kind === 'flat' ? 0 : h.yaw);
    S.tr = { t0: performance.now() / 1000, h, to: h.to, yaw: arriveYaw, at: S.hs.find((q) => q.h === h) };
    env.sound && spec.step_sound && env.sound(spec.step_sound);
  }
  function activate(h) {
    if (h.to) go(h);
    else env.emit({ type: 'hotspot', id: h.id, node: S.node, state: { node: S.node, yaw: Math.round(S.yaw) } });
  }
  return {
    draw(g, sp, X, Y, Wd, Hd, t, dt) {
      spec = sp; tour = env.data(sp.tour); if (!tour) return; sync();
      const n = node(S.node); if (!n) return;
      // keyboard turning + glide
      const turn = (S.held.ArrowLeft || S.held.a ? -1 : 0) + (S.held.ArrowRight || S.held.d ? 1 : 0);
      if (turn) { S.yaw += turn * 70 * dt; S.dirty = true; }
      if (!S.drag && Math.abs(S.vyaw) > 0.5) { S.yaw += S.vyaw * dt; S.vyaw *= Math.pow(0.02, dt); S.dirty = true; }
      if ((n.kind || 'pano') === 'flat') { const r = n.range || 40; S.yaw = Math.max(-r, Math.min(r, S.yaw)); }
      const key = `${S.node}|${S.yaw.toFixed(2)}|${S.pitch.toFixed(2)}|${Wd}x${Hd}|${!!img(n)}`;
      if (key !== S.last || S.dirty) { S.ok = render(views[0], n, S.yaw, S.pitch, Wd, Hd); S.last = key; S.dirty = !S.ok; }
      g.save(); g.beginPath(); g.rect(X, Y, Wd, Hd); g.clip();
      if (S.tr) {
        const p = Math.min(1, (t - S.tr.t0) / (sp.glide || 0.8)), e = p * p * (3 - 2 * p);
        const at = S.tr.at ? [S.tr.at.x, S.tr.at.y] : [Wd / 2, Hd / 2];
        const to = node(S.tr.to); if (!S.tr.ready) S.tr.ready = render(views[1], to, S.tr.yaw, 0, Wd, Hd);
        const z = 1 + e * 1.4;
        g.globalAlpha = 1; g.drawImage(views[0], X + at[0] - at[0] * z, Y + at[1] - at[1] * z, Wd * z, Hd * z);
        if (S.tr.ready) { const z2 = 0.82 + 0.18 * e; g.globalAlpha = Math.min(1, e * 1.4); g.drawImage(views[1], X + (Wd - Wd * z2) / 2, Y + (Hd - Hd * z2) / 2, Wd * z2, Hd * z2); g.globalAlpha = 1; }
        if (p >= 1) {
          S.node = S.tr.to; S.yaw = S.tr.yaw; S.pitch = 0; S.tr = null; S.dirty = true;
          env.emit({ type: 'arrive', node: S.node, state: { node: S.node, yaw: Math.round(S.yaw) } });
        }
        g.restore(); return;
      }
      g.drawImage(views[0], X, Y);
      // hotspots
      S.hs = [];
      for (const h of n.hotspots || []) {
        const pr = project(n, h, Wd, Hd); if (!pr) continue;
        const [hx, hy, depth] = pr, x = X + hx, y = Y + hy, hov = S.hover === h, pulse = 0.5 + 0.5 * Math.sin(t * 3 + (h.yaw || 0));
        if (h.to) {
          const r = Math.max(18, Math.min(60, (h.size || 46) / depth));
          g.save(); g.translate(x, y); g.scale(1, 0.42);
          g.fillStyle = `rgba(255,255,255,${hov ? 0.5 : 0.22 + 0.12 * pulse})`; g.beginPath(); g.arc(0, 0, r, 0, 7); g.fill();
          g.strokeStyle = 'rgba(255,255,255,.95)'; g.lineWidth = 3; g.stroke();
          g.restore();
          g.save(); g.translate(x, y - r * 0.05); g.fillStyle = '#fff'; g.beginPath(); g.moveTo(0, -r * 0.32); g.lineTo(r * 0.3, -r * 0.02); g.lineTo(-r * 0.3, -r * 0.02); g.closePath(); g.fill(); g.restore();
          S.hs.push({ h, x: hx, y: hy, r: r + 10 });
        } else {
          const r = hov ? 16 : 12 + 3 * pulse;
          g.fillStyle = 'rgba(255,255,255,.25)'; g.beginPath(); g.arc(x, y, r + 8, 0, 7); g.fill();
          g.fillStyle = h.color || '#ff6fa5'; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
          g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke();
          g.fillStyle = '#fff'; g.font = 'bold 15px sans-serif'; g.textAlign = 'center'; g.fillText(h.icon || 'i', x, y + 5);
          S.hs.push({ h, x: hx, y: hy, r: r + 14 });
        }
        if (h.label && (hov || h.to || sp.labels)) {
          g.font = '600 17px sans-serif'; g.textAlign = 'center'; const tw = g.measureText(h.label).width;
          const ly = y - (h.to ? 34 : 30);
          g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(x - tw / 2 - 10, ly - 18, tw + 20, 26); g.fillStyle = '#fff'; g.fillText(h.label, x, ly);
        }
      }
      g.textAlign = 'left'; g.restore();
    },
    pointer(type, x, y) {
      if (type === 'down') { S.drag = { x, y, yaw: S.yaw, pitch: S.pitch, t: performance.now(), lx: x, lt: performance.now(), moved: false }; S.vyaw = 0; return; }
      const d = S.drag;
      if (type === 'move') {
        S.hover = null; for (const q of S.hs) if (Math.hypot(x - q.x, y - q.y) < q.r) S.hover = q.h;
        if (!d) return;
        if (Math.hypot(x - d.x, y - d.y) > 6) d.moved = true;
        const n = node(S.node), fov = (n && n.fov) || 80, k = fov / ((spec && views[0].width) || 1280);
        S.yaw = d.yaw - (x - d.x) * k; S.pitch = Math.max(-25, Math.min(25, d.pitch + (y - d.y) * k));
        const nt = performance.now(); if (nt - d.lt > 0) { S.vyaw = (-(x - d.lx) * k) / ((nt - d.lt) / 1000); d.lx = x; d.lt = nt; }
        return;
      }
      if (type === 'up') {
        S.drag = null; if (!d) return;
        if (d.moved) { if (performance.now() - d.lt > 80) S.vyaw = 0; return; }
        S.vyaw = 0;
        let best = null; for (const q of S.hs) { const dd = Math.hypot(x - q.x, y - q.y); if (dd < q.r && (!best || dd < best.d)) best = { q, d: dd }; }
        if (best) activate(best.q.h);
      }
    },
    key(type, k) {
      if (['ArrowLeft', 'ArrowRight', 'a', 'd'].includes(k)) { S.held[k] = type === 'down'; return true; }
      if (type !== 'down') return k === 'ArrowUp' || k === 'w';
      if (k === 'ArrowUp' || k === 'w' || k === 'Enter' || k === ' ') {
        let best = null; for (const q of S.hs) { const dd = Math.abs(q.x - views[0].width / 2); if (q.h.to && (!best || dd < best.d)) best = { q, d: dd }; }
        if (best && best.d < views[0].width * 0.3) { activate(best.q.h); return true; }
        return k === 'ArrowUp' || k === 'w';
      }
      if (k === 'ArrowDown' || k === 's') { S.yaw += 180; S.dirty = true; return true; }
      return false;
    },
  };
}
