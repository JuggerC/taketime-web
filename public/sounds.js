// sounds.js — Web Audio sound effects (jester's court edition)
// All sounds generated programmatically; no asset files needed.

const SoundFX = (() => {
  let ctx = null;
  let enabled = true;

  function getCtx() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) ctx = new AC();
    }
    return ctx;
  }

  function setEnabled(v) {
    enabled = v;
    try { localStorage.setItem('sound_enabled', v ? '1' : '0'); } catch (_) {}
  }
  function isEnabled() {
    try {
      const v = localStorage.getItem('sound_enabled');
      if (v !== null) enabled = v === '1';
    } catch (_) {}
    return enabled;
  }

  // ----- Low-level helpers -----
  function tone(freq, duration, type = 'sine', vol = 0.15, attack = 0.005, release = 0.05, startOffset = 0) {
    if (!enabled) return;
    const c = getCtx();
    if (!c) return;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.value = freq;
    const t0 = c.currentTime + startOffset;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + duration + release);
    o.connect(g).connect(c.destination);
    o.start(t0);
    o.stop(t0 + duration + release);
  }

  function noiseBurst(duration = 0.2, vol = 0.1, filterFreq = 2000) {
    if (!enabled) return;
    const c = getCtx();
    if (!c) return;
    const bufferSize = c.sampleRate * duration;
    const buffer = c.createBuffer(1, bufferSize, c.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    }
    const source = c.createBufferSource();
    source.buffer = buffer;
    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = filterFreq;
    const g = c.createGain();
    g.gain.value = vol;
    source.connect(filter).connect(g).connect(c.destination);
    source.start();
  }

  // ----- High-level sound effects -----

  return {
    enabled: isEnabled,
    setEnabled,

    // Soft click for buttons
    click:    () => tone(800, 0.04, 'square', 0.08),

    // Soft select chime (e.g. card pick, slot pick)
    select:   () => tone(1200, 0.06, 'sine', 0.12),

    // Card played: bell jingle (3 ascending notes)
    play:     () => {
      tone(880,  0.06, 'triangle', 0.16, 0.005, 0.06, 0.00);
      tone(1320, 0.07, 'triangle', 0.16, 0.005, 0.06, 0.05);
      tone(1760, 0.10, 'triangle', 0.14, 0.005, 0.10, 0.11);
    },

    // Face-up card reveal: shimmering high notes
    faceUp:   () => {
      tone(1568, 0.05, 'sine', 0.14, 0.005, 0.05, 0.00);
      tone(2093, 0.08, 'sine', 0.14, 0.005, 0.08, 0.04);
    },

    // Victory fanfare (4 ascending trumpet notes)
    win:      () => {
      tone(523, 0.10, 'triangle', 0.18, 0.01, 0.10, 0.00);
      tone(659, 0.10, 'triangle', 0.18, 0.01, 0.10, 0.12);
      tone(784, 0.10, 'triangle', 0.18, 0.01, 0.10, 0.24);
      tone(1047, 0.24, 'triangle', 0.20, 0.01, 0.20, 0.36);
    },

    // Defeat (deep descending sawtooth)
    lose:     () => {
      tone(330, 0.18, 'sawtooth', 0.10, 0.02, 0.18, 0.00);
      tone(247, 0.18, 'sawtooth', 0.10, 0.02, 0.18, 0.15);
      tone(196, 0.30, 'sawtooth', 0.10, 0.02, 0.25, 0.30);
    },

    // Error buzz
    error:    () => tone(180, 0.18, 'square', 0.13),

    // Player joined (bell)
    join:     () => {
      tone(1320, 0.04, 'sine', 0.10, 0.005, 0.04, 0.00);
      tone(1760, 0.06, 'sine', 0.10, 0.005, 0.06, 0.04);
    },

    // Declare first / start game: horn fanfare
    declare:  () => {
      tone(440, 0.08, 'triangle', 0.16, 0.01, 0.08, 0.00);
      tone(554, 0.08, 'triangle', 0.16, 0.01, 0.08, 0.07);
      tone(659, 0.12, 'triangle', 0.18, 0.01, 0.12, 0.14);
    },

    // Wax seal break: noise burst + thud
    sealBreak: () => {
      noiseBurst(0.08, 0.12, 1500);
      tone(120, 0.08, 'square', 0.10, 0.005, 0.08, 0.05);
    },

    // Curtain wipe: low-passed noise sweep
    curtain:  () => {
      const c = getCtx();
      if (!c) return;
      const bufferSize = c.sampleRate * 0.4;
      const buffer = c.createBuffer(1, bufferSize, c.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1);
      const source = c.createBufferSource();
      source.buffer = buffer;
      const filter = c.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(200,  c.currentTime);
      filter.frequency.linearRampToValueAtTime(3000, c.currentTime + 0.3);
      filter.Q.value = 2;
      const g = c.createGain();
      g.gain.setValueAtTime(0, c.currentTime);
      g.gain.linearRampToValueAtTime(0.08, c.currentTime + 0.05);
      g.gain.linearRampToValueAtTime(0, c.currentTime + 0.4);
      source.connect(filter).connect(g).connect(c.destination);
      source.start();
    },

    // Ready / confirm (2-note chimes)
    ready:    () => {
      tone(880, 0.06, 'sine', 0.13, 0.005, 0.06, 0.00);
      tone(1109, 0.08, 'sine', 0.13, 0.005, 0.08, 0.05);
    },
  };
})();
