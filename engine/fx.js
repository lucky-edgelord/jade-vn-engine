// vn-engine post-processing: "mosh"-style glitch/video effects as a WebGL shader chain.
// The 2D scene canvas is uploaded as a texture each frame, run through the enabled effects
// in a fixed order, and drawn to the visible canvas. Written for vn-engine; loaded on demand by vn.js.
//
// Script API (python):  renpy.fx('rgbshift', amount=0.006)   renpy.fx_off('rgbshift')   renpy.fx_off()
//                       transitions: Glitch(t, strength)      text tag: {glitch}
// JS API:               fx.set(name, params) / fx.off(name?) / fx.pulse(name, seconds, strength) / fx.list()

const HEAD = `precision mediump float;
varying vec2 uv; uniform sampler2D tex; uniform sampler2D prev; uniform vec2 res; uniform float time; uniform float amt; uniform vec4 p;
float rnd(vec2 c){ return fract(sin(dot(c, vec2(12.9898, 78.233))) * 43758.5453); }
float lum(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
`;

// name: [fragment body, default params {amount, p:[4]}, default pulse amount]
const EFFECTS = {
  pixelate: [`void main(){ float s = max(1.0, amt); vec2 px = s / res; vec2 u = (floor(uv / px) + 0.5) * px; gl_FragColor = texture2D(tex, u); }`, { amount: 6 }, 18],
  wave: [`void main(){ vec2 u = uv; u.x += sin(u.y * p.x + time * p.y) * amt * 0.02; u.y += cos(u.x * p.x * 0.7 + time * p.y * 0.8) * amt * 0.01; gl_FragColor = texture2D(tex, u); }`, { amount: 0.5, p: [18, 2, 0, 0] }, 1.5],
  badtv: [`void main(){ vec2 u = uv; float t = time * p.z;
      float y = u.y;
      float off = (sin(y * 24.0 + t * 3.0) * 0.5 + sin(y * 6.0 - t * 1.3) * 0.5) * amt * 0.012;
      off += (rnd(vec2(floor(y * 140.0), floor(t * 12.0))) - 0.5) * amt * 0.006;
      u.x += off; u.y = fract(u.y + time * p.w);
      vec4 c = texture2D(tex, u);
      c.r = texture2D(tex, u + vec2(amt * 0.004, 0.0)).r;
      gl_FragColor = c; }`, { amount: 1, p: [0, 0, 1, 0] }, 3],
  jitter: [`void main(){ float t = floor(time * 24.0); vec2 o = (vec2(rnd(vec2(t, 1.0)), rnd(vec2(t, 7.0))) - 0.5) * amt * vec2(0.02, 0.012); gl_FragColor = texture2D(tex, uv + o); }`, { amount: 0.5 }, 1.5],
  glitch: [`void main(){ vec2 u = uv; float t = floor(time * p.y);
      float row = floor(u.y * p.z);
      float b = rnd(vec2(row, t));
      if (b < amt * 0.35) u.x += (rnd(vec2(t, row)) - 0.5) * amt * 0.25;
      float line = step(1.0 - amt * 0.05, rnd(vec2(t * 1.3, floor(u.y * res.y * 0.5))));
      u.x += line * (rnd(vec2(t, u.y)) - 0.5) * 0.12;
      float sh = amt * 0.02 * (rnd(vec2(t, 3.0)) - 0.5);
      vec4 c = texture2D(tex, u);
      c.r = texture2D(tex, u + vec2(sh, 0.0)).r; c.b = texture2D(tex, u - vec2(sh, 0.0)).b;
      float cb = step(1.0 - amt * 0.12, rnd(floor(u * vec2(16.0, 9.0)) + t));
      c.rgb = mix(c.rgb, c.gbr, cb);
      gl_FragColor = c; }`, { amount: 0.6, p: [0, 14, 28, 0] }, 1.2],
  tear: [`void main(){ vec2 u = uv; float t = floor(time * 10.0);
      float band = floor(u.y * 9.0 + rnd(vec2(t, 2.0)) * 9.0);
      float on = step(1.0 - amt * 0.3, rnd(vec2(band, t)));
      u.x = fract(u.x + on * (rnd(vec2(band, t + 1.0)) - 0.5) * 0.3);
      vec4 c = texture2D(tex, u); c.rgb += on * 0.06; gl_FragColor = c; }`, { amount: 0.5 }, 1.5],
  rgbshift: [`void main(){ vec2 o = amt * vec2(cos(p.x), sin(p.x)); vec4 c = texture2D(tex, uv);
      gl_FragColor = vec4(texture2D(tex, uv + o).r, c.g, texture2D(tex, uv - o).b, c.a); }`, { amount: 0.004, p: [0, 0, 0, 0] }, 0.02],
  chroma: [`void main(){ vec2 d = uv - 0.5; vec4 c = texture2D(tex, uv);
      gl_FragColor = vec4(texture2D(tex, uv + d * amt * 0.03).r, c.g, texture2D(tex, uv - d * amt * 0.03).b, c.a); }`, { amount: 0.5 }, 2],
  melt: [`void main(){ vec4 c = texture2D(tex, uv); float l = lum(c.rgb);
      vec2 pu = uv + vec2((l - 0.5) * amt * 0.012, amt * 0.004 + sin(uv.x * 30.0 + time) * amt * 0.002);
      vec4 q = texture2D(prev, pu);
      float keep = p.x * step(0.04, abs(lum(q.rgb) - l));
      gl_FragColor = mix(c, q, keep); }`, { amount: 1, p: [0.85, 0, 0, 0] }, 2],
  huesat: [`vec3 hue(vec3 c, float a){ const vec3 k = vec3(0.57735); float ca = cos(a); return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca); }
    void main(){ vec4 c = texture2D(tex, uv); vec3 x = hue(c.rgb, p.x);
      x = mix(vec3(lum(x)), x, p.y); x = (x - 0.5) * p.w + 0.5 + p.z;
      gl_FragColor = vec4(mix(c.rgb, x, amt), c.a); }`, { amount: 1, p: [0, 1, 0, 1] }, 1],
  tint: [`void main(){ vec4 c = texture2D(tex, uv); gl_FragColor = vec4(mix(c.rgb, c.rgb * p.rgb, amt), c.a); }`, { amount: 0.5, p: [1, 0.4, 0.5, 0] }, 1],
  posterize: [`void main(){ vec4 c = texture2D(tex, uv); float n = max(2.0, amt); gl_FragColor = vec4(floor(c.rgb * n + 0.5) / n, c.a); }`, { amount: 6 }, 3],
  halftone: [`void main(){ vec2 px = uv * res; float s = max(3.0, p.x); vec2 cell = floor(px / s) * s + s * 0.5;
      vec4 c = texture2D(tex, cell / res); float r = (1.0 - lum(c.rgb)) * s * 0.7;
      float d = step(length(px - cell), r); vec3 o = mix(vec3(1.0), c.rgb * 0.35, d);
      gl_FragColor = vec4(mix(texture2D(tex, uv).rgb, o, amt), 1.0); }`, { amount: 1, p: [8, 0, 0, 0] }, 1],
  dither: [`float bayer(vec2 v){ vec2 a = mod(floor(v), 4.0); float i = a.x + a.y * 4.0;
      return mod(i * 7.0 + floor(i / 4.0) * 3.0, 16.0) / 16.0; }
    void main(){ vec4 c = texture2D(tex, uv); float n = max(2.0, p.x); vec3 q = floor(c.rgb * (n - 1.0) + bayer(uv * res / max(1.0, p.y))) / (n - 1.0);
      gl_FragColor = vec4(mix(c.rgb, q, amt), c.a); }`, { amount: 1, p: [3, 2, 0, 0] }, 1],
  invert: [`void main(){ vec4 c = texture2D(tex, uv); gl_FragColor = vec4(mix(c.rgb, 1.0 - c.rgb, amt), c.a); }`, { amount: 1 }, 1],
  mirror: [`void main(){ vec2 u = uv; if (p.x < 0.5) u.x = u.x > 0.5 ? 1.0 - u.x : u.x; else u.y = u.y > 0.5 ? 1.0 - u.y : u.y; gl_FragColor = texture2D(tex, mix(uv, u, step(0.5, amt))); }`, { amount: 1, p: [0, 0, 0, 0] }, 1],
  glow: [`void main(){ vec4 c = texture2D(tex, uv); vec3 s = vec3(0.0); vec2 r = p.x / res;
      for (int i = 0; i < 8; i++) { float a = float(i) * 0.785398; vec3 q = texture2D(tex, uv + vec2(cos(a), sin(a)) * r).rgb; s += max(q - 0.55, 0.0); }
      gl_FragColor = vec4(c.rgb + s * amt * 0.35, c.a); }`, { amount: 1, p: [6, 0, 0, 0] }, 2],
  scanlines: [`void main(){ vec4 c = texture2D(tex, uv); float n = p.x > 0.0 ? p.x : res.y * 0.5;
      c.rgb *= 1.0 - amt * (0.5 + 0.5 * sin(uv.y * n * 6.28318)); gl_FragColor = c; }`, { amount: 0.18, p: [0, 0, 0, 0] }, 0.5],
  grain: [`void main(){ vec4 c = texture2D(tex, uv); c.rgb += (rnd(uv * res + fract(time * 13.7) * 91.0) - 0.5) * amt; gl_FragColor = c; }`, { amount: 0.08 }, 0.3],
  vignette: [`void main(){ vec4 c = texture2D(tex, uv); float d = distance(uv, vec2(0.5)) * 1.41421;
      float v = smoothstep(1.0 - p.x, 1.0 - p.x - 0.55, d); c.rgb = mix(c.rgb, p.yzw, (1.0 - v) * amt); gl_FragColor = c; }`, { amount: 0.7, p: [0.25, 0, 0, 0] }, 1],
};
const ORDER = ['pixelate', 'wave', 'badtv', 'jitter', 'glitch', 'tear', 'rgbshift', 'chroma', 'melt', 'huesat', 'tint', 'posterize', 'halftone', 'dither', 'invert', 'mirror', 'glow', 'scanlines', 'grain', 'vignette'];
const VERT = `attribute vec2 a; varying vec2 uv; void main(){ uv = a * 0.5 + 0.5; gl_Position = vec4(a, 0.0, 1.0); }`;
const COPY = `precision mediump float; varying vec2 uv; uniform sampler2D tex; void main(){ gl_FragColor = texture2D(tex, uv); }`;

export const FX = {
  effects: Object.keys(EFFECTS),
  create(out, src) {
    let gl;
    try { gl = out.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false }); } catch (e) { gl = null; }
    if (!gl) return null;
    const W = src.width, H = src.height;
    const prog = (fs) => {
      const p = gl.createProgram();
      for (const [type, s] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, fs]]) {
        const sh = gl.createShader(type); gl.shaderSource(sh, s); gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) { console.warn('fx shader', gl.getShaderInfoLog(sh)); return null; }
        gl.attachShader(p, sh);
      }
      gl.bindAttribLocation(p, 0, 'a'); gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) return null;
      const u = {}; for (const n of ['tex', 'prev', 'res', 'time', 'amt', 'p']) u[n] = gl.getUniformLocation(p, n);
      return { p, u };
    };
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const texture = () => {
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    const target = () => {
      const t = texture(); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      return { t, f };
    };
    const srcTex = texture();
    const T = [target(), target(), target()];   // ping, pong, previous frame
    const copy = prog(COPY);
    const progs = {};
    const active = {};                          // name -> {amount, p}
    const pulses = {};                          // name -> {t0, dur, s}
    const pass = (pr, inTex, outFb, amt, p, time) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, outFb); gl.viewport(0, 0, W, H);
      gl.useProgram(pr.p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, inTex); gl.uniform1i(pr.u.tex, 0);
      if (pr.u.prev) { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, T[2].t); gl.uniform1i(pr.u.prev, 1); }
      if (pr.u.res) gl.uniform2f(pr.u.res, W, H);
      if (pr.u.time) gl.uniform1f(pr.u.time, time);
      if (pr.u.amt) gl.uniform1f(pr.u.amt, amt);
      if (pr.u.p) gl.uniform4f(pr.u.p, p[0] || 0, p[1] || 0, p[2] || 0, p[3] || 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    const api = {
      set(name, params = {}) {
        if (!EFFECTS[name]) { console.warn('fx: unknown effect', name); return; }
        const d = EFFECTS[name][1];
        const cur = active[name] || { amount: d.amount, p: (d.p || [0, 0, 0, 0]).slice() };
        if (params.amount != null) cur.amount = params.amount;
        if (params.p) cur.p = params.p.slice();
        for (let i = 0; i < 4; i++) if (params['p' + i] != null) cur.p[i] = params['p' + i];
        if (params.color) { const c = hex(params.color); cur.p[name === 'vignette' ? 1 : 0] = c[0]; cur.p[name === 'vignette' ? 2 : 1] = c[1]; cur.p[name === 'vignette' ? 3 : 2] = c[2]; }
        if (params.duration) { pulses[name] = { t0: performance.now() / 1000, dur: params.duration, s: params.amount ?? EFFECTS[name][2] }; return; }
        active[name] = cur;
      },
      off(name) { if (name) delete active[name]; else for (const k in active) delete active[k]; },
      pulse(name, dur, strength = 1) { if (EFFECTS[name]) pulses[name] = { t0: performance.now() / 1000, dur, s: EFFECTS[name][2] * strength }; },
      list() { return JSON.parse(JSON.stringify(active)); },
      busy() { return Object.keys(active).length > 0 || Object.keys(pulses).length > 0; },
      render(time) {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.bindTexture(gl.TEXTURE_2D, srcTex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
        let inTex = srcTex, k = 0, usedMelt = false;
        for (const name of ORDER) {
          let amt = 0, p = null;
          if (active[name]) { amt = active[name].amount; p = active[name].p; }
          const pu = pulses[name];
          if (pu) {
            const x = (time - pu.t0) / pu.dur;
            if (x >= 1) delete pulses[name]; else { amt += pu.s * (1 - x) * (1 - x); p = p || (EFFECTS[name][1].p || [0, 0, 0, 0]); }
          }
          if (!p || amt === 0) continue;
          const pr = progs[name] || (progs[name] = prog(HEAD + EFFECTS[name][0]));
          if (!pr) continue;
          pass(pr, inTex, T[k].f, amt, p, time); inTex = T[k].t; k ^= 1;
          if (name === 'melt') usedMelt = true;
        }
        if (usedMelt) pass(copy, inTex, T[2].f, 0, [0, 0, 0, 0], time);
        pass(copy, inTex, null, 0, [0, 0, 0, 0], time);
      },
    };
    return api;
  },
};
function hex(c) {
  let s = String(c).replace('#', ''); if (s.length <= 4) s = [...s].map((x) => x + x).join('');
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);
}
