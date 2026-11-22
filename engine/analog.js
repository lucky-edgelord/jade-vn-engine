// vn-engine analog bed: generated background noise of an 80s/90s tape on a CRT. Loaded on first use.
//   hiss    tape hiss: white noise, band-limited to where tape hiss lives (about 2-12 kHz), slowly breathing
//   hum     mains hum: the 60 Hz (or 50 Hz) fundamental plus its 120/180/240 Hz harmonics
//   whine   the CRT flyback transformer: 15.734 kHz on NTSC sets, 15.625 kHz on PAL
//   rumble  low transport rumble from the deck's motor
// Python: renpy.analog(hiss=0.02, hum=0.012, whine=0.003, rumble=0.0, hz=60)  renpy.analog_off()

export function create(actx, dest) {
  const out = actx.createGain(); out.gain.value = 1; out.connect(dest);
  const sr = actx.sampleRate, len = sr * 3;
  const nb = actx.createBuffer(1, len, sr), d = nb.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const parts = {};
  const gain = (v) => { const g = actx.createGain(); g.gain.value = v; g.connect(out); return g; };

  // hiss
  const hs = actx.createBufferSource(); hs.buffer = nb; hs.loop = true;
  const hp = actx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2200; hp.Q.value = 0.5;
  const lp = actx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 12000;
  const hg = gain(0); hs.connect(hp); hp.connect(lp); lp.connect(hg); hs.start();
  const breath = actx.createOscillator(); breath.frequency.value = 0.13; const bd = actx.createGain(); bd.gain.value = 0; breath.connect(bd); bd.connect(hg.gain); breath.start();
  parts.hiss = { g: hg, mod: bd };

  // hum: fundamental + harmonics, through a gentle lowpass so it sounds like it comes through a speaker
  const humBus = actx.createBiquadFilter(); humBus.type = 'lowpass'; humBus.frequency.value = 600;
  const humG = gain(0); humBus.connect(humG);
  const oscs = [[1, 1], [2, 0.55], [3, 0.3], [4, 0.12], [5, 0.06]].map(([m, a]) => {
    const o = actx.createOscillator(); o.type = 'sine'; const og = actx.createGain(); og.gain.value = a; o.connect(og); og.connect(humBus); o.start(); return [o, m];
  });
  parts.hum = { g: humG, oscs };

  // flyback whine
  const wo = actx.createOscillator(); wo.type = 'sine'; wo.frequency.value = 15734; const wg = gain(0); wo.connect(wg); wo.start();
  parts.whine = { g: wg, o: wo };

  // rumble
  const rs = actx.createBufferSource(); rs.buffer = nb; rs.loop = true; rs.playbackRate.value = 0.5;
  const rl = actx.createBiquadFilter(); rl.type = 'lowpass'; rl.frequency.value = 90;
  const rg = gain(0); rs.connect(rl); rl.connect(rg); rs.start();
  parts.rumble = { g: rg };

  const ramp = (param, v, t = 0.6) => { param.cancelScheduledValues(actx.currentTime); param.setTargetAtTime(v, actx.currentTime, t / 3); };
  return {
    set(o = {}) {
      const hz = o.hz || 60;
      parts.hum.oscs.forEach(([osc, m]) => (osc.frequency.value = hz * m));
      parts.whine.o.frequency.value = o.whine_hz || (hz === 50 ? 15625 : 15734);
      if (o.hiss != null) { ramp(parts.hiss.g.gain, o.hiss, o.fade ?? 0.6); parts.hiss.mod.gain.value = o.hiss * 0.25; }
      if (o.hum != null) ramp(parts.hum.g.gain, o.hum, o.fade ?? 0.6);
      if (o.whine != null) ramp(parts.whine.g.gain, o.whine, o.fade ?? 0.6);
      if (o.rumble != null) ramp(parts.rumble.g.gain, o.rumble, o.fade ?? 0.6);
    },
    off(fade = 0.4) { for (const k in parts) ramp(parts[k].g.gain, 0, fade); },
  };
}
