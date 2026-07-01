// Central mutable state + undo/redo. Clips reference immutable AudioBuffers
// (original + rendered), so undo snapshots are cheap metadata clones that keep
// old rendered buffers alive — undoing a pitch/speed change needs no re-render.

export const DEFAULT_COLOR = '#a3bd8f';

export const PALETTE = [
  '#a3bd8f', // faded green (default)
  '#8fb0c9', // blue
  '#8fc9bb', // teal
  '#cdc98f', // yellow
  '#d4a878', // orange
  '#cf8f8f', // red
  '#af97cc', // purple
  '#a8a8a8', // grey
];

export const state = {
  clips: [],
  numTracks: 1,
  trackMuted: [],
  selectedId: null,
  playhead: 0,
  playing: false,
  pxPerSec: 100,
  snap: true,
  tool: 'pointer',
};

let nextId = 1;

export function makeClip(name, buffer, rendered, peaks, track, start) {
  return {
    id: nextId++,
    name,
    buffer,      // original decoded AudioBuffer (immutable)
    rendered,    // buffer after pitch/speed/reverse/normalize (immutable)
    peaks,       // Float32Array [min,max,...] per PEAK_BUCKET of rendered
    track,
    start,       // timeline position, seconds
    srcStart: 0, // trim window into rendered, seconds
    srcEnd: rendered.duration,
    gain: 1,
    fadeIn: 0,
    fadeOut: 0,
    color: null, // null = default green
    params: { semitones: 0, speed: 1, reverse: false, normalize: false },
  };
}

export function clipDur(c) {
  return c.srcEnd - c.srcStart;
}

export function clipEnd(c) {
  return c.start + clipDur(c);
}

export function clipColor(c) {
  return c.color || DEFAULT_COLOR;
}

export function selectedClip() {
  return state.clips.find((c) => c.id === state.selectedId) || null;
}

export function projectEnd() {
  return state.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
}

// ---- undo / redo ----

const undoStack = [];
const redoStack = [];
const MAX_UNDO = 40;

function cloneClips(clips) {
  return clips.map((c) => ({ ...c, params: { ...c.params } }));
}

function snapshot() {
  return {
    clips: cloneClips(state.clips),
    numTracks: state.numTracks,
    trackMuted: [...state.trackMuted],
    selectedId: state.selectedId,
  };
}

export function pushUndo(snap) {
  undoStack.push(snap || snapshot());
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack.length = 0;
}

export function takeSnapshot() {
  return snapshot();
}

function restore(snap) {
  state.clips = cloneClips(snap.clips);
  state.numTracks = snap.numTracks;
  state.trackMuted = [...snap.trackMuted];
  state.selectedId = snap.selectedId;
}

export function undo() {
  if (!undoStack.length) return false;
  redoStack.push(snapshot());
  restore(undoStack.pop());
  return true;
}

export function redo() {
  if (!redoStack.length) return false;
  undoStack.push(snapshot());
  restore(redoStack.pop());
  return true;
}
