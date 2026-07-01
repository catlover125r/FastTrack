// Canvas timeline: ruler, track headers, lanes, clip waveforms, playhead,
// and all mouse interaction (move/trim/fade/split/seek/zoom/snap).

import {
  state, clipDur, clipEnd, clipColor, projectEnd, pushUndo, takeSnapshot,
  trimLeft, setOutDur, srcAvailBefore, srcAvailAfter,
} from './state.js';
import { PEAK_BUCKET, COARSE_FACTOR, playbackPos, setTrackMuteLive, normGainOf } from './audio.js';
import { splitClip, cloneClipAt, addTrackIfNeeded } from './edits.js';

export const RULER_H = 28;
export const TRACK_H = 84;
export const HEADER_W = 140;
const MIN_PPS = 1;
const MAX_PPS = 1200;
const NAME_BAR_H = 14;

let canvas, wrap, spacer, g, hooks;
let scrollX = 0;
let scrollY = 0;
let viewW = 0;
let viewH = 0;
let drag = null;
let dropIndicator = null; // { time, track } while files are dragged over
let needsDraw = false;

const waveColorCache = new Map();

function waveColor(hex) {
  let c = waveColorCache.get(hex);
  if (!c) {
    const r = parseInt(hex.slice(1, 3), 16);
    const gr = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    c = `rgb(${(r * 0.3) | 0},${(gr * 0.3) | 0},${(b * 0.3) | 0})`;
    waveColorCache.set(hex, c);
  }
  return c;
}

const timeToX = (t) => HEADER_W + t * state.pxPerSec - scrollX;
const xToTime = (x) => (x - HEADER_W + scrollX) / state.pxPerSec;
const trackToY = (i) => RULER_H + i * TRACK_H - scrollY;
const trackAtY = (y) => Math.floor((y - RULER_H + scrollY) / TRACK_H);

// Snapping (FCP/Logic hybrid): a strong magnetic pull to clip edges, the
// playhead and 0 (with a yellow guide line), and otherwise quantization to
// the ruler's minor ticks so dragging visibly steps. Hold ⌘ to bypass.
let snapGuide = null; // timeline seconds of an engaged event-snap, else null

function snapTimeInfo(t, excludeId = null, bypass = false) {
  if (!state.snap || bypass) return { v: Math.max(0, t), guide: null };
  const th = 12 / state.pxPerSec;
  let best = null;
  const consider = (v) => {
    const d = Math.abs(v - t);
    if (d < th && (!best || d < best.d)) best = { v, d };
  };
  consider(0);
  consider(state.playhead);
  for (const c of state.clips) {
    if (c.id === excludeId) continue;
    consider(c.start);
    consider(clipEnd(c));
  }
  if (best) return { v: best.v, guide: best.v };
  const minor = rulerStep() / 5;
  return { v: Math.max(0, Math.round(t / minor) * minor), guide: null };
}

export function snapTime(t, excludeId = null, bypass = false) {
  return snapTimeInfo(t, excludeId, bypass).v;
}

// Snap either edge of a moving clip, whichever event candidate is closer.
function snapMoveInfo(t, dur, excludeId, bypass) {
  if (!state.snap || bypass) return { v: Math.max(0, t), guide: null };
  const a = snapTimeInfo(t, excludeId);
  const b = snapTimeInfo(t + dur, excludeId);
  if (a.guide !== null || b.guide !== null) {
    const da = a.guide !== null ? Math.abs(a.v - t) : Infinity;
    const db = b.guide !== null ? Math.abs(b.v - (t + dur)) : Infinity;
    if (db < da) return { v: Math.max(0, b.v - dur), guide: b.guide };
    return { v: Math.max(0, a.v), guide: a.guide };
  }
  return { v: a.v, guide: null };
}

export function updateSpacer() {
  const w = HEADER_W + (projectEnd() + 60) * state.pxPerSec;
  const h = RULER_H + (state.numTracks + 1) * TRACK_H;
  spacer.style.width = `${w}px`;
  spacer.style.height = `${h}px`;
}

export function requestDraw() {
  if (needsDraw) return;
  needsDraw = true;
  requestAnimationFrame(() => {
    needsDraw = false;
    draw();
  });
}

// ---- zoom ----

export function setZoom(pps, anchorX = HEADER_W) {
  pps = Math.max(MIN_PPS, Math.min(MAX_PPS, pps));
  const t = xToTime(anchorX);
  state.pxPerSec = pps;
  updateSpacer();
  wrap.scrollLeft = Math.max(0, t * pps - (anchorX - HEADER_W));
  scrollX = wrap.scrollLeft;
  hooks.onZoom();
  requestDraw();
}

export function zoomBy(factor, anchorX) {
  setZoom(state.pxPerSec * factor, anchorX ?? viewW / 2);
}

export const sliderToPps = (v) => MIN_PPS * Math.pow(MAX_PPS / MIN_PPS, v / 100);
export const ppsToSlider = (pps) => (100 * Math.log(pps / MIN_PPS)) / Math.log(MAX_PPS / MIN_PPS);

// ---- hit testing ----

function hitTest(mx, my) {
  if (my <= RULER_H) {
    return mx >= HEADER_W ? { type: 'ruler', time: xToTime(mx) } : { type: 'corner' };
  }
  const track = trackAtY(my);
  if (mx < HEADER_W) {
    if (track >= 0 && track < state.numTracks) {
      const y = trackToY(track);
      if (mx >= HEADER_W - 32 && mx <= HEADER_W - 10 && my >= y + 8 && my <= y + 26) {
        return { type: 'mute', track };
      }
      return { type: 'header', track };
    }
    return { type: 'none' };
  }
  const time = xToTime(mx);
  if (track >= 0 && track < state.numTracks) {
    for (let i = state.clips.length - 1; i >= 0; i--) {
      const c = state.clips[i];
      if (c.track !== track) continue;
      const x0 = timeToX(c.start);
      const x1 = timeToX(clipEnd(c));
      if (mx < x0 - 7 || mx > x1 + 7) continue;
      const y = trackToY(track) + 3;
      const hy = y + 8;
      const fiX = x0 + c.fadeIn * state.pxPerSec;
      const foX = x1 - c.fadeOut * state.pxPerSec;
      if (state.tool === 'pointer' && Math.hypot(mx - fiX, my - hy) < 8) return { type: 'clip', clip: c, zone: 'fade-in', time };
      if (state.tool === 'pointer' && Math.hypot(mx - foX, my - hy) < 8) return { type: 'clip', clip: c, zone: 'fade-out', time };
      if (mx < x0 || mx > x1) continue;
      if (x1 - x0 > 20) {
        if (mx <= x0 + 6) return { type: 'clip', clip: c, zone: 'l-edge', time };
        if (mx >= x1 - 6) return { type: 'clip', clip: c, zone: 'r-edge', time };
      }
      return { type: 'clip', clip: c, zone: 'body', time };
    }
  }
  return { type: 'lane', track, time };
}

function cursorFor(h, altKey) {
  if (h.type === 'ruler') return 'default';
  if (h.type === 'mute') return 'pointer';
  if (h.type === 'clip') {
    if (state.tool === 'scissors') return 'crosshair';
    if (state.tool === 'fade') return 'ew-resize';
    if (h.zone === 'l-edge' || h.zone === 'r-edge') return 'col-resize';
    if (h.zone === 'fade-in' || h.zone === 'fade-out') return 'pointer';
    return altKey ? 'copy' : 'default';
  }
  return 'default';
}

// ---- mouse ----

function canvasPos(e) {
  const r = canvas.getBoundingClientRect();
  return { mx: e.clientX - r.left, my: e.clientY - r.top };
}

function onMouseDown(e) {
  const { mx, my } = canvasPos(e);
  const h = hitTest(mx, my);

  if (h.type === 'ruler') {
    const wasPlaying = state.playing;
    if (wasPlaying) hooks.stop();
    state.playhead = snapTime(h.time, null, e.metaKey);
    drag = { mode: 'playhead', wasPlaying };
    hooks.onChange();
    requestDraw();
    return;
  }
  if (h.type === 'mute') {
    state.trackMuted[h.track] = !state.trackMuted[h.track];
    setTrackMuteLive(h.track, state.trackMuted[h.track]);
    requestDraw();
    return;
  }
  if (h.type === 'clip') {
    const c = h.clip;
    state.selectedId = c.id;
    if (state.tool === 'scissors') {
      splitClip(c, snapTime(h.time, null, e.metaKey));
      hooks.onChange();
      updateSpacer();
      requestDraw();
      return;
    }
    if (state.tool === 'fade') {
      const local = h.time - c.start;
      drag = {
        mode: local < clipDur(c) / 2 ? 'fade-in' : 'fade-out',
        clip: c, snap: takeSnapshot(), moved: false,
      };
    } else {
      const modes = { body: 'move', 'l-edge': 'trim-l', 'r-edge': 'trim-r', 'fade-in': 'fade-in', 'fade-out': 'fade-out' };
      const snap = takeSnapshot();
      let target = c;
      let duplicated = false;
      if (h.zone === 'body' && e.altKey) {
        // option-drag duplicates the clip and drags the copy
        target = cloneClipAt(c);
        state.selectedId = target.id;
        duplicated = true;
      }
      drag = {
        mode: modes[h.zone], clip: target, snap, moved: false,
        duplicated, origId: c.id, grabDT: h.time - c.start,
      };
    }
    hooks.onChange();
    requestDraw();
    return;
  }
  if (h.type === 'lane') {
    state.selectedId = null;
    const t = snapTime(h.time, null, e.metaKey);
    if (state.playing) {
      hooks.seek(t);
    } else {
      state.playhead = Math.max(0, t);
    }
    hooks.onChange();
    requestDraw();
  }
}

function onMouseMove(e) {
  if (!drag) {
    const { mx, my } = canvasPos(e);
    canvas.style.cursor = cursorFor(hitTest(mx, my), e.altKey);
    return;
  }
  const { mx, my } = canvasPos(e);
  const time = xToTime(mx);
  const c = drag.clip;

  if (drag.mode === 'playhead') {
    state.playhead = snapTime(time, null, e.metaKey);
    hooks.onChange();
    requestDraw();
    return;
  }
  if (drag.mode === 'move') {
    const info = snapMoveInfo(time - drag.grabDT, clipDur(c), c.id, e.metaKey);
    snapGuide = info.guide;
    const tr = Math.max(0, Math.min(trackAtY(my), state.numTracks));
    if (info.v !== c.start || tr !== c.track) drag.moved = true;
    c.start = info.v;
    c.track = tr;
  } else if (drag.mode === 'trim-l') {
    const minT = Math.max(0, c.start - srcAvailBefore(c) / c.params.speed);
    const info = snapTimeInfo(time, c.id, e.metaKey);
    const t = Math.max(minT, Math.min(info.v, clipEnd(c) - 0.02));
    snapGuide = t === info.v ? info.guide : null;
    const delta = t - c.start;
    if (delta !== 0) drag.moved = true;
    trimLeft(c, delta);
    c.fadeIn = Math.min(c.fadeIn, clipDur(c));
  } else if (drag.mode === 'trim-r') {
    const maxT = c.start + clipDur(c) + srcAvailAfter(c) / c.params.speed;
    const info = snapTimeInfo(time, c.id, e.metaKey);
    const t = Math.max(c.start + 0.02, Math.min(info.v, maxT));
    snapGuide = t === info.v ? info.guide : null;
    if (t !== clipEnd(c)) drag.moved = true;
    setOutDur(c, t - c.start);
    c.fadeOut = Math.min(c.fadeOut, clipDur(c));
  } else if (drag.mode === 'fade-in') {
    const v = Math.max(0, Math.min(time - c.start, clipDur(c)));
    if (v !== c.fadeIn) drag.moved = true;
    c.fadeIn = v;
  } else if (drag.mode === 'fade-out') {
    const v = Math.max(0, Math.min(clipEnd(c) - time, clipDur(c)));
    if (v !== c.fadeOut) drag.moved = true;
    c.fadeOut = v;
  }
  hooks.onChange();
  requestDraw();
}

function onMouseUp() {
  if (!drag) return;
  if (drag.mode === 'playhead') {
    if (drag.wasPlaying) hooks.play();
  } else if (drag.duplicated && !drag.moved) {
    // option-click without an actual drag: discard the clone
    state.clips = state.clips.filter((c) => c.id !== drag.clip.id);
    state.selectedId = drag.origId;
    hooks.onChange();
  } else if (drag.moved) {
    if (drag.mode === 'move') addTrackIfNeeded(drag.clip.track);
    pushUndo(drag.snap);
    // edits during playback need a reschedule to be heard
    if (state.playing) hooks.seek(playbackPos());
  }
  drag = null;
  snapGuide = null;
  updateSpacer();
  requestDraw();
}

function onWheel(e) {
  if (e.metaKey || e.ctrlKey) {
    e.preventDefault();
    const { mx } = canvasPos(e);
    setZoom(state.pxPerSec * Math.exp(-e.deltaY * 0.008), mx);
  }
}

// ---- drawing ----

function roundRect(x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function formatRuler(t, step) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  if (step < 1) return `${m}:${s.toFixed(1).padStart(4, '0')}`;
  return `${m}:${String(Math.round(s)).padStart(2, '0')}`;
}

function rulerStep() {
  const steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const s of steps) if (s * state.pxPerSec >= 68) return s;
  return 600;
}

function drawClip(c, pos) {
  const pps = state.pxPerSec;
  const x = timeToX(c.start);
  const w = clipDur(c) * pps;
  if (x + w < HEADER_W || x > viewW) return;
  const y = trackToY(c.track) + 3;
  const h = TRACK_H - 7;
  const color = clipColor(c);
  const selected = c.id === state.selectedId;

  roundRect(x, y, w, h, 4);
  g.fillStyle = color;
  g.fill();
  if (selected) {
    g.fillStyle = 'rgba(255,255,255,0.14)';
    g.fill();
  }

  g.save();
  roundRect(x, y, w, h, 4);
  g.clip();

  // name bar
  g.fillStyle = 'rgba(255,255,255,0.28)';
  g.fillRect(x, y, w, NAME_BAR_H);
  g.fillStyle = 'rgba(10,20,8,0.85)';
  g.font = '600 9.5px -apple-system, sans-serif';
  g.textBaseline = 'middle';
  g.fillText(c.name, x + 5, y + NAME_BAR_H / 2 + 0.5, Math.max(10, w - 10));

  // waveform — mapped through speed (x-scale), reverse (mirror), normalize (y-scale)
  const top = y + NAME_BAR_H + 2;
  const bottom = y + h - 3;
  const centerY = (top + bottom) / 2;
  const amp = (bottom - top) / 2;
  const sr = c.buffer.sampleRate;
  const rev = c.params.reverse;
  const k = c.params.normalize ? normGainOf(c) : 1;
  const srcPerPx = c.params.speed / pps; // source seconds per screen pixel
  const useCoarse = (srcPerPx * sr) / PEAK_BUCKET > COARSE_FACTOR;
  const level = useCoarse ? c.peaks.coarse : c.peaks.fine;
  const bucketSec = (useCoarse ? PEAK_BUCKET * COARSE_FACTOR : PEAK_BUCKET) / sr;
  const nBuckets = level.length / 2;
  const px0 = Math.max(Math.floor(x), HEADER_W);
  const px1 = Math.min(Math.ceil(x + w), viewW);
  g.fillStyle = waveColor(color);
  g.beginPath();
  for (let px = px0; px < px1; px++) {
    const o = px - x;
    const tA = rev ? c.srcEnd - (o + 1) * srcPerPx : c.srcStart + o * srcPerPx;
    let b0 = Math.floor(tA / bucketSec);
    let b1 = Math.floor((tA + srcPerPx) / bucketSec);
    b0 = Math.max(0, Math.min(b0, nBuckets - 1));
    b1 = Math.max(b0, Math.min(b1, nBuckets - 1));
    let mn = 0;
    let mx = 0;
    for (let b = b0; b <= b1; b++) {
      if (level[b * 2] < mn) mn = level[b * 2];
      if (level[b * 2 + 1] > mx) mx = level[b * 2 + 1];
    }
    mn = Math.max(-1, mn * k);
    mx = Math.min(1, mx * k);
    const yTop = centerY - mx * amp;
    const yH = Math.max(1, (mx - mn) * amp);
    g.rect(px, yTop, 1, yH);
  }
  g.fill();

  // fades
  const fiW = c.fadeIn * pps;
  const foW = c.fadeOut * pps;
  if (fiW > 1) {
    g.beginPath();
    g.moveTo(x, y + h);
    g.quadraticCurveTo(x + fiW * 0.35, y, x + fiW, y);
    g.lineTo(x, y);
    g.closePath();
    g.fillStyle = 'rgba(0,0,0,0.30)';
    g.fill();
    g.beginPath();
    g.moveTo(x, y + h);
    g.quadraticCurveTo(x + fiW * 0.35, y, x + fiW, y);
    g.strokeStyle = 'rgba(255,255,255,0.75)';
    g.lineWidth = 1.2;
    g.stroke();
  }
  if (foW > 1) {
    const xe = x + w;
    g.beginPath();
    g.moveTo(xe, y + h);
    g.quadraticCurveTo(xe - foW * 0.35, y, xe - foW, y);
    g.lineTo(xe, y);
    g.closePath();
    g.fillStyle = 'rgba(0,0,0,0.30)';
    g.fill();
    g.beginPath();
    g.moveTo(xe, y + h);
    g.quadraticCurveTo(xe - foW * 0.35, y, xe - foW, y);
    g.strokeStyle = 'rgba(255,255,255,0.75)';
    g.lineWidth = 1.2;
    g.stroke();
  }
  g.restore();

  // fade handles (selected, pointer tool)
  if (selected && state.tool === 'pointer') {
    for (const hx of [x + fiW, x + w - foW]) {
      g.beginPath();
      g.arc(hx, y + 8, 4, 0, Math.PI * 2);
      g.fillStyle = '#f0f0f0';
      g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.6)';
      g.lineWidth = 1;
      g.stroke();
    }
  }

  // border
  roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 4);
  g.strokeStyle = selected ? '#f2f2f2' : 'rgba(0,0,0,0.45)';
  g.lineWidth = selected ? 1.5 : 1;
  g.stroke();
}

function draw() {
  const pps = state.pxPerSec;
  g.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  g.clearRect(0, 0, viewW, viewH);
  g.fillStyle = '#212121';
  g.fillRect(0, 0, viewW, viewH);

  // lanes
  for (let t = 0; t < state.numTracks; t++) {
    const y = trackToY(t);
    g.fillStyle = t % 2 ? '#232323' : '#252525';
    g.fillRect(HEADER_W, y, viewW - HEADER_W, TRACK_H);
    g.fillStyle = '#1a1a1a';
    g.fillRect(HEADER_W, y + TRACK_H - 1, viewW - HEADER_W, 1);
  }

  // ghost "new track" lane while dragging down / dropping
  const ghostTrack =
    (drag && drag.mode === 'move' && drag.clip.track === state.numTracks) ||
    (dropIndicator && dropIndicator.track === state.numTracks);
  if (ghostTrack) {
    const y = trackToY(state.numTracks);
    g.fillStyle = 'rgba(163,189,143,0.07)';
    g.fillRect(HEADER_W, y, viewW - HEADER_W, TRACK_H);
    g.strokeStyle = 'rgba(163,189,143,0.35)';
    g.setLineDash([5, 4]);
    g.strokeRect(HEADER_W + 3.5, y + 3.5, viewW - HEADER_W - 7, TRACK_H - 7);
    g.setLineDash([]);
    g.fillStyle = 'rgba(163,189,143,0.5)';
    g.font = '11px -apple-system, sans-serif';
    g.fillText('New Track', HEADER_W + 12, y + TRACK_H / 2);
  }

  // grid lines
  const step = rulerStep();
  const t0 = Math.floor(xToTime(HEADER_W) / step) * step;
  const t1 = xToTime(viewW);
  g.fillStyle = 'rgba(255,255,255,0.045)';
  for (let t = Math.max(0, t0); t <= t1; t += step) {
    const x = timeToX(t);
    if (x >= HEADER_W) g.fillRect(Math.round(x), RULER_H, 1, viewH - RULER_H);
  }

  // clips
  const pos = state.playing ? playbackPos() : state.playhead;
  for (const c of state.clips) drawClip(c, pos);

  // empty hint
  if (!state.clips.length) {
    g.fillStyle = '#5c5c5c';
    g.font = '13px -apple-system, sans-serif';
    g.textAlign = 'center';
    g.fillText('Drop audio files here  —  or press ⌘O to import', HEADER_W + (viewW - HEADER_W) / 2, RULER_H + TRACK_H / 2);
    g.textAlign = 'left';
  }

  // ruler
  g.fillStyle = '#2a2a2a';
  g.fillRect(0, 0, viewW, RULER_H);
  g.fillStyle = '#161616';
  g.fillRect(0, RULER_H - 1, viewW, 1);
  g.font = '9.5px -apple-system, sans-serif';
  g.textBaseline = 'alphabetic';
  for (let t = Math.max(0, t0); t <= t1; t += step) {
    const x = Math.round(timeToX(t));
    if (x < HEADER_W - 4) continue;
    g.fillStyle = '#555';
    g.fillRect(x, RULER_H - 8, 1, 8);
    g.fillStyle = '#909090';
    g.fillText(formatRuler(t, step), x + 4, RULER_H - 10);
    // minor ticks
    const minor = step / 5;
    g.fillStyle = '#3d3d3d';
    for (let k = 1; k < 5; k++) {
      const xm = Math.round(timeToX(t + minor * k));
      if (xm >= HEADER_W) g.fillRect(xm, RULER_H - 4, 1, 4);
    }
  }

  // header column
  g.fillStyle = '#2e2e2e';
  g.fillRect(0, 0, HEADER_W, viewH);
  g.fillStyle = '#191919';
  g.fillRect(HEADER_W - 1, 0, 1, viewH);
  g.fillStyle = '#161616';
  g.fillRect(0, RULER_H - 1, HEADER_W, 1);
  g.font = '11px -apple-system, sans-serif';
  g.textBaseline = 'middle';
  for (let t = 0; t < state.numTracks; t++) {
    const y = trackToY(t);
    if (y > viewH || y + TRACK_H < RULER_H) continue;
    g.fillStyle = '#1f1f1f';
    g.fillRect(0, y + TRACK_H - 1, HEADER_W, 1);
    g.fillStyle = '#b4b4b4';
    g.fillText(`Track ${t + 1}`, 12, y + 18);
    // mute button
    const muted = state.trackMuted[t];
    roundRect(HEADER_W - 32, y + 8, 22, 18, 4);
    g.fillStyle = muted ? '#c8a03c' : '#262626';
    g.fill();
    g.strokeStyle = '#191919';
    g.lineWidth = 1;
    g.stroke();
    g.fillStyle = muted ? '#241c06' : '#8a8a8a';
    g.font = '600 10px -apple-system, sans-serif';
    g.textAlign = 'center';
    g.fillText('M', HEADER_W - 21, y + 17.5);
    g.textAlign = 'left';
    g.font = '11px -apple-system, sans-serif';
  }
  if (ghostTrack) {
    const y = trackToY(state.numTracks);
    g.fillStyle = '#7a8a6e';
    g.fillText(`Track ${state.numTracks + 1}`, 12, y + 18);
  }

  // snap guide (FCP-style) when a drag locks onto another clip's edge
  if (snapGuide !== null) {
    const x = Math.round(timeToX(snapGuide));
    if (x >= HEADER_W) {
      g.fillStyle = '#f0c343';
      g.fillRect(x, RULER_H, 1, viewH - RULER_H);
      g.fillStyle = 'rgba(240,195,67,0.25)';
      g.fillRect(x - 1, RULER_H, 3, viewH - RULER_H);
    }
  }

  // drop indicator
  if (dropIndicator) {
    const x = timeToX(dropIndicator.time);
    const y = trackToY(dropIndicator.track);
    if (x >= HEADER_W) {
      g.fillStyle = '#b9d8a0';
      g.fillRect(Math.round(x), Math.max(y, RULER_H), 2, TRACK_H);
    }
  }

  // playhead
  const px = timeToX(pos);
  if (px >= HEADER_W - 6) {
    g.fillStyle = '#e8e8e8';
    if (px >= HEADER_W) g.fillRect(Math.round(px), RULER_H - 6, 1, viewH - RULER_H + 6);
    g.beginPath();
    g.moveTo(px - 5, RULER_H - 8);
    g.lineTo(px + 5, RULER_H - 8);
    g.lineTo(px, RULER_H);
    g.closePath();
    g.fill();
  }
}

// ---- drop indicator API (used by drag & drop in app.js) ----

export function setDropIndicator(ind) {
  dropIndicator = ind;
  requestDraw();
}

export function clientPointToTimeTrack(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  const mx = clientX - r.left;
  const my = clientY - r.top;
  const time = Math.max(0, xToTime(Math.max(mx, HEADER_W)));
  let track = trackAtY(Math.max(my, RULER_H + 1));
  track = Math.max(0, Math.min(track, state.numTracks));
  return { time, track };
}

// ---- init ----

export function initTimeline(hooks_) {
  hooks = hooks_;
  canvas = document.getElementById('tl');
  wrap = document.getElementById('tl-wrap');
  spacer = document.getElementById('tl-spacer');
  g = canvas.getContext('2d');

  const resize = () => {
    viewW = wrap.clientWidth;
    viewH = wrap.clientHeight;
    canvas.width = viewW * devicePixelRatio;
    canvas.height = viewH * devicePixelRatio;
    canvas.style.width = `${viewW}px`;
    canvas.style.height = `${viewH}px`;
    requestDraw();
  };
  new ResizeObserver(resize).observe(wrap);
  resize();

  wrap.addEventListener('scroll', () => {
    scrollX = wrap.scrollLeft;
    scrollY = wrap.scrollTop;
    requestDraw();
  });

  canvas.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  wrap.addEventListener('wheel', onWheel, { passive: false });

  updateSpacer();
  requestDraw();
}
