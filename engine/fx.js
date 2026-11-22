// vn-engine post-processing: "mosh"-style glitch/video effects as a WebGL shader chain.
// The 2D scene canvas is uploaded as a texture each frame, run through the enabled effects
// in a fixed order, and drawn to the visible canvas. Written for vn-engine; loaded on demand by vn.js.
//
// Script API (python):  renpy.fx('rgbshift', amount=0.006)   renpy.fx_off('rgbshift')   renpy.fx_off()
//                       renpy.fx('grade', preset='nashville')  renpy.fx('lut', image='luts/teal.png')  (16x16x16 strip)
//                       renpy.fx('vhs') renpy.fx('crt') renpy.fx('static', amount=.3, duration=.5) ...
//                       transitions: Glitch(t, strength)      text tag: {glitch}
// JS API:               fx.set(name, params) / fx.off(name?) / fx.pulse(name, seconds, strength) / fx.list()

const HEAD = `precision mediump float;
varying vec2 uv; uniform sampler2D tex; uniform sampler2D prev; uniform sampler2D lut; uniform vec2 res; uniform float time; uniform float amt; uniform vec4 p; uniform vec4 q; uniform vec4 co;
float rnd(vec2 c){ return fract(sin(dot(c, vec2(12.9898, 78.233))) * 43758.5453); }
float vnoise(vec2 x){ vec2 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(rnd(i), rnd(i + vec2(1.0, 0.0)), f.x), mix(rnd(i + vec2(0.0, 1.0)), rnd(i + 1.0), f.x), f.y); }
float fbm(vec2 x){ float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * vnoise(x); x *= 2.03; a *= 0.5; } return v; }
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
  // ---------------------------------------------------------------- analog / horror set
  vhs: [`vec3 yiq(vec3 c){ return mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312) * c; }
    vec3 rgb(vec3 c){ return mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703) * c; }
    void main(){ vec2 u = uv; float t = time;
      float y = 1.0 - u.y;
      // tracking band that rolls down the picture
      float band = fract(t * 0.07 + 0.3); float d = y - band; float tb = exp(-d * d * 900.0) * p.x;
      u.x += (rnd(vec2(floor(y * 240.0), floor(t * 30.0))) - 0.5) * 0.03 * tb + sin(y * 60.0 + t * 4.0) * 0.0012 * amt;
      // head-switching noise at the bottom edge
      float hs = smoothstep(0.955, 1.0, y) * p.w; u.x += hs * (rnd(vec2(floor(y * 300.0), floor(t * 24.0))) * 0.05 + 0.02);
      // soft luma, smeared chroma (VHS has far less colour resolution than brightness)
      vec2 px = vec2(1.0 / res.x, 0.0);
      vec3 L = yiq((texture2D(tex, u - px).rgb + texture2D(tex, u).rgb * 2.0 + texture2D(tex, u + px).rgb) * 0.25);
      vec3 C = vec3(0.0); for (int i = 0; i < 8; i++) { float o = (float(i) - 2.0) * p.z * 1.6; C += yiq(texture2D(tex, u + px * o + vec2(0.0, 0.0)).rgb); } C /= 8.0;
      vec3 c = rgb(vec3(L.x, C.y * 0.9, C.z * 0.9));
      // dropouts: thin bright streaks
      float dr = step(0.9985 - amt * 0.0015, rnd(vec2(floor(y * 400.0), floor(t * 18.0)))); c += dr * vec3(0.7) * rnd(vec2(u.x * 40.0, t));
      c += tb * (rnd(u * res + t) - 0.5) * 0.35 + hs * (rnd(u * res - t) - 0.3) * 0.6;
      c = mix(c, c * vec3(1.02, 0.98, 1.05) + 0.02, 0.6);
      gl_FragColor = vec4(mix(texture2D(tex, uv).rgb, c, amt), 1.0); }`, { amount: 1, p: [0.6, 0, 1.2, 1] }, 1],
  crt: [`void main(){ vec2 c = uv * 2.0 - 1.0; c *= 1.0 + p.x * dot(c.yx, c.yx) * vec2(0.12, 0.16) ;
      vec2 u = c * 0.5 + 0.5;
      if (u.x < 0.0 || u.x > 1.0 || u.y < 0.0 || u.y > 1.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
      vec3 col = texture2D(tex, u).rgb;
      vec3 bl = (texture2D(tex, u + vec2(2.0, 0.0) / res).rgb + texture2D(tex, u - vec2(2.0, 0.0) / res).rgb + texture2D(tex, u + vec2(0.0, 2.0) / res).rgb + texture2D(tex, u - vec2(0.0, 2.0) / res).rgb) * 0.25;
      col += max(bl - 0.6, 0.0) * 0.6;                               // phosphor bloom
      float sl = 0.5 + 0.5 * cos(u.y * res.y * 3.14159); col *= 1.0 - p.z * (1.0 - sl);            // scanlines
      float m = mod(floor(u.x * res.x), 3.0); vec3 mask = m < 1.0 ? vec3(1.0, 0.7, 0.7) : m < 2.0 ? vec3(0.7, 1.0, 0.7) : vec3(0.7, 0.7, 1.0);
      col *= mix(vec3(1.0), mask, p.y);                              // aperture grille
      float v = u.x * u.y * (1.0 - u.x) * (1.0 - u.y); col *= pow(16.0 * v, 0.25);   // tube vignette
      col *= 1.0 - p.w * 0.04 * rnd(vec2(floor(time * 30.0), 1.0)); // flicker
      gl_FragColor = vec4(mix(texture2D(tex, uv).rgb, col * 1.12, amt), 1.0); }`, { amount: 1, p: [1, 0.35, 0.35, 1] }, 1],
  static: [`void main(){ vec4 c = texture2D(tex, uv); float n = rnd(floor(uv * res / max(1.0, p.x)) + fract(time * 7.13) * 99.0);
      float roll = smoothstep(0.0, 0.15, fract(uv.y + time * 0.5)) * 0.2 + 0.8;
      gl_FragColor = vec4(mix(c.rgb, vec3(n) * roll, amt), 1.0); }`, { amount: 0.15, p: [2, 0, 0, 0] }, 1],
  interference: [`void main(){ vec2 u = uv; float y = uv.y * 6.0 + time * p.x; float bar = smoothstep(0.85, 1.0, sin(y) * 0.5 + 0.5);
      u.x += bar * amt * 0.02 * sin(uv.y * 200.0 + time * 30.0);
      vec4 c = texture2D(tex, u); c.rgb += bar * amt * vec3(0.12, -0.04, 0.10) + amt * 0.06 * sin(uv.y * res.y * 1.7 + time * 50.0);
      gl_FragColor = c; }`, { amount: 0.5, p: [1.5, 0, 0, 0] }, 1.5],
  echo: [`void main(){ vec4 c = texture2D(tex, uv); vec4 g = texture2D(prev, uv + vec2(p.x, p.y) * 0.002); gl_FragColor = vec4(max(c.rgb, mix(c.rgb, g.rgb, amt)), 1.0); }`, { amount: 0.75, p: [1, 0, 0, 0] }, 0.9],
  fisheye: [`void main(){ vec2 c = uv - 0.5; float r = length(c); vec2 u = 0.5 + c * (1.0 + amt * r * r * 1.6) / (1.0 + amt * 0.4);
      gl_FragColor = (u.x < 0.0 || u.x > 1.0 || u.y < 0.0 || u.y > 1.0) ? vec4(0.0, 0.0, 0.0, 1.0) : texture2D(tex, u); }`, { amount: 0.4 }, 1],
  pulse: [`void main(){ vec4 c = texture2D(tex, uv); float b = fract(time * p.x / 60.0); float beat = exp(-b * 9.0) + 0.6 * exp(-max(0.0, b - 0.18) * 11.0) * step(0.18, b);
      float d = distance(uv, vec2(0.5)) * 1.41421; float v = smoothstep(0.35, 1.0, d) * (0.45 + 0.55 * beat);
      gl_FragColor = vec4(mix(c.rgb, vec3(0.35, 0.0, 0.02), v * amt), 1.0); }`, { amount: 0.8, p: [72, 0, 0, 0] }, 1],
  creep: [`void main(){ vec4 c = texture2D(tex, uv); vec2 d = uv - 0.5; float r = length(d * vec2(res.x / res.y, 1.0));
      float n = fbm(vec2(atan(d.y, d.x) * 3.0, r * 4.0 - time * 0.25) + time * 0.05);
      float edge = smoothstep(0.95 - amt * 0.45, 1.25 - amt * 0.45, r + n * 0.3) * min(1.0, amt * 2.0);
      gl_FragColor = vec4(c.rgb * (1.0 - edge), 1.0); }`, { amount: 0.4 }, 1],
  flicker: [`void main(){ vec4 c = texture2D(tex, uv); float t = floor(time * 18.0); float f = step(1.0 - amt * 0.3, rnd(vec2(t, 4.0)));
      float k = 1.0 - f * (0.5 + 0.5 * rnd(vec2(t, 9.0))) - amt * 0.06 * rnd(vec2(t, 2.0)); gl_FragColor = vec4(c.rgb * k, 1.0); }`, { amount: 0.4 }, 1.5],
  nightvision: [`void main(){ vec4 c = texture2D(tex, uv); float l = lum(c.rgb) * 1.8 + (rnd(uv * res + time) - 0.5) * 0.2;
      float v = 1.0 - smoothstep(0.35, 0.75, distance(uv, vec2(0.5)));
      gl_FragColor = vec4(mix(c.rgb, vec3(0.1, 1.0, 0.25) * l * v, amt), 1.0); }`, { amount: 1 }, 1],
  thermal: [`vec3 pal(float x){ vec3 a = vec3(0.0, 0.0, 0.1), b = vec3(0.25, 0.0, 0.55), c = vec3(0.9, 0.1, 0.25), d = vec3(1.0, 0.75, 0.1), e = vec3(1.0);
      return x < 0.25 ? mix(a, b, x * 4.0) : x < 0.5 ? mix(b, c, x * 4.0 - 1.0) : x < 0.75 ? mix(c, d, x * 4.0 - 2.0) : mix(d, e, x * 4.0 - 3.0); }
    void main(){ vec4 c = texture2D(tex, uv); gl_FragColor = vec4(mix(c.rgb, pal(lum(c.rgb)), amt), 1.0); }`, { amount: 1 }, 1],
  // colour grading: Instagram-style presets (see GRADES) or your own numbers
  grade: [`void main(){ vec4 c = texture2D(tex, uv); vec3 x = c.rgb;
      vec3 sep = vec3(dot(x, vec3(0.393, 0.769, 0.189)), dot(x, vec3(0.349, 0.686, 0.168)), dot(x, vec3(0.272, 0.534, 0.131)));
      x = mix(x, sep, p.w) * p.rgb;
      x = (x - 0.5) * q.x + 0.5 + q.y;
      x = mix(vec3(lum(x)), x, q.z);
      x = co.rgb * q.w + x * (1.0 - q.w);
      x *= 1.0 - co.w * smoothstep(0.3, 1.0, distance(uv, vec2(0.5)) * 1.41421);
      gl_FragColor = vec4(mix(c.rgb, clamp(x, 0.0, 1.0), amt), 1.0); }`, { amount: 1, p: [1, 1, 1, 0], q: [1, 0, 1, 0], co: [0, 0, 0, 0] }, 1],
  lut: [`void main(){ vec4 c = texture2D(tex, uv); float n = p.x; vec3 x = clamp(c.rgb, 0.0, 1.0) * (n - 1.0);
      float b0 = floor(x.b), b1 = min(n - 1.0, b0 + 1.0);
      vec2 a = vec2((b0 * n + x.r + 0.5) / (n * n), (x.g + 0.5) / n), b = vec2((b1 * n + x.r + 0.5) / (n * n), (x.g + 0.5) / n);
      vec3 l = mix(texture2D(lut, a).rgb, texture2D(lut, b).rgb, x.b - b0);
      gl_FragColor = vec4(mix(c.rgb, l, amt), c.a); }`, { amount: 1, p: [16, 0, 0, 0] }, 1],
  vignette: [`void main(){ vec4 c = texture2D(tex, uv); float d = distance(uv, vec2(0.5)) * 1.41421;
      float v = smoothstep(1.0 - p.x, 1.0 - p.x - 0.55, d); c.rgb = mix(c.rgb, p.yzw, (1.0 - v) * amt); gl_FragColor = c; }`, { amount: 0.7, p: [0.25, 0, 0, 0] }, 1],
};
const ORDER = ['pixelate', 'fisheye', 'wave', 'badtv', 'jitter', 'glitch', 'tear', 'rgbshift', 'chroma', 'melt', 'echo', 'grade', 'lut', 'huesat', 'tint',
  'nightvision', 'thermal', 'posterize', 'halftone', 'dither', 'invert', 'mirror', 'glow', 'vhs', 'interference', 'static', 'creep', 'pulse', 'flicker',
  'scanlines', 'grain', 'vignette', 'crt'];
const PREV = new Set(['melt', 'echo']);
// grade presets: p = [mulR, mulG, mulB, sepia], q = [contrast, brightness, saturation, fade], co = [liftR, liftG, liftB, vignette]
export const GRADES = {
  clarendon: [[1, 1.02, 1.08, 0], [1.2, 0, 1.35, 0.04], [0.1, 0.2, 0.25, 0.1]],
  gingham: [[1.05, 1, 0.95, 0], [0.9, 0.05, 0.8, 0.2], [0.75, 0.7, 0.7, 0]],
  juno: [[1.1, 1, 0.9, 0], [1.15, 0, 1.3, 0], [0, 0, 0, 0.15]],
  lark: [[1, 1.02, 1.05, 0], [0.95, 0.08, 0.9, 0.08], [0.3, 0.35, 0.4, 0]],
  moon: [[1, 1, 1, 0], [1.2, 0.02, 0, 0.12], [0.2, 0.2, 0.22, 0.2]],
  valencia: [[1.08, 0.98, 0.88, 0.08], [1.08, 0, 1, 0.1], [0.35, 0.2, 0.2, 0.1]],
  nashville: [[1.1, 0.98, 0.88, 0], [0.9, 0.04, 1.2, 0.2], [0.97, 0.73, 0.62, 0]],
  '1977': [[1.1, 1, 1, 0], [1.1, 0.02, 1.3, 0.15], [1, 0.55, 0.55, 0.1]],
  xpro2: [[1.05, 1.05, 0.88, 0], [1.3, 0, 1.25, 0], [0, 0, 0, 0.5]],
  toaster: [[1.2, 1, 0.85, 0], [1.3, 0, 1.1, 0.1], [0.5, 0.2, 0.1, 0.45]],
  kelvin: [[1.25, 1.05, 0.75, 0], [1.1, 0, 1.4, 0], [0, 0, 0, 0.1]],
  inkwell: [[1, 1, 1, 0], [1.25, 0.05, 0, 0], [0, 0, 0, 0.15]],
  lofi: [[1, 1, 1, 0], [1.5, 0, 1.4, 0], [0, 0, 0, 0.45]],
  hudson: [[0.9, 1, 1.15, 0], [1.1, 0, 1, 0.05], [0.3, 0.4, 0.6, 0.3]],
  willow: [[1, 1, 1, 0], [0.95, 0.02, 0.05, 0.2], [0.85, 0.8, 0.75, 0.2]],
  sepia: [[1, 1, 1, 1], [1.05, 0, 1, 0.05], [0.3, 0.2, 0.1, 0.3]],
  // horror
  found_footage: [[0.95, 1, 1.05, 0], [1.15, -0.02, 0.55, 0.12], [0.1, 0.14, 0.12, 0.4]],
  cursed: [[1, 1.08, 0.75, 0], [1.25, -0.03, 0.7, 0.1], [0.15, 0.2, 0.05, 0.6]],
  bloodmoon: [[1.25, 0.72, 0.72, 0], [1.3, -0.04, 0.9, 0], [0.2, 0, 0, 0.7]],
  coldcase: [[0.85, 0.97, 1.1, 0], [1.2, -0.02, 0.4, 0.1], [0.1, 0.15, 0.2, 0.35]],
  bleach: [[1, 1, 1, 0], [1.4, 0, 0.35, 0], [0, 0, 0, 0.3]],
  morgue: [[0.9, 1.02, 1.0, 0], [1.1, 0.02, 0.25, 0.18], [0.55, 0.65, 0.62, 0.35]],
  rotten: [[0.95, 1.05, 0.7, 0.3], [1.2, -0.05, 0.8, 0.12], [0.2, 0.22, 0.08, 0.55]],
};
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
      const u = {}; for (const n of ['tex', 'prev', 'lut', 'res', 'time', 'amt', 'p', 'q', 'co']) u[n] = gl.getUniformLocation(p, n);
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
    let lutTex = null;
    const pass = (pr, inTex, outFb, amt, p, time, e) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, outFb); gl.viewport(0, 0, W, H);
      gl.useProgram(pr.p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, inTex); gl.uniform1i(pr.u.tex, 0);
      if (pr.u.prev) { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, T[2].t); gl.uniform1i(pr.u.prev, 1); }
      if (pr.u.res) gl.uniform2f(pr.u.res, W, H);
      if (pr.u.time) gl.uniform1f(pr.u.time, time);
      if (pr.u.amt) gl.uniform1f(pr.u.amt, amt);
      if (pr.u.p) gl.uniform4f(pr.u.p, p[0] || 0, p[1] || 0, p[2] || 0, p[3] || 0);
      const q = (e && e.q) || [0, 0, 0, 0], co = (e && e.co) || [0, 0, 0, 0];
      if (pr.u.q) gl.uniform4f(pr.u.q, q[0], q[1], q[2], q[3]);
      if (pr.u.co) gl.uniform4f(pr.u.co, co[0], co[1], co[2], co[3]);
      if (pr.u.lut && lutTex) { gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, lutTex); gl.uniform1i(pr.u.lut, 2); }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    const api = {
      set(name, params = {}) {
        if (!EFFECTS[name]) { console.warn('fx: unknown effect', name); return; }
        const d = EFFECTS[name][1];
        const cur = active[name] || { amount: d.amount, p: (d.p || [0, 0, 0, 0]).slice(), q: (d.q || [0, 0, 0, 0]).slice(), co: (d.co || [0, 0, 0, 0]).slice() };
        if (params.preset && name === 'grade') { const g = GRADES[params.preset]; if (!g) console.warn('fx: unknown grade', params.preset); else { cur.p = g[0].slice(); cur.q = g[1].slice(); cur.co = g[2].slice(); } }
        if (params.q) cur.q = params.q.slice();
        if (params.co) cur.co = params.co.slice();
        if (name === 'lut' && params.image) {
          const im = new Image(); im.onload = () => { lutTex = texture(); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im); cur.p[0] = im.height; }; im.src = params.image;
        }
        if (params.amount != null) cur.amount = params.amount;
        if (params.p) cur.p = params.p.slice();
        for (let i = 0; i < 4; i++) if (params['p' + i] != null) cur.p[i] = params['p' + i];
        if (params.color) { const c = hex(params.color); cur.p[name === 'vignette' ? 1 : 0] = c[0]; cur.p[name === 'vignette' ? 2 : 1] = c[1]; cur.p[name === 'vignette' ? 3 : 2] = c[2]; }
        if (params.duration) { pulses[name] = { t0: performance.now() / 1000, dur: params.duration, s: params.amount ?? EFFECTS[name][2], e: cur }; return; }
        active[name] = cur;
      },
      off(name) { if (name) delete active[name]; else for (const k in active) delete active[k]; },
      pulse(name, dur, strength = 1) { if (EFFECTS[name]) pulses[name] = { t0: performance.now() / 1000, dur, s: EFFECTS[name][2] * strength }; },
      list() { return JSON.parse(JSON.stringify(active)); },
      busy() { return Object.keys(active).length > 0 || Object.keys(pulses).length > 0; },
      render(time) {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, srcTex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
        let inTex = srcTex, k = 0, usedPrev = false;
        for (const name of ORDER) {
          let amt = 0, p = null, e = active[name];
          if (e) { amt = e.amount; p = e.p; }
          const pu = pulses[name];
          if (pu) {
            const x = (time - pu.t0) / pu.dur;
            if (x >= 1) delete pulses[name]; else { amt += pu.s * (1 - x) * (1 - x); e = e || pu.e; p = p || (e && e.p) || (EFFECTS[name][1].p || [0, 0, 0, 0]); }
          }
          if (!p || amt === 0 || (name === 'lut' && !lutTex)) continue;
          const pr = progs[name] || (progs[name] = prog(HEAD + EFFECTS[name][0]));
          if (!pr) continue;
          pass(pr, inTex, T[k].f, amt, p, time, e); inTex = T[k].t; k ^= 1;
          if (PREV.has(name)) usedPrev = true;
        }
        if (usedPrev) pass(copy, inTex, T[2].f, 0, [0, 0, 0, 0], time);
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
