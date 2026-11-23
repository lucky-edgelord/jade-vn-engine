// vn-engine Live2D (Cubism 4/5 models: .model3.json + .moc3). Loaded the first time a Live2D displayable is drawn.
// A small renderer written directly on the Cubism Core: WebGL with stencil masks and the Cubism blend modes,
// motion3 curves (linear / bezier / stepped), automatic blinking and breathing, look-at, lip-sync from the voice
// channel, expressions (exp3) and pose groups (pose3). Physics is not simulated yet.
//
// The Cubism Core (live2dcubismcore.min.js) is Live2D's proprietary runtime: it is not shipped with the engine.
// Put it in your game's assets folder (download it from Live2D and accept their license), or point
// config.live2d_core at it. Models you ship must allow it under their own licence.
let corePromise = null;
function loadCore(src) {
  if (window.Live2DCubismCore) return Promise.resolve(window.Live2DCubismCore);
  if (corePromise) return corePromise;
  corePromise = new Promise((ok, no) => {
    const s = document.createElement('script'); s.src = src;
    s.onload = () => { const wait = () => (window.Live2DCubismCore && Live2DCubismCore.Moc ? ok(Live2DCubismCore) : setTimeout(wait, 20)); wait(); };
    s.onerror = () => no(new Error('Live2D: could not load ' + src + ' (put live2dcubismcore.min.js in your game folder)'));
    document.head.appendChild(s);
  });
  return corePromise;
}
const fetchJSON = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(u + ' ' + r.status); return r.json(); });
const fetchBuf = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(u + ' ' + r.status); return r.arrayBuffer(); });
const dir = (u) => u.slice(0, u.lastIndexOf('/') + 1);

// ---------------------------------------------------------------- motion3 curves
function parseMotion(j) {
  const curves = j.Curves.map((c) => {
    const s = c.Segments, segs = []; let x = s[0], y = s[1], i = 2;
    while (i < s.length) {
      const type = s[i];
      if (type === 1) { segs.push({ type, p: [x, y, s[i + 1], s[i + 2], s[i + 3], s[i + 4], s[i + 5], s[i + 6]] }); x = s[i + 5]; y = s[i + 6]; i += 7; }
      else { segs.push({ type, p: [x, y, s[i + 1], s[i + 2]] }); x = s[i + 1]; y = s[i + 2]; i += 3; }
    }
    return { target: c.Target, id: c.Id, segs, first: [s[0], s[1]], fin: c.FadeInTime, fout: c.FadeOutTime };
  });
  return { dur: j.Meta.Duration, loop: j.Meta.Loop, curves, fin: j.Meta.FadeInTime ?? 0.5, fout: j.Meta.FadeOutTime ?? 0.5 };
}
function bez(p, t) {
  // cubic bezier in x and y; solve x(u) = t by bisection
  const [x0, y0, x1, y1, x2, y2, x3, y3] = p; let lo = 0, hi = 1, u = 0.5;
  for (let k = 0; k < 18; k++) { u = (lo + hi) / 2; const xu = ((1 - u) ** 3) * x0 + 3 * ((1 - u) ** 2) * u * x1 + 3 * (1 - u) * u * u * x2 + u ** 3 * x3; if (xu < t) lo = u; else hi = u; }
  return ((1 - u) ** 3) * y0 + 3 * ((1 - u) ** 2) * u * y1 + 3 * (1 - u) * u * u * y2 + u ** 3 * y3;
}
function evalCurve(c, t) {
  if (!c.segs.length || t <= c.first[0]) return c.first[1];
  for (const s of c.segs) {
    const p = s.p, end = s.type === 1 ? p[6] : p[2];
    if (t > end) continue;
    if (s.type === 0) return p[1] + ((p[3] - p[1]) * (t - p[0])) / Math.max(1e-6, p[2] - p[0]);
    if (s.type === 1) return bez(p, t);
    if (s.type === 2) return p[1];   // stepped
    return p[3];                     // inverse stepped
  }
  const L = c.segs[c.segs.length - 1].p; return L.length === 8 ? L[7] : L[3];
}

// ---------------------------------------------------------------- WebGL
const VS = `attribute vec2 a; attribute vec2 uv; uniform vec4 xf; varying vec2 v; void main(){ v = vec2(uv.x, 1.0 - uv.y); gl_Position = vec4(a * xf.xy + xf.zw, 0.0, 1.0); }`;
const FS = `precision mediump float; varying vec2 v; uniform sampler2D tex; uniform float op; uniform vec4 mul; uniform vec4 scr; uniform float maskpass;
void main(){ vec4 c = texture2D(tex, v);
  if (maskpass > 0.5) { if (c.a < 0.35) discard; gl_FragColor = vec4(0.0); return; }
  c.rgb = c.rgb * mul.rgb; c.rgb = c.rgb + scr.rgb * c.a - c.rgb * scr.rgb; gl_FragColor = c * op; }`;

export function create(env) {
  const S = { ready: false, err: null, loading: false, src: null, t0: performance.now() / 1000, motion: null, queue: [], blink: 0, nextBlink: 2, look: [0, 0], exprs: {}, expr: null };
  const cv = document.createElement('canvas');
  let gl = null, prog = null, loc = {}, model = null, M = null, tex = [], buf = {}, settings = null, base = '';
  function initGL(w, h) {
    cv.width = w; cv.height = h;
    gl = cv.getContext('webgl', { premultipliedAlpha: true, stencil: true, alpha: true, preserveDrawingBuffer: true });
    const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); return o; };
    prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
    for (const n of ['xf', 'tex', 'op', 'mul', 'scr', 'maskpass']) loc[n] = gl.getUniformLocation(prog, n);
    loc.a = gl.getAttribLocation(prog, 'a'); loc.uv = gl.getAttribLocation(prog, 'uv');
    buf.v = gl.createBuffer(); buf.uv = gl.createBuffer(); buf.i = gl.createBuffer();
  }
  async function load(spec) {
    S.loading = true; S.src = spec.model;
    try {
      await loadCore(spec.core || 'live2dcubismcore.min.js');
      base = dir(spec.model); settings = await fetchJSON(spec.model);
      const R = settings.FileReferences;
      const moc = Live2DCubismCore.Moc.fromArrayBuffer(await fetchBuf(base + R.Moc));
      model = Live2DCubismCore.Model.fromMoc(moc);
      const ci = model.canvasinfo, scale = Math.min(1, 2048 / Math.max(ci.CanvasWidth, ci.CanvasHeight));
      initGL(Math.round(ci.CanvasWidth * scale), Math.round(ci.CanvasHeight * scale));
      const imgs = await Promise.all(R.Textures.map((t) => new Promise((ok, no) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => ok(i); i.onerror = () => no(new Error('texture ' + t)); i.src = base + t; })));
      tex = imgs.map((im) => {
        const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
      });
      const P = model.parameters; M = { idx: {}, def: Float32Array.from(P.defaultValues), part: {} };
      P.ids.forEach((id, i) => (M.idx[id] = i)); model.parts.ids.forEach((id, i) => (M.part[id] = i));
      const groups = settings.Groups || [];
      M.blink = (groups.find((g) => g.Name === 'EyeBlink') || { Ids: ['ParamEyeLOpen', 'ParamEyeROpen'] }).Ids;
      M.lip = (groups.find((g) => g.Name === 'LipSync') || { Ids: ['ParamMouthOpenY'] }).Ids;
      M.motions = {};
      for (const [grp, list] of Object.entries(R.Motions || {})) M.motions[grp] = list.map((m) => ({ file: m.File, fin: m.FadeInTime, fout: m.FadeOutTime, data: null }));
      for (const e of R.Expressions || []) S.exprs[e.Name] = { file: e.File, data: null };
      if (R.Pose) { try { M.pose = await fetchJSON(base + R.Pose); } catch (e) {} }
      S.ready = true; env.redraw();
    } catch (e) { S.err = String(e.message || e); console.warn(e); }
  }
  async function startMotion(group, index) {
    const list = M && M.motions[group]; if (!list || !list.length) return;
    const i = index == null ? Math.floor(Math.random() * list.length) : index % list.length, m = list[i];
    if (!m.data) m.data = parseMotion(await fetchJSON(base + m.file));
    if (S.motion) S.prev = Object.assign(S.motion, { fadeFrom: performance.now() / 1000 });
    S.motion = { m: m.data, group, t0: performance.now() / 1000, fin: m.fin ?? m.data.fin, fout: m.fout ?? m.data.fout };
  }
  async function setExpression(name) {
    if (!name) { S.expr = null; return; }
    const e = S.exprs[name]; if (!e) return; if (!e.data) e.data = await fetchJSON(base + e.file); S.expr = e.data;
  }
  function apply(t) {
    const P = model.parameters, v = P.values, n = P.count;
    for (let i = 0; i < n; i++) v[i] = M.def[i];
    const set = (id, val, w = 1) => { const i = M.idx[id]; if (i != null) v[i] = v[i] * (1 - w) + val * w; };
    const add = (id, val) => { const i = M.idx[id]; if (i != null) v[i] += val; };
    const parts = model.parts.opacities;
    // pose: first part of each group visible
    if (M.pose) for (const grp of M.pose.Groups || []) grp.forEach((p, k) => { const i = M.part[p.Id]; if (i != null) parts[i] = k === 0 ? 1 : 0; });
    // motion (with fade in/out), looping in its group
    const play = (mo, w) => {
      const lt = t - mo.t0, d = mo.m.dur; let tt = lt; if (lt > d) { if (mo.m.loop) tt = lt % d; else tt = d; }
      for (const c of mo.m.curves) {
        const val = evalCurve(c, tt);
        if (c.target === 'Parameter') set(c.id, val, w);
        else if (c.target === 'PartOpacity') { const i = M.part[c.id]; if (i != null) parts[i] = val; }
      }
      return lt >= d && !mo.m.loop;
    };
    if (S.motion) {
      const fin = Math.min(1, (t - S.motion.t0) / Math.max(0.01, S.motion.fin || 0.5));
      if (S.prev) { const fo = 1 - fin; if (fo > 0) play(S.prev, 1); else S.prev = null; }
      if (play(S.motion, fin)) { const g = S.motion.group; S.motion = null; startMotion(S.idle || g); }
    }
    // expression
    if (S.expr) for (const p of S.expr.Parameters || []) { const i = M.idx[p.Id]; if (i == null) continue; if (p.Blend === 'Multiply') v[i] *= p.Value; else if (p.Blend === 'Overwrite') v[i] = p.Value; else v[i] += p.Value; }
    // breathing and idle sway
    add('ParamBreath', 0.5 + 0.5 * Math.sin(t * 2.2)); add('ParamAngleX', Math.sin(t * 0.55) * 2); add('ParamAngleZ', Math.sin(t * 0.43) * 1.2); add('ParamBodyAngleX', Math.sin(t * 0.35) * 1.5);
    // look at
    const [lx, ly] = S.look; add('ParamAngleX', lx * 30); add('ParamAngleY', ly * 30); add('ParamBodyAngleX', lx * 10); set('ParamEyeBallX', lx, 0.8); set('ParamEyeBallY', ly, 0.8);
    // blink
    if (t > S.nextBlink) { S.blink = t; S.nextBlink = t + 2 + Math.random() * 4; }
    const bt = (t - S.blink) / 0.18, open = bt < 1 ? Math.abs(1 - 2 * bt) : 1;
    for (const id of M.blink) { const i = M.idx[id]; if (i != null) v[i] *= open; }
    // lip sync from the voice channel
    const lv = env.voiceLevel ? env.voiceLevel() : 0;
    if (S.lipsync !== false) for (const id of M.lip) set(id, Math.min(1, lv * 6), lv > 0.01 ? 1 : 0);
    for (let i = 0; i < n; i++) v[i] = Math.max(P.minimumValues[i], Math.min(P.maximumValues[i], v[i]));
  }
  function render() {
    model.update();
    const D = model.drawables, ci = model.canvasinfo, ppu = ci.PixelsPerUnit;
    gl.viewport(0, 0, cv.width, cv.height); gl.clearColor(0, 0, 0, 0); gl.clearStencil(0); gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.useProgram(prog); gl.enable(gl.BLEND);
    // model units -> clip space
    gl.uniform4f(loc.xf, (2 * ppu) / ci.CanvasWidth, (2 * ppu) / ci.CanvasHeight, (2 * ci.CanvasOriginX) / ci.CanvasWidth - 1, 1 - (2 * ci.CanvasOriginY) / ci.CanvasHeight);
    const order = [...Array(D.count).keys()].sort((a, b) => D.renderOrders[a] - D.renderOrders[b]);
    const draw = (i, maskpass) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf.v); gl.bufferData(gl.ARRAY_BUFFER, D.vertexPositions[i], gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(loc.a); gl.vertexAttribPointer(loc.a, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf.uv); gl.bufferData(gl.ARRAY_BUFFER, D.vertexUvs[i], gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(loc.uv); gl.vertexAttribPointer(loc.uv, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buf.i); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, D.indices[i], gl.DYNAMIC_DRAW);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex[D.textureIndices[i]]); gl.uniform1i(loc.tex, 0);
      gl.uniform1f(loc.maskpass, maskpass ? 1 : 0);
      gl.uniform1f(loc.op, D.opacities[i]);
      const mc = D.multiplyColors, sc = D.screenColors;
      gl.uniform4f(loc.mul, mc ? mc[i * 4] : 1, mc ? mc[i * 4 + 1] : 1, mc ? mc[i * 4 + 2] : 1, 1);
      gl.uniform4f(loc.scr, sc ? sc[i * 4] : 0, sc ? sc[i * 4 + 1] : 0, sc ? sc[i * 4 + 2] : 0, 1);
      const flags = D.constantFlags[i];
      if (flags & 4) gl.disable(gl.CULL_FACE); else { gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); gl.frontFace(gl.CCW); }
      gl.disable(gl.CULL_FACE);
      gl.drawElements(gl.TRIANGLES, D.indexCounts[i], gl.UNSIGNED_SHORT, 0);
    };
    for (const i of order) {
      if (!(D.dynamicFlags[i] & 1) || D.opacities[i] <= 0.001) continue;
      const masks = D.masks[i], nm = D.maskCounts[i], inv = D.constantFlags[i] & 8;
      if (nm > 0) {
        gl.enable(gl.STENCIL_TEST); gl.clear(gl.STENCIL_BUFFER_BIT);
        gl.colorMask(false, false, false, false); gl.stencilFunc(gl.ALWAYS, 1, 0xff); gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
        for (let k = 0; k < nm; k++) draw(masks[k], true);
        gl.colorMask(true, true, true, true); gl.stencilFunc(inv ? gl.NOTEQUAL : gl.EQUAL, 1, 0xff); gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
      } else gl.disable(gl.STENCIL_TEST);
      const f = D.constantFlags[i];
      if (f & 1) gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
      else if (f & 2) gl.blendFuncSeparate(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
      else gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      draw(i, false);
    }
    gl.disable(gl.STENCIL_TEST);
    D.resetDynamicFlags && D.resetDynamicFlags();
  }
  return {
    draw(g, sp, X, Y, Wd, Hd, t) {
      if (S.src !== sp.model && !S.loading) load(sp);
      if (S.err) { g.fillStyle = '#f66'; g.font = '16px sans-serif'; g.fillText(S.err, X + 10, Y + 30); return; }
      if (!S.ready) return;
      if (S.idleWant !== sp.motion) { S.idleWant = sp.motion; S.idle = sp.motion || 'Idle'; startMotion(S.idle, sp.index); }
      if (S.exprWant !== sp.expression) { S.exprWant = sp.expression; setExpression(sp.expression); }
      S.lipsync = sp.lipsync;
      // look at the pointer (or a fixed point)
      let want = [0, 0];
      if (sp.look === 'mouse' || sp.look === true) { const m = env.mouse(); want = [Math.max(-1, Math.min(1, (m[0] - (X + Wd / 2)) / (Wd * 0.8))), Math.max(-1, Math.min(1, -(m[1] - (Y + Hd * 0.3)) / (Hd * 0.8)))]; }
      else if (Array.isArray(sp.look)) want = sp.look;
      S.look = [S.look[0] + (want[0] - S.look[0]) * 0.12, S.look[1] + (want[1] - S.look[1]) * 0.12];
      apply(performance.now() / 1000); render();
      // fit inside the box, feet at the bottom
      const z = sp.zoom || 1, s = Math.min(Wd / cv.width, Hd / cv.height) * z, dw = cv.width * s, dh = cv.height * s;
      g.drawImage(cv, X + (Wd - dw) / 2 + (sp.xoffset || 0), Y + Hd - dh + (sp.yoffset || 0), dw, dh);
    },
    command(o) {
      if (!S.ready) { S.queue.push(o); return; }
      if (o.motion) { if (o.idle) S.idle = o.motion; startMotion(o.motion, o.index); }
      if ('expression' in o) setExpression(o.expression);
      if (o.look) S.lookFixed = o.look;
    },
    // a host can also run commands queued before the model finished loading
    flush() { const q = S.queue; S.queue = []; q.forEach((o) => this.command(o)); },
  };
}
