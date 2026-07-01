// Clip edit operations shared by timeline tools, inspector buttons and menu.

import { state, makeClip, pushUndo, clipDur, clipEnd, selectedClip } from './state.js';

export function splitClip(clip, t) {
  const MIN = 0.02;
  if (t <= clip.start + MIN || t >= clipEnd(clip) - MIN) return false;
  pushUndo();
  const left = state.clips.find((c) => c.id === clip.id);
  const cutSrc = (t - left.start) * left.params.speed; // source seconds
  const right = makeClip(left.name, left.buffer, left.peaks, left.track, t);
  right.gain = left.gain;
  right.color = left.color;
  right.params = { ...left.params };
  if (left.params.reverse) {
    // timeline-left of a reversed clip corresponds to the source END
    right.srcStart = left.srcStart;
    right.srcEnd = left.srcEnd - cutSrc;
    left.srcStart = left.srcEnd - cutSrc;
  } else {
    right.srcStart = left.srcStart + cutSrc;
    right.srcEnd = left.srcEnd;
    left.srcEnd = left.srcStart + cutSrc;
  }
  right.fadeIn = 0;
  right.fadeOut = Math.min(left.fadeOut, clipDur(right));
  left.fadeOut = 0;
  left.fadeIn = Math.min(left.fadeIn, clipDur(left));
  state.clips.splice(state.clips.indexOf(left) + 1, 0, right);
  state.selectedId = right.id;
  return true;
}

export function splitAtPlayhead() {
  const t = state.playhead;
  const sel = selectedClip();
  if (sel && t > sel.start && t < clipEnd(sel)) return splitClip(sel, t);
  // otherwise split the topmost clip under the playhead
  for (let i = state.clips.length - 1; i >= 0; i--) {
    const c = state.clips[i];
    if (t > c.start && t < clipEnd(c)) return splitClip(c, t);
  }
  return false;
}

// Exact copy at the same position; no undo entry — callers handle that.
export function cloneClipAt(clip) {
  const d = makeClip(clip.name, clip.buffer, clip.peaks, clip.track, clip.start);
  d.srcStart = clip.srcStart;
  d.srcEnd = clip.srcEnd;
  d.gain = clip.gain;
  d.fadeIn = clip.fadeIn;
  d.fadeOut = clip.fadeOut;
  d.color = clip.color;
  d.params = { ...clip.params };
  state.clips.push(d);
  return d;
}

export function duplicateClip(clip) {
  pushUndo();
  const d = cloneClipAt(clip);
  d.start = clipEnd(clip);
  state.selectedId = d.id;
  return d;
}

export function deleteClip(clip) {
  pushUndo();
  state.clips = state.clips.filter((c) => c.id !== clip.id);
  if (state.selectedId === clip.id) state.selectedId = null;
}

export function addTrackIfNeeded(track) {
  while (state.numTracks <= track) {
    state.numTracks++;
    state.trackMuted.push(false);
  }
}
