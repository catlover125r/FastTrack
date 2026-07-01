// Left inspector: edits every selected clip (name, color, volume, pitch,
// speed, fades, reverse/normalize) plus split/duplicate/delete actions.
// With several clips selected, values shown come from the first one and
// changes are applied to the whole selection.

import {
  state, selectedClips, pushUndo, takeSnapshot, PALETTE, clipDur,
} from './state.js';
import { updateLiveClip, playbackPos } from './audio.js';
import { splitAtPlayhead, duplicateSelected, deleteSelected } from './edits.js';

let hooks;
let els = {};
let gestureSnap = null; // snapshot taken at the start of a slider gesture

const dbToGain = (db) => Math.pow(10, db / 20);
const gainToDb = (gn) => (gn <= 0.0001 ? -30 : Math.max(-30, 20 * Math.log10(gn)));
const sliderToSpeed = (v) => Math.pow(2, v / 50);
const speedToSlider = (s) => 50 * Math.log2(s);

function beginGesture() {
  if (!gestureSnap) gestureSnap = takeSnapshot();
}

function commitGesture() {
  if (gestureSnap) {
    pushUndo(gestureSnap);
    gestureSnap = null;
  }
}

// Structural param changes (speed/reverse) invalidate what's currently
// scheduled; a seamless re-seek makes them audible at the same position.
function resync() {
  if (state.playing) hooks.seek(playbackPos());
}

// Lightroom-style filled track: expose the thumb position to CSS.
function updateFill(el) {
  const pct = ((el.value - el.min) / (el.max - el.min)) * 100;
  el.style.setProperty('--fill', `${pct}%`);
}

export function refreshInspector() {
  const sel = selectedClips();
  els.empty.classList.toggle('hidden', sel.length > 0);
  els.panel.classList.toggle('hidden', sel.length === 0);
  if (!sel.length) return;
  const c = sel[0];

  if (document.activeElement !== els.name) {
    if (sel.length > 1) {
      els.name.value = '';
      els.name.placeholder = `${sel.length} regions selected`;
    } else {
      els.name.value = c.name;
      els.name.placeholder = '';
    }
  }
  const db = gainToDb(c.gain);
  els.gain.value = db;
  els.gainVal.textContent = `${db.toFixed(1)} dB`;
  els.pitch.value = c.params.semitones;
  els.pitchVal.textContent = `${c.params.semitones > 0 ? '+' : ''}${c.params.semitones} st`;
  els.speed.value = speedToSlider(c.params.speed);
  els.speedVal.textContent = `${Math.round(c.params.speed * 100)}%`;
  if (document.activeElement !== els.fadeIn) els.fadeIn.value = c.fadeIn.toFixed(2);
  if (document.activeElement !== els.fadeOut) els.fadeOut.value = c.fadeOut.toFixed(2);
  els.reverse.classList.toggle('active', c.params.reverse);
  els.normalize.classList.toggle('active', c.params.normalize);
  for (const el of [els.gain, els.pitch, els.speed]) updateFill(el);

  const swatches = els.colors.children;
  for (let i = 0; i < swatches.length; i++) {
    const sw = swatches[i];
    sw.classList.toggle('active', (c.color || PALETTE[0]) === sw.dataset.color);
  }
}

export function initInspector(hooks_) {
  hooks = hooks_;
  els = {
    empty: document.getElementById('insp-empty'),
    panel: document.getElementById('insp-clip'),
    name: document.getElementById('insp-name'),
    colors: document.getElementById('insp-colors'),
    gain: document.getElementById('insp-gain'),
    gainVal: document.getElementById('insp-gain-val'),
    pitch: document.getElementById('insp-pitch'),
    pitchVal: document.getElementById('insp-pitch-val'),
    speed: document.getElementById('insp-speed'),
    speedVal: document.getElementById('insp-speed-val'),
    fadeIn: document.getElementById('insp-fadein'),
    fadeOut: document.getElementById('insp-fadeout'),
    reverse: document.getElementById('insp-reverse'),
    normalize: document.getElementById('insp-normalize'),
  };

  for (const color of PALETTE) {
    const sw = document.createElement('div');
    sw.className = 'swatch';
    sw.dataset.color = color;
    sw.style.background = color;
    sw.title = color === PALETTE[0] ? 'Default' : '';
    sw.addEventListener('click', () => {
      const sel = selectedClips();
      if (!sel.length) return;
      pushUndo();
      for (const c of sel) c.color = color === PALETTE[0] ? null : color;
      hooks.onChange();
      refreshInspector();
    });
    els.colors.appendChild(sw);
  }

  els.name.addEventListener('change', () => {
    const sel = selectedClips();
    if (!sel.length || !els.name.value) return;
    pushUndo();
    for (const c of sel) c.name = els.name.value;
    els.name.blur();
    hooks.onChange();
  });

  // volume: live while dragging, one undo entry per gesture
  els.gain.addEventListener('input', () => {
    const sel = selectedClips();
    if (!sel.length) return;
    beginGesture();
    const gv = dbToGain(parseFloat(els.gain.value));
    for (const c of sel) {
      c.gain = gv;
      updateLiveClip(c);
    }
    els.gainVal.textContent = `${parseFloat(els.gain.value).toFixed(1)} dB`;
    updateFill(els.gain);
    hooks.onChange();
  });
  els.gain.addEventListener('change', commitGesture);

  // pitch: applied to playing SoundTouch nodes in real time
  els.pitch.addEventListener('input', () => {
    const sel = selectedClips();
    if (!sel.length) return;
    const v = parseInt(els.pitch.value, 10);
    els.pitchVal.textContent = `${v > 0 ? '+' : ''}${v} st`;
    updateFill(els.pitch);
    beginGesture();
    for (const c of sel) {
      c.params.semitones = v;
      updateLiveClip(c);
    }
    hooks.onChange();
  });
  els.pitch.addEventListener('change', () => {
    commitGesture();
    // clips playing through the plain (non-stretch) path need a reschedule
    resync();
  });

  // speed: tempo changes live; timing/fades resync on release
  els.speed.addEventListener('input', () => {
    const sel = selectedClips();
    if (!sel.length) return;
    const v = Math.round(sliderToSpeed(parseFloat(els.speed.value)) * 100) / 100;
    els.speedVal.textContent = `${Math.round(v * 100)}%`;
    updateFill(els.speed);
    beginGesture();
    for (const c of sel) {
      c.params.speed = v;
      updateLiveClip(c);
    }
    hooks.onChange();
  });
  els.speed.addEventListener('change', () => {
    commitGesture();
    resync();
  });

  const fadeHandler = (el, key) => () => {
    const sel = selectedClips();
    if (!sel.length) return;
    const v = Math.max(0, parseFloat(el.value) || 0);
    pushUndo();
    for (const c of sel) c[key] = Math.min(v, clipDur(c));
    hooks.onChange();
    refreshInspector();
    resync();
  };
  els.fadeIn.addEventListener('change', fadeHandler(els.fadeIn, 'fadeIn'));
  els.fadeOut.addEventListener('change', fadeHandler(els.fadeOut, 'fadeOut'));

  els.reverse.addEventListener('click', () => {
    const sel = selectedClips();
    if (!sel.length) return;
    pushUndo();
    const nv = !sel[0].params.reverse;
    for (const c of sel) c.params.reverse = nv;
    hooks.onChange();
    refreshInspector();
    resync();
  });
  els.normalize.addEventListener('click', () => {
    const sel = selectedClips();
    if (!sel.length) return;
    pushUndo();
    const nv = !sel[0].params.normalize;
    for (const c of sel) {
      c.params.normalize = nv;
      updateLiveClip(c);
    }
    hooks.onChange();
    refreshInspector();
  });

  document.getElementById('insp-split').addEventListener('click', () => {
    if (splitAtPlayhead()) {
      hooks.onChange();
      refreshInspector();
    }
  });
  document.getElementById('insp-dup').addEventListener('click', () => {
    if (duplicateSelected()) {
      hooks.onChange();
      refreshInspector();
    }
  });
  document.getElementById('insp-delete').addEventListener('click', () => {
    if (deleteSelected()) {
      resync();
      hooks.onChange();
      refreshInspector();
    }
  });
}
