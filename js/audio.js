// Small synthesized sound set. Soft pentatonic tones stay pleasant after
// hundreds of actions; nothing is loaded from the network.

const SCALE = [523.25, 587.33, 659.25, 783.99, 880, 1046.5, 1174.66, 1318.51, 1567.98];

export class Sound {
  constructor() {
    this.enabled = true;
    this.volume = 0.7;
    this.ctx = null;
  }

  ensure() {
    if (!this.enabled || this.volume <= 0) return null;
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    }
    // Resumes after interruptions such as calls or backgrounding.
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
    this.master.gain.value = this.volume * 0.6;
    return this.ctx;
  }

  tone(freq, { at = 0, dur = 0.12, type = 'sine', gain = 0.2, attack = 0.006 } = {}) {
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.03);
  }

  // Rises as the tray fills.
  click(step) {
    const f = SCALE[Math.min(step, SCALE.length - 1)];
    this.tone(f, { dur: 0.09, type: 'triangle', gain: 0.16 });
    this.tone(f * 2, { dur: 0.05, gain: 0.03 });
  }

  select() {
    this.tone(698.46, { dur: 0.05, gain: 0.05 });
  }

  cascade(n) {
    for (let i = 0; i < n; i++) this.tone(SCALE[(i * 2) % SCALE.length] * 1.5, { at: i * 0.055, dur: 0.3, gain: 0.07 });
  }

  sparkle() {
    SCALE.forEach((f, i) => this.tone(f * 2, { at: i * 0.07, dur: 0.5, gain: 0.05 }));
    this.tone(SCALE[0], { dur: 1.2, gain: 0.06, attack: 0.05 });
    this.tone(SCALE[2], { dur: 1.2, gain: 0.05, attack: 0.05 });
    this.tone(SCALE[4], { at: 0.1, dur: 1.2, gain: 0.05, attack: 0.05 });
  }

  nope() {
    this.tone(220, { dur: 0.14, gain: 0.08 });
    this.tone(196, { at: 0.07, dur: 0.16, gain: 0.07 });
  }
}
