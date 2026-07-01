// Left inspector: edits the selected clip's name, color, volume, pitch,
// speed, fades, reverse/normalize, plus split/duplicate/delete actions.

import { state, selectedClip, pushUndo, takeSnapshot, PALETTE, clipDur } from './state.js';
import { applyParams } from './audio.js';
import { splitAtPlayhead, duplicateClip, deleteClip } from './edits.js';

let hooks;
let els = {};
let gestureSnap = null; // snapshot taken at the start of a slider gesture

const dbToGain = (db) => Math.pow(10, db / 20);
const gainToDb = (gn) => (gn <= 0.0001 ? -40 : 20 * Math.log10(gn));
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

function rerender(clip, params) {
  hooks.setStatus('Rendering…');
  setTimeout(() => {
    applyParams(clip, params);
    hooks.setStatus('');
    hooks.onChange();
    refreshInspector();
  }, 25);
}

export function refreshInspector() {
  const c = selectedClip();
  els.empty.classList.toggle('hidden', !!c);
  els.panel.classList.toggle('hidden', !c);
  if (!c) return;

  if (document.activeElement !== els.name) els.name.value = c.name;
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

  const swatches = els.colors.children;
  for (let i = 0; i < swatches.length; i++) {
    const sw = swatches[i];
    const active = (c.color || PALETTE[0]) === sw.dataset.color;
    sw.classList.toggle('active', active);
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
      const c = selectedClip();
      if (!c) return;
      pushUndo();
      c.color = color === PALETTE[0] ? null : color;
      hooks.onChange();
      refreshInspector();
    });
    els.colors.appendChild(sw);
  }

  els.name.addEventListener('change', () => {
    const c = selectedClip();
    if (!c) return;
    pushUndo();
    c.name = els.name.value || c.name;
    els.name.blur();
    hooks.onChange();
  });

  // volume: live while dragging, one undo entry per gesture
  els.gain.addEventListener('input', () => {
    const c = selectedClip();
    if (!c) return;
    beginGesture();
    c.gain = dbToGain(parseFloat(els.gain.value));
    els.gainVal.textContent = `${parseFloat(els.gain.value).toFixed(1)} dB`;
    hooks.onChange();
  });
  els.gain.addEventListener('change', commitGesture);

  // pitch / speed: label live, re-render on release
  els.pitch.addEventListener('input', () => {
    const v = parseInt(els.pitch.value, 10);
    els.pitchVal.textContent = `${v > 0 ? '+' : ''}${v} st`;
  });
  els.pitch.addEventListener('change', () => {
    const c = selectedClip();
    if (!c) return;
    const v = parseInt(els.pitch.value, 10);
    if (v === c.params.semitones) return;
    pushUndo();
    rerender(c, { ...c.params, semitones: v });
  });

  els.speed.addEventListener('input', () => {
    els.speedVal.textContent = `${Math.round(sliderToSpeed(parseFloat(els.speed.value)) * 100)}%`;
  });
  els.speed.addEventListener('change', () => {
    const c = selectedClip();
    if (!c) return;
    const v = Math.round(sliderToSpeed(parseFloat(els.speed.value)) * 100) / 100;
    if (v === c.params.speed) return;
    pushUndo();
    rerender(c, { ...c.params, speed: v });
  });

  const fadeHandler = (el, key) => () => {
    const c = selectedClip();
    if (!c) return;
    const v = Math.max(0, Math.min(parseFloat(el.value) || 0, clipDur(c)));
    if (v === c[key]) return;
    pushUndo();
    c[key] = v;
    hooks.onChange();
    refreshInspector();
  };
  els.fadeIn.addEventListener('change', fadeHandler(els.fadeIn, 'fadeIn'));
  els.fadeOut.addEventListener('change', fadeHandler(els.fadeOut, 'fadeOut'));

  els.reverse.addEventListener('click', () => {
    const c = selectedClip();
    if (!c) return;
    pushUndo();
    rerender(c, { ...c.params, reverse: !c.params.reverse });
  });
  els.normalize.addEventListener('click', () => {
    const c = selectedClip();
    if (!c) return;
    pushUndo();
    rerender(c, { ...c.params, normalize: !c.params.normalize });
  });

  document.getElementById('insp-split').addEventListener('click', () => {
    if (splitAtPlayhead()) {
      hooks.onChange();
      refreshInspector();
    }
  });
  document.getElementById('insp-dup').addEventListener('click', () => {
    const c = selectedClip();
    if (!c) return;
    duplicateClip(c);
    hooks.onChange();
    refreshInspector();
  });
  document.getElementById('insp-delete').addEventListener('click', () => {
    const c = selectedClip();
    if (!c) return;
    deleteClip(c);
    hooks.onChange();
    refreshInspector();
  });
}
