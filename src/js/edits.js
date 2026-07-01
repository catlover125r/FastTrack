// Clip edit operations shared by timeline tools, inspector buttons and menu.

import {
  state, makeClip, pushUndo, clipDur, clipEnd, selectedClips, setSelection,
} from './state.js';

function splitNoUndo(clip, t) {
  const MIN = 0.02;
  if (t <= clip.start + MIN || t >= clipEnd(clip) - MIN) return null;
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
  return right;
}

export function splitClip(clip, t) {
  if (t <= clip.start + 0.02 || t >= clipEnd(clip) - 0.02) return false;
  pushUndo();
  const right = splitNoUndo(clip, t);
  if (right) setSelection([right.id]);
  return !!right;
}

export function splitAtPlayhead() {
  const t = state.playhead;
  const inside = (c) => t > c.start + 0.02 && t < clipEnd(c) - 0.02;
  // split every selected clip the playhead crosses…
  let targets = selectedClips().filter(inside);
  // …or the topmost clip under the playhead
  if (!targets.length) {
    for (let i = state.clips.length - 1; i >= 0; i--) {
      if (inside(state.clips[i])) {
        targets = [state.clips[i]];
        break;
      }
    }
  }
  if (!targets.length) return false;
  pushUndo();
  const ids = [];
  for (const c of targets) {
    const right = splitNoUndo(c, t);
    if (right) ids.push(right.id);
  }
  if (ids.length) setSelection(ids);
  return ids.length > 0;
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

export function duplicateSelected() {
  const sel = selectedClips();
  if (!sel.length) return false;
  pushUndo();
  const ids = [];
  for (const c of sel) {
    const d = cloneClipAt(c);
    d.start = clipEnd(c);
    ids.push(d.id);
  }
  setSelection(ids);
  return true;
}

export function deleteSelected() {
  const sel = new Set(state.selectedIds);
  if (!sel.size) return false;
  pushUndo();
  state.clips = state.clips.filter((c) => !sel.has(c.id));
  setSelection([]);
  return true;
}

export function addTrackIfNeeded(track) {
  while (state.numTracks <= track) {
    state.numTracks++;
    state.trackMuted.push(false);
  }
}
