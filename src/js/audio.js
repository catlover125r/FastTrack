// Audio engine: decoding, peak computation, real-time playback (streaming
// SoundTouch for pitch/speed so param changes are audible live), MP3 export.

import { SoundTouch, SimpleFilter, WebAudioBufferSource } from '../../node_modules/soundtouchjs/dist/soundtouch.js';
import { Mp3Encoder } from '../../node_modules/@breezystack/lamejs/dist/lamejs.js';
import { state, clipDur, clipEnd, projectEnd } from './state.js';

export const PEAK_BUCKET = 256;
export const COARSE_FACTOR = 32; // coarse bucket = 8192 samples

let ctx = null;

export function audioCtx() {
  if (!ctx) ctx = new AudioContext();
  return ctx;
}

export async function decodeArrayBuffer(data) {
  return audioCtx().decodeAudioData(data);
}

// ---- peaks ----

export function computePeaks(buffer) {
  const frames = buffer.length;
  const nBuckets = Math.ceil(frames / PEAK_BUCKET);
  const fine = new Float32Array(nBuckets * 2);
  const nCh = buffer.numberOfChannels;
  for (let c = 0; c < nCh; c++) {
    const d = buffer.getChannelData(c);
    for (let b = 0; b < nBuckets; b++) {
      let min = fine[b * 2];
      let max = fine[b * 2 + 1];
      const end = Math.min(frames, (b + 1) * PEAK_BUCKET);
      for (let i = b * PEAK_BUCKET; i < end; i++) {
        const v = d[i];
        if (v < min) min = v;
        else if (v > max) max = v;
      }
      fine[b * 2] = min;
      fine[b * 2 + 1] = max;
    }
  }
  const nCoarse = Math.ceil(nBuckets / COARSE_FACTOR);
  const coarse = new Float32Array(nCoarse * 2);
  let maxAbs = 0;
  for (let j = 0; j < nCoarse; j++) {
    let min = 0;
    let max = 0;
    const end = Math.min(nBuckets, (j + 1) * COARSE_FACTOR);
    for (let b = j * COARSE_FACTOR; b < end; b++) {
      if (fine[b * 2] < min) min = fine[b * 2];
      if (fine[b * 2 + 1] > max) max = fine[b * 2 + 1];
    }
    coarse[j * 2] = min;
    coarse[j * 2 + 1] = max;
    if (-min > maxAbs) maxAbs = -min;
    if (max > maxAbs) maxAbs = max;
  }
  return { fine, coarse, maxAbs };
}

// gain applied by Normalize: bring the file's peak to 0.98
export function normGainOf(clip) {
  const m = clip.peaks.maxAbs;
  return m > 0.001 ? 0.98 / m : 1;
}

export function volumeOf(clip) {
  return clip.gain * (clip.params.normalize ? normGainOf(clip) : 1);
}

// fade envelope shape (0..1), t = seconds into the trimmed clip
function envShape(clip, t) {
  const dur = clipDur(clip);
  let e = 1;
  if (clip.fadeIn > 0 && t < clip.fadeIn) e *= Math.max(0, t / clip.fadeIn);
  if (clip.fadeOut > 0 && t > dur - clip.fadeOut) e *= Math.max(0, (dur - t) / clip.fadeOut);
  return e;
}

function scheduleEnvelope(gainParam, clip, offsetInClip, startAt) {
  const dur = clipDur(clip);
  const pts = [clip.fadeIn, dur - clip.fadeOut, dur].filter((p) => p > offsetInClip + 0.0005);
  pts.sort((a, b) => a - b);
  gainParam.setValueAtTime(envShape(clip, offsetInClip), startAt);
  for (const p of pts) {
    gainParam.linearRampToValueAtTime(envShape(clip, p), startAt + (p - offsetInClip));
  }
}

// ---- reversed-buffer cache (plain playback path only) ----

const reversedCache = new WeakMap();

function reversedBuffer(buffer) {
  let rev = reversedCache.get(buffer);
  if (!rev) {
    rev = audioCtx().createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const d = rev.getChannelData(c);
      d.set(buffer.getChannelData(c));
      d.reverse();
    }
    reversedCache.set(buffer, rev);
  }
  return rev;
}

// ---- streaming SoundTouch source (pitch/speed clips) ----

// Interleaved-stereo extractor over the clip's source window, honoring
// reverse, padded with 0.5s of silence so SoundTouch's pipeline tail flushes.
function makeWindowSource(buffer, srcStart, srcEnd, reverse) {
  const sr = buffer.sampleRate;
  const l = buffer.getChannelData(0);
  const r = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : l;
  const startF = Math.max(0, Math.floor(srcStart * sr));
  const endF = Math.min(buffer.length, Math.floor(srcEnd * sr));
  const windowFrames = Math.max(0, endF - startF);
  const padFrames = Math.floor(sr * 0.5);
  return {
    extract(target, numFrames, position) {
      const n = Math.max(0, Math.min(numFrames, windowFrames + padFrames - position));
      for (let i = 0; i < n; i++) {
        const w = position + i;
        if (w >= windowFrames) {
          target[i * 2] = 0;
          target[i * 2 + 1] = 0;
        } else {
          const p = reverse ? endF - 1 - w : startF + w;
          target[i * 2] = l[p];
          target[i * 2 + 1] = r[p];
        }
      }
      return n;
    },
  };
}

function makeStretchNode(actx, clip, offsetInClip, startAt) {
  const sr = actx.sampleRate;
  const st = new SoundTouch();
  st.tempo = clip.params.speed;
  st.pitchSemitones = clip.params.semitones;
  const source = makeWindowSource(clip.buffer, clip.srcStart, clip.srcEnd, clip.params.reverse);
  const filter = new SimpleFilter(source, st);
  filter.sourcePosition = Math.floor(offsetInClip * clip.params.speed * sr);

  const BUF = 4096;
  const node = actx.createScriptProcessor(BUF, 2, 2);
  const tmp = new Float32Array(BUF * 2);
  let done = false;
  node.onaudioprocess = (e) => {
    const out0 = e.outputBuffer.getChannelData(0);
    const out1 = e.outputBuffer.getChannelData(1);
    out0.fill(0);
    out1.fill(0);
    if (done) return;
    const pt = e.playbackTime;
    if (pt + BUF / sr <= startAt) return; // entirely before the clip starts
    const writeStart = pt < startAt ? Math.round((startAt - pt) * sr) : 0;
    const want = BUF - writeStart;
    const got = filter.extract(tmp, want);
    for (let i = 0; i < got; i++) {
      out0[writeStart + i] = tmp[i * 2];
      out1[writeStart + i] = tmp[i * 2 + 1];
    }
    if (got < want) done = true;
  };
  return { node, st };
}

// ---- playback ----

let activeClips = new Map(); // clipId -> { st?, srcNode?, spNode?, fadeGain, volGain }
let liveTrackGains = new Map();
let masterGain = null;
let playStartPos = 0;
let playStartCtxTime = 0;

function scheduleClip(actx, dest, clip, fromPos, when) {
  const dur = clipDur(clip);
  if (clipEnd(clip) <= fromPos + 0.001) return null;
  const offsetInClip = Math.max(0, fromPos - clip.start);
  const startAt = when + Math.max(0, clip.start - fromPos);

  const fadeGain = actx.createGain();
  const volGain = actx.createGain();
  volGain.gain.value = volumeOf(clip);
  fadeGain.connect(volGain);
  volGain.connect(dest);
  scheduleEnvelope(fadeGain.gain, clip, offsetInClip, startAt);

  const p = clip.params;
  if (p.speed === 1 && p.semitones === 0) {
    const src = actx.createBufferSource();
    if (p.reverse) {
      src.buffer = reversedBuffer(clip.buffer);
      src.start(startAt, clip.buffer.duration - clip.srcEnd + offsetInClip, dur - offsetInClip);
    } else {
      src.buffer = clip.buffer;
      src.start(startAt, clip.srcStart + offsetInClip, dur - offsetInClip);
    }
    src.connect(fadeGain);
    return { srcNode: src, fadeGain, volGain };
  }
  const { node, st } = makeStretchNode(actx, clip, offsetInClip, startAt);
  node.connect(fadeGain);
  return { spNode: node, st, fadeGain, volGain };
}

export function play() {
  if (state.playing) return;
  const actx = audioCtx();
  if (actx.state === 'suspended') actx.resume();
  playStartPos = state.playhead;
  playStartCtxTime = actx.currentTime + 0.06;
  masterGain = actx.createGain();
  masterGain.connect(actx.destination);
  liveTrackGains = new Map();
  for (let t = 0; t < state.numTracks; t++) {
    const g = actx.createGain();
    g.gain.value = state.trackMuted[t] ? 0 : 1;
    g.connect(masterGain);
    liveTrackGains.set(t, g);
  }
  activeClips = new Map();
  for (const clip of state.clips) {
    const dest = liveTrackGains.get(clip.track);
    if (!dest) continue;
    const rec = scheduleClip(actx, dest, clip, playStartPos, playStartCtxTime);
    if (rec) activeClips.set(clip.id, rec);
  }
  state.playing = true;
}

export function stop() {
  if (!state.playing) return;
  state.playhead = playbackPos();
  for (const rec of activeClips.values()) {
    try {
      if (rec.srcNode) rec.srcNode.stop();
      if (rec.spNode) rec.spNode.disconnect();
      rec.fadeGain.disconnect();
      rec.volGain.disconnect();
    } catch (e) { /* already ended */ }
  }
  if (masterGain) masterGain.disconnect();
  activeClips = new Map();
  liveTrackGains = new Map();
  masterGain = null;
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

// Push a clip's current volume/pitch/speed into its playing nodes (real time).
export function updateLiveClip(clip) {
  const rec = activeClips.get(clip.id);
  if (!rec) return;
  rec.volGain.gain.value = volumeOf(clip);
  if (rec.st) {
    rec.st.tempo = clip.params.speed;
    rec.st.pitchSemitones = clip.params.semitones;
  }
}

// ---- offline processing (export only) ----

function sliceWindow(clip) {
  const buf = clip.buffer;
  const sr = buf.sampleRate;
  const startF = Math.max(0, Math.floor(clip.srcStart * sr));
  const endF = Math.min(buf.length, Math.floor(clip.srcEnd * sr));
  const n = Math.max(1, endF - startF);
  const out = audioCtx().createBuffer(2, n, sr);
  for (let c = 0; c < 2; c++) {
    const src = buf.getChannelData(Math.min(c, buf.numberOfChannels - 1));
    const d = out.getChannelData(c);
    d.set(src.subarray(startF, endF));
    if (clip.params.reverse) d.reverse();
  }
  return out;
}

function timeStretch(buffer, tempo, semitones) {
  const st = new SoundTouch();
  st.tempo = tempo;
  st.pitchSemitones = semitones;
  // SoundTouch never flushes its pipeline tail, so pad the input with
  // silence and trim the output back to the expected stretched length.
  const padFrames = Math.ceil(buffer.sampleRate * 0.5 * Math.max(1, tempo));
  const expected = Math.max(1, Math.round(buffer.length / tempo));
  const padded = audioCtx().createBuffer(2, buffer.length + padFrames, buffer.sampleRate);
  for (let c = 0; c < 2; c++) {
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

// ---- export ----

export async function exportMp3() {
  const end = projectEnd();
  if (end <= 0) throw new Error('Nothing to export');
  const sr = audioCtx().sampleRate;
  const offline = new OfflineAudioContext(2, Math.ceil(end * sr) + Math.floor(sr * 0.1), sr);
  const master = offline.createGain();
  master.connect(offline.destination);
  for (const clip of state.clips) {
    if (state.trackMuted[clip.track]) continue;
    let buf = sliceWindow(clip);
    const p = clip.params;
    if (p.speed !== 1 || p.semitones !== 0) buf = timeStretch(buf, p.speed, p.semitones);
    const src = offline.createBufferSource();
    src.buffer = buf;
    const g = offline.createGain();
    src.connect(g);
    g.connect(master);
    const vol = volumeOf(clip);
    const dur = clipDur(clip);
    const pts = [clip.fadeIn, dur - clip.fadeOut, dur].filter((x) => x > 0.0005).sort((a, b) => a - b);
    g.gain.setValueAtTime(envShape(clip, 0) * vol, clip.start);
    for (const x of pts) g.gain.linearRampToValueAtTime(envShape(clip, x) * vol, clip.start + x);
    src.start(clip.start, 0, dur);
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
      const a = Math.max(-1, Math.min(1, l[pos + i]));
      const b = Math.max(-1, Math.min(1, r[pos + i]));
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
