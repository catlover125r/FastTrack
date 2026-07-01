// Audio engine: decoding, offline clip rendering (pitch/speed/reverse/normalize),
// playback scheduling with fades, and MP3 export.

import { SoundTouch, SimpleFilter, WebAudioBufferSource } from '../../node_modules/soundtouchjs/dist/soundtouch.js';
import { Mp3Encoder } from '../../node_modules/@breezystack/lamejs/dist/lamejs.js';
import { state, clipDur, clipEnd, projectEnd } from './state.js';

export const PEAK_BUCKET = 256;

let ctx = null;

export function audioCtx() {
  if (!ctx) ctx = new AudioContext();
  return ctx;
}

export async function decodeArrayBuffer(data) {
  return audioCtx().decodeAudioData(data);
}

export function computePeaks(buffer) {
  const frames = buffer.length;
  const nBuckets = Math.ceil(frames / PEAK_BUCKET);
  const peaks = new Float32Array(nBuckets * 2);
  const chans = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
  for (let b = 0; b < nBuckets; b++) {
    let min = 0, max = 0;
    const end = Math.min(frames, (b + 1) * PEAK_BUCKET);
    for (const ch of chans) {
      for (let i = b * PEAK_BUCKET; i < end; i++) {
        const v = ch[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    peaks[b * 2] = min;
    peaks[b * 2 + 1] = max;
  }
  return peaks;
}

function timeStretch(buffer, tempo, semitones) {
  const st = new SoundTouch();
  st.tempo = tempo;
  st.pitchSemitones = semitones;
  // SoundTouch never flushes its pipeline tail, so pad the input with
  // silence and trim the output back to the expected stretched length.
  const padFrames = Math.ceil(buffer.sampleRate * 0.5 * Math.max(1, tempo));
  const expected = Math.max(1, Math.round(buffer.length / tempo));
  const padded = audioCtx().createBuffer(
    Math.max(2, buffer.numberOfChannels), buffer.length + padFrames, buffer.sampleRate,
  );
  for (let c = 0; c < padded.numberOfChannels; c++) {
    padded.getChannelData(c).set(buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1)));
  }
  const source = new WebAudioBufferSource(padded);
  const filter = new SimpleFilter(source, st);
  const CHUNK = 16384;
  const tmp = new Float32Array(CHUNK * 2);
  const chunksL = [];
  const chunksR = [];
  let total = 0;
  let n;
  while (total < expected && (n = filter.extract(tmp, CHUNK)) > 0) {
    const take = Math.min(n, expected - total);
    const l = new Float32Array(take);
    const r = new Float32Array(take);
    for (let i = 0; i < take; i++) {
      l[i] = tmp[i * 2];
      r[i] = tmp[i * 2 + 1];
    }
    chunksL.push(l);
    chunksR.push(r);
    total += take;
  }
  const out = audioCtx().createBuffer(2, Math.max(total, 1), buffer.sampleRate);
  const ol = out.getChannelData(0);
  const or_ = out.getChannelData(1);
  let pos = 0;
  for (let i = 0; i < chunksL.length; i++) {
    ol.set(chunksL[i], pos);
    or_.set(chunksR[i], pos);
    pos += chunksL[i].length;
  }
  return out;
}

// Renders clip.buffer through its params into a fresh {rendered, peaks}.
export function renderClipBuffer(clip) {
  const { semitones, speed, reverse, normalize } = clip.params;
  let buf = clip.buffer;
  if (speed !== 1 || semitones !== 0) {
    buf = timeStretch(buf, speed, semitones);
  } else if (reverse || normalize) {
    // copy so we never mutate the original
    const copy = audioCtx().createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
    for (let c = 0; c < buf.numberOfChannels; c++) copy.getChannelData(c).set(buf.getChannelData(c));
    buf = copy;
  }
  if (normalize) {
    let peak = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) {
        const a = Math.abs(d[i]);
        if (a > peak) peak = a;
      }
    }
    if (peak > 0.0001) {
      const k = 0.98 / peak;
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < d.length; i++) d[i] *= k;
      }
    }
  }
  if (reverse) {
    for (let c = 0; c < buf.numberOfChannels; c++) buf.getChannelData(c).reverse();
  }
  return { rendered: buf, peaks: computePeaks(buf) };
}

// Re-render a clip after params changed, remapping the trim window.
export function applyParams(clip, newParams) {
  const old = clip.params;
  const oldDur = clip.rendered.duration;
  clip.params = { ...newParams };

  const { rendered, peaks } = renderClipBuffer(clip);

  let s = clip.srcStart;
  let e = clip.srcEnd;
  // un-reverse trim window into "forward" domain of old rendering
  if (old.reverse) [s, e] = [oldDur - e, oldDur - s];
  // rescale for new speed
  const scale = old.speed / newParams.speed;
  s *= scale;
  e *= scale;
  // re-reverse for new orientation
  if (newParams.reverse) {
    const d = rendered.duration;
    [s, e] = [d - e, d - s];
  }
  clip.rendered = rendered;
  clip.peaks = peaks;
  clip.srcStart = Math.max(0, Math.min(s, rendered.duration - 0.01));
  clip.srcEnd = Math.max(clip.srcStart + 0.01, Math.min(e, rendered.duration));
  clip.fadeIn = Math.min(clip.fadeIn, clipDur(clip));
  clip.fadeOut = Math.min(clip.fadeOut, clipDur(clip));
}

// ---- playback ----

let activeSources = [];
let liveTrackGains = new Map();
let playStartPos = 0;
let playStartCtxTime = 0;

function envelopeAt(clip, t) {
  // t = seconds into the (trimmed) clip
  const dur = clipDur(clip);
  let e = clip.gain;
  if (clip.fadeIn > 0 && t < clip.fadeIn) e *= Math.max(0, t / clip.fadeIn);
  if (clip.fadeOut > 0 && t > dur - clip.fadeOut) e *= Math.max(0, (dur - t) / clip.fadeOut);
  return e;
}

function scheduleClip(actx, dest, clip, fromPos, when) {
  const dur = clipDur(clip);
  if (clipEnd(clip) <= fromPos + 0.001) return null;
  const offsetInClip = Math.max(0, fromPos - clip.start);
  const startAt = when + Math.max(0, clip.start - fromPos);

  const src = actx.createBufferSource();
  src.buffer = clip.rendered;
  const g = actx.createGain();
  src.connect(g);
  g.connect(dest);

  const pts = [clip.fadeIn, dur - clip.fadeOut, dur].filter((p) => p > offsetInClip + 0.0005);
  pts.sort((a, b) => a - b);
  g.gain.setValueAtTime(envelopeAt(clip, offsetInClip), startAt);
  for (const p of pts) {
    g.gain.linearRampToValueAtTime(envelopeAt(clip, p), startAt + (p - offsetInClip));
  }

  src.start(startAt, clip.srcStart + offsetInClip, dur - offsetInClip);
  return src;
}

function buildGraph(actx) {
  const master = actx.createGain();
  master.connect(actx.destination);
  const trackGains = new Map();
  for (let t = 0; t < state.numTracks; t++) {
    const g = actx.createGain();
    g.gain.value = state.trackMuted[t] ? 0 : 1;
    g.connect(master);
    trackGains.set(t, g);
  }
  return trackGains;
}

export function play() {
  if (state.playing) return;
  const actx = audioCtx();
  if (actx.state === 'suspended') actx.resume();
  playStartPos = state.playhead;
  playStartCtxTime = actx.currentTime + 0.06;
  liveTrackGains = buildGraph(actx);
  activeSources = [];
  for (const clip of state.clips) {
    const dest = liveTrackGains.get(clip.track);
    if (!dest) continue;
    const src = scheduleClip(actx, dest, clip, playStartPos, playStartCtxTime);
    if (src) activeSources.push(src);
  }
  state.playing = true;
}

export function stop() {
  if (!state.playing) return;
  state.playhead = playbackPos();
  for (const s of activeSources) {
    try { s.stop(); } catch (e) { /* already ended */ }
  }
  activeSources = [];
  liveTrackGains = new Map();
  state.playing = false;
}

export function playbackPos() {
  if (!state.playing) return state.playhead;
  return Math.max(playStartPos, playStartPos + audioCtx().currentTime - playStartCtxTime);
}

export function setTrackMuteLive(track, muted) {
  const g = liveTrackGains.get(track);
  if (g) g.gain.value = muted ? 0 : 1;
}

// ---- export ----

export async function exportMp3() {
  const end = projectEnd();
  if (end <= 0) throw new Error('Nothing to export');
  const sr = audioCtx().sampleRate;
  const offline = new OfflineAudioContext(2, Math.ceil(end * sr) + sr * 0.1, sr);
  const master = offline.createGain();
  master.connect(offline.destination);
  const trackGains = new Map();
  for (let t = 0; t < state.numTracks; t++) {
    const g = offline.createGain();
    g.gain.value = state.trackMuted[t] ? 0 : 1;
    g.connect(master);
    trackGains.set(t, g);
  }
  for (const clip of state.clips) {
    const dest = trackGains.get(clip.track);
    if (dest) scheduleClip(offline, dest, clip, 0, 0);
  }
  const rendered = await offline.startRendering();

  const enc = new Mp3Encoder(2, sr, 192);
  const l = rendered.getChannelData(0);
  const r = rendered.getChannelData(1);
  const CHUNK = 1152 * 16;
  const li = new Int16Array(CHUNK);
  const ri = new Int16Array(CHUNK);
  const parts = [];
  for (let pos = 0; pos < l.length; pos += CHUNK) {
    const n = Math.min(CHUNK, l.length - pos);
    for (let i = 0; i < n; i++) {
      let a = Math.max(-1, Math.min(1, l[pos + i]));
      let b = Math.max(-1, Math.min(1, r[pos + i]));
      li[i] = a < 0 ? a * 0x8000 : a * 0x7fff;
      ri[i] = b < 0 ? b * 0x8000 : b * 0x7fff;
    }
    const out = enc.encodeBuffer(li.subarray(0, n), ri.subarray(0, n));
    if (out.length) parts.push(new Uint8Array(out));
  }
  const fin = enc.flush();
  if (fin.length) parts.push(new Uint8Array(fin));

  let total = 0;
  for (const p of parts) total += p.length;
  const mp3 = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    mp3.set(p, off);
    off += p.length;
  }
  return mp3.buffer;
}
