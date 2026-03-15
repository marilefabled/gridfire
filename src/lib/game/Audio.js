/**
 * Synthesized audio — all tones programmatic. No assets.
 * Arcade/action aesthetic: punchy, satisfying, immediate.
 */
class Audio {
  constructor() {
    this.ctx = null;
    this.gain = null;
    this.init = false;
  }

  _init() {
    if (this.init) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 0.2;
      this.gain.connect(this.ctx.destination);
      this.init = true;
    } catch {}
  }

  _ensure() {
    if (!this.init) this._init();
    if (!this.ctx) return false;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return true;
  }

  _tone(freq, dur, type = 'sine', vol = 0.3, delay = 0) {
    if (!this._ensure()) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g);
    g.connect(this.gain);
    o.start(t);
    o.stop(t + dur);
  }

  _noise(dur, vol = 0.05, delay = 0) {
    if (!this._ensure()) return;
    const t = this.ctx.currentTime + delay;
    const sz = this.ctx.sampleRate * dur;
    const buf = this.ctx.createBuffer(1, sz, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < sz; i++) d[i] = (Math.random() * 2 - 1) * 0.5;
    const src = this.ctx.createBufferSource();
    const g = this.ctx.createGain();
    src.buffer = buf;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(g);
    g.connect(this.gain);
    src.start(t);
    src.stop(t + dur);
  }

  // Grid actions
  swap() {
    this._tone(800, 0.04, 'square', 0.1);
    this._tone(1100, 0.03, 'sine', 0.08, 0.02);
  }

  badSwap() {
    this._tone(200, 0.1, 'sawtooth', 0.06);
    this._tone(150, 0.1, 'sawtooth', 0.04, 0.05);
  }

  match(size) {
    const base = 523;
    for (let i = 0; i < Math.min(size, 5); i++) {
      this._tone(base * (1 + i * 0.25), 0.1, 'sine', 0.15 - i * 0.02, i * 0.06);
    }
  }

  combo(count) {
    const notes = [523, 659, 784, 1047];
    notes.slice(0, Math.min(count, 4)).forEach((f, i) => {
      this._tone(f, 0.15, 'sine', 0.12, i * 0.08);
    });
  }

  // Combat
  fire(element) {
    switch (element) {
      case 'fire':
        this._tone(300, 0.08, 'sawtooth', 0.12);
        this._tone(200, 0.15, 'sawtooth', 0.08, 0.04);
        this._noise(0.08, 0.04, 0.02);
        break;
      case 'ice':
        this._tone(1200, 0.06, 'sine', 0.1);
        this._tone(1800, 0.08, 'sine', 0.06, 0.03);
        break;
      case 'lightning':
        this._noise(0.04, 0.08);
        this._tone(2000, 0.03, 'square', 0.1, 0.01);
        this._tone(1500, 0.04, 'square', 0.06, 0.03);
        break;
      case 'kinetic':
        this._tone(150, 0.12, 'sine', 0.15);
        this._tone(100, 0.1, 'sine', 0.1, 0.04);
        break;
    }
  }

  hit() {
    this._tone(400, 0.05, 'square', 0.08);
    this._noise(0.03, 0.04, 0.02);
  }

  kill() {
    this._tone(600, 0.06, 'sine', 0.12);
    this._tone(800, 0.06, 'sine', 0.1, 0.05);
    this._tone(1000, 0.08, 'sine', 0.08, 0.1);
    this._noise(0.08, 0.03, 0.05);
  }

  playerHit() {
    this._tone(150, 0.3, 'sawtooth', 0.15);
    this._tone(120, 0.3, 'sawtooth', 0.12, 0.05);
    this._noise(0.15, 0.06);
  }

  blast() {
    this._noise(0.2, 0.1);
    this._tone(200, 0.3, 'sawtooth', 0.12);
    this._tone(150, 0.3, 'sine', 0.1, 0.05);
  }

  waveStart() {
    this._tone(440, 0.1, 'triangle', 0.1);
    this._tone(554, 0.1, 'triangle', 0.08, 0.08);
    this._tone(659, 0.12, 'triangle', 0.06, 0.16);
  }

  gameOver() {
    const notes = [440, 370, 311, 261, 220];
    notes.forEach((f, i) => {
      this._tone(f, 0.3, 'sawtooth', 0.1 - i * 0.015, i * 0.15);
    });
    this._noise(0.3, 0.04, 0.3);
    this.stopPulse();
  }

  weaknessHit() {
    this._tone(880, 0.08, 'sine', 0.15);
    this._tone(1100, 0.06, 'sine', 0.12, 0.04);
    this._tone(1320, 0.1, 'sine', 0.08, 0.08);
  }

  crit() {
    this._tone(1500, 0.04, 'square', 0.12);
    this._noise(0.03, 0.06, 0.02);
    this._tone(2000, 0.06, 'sine', 0.08, 0.04);
  }

  bossAppear() {
    this._tone(80, 0.6, 'sawtooth', 0.15);
    this._tone(60, 0.8, 'sawtooth', 0.1, 0.2);
    this._noise(0.3, 0.06, 0.1);
    this._tone(120, 0.3, 'square', 0.08, 0.5);
  }

  bossKill() {
    const notes = [262, 330, 392, 523, 659, 784];
    notes.forEach((f, i) => {
      this._tone(f, 0.25, 'sine', 0.14 - i * 0.015, i * 0.1);
    });
    this._noise(0.3, 0.06, 0.2);
  }

  perkSelect() {
    this._tone(523, 0.08, 'sine', 0.12);
    this._tone(659, 0.08, 'sine', 0.1, 0.06);
    this._tone(784, 0.12, 'sine', 0.08, 0.12);
  }

  // Background music pulse — looping bass
  _pulseOsc = null;
  _pulseGain = null;

  startPulse(freq = 45) {
    if (!this._ensure()) return;
    if (this._pulseOsc) this.stopPulse();
    this._pulseOsc = this.ctx.createOscillator();
    this._pulseGain = this.ctx.createGain();
    this._pulseOsc.type = 'sine';
    this._pulseOsc.frequency.value = freq;
    this._pulseGain.gain.value = 0;
    // Fade in
    this._pulseGain.gain.linearRampToValueAtTime(0.06, this.ctx.currentTime + 2);
    this._pulseOsc.connect(this._pulseGain);
    this._pulseGain.connect(this.gain);
    this._pulseOsc.start();
  }

  updatePulse(freq) {
    if (this._pulseOsc) {
      this._pulseOsc.frequency.linearRampToValueAtTime(freq, this.ctx.currentTime + 0.5);
    }
  }

  stopPulse() {
    if (this._pulseOsc) {
      try {
        this._pulseGain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.5);
        const osc = this._pulseOsc;
        setTimeout(() => { try { osc.stop(); } catch {} }, 600);
      } catch {}
      this._pulseOsc = null;
      this._pulseGain = null;
    }
  }
}

export default new Audio();
