/**
 * All sound is synthesised with WebAudio, so there are no audio files to ship and
 * nothing to 404 on GitHub Pages.
 *
 * Two browser rules shape this module:
 *   1. An AudioContext starts suspended until a user gesture resumes it, so
 *      `unlock()` must be called from a click handler.
 *   2. A hidden tab has its timers throttled unless it is playing audio, hence
 *      the optional near-silent keep-alive loop.
 */

let ctx = null;
let keepAliveNode = null;

/** Chime shapes per annoyance level: ascending and soft, or dissonant and sharp. */
const PATTERNS = {
  gentle: { type: 'sine', notes: [660, 880], noteMs: 180, gapMs: 90, attack: 0.02, release: 0.25 },
  nagging: { type: 'triangle', notes: [880, 660, 880], noteMs: 150, gapMs: 70, attack: 0.005, release: 0.12 },
  infuriating: { type: 'square', notes: [1180, 830, 1180, 830, 1180], noteMs: 130, gapMs: 55, attack: 0.001, release: 0.04 },
};

export function isUnlocked() {
  return Boolean(ctx) && ctx.state === 'running';
}

/** Must be called from a user gesture. Safe to call repeatedly. */
export async function unlock() {
  const AudioCtx = window.AudioContext ?? window.webkitAudioContext;
  if (!AudioCtx) return false;
  if (!ctx) ctx = new AudioCtx();
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume();
    } catch {
      return false;
    }
  }
  return ctx.state === 'running';
}

/**
 * Play one alarm. `level` picks the timbre, `volume` is 0..1 and already carries
 * any escalation ramp from `volumeForStep`.
 */
export function play(level, volume) {
  if (!ctx || ctx.state !== 'running' || volume <= 0) return;
  const pattern = PATTERNS[level] ?? PATTERNS.nagging;
  const step = (pattern.noteMs + pattern.gapMs) / 1000;
  const peak = Math.min(1, volume) * 0.35; // 0.35 keeps a full-volume square wave short of clipping

  pattern.notes.forEach((frequency, index) => {
    const startAt = ctx.currentTime + index * step;
    const endAt = startAt + pattern.noteMs / 1000;

    const osc = ctx.createOscillator();
    osc.type = pattern.type;
    osc.frequency.setValueAtTime(frequency, startAt);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(peak, startAt + pattern.attack);
    gain.gain.setValueAtTime(peak, endAt);
    gain.gain.exponentialRampToValueAtTime(0.0001, endAt + pattern.release);

    osc.connect(gain).connect(ctx.destination);
    osc.start(startAt);
    osc.stop(endAt + pattern.release + 0.02);
  });
}

/** A distinct, friendlier two-note motif for "you can sit down now". */
export function playSitCue(volume) {
  if (!ctx || ctx.state !== 'running' || volume <= 0) return;
  const peak = Math.min(1, volume) * 0.2;
  [523.25, 784].forEach((frequency, index) => {
    const startAt = ctx.currentTime + index * 0.16;
    const endAt = startAt + 0.22;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(frequency, startAt);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, endAt);
    osc.connect(gain).connect(ctx.destination);
    osc.start(startAt);
    osc.stop(endAt + 0.05);
  });
}

/**
 * Loop a near-silent buffer so the browser treats the tab as audible and stops
 * clamping its timers to once a minute. Audible enough to count, quiet enough to
 * be inaudible; the cost is a speaker icon on the tab.
 */
export function startKeepAlive() {
  if (!ctx || ctx.state !== 'running' || keepAliveNode) return;
  const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < channel.length; i++) {
    channel[i] = (i % 2 ? 1 : -1) * 0.0002;
  }
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  const gain = ctx.createGain();
  gain.gain.value = 0.0015;
  source.connect(gain).connect(ctx.destination);
  source.start();
  keepAliveNode = source;
}

export function stopKeepAlive() {
  if (!keepAliveNode) return;
  try {
    keepAliveNode.stop();
  } catch {
    /* already stopped */
  }
  keepAliveNode = null;
}
