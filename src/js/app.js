// App wiring: transport, keyboard, tool menu, import/export, drag & drop.

import {
  state, selectedClip, setSelection, pushUndo, undo, redo, makeClip, clipEnd, projectEnd,
} from './state.js';
import * as audio from './audio.js';
import {
  initTimeline, requestDraw, updateSpacer, setDropIndicator,
  clientPointToTimeTrack, snapTime, zoomBy, setZoom, sliderToPps, ppsToSlider, HEADER_W,
} from './timeline.js';
import { initInspector, refreshInspector } from './inspector.js';
import { splitAtPlayhead, duplicateSelected, deleteSelected, addTrackIfNeeded } from './edits.js';

const $ = (id) => document.getElementById(id);
const lcd = $('lcd-time');
const statusEl = $('status');
const playBtn = $('btn-play');
const toolMenu = $('toolmenu');

let mouseX = 300;
let mouseY = 200;

// ---- helpers ----

function formatLCD(t) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const ms = Math.floor((t % 1) * 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function updateLCD() {
  lcd.textContent = formatLCD(state.playing ? audio.playbackPos() : state.playhead);
}

let toastTimer = null;
function toast(msg, ms = 2800) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

function setStatus(msg) {
  statusEl.textContent = msg;
}

// ---- tooltips ----

const tipEl = $('tooltip');
const tipText = $('tooltip-text');
const tipKey = $('tooltip-key');
let tipTimer = null;
let tipCurrent = null; // identity of the pending/shown tooltip

function hideTip() {
  clearTimeout(tipTimer);
  tipTimer = null;
  tipCurrent = null;
  tipEl.classList.add('hidden');
}

function displayTip(text, key, x, y, below = true) {
  tipText.textContent = text;
  tipKey.textContent = key || '';
  tipKey.style.display = key ? '' : 'none';
  tipEl.classList.remove('hidden');
  const w = tipEl.offsetWidth;
  const h = tipEl.offsetHeight;
  let left = Math.max(8, Math.min(x - w / 2, window.innerWidth - w - 8));
  let top = below ? y + 8 : y - h - 8;
  if (top + h > window.innerHeight - 8) top = y - h - 8;
  if (top < 8) top = y + 8;
  tipEl.style.left = `${left}px`;
  tipEl.style.top = `${top}px`;
}

function scheduleTip(identity, show) {
  if (tipCurrent === identity) return;
  hideTip();
  tipCurrent = identity;
  tipTimer = setTimeout(show, 500);
}

document.addEventListener('mouseover', (e) => {
  const t = e.target.closest?.('[data-tip]');
  if (!t) return;
  scheduleTip(`el:${t.dataset.tip}`, () => {
    const r = t.getBoundingClientRect();
    displayTip(t.dataset.tip, t.dataset.key, r.left + r.width / 2, r.bottom);
  });
});
document.addEventListener('mouseout', (e) => {
  const t = e.target.closest?.('[data-tip]');
  if (t && !t.contains(e.relatedTarget)) hideTip();
});
window.addEventListener('mousedown', hideTip, true);

// tooltips for canvas hit targets (mute buttons, fade handles, …)
function hoverTip(tip, x, y) {
  if (!tip) {
    if (tipCurrent && tipCurrent.startsWith('cv:')) hideTip();
    return;
  }
  scheduleTip(`cv:${tip.text}`, () => displayTip(tip.text, tip.key, x, y + 14));
}

function onChange() {
  updateSpacer();
  updateLCD();
  refreshInspector();
  requestDraw();
}

// ---- playback ----

function syncPlayBtn() {
  $('icon-play').classList.toggle('hidden', state.playing);
  $('icon-stop').classList.toggle('hidden', !state.playing);
  playBtn.classList.toggle('playing', state.playing);
}

function tick() {
  if (!state.playing) return;
  updateLCD();
  requestDraw();
  const end = projectEnd();
  if (end > 0 && audio.playbackPos() >= end) {
    audio.stop();
    state.playhead = end;
    syncPlayBtn();
    onChange();
    return;
  }
  requestAnimationFrame(tick);
}

function play() {
  if (state.playing || !state.clips.length) return;
  if (projectEnd() > 0 && state.playhead >= projectEnd() - 0.01) state.playhead = 0;
  audio.play();
  syncPlayBtn();
  requestAnimationFrame(tick);
}

function stopPlayback() {
  audio.stop();
  syncPlayBtn();
  onChange();
}

function togglePlay() {
  if (state.playing) stopPlayback();
  else play();
}

function seek(t) {
  const was = state.playing;
  if (was) audio.stop();
  state.playhead = Math.max(0, t);
  if (was) audio.play();
  syncPlayBtn();
  updateLCD();
  requestDraw();
}

// ---- import ----

async function addClips(files, time, track) {
  if (!files.length) return;
  setStatus('Importing…');
  const decoded = [];
  for (const f of files) {
    try {
      decoded.push({ name: f.name, buffer: await audio.decodeArrayBuffer(f.data) });
    } catch (err) {
      toast(`Couldn't read "${f.name}" — unsupported format`);
    }
  }
  setStatus('');
  if (!decoded.length) return;
  const wasEmpty = !state.clips.length;
  pushUndo();
  addTrackIfNeeded(track);
  let t = time;
  let last = null;
  for (const d of decoded) {
    const peaks = audio.computePeaks(d.buffer);
    const clip = makeClip(d.name.replace(/\.[^.]+$/, ''), d.buffer, peaks, track, t);
    state.clips.push(clip);
    t = clipEnd(clip);
    last = clip;
  }
  setSelection([last.id]);
  // first import: zoom to fit if the audio overflows the viewport
  if (wasEmpty) {
    const avail = $('tl-wrap').clientWidth - HEADER_W - 40;
    const end = projectEnd();
    if (end * state.pxPerSec > avail && end > 0) setZoom(avail / end, HEADER_W);
  }
  onChange();
}

async function importDialog() {
  const files = await window.fasttrack.openAudio();
  const track = selectedClip() ? selectedClip().track : 0;
  await addClips(files, snapTime(state.playhead), track);
}

// ---- export ----

let exporting = false;
async function doExport() {
  if (exporting) return;
  if (!state.clips.length) {
    toast('Nothing to export — the timeline is empty');
    return;
  }
  exporting = true;
  if (state.playing) stopPlayback();
  setStatus('Exporting…');
  try {
    const mp3 = await audio.exportMp3();
    const name = `${state.clips[0].name || 'FastTrack'}.mp3`;
    const saved = await window.fasttrack.saveMp3(new Uint8Array(mp3), name);
    if (saved) toast(`Exported to ${saved}`);
  } catch (err) {
    toast(`Export failed: ${err.message}`);
  } finally {
    setStatus('');
    exporting = false;
  }
}

// ---- tools ----

function setTool(tool) {
  state.tool = tool;
  document.querySelectorAll('.tool-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.tool === tool);
  });
  hideToolMenu();
  requestDraw();
}

function showToolMenu() {
  toolMenu.classList.remove('hidden');
  const w = toolMenu.offsetWidth;
  const h = toolMenu.offsetHeight;
  toolMenu.style.left = `${Math.min(mouseX, window.innerWidth - w - 8)}px`;
  toolMenu.style.top = `${Math.min(mouseY, window.innerHeight - h - 8)}px`;
  toolMenu.querySelectorAll('.tm-item').forEach((it) => {
    it.classList.toggle('current', it.dataset.tool === state.tool);
  });
}

function hideToolMenu() {
  toolMenu.classList.add('hidden');
}

// ---- edit commands ----

function cmdDelete() {
  if (!deleteSelected()) return;
  if (state.playing) seek(audio.playbackPos());
  onChange();
}

function cmdUndo() {
  if (undo()) {
    if (state.playing) seek(audio.playbackPos());
    onChange();
  }
}

function cmdRedo() {
  if (redo()) {
    if (state.playing) seek(audio.playbackPos());
    onChange();
  }
}

function cmdSplit() {
  if (splitAtPlayhead()) onChange();
}

function cmdDuplicate() {
  if (duplicateSelected()) onChange();
}

function setSnap(on) {
  state.snap = on;
  $('btn-snap').classList.toggle('active', on);
}

// ---- boot ----

const hooks = {
  onChange,
  onZoom: () => {
    $('zoom-slider').value = ppsToSlider(state.pxPerSec);
  },
  play,
  stop: stopPlayback,
  seek,
  setStatus,
  hover: hoverTip,
};

initTimeline(hooks);
initInspector(hooks);
updateLCD();

document.querySelectorAll('.tool-btn').forEach((b) => {
  b.addEventListener('click', () => setTool(b.dataset.tool));
});
toolMenu.querySelectorAll('.tm-item').forEach((it) => {
  it.addEventListener('click', () => setTool(it.dataset.tool));
});

$('btn-play').addEventListener('click', togglePlay);
$('btn-rewind').addEventListener('click', () => seek(0));
$('btn-snap').addEventListener('click', () => setSnap(!state.snap));
$('btn-open').addEventListener('click', importDialog);
$('btn-export').addEventListener('click', doExport);
$('btn-zoom-in').addEventListener('click', () => zoomBy(1.5));
$('btn-zoom-out').addEventListener('click', () => zoomBy(1 / 1.5));
$('zoom-slider').addEventListener('input', (e) => {
  const wrap = $('tl-wrap');
  setZoom(sliderToPps(parseFloat(e.target.value)), (HEADER_W + wrap.clientWidth) / 2);
});
$('zoom-slider').value = ppsToSlider(state.pxPerSec);

window.addEventListener('mousemove', (e) => {
  mouseX = e.clientX;
  mouseY = e.clientY;
});
window.addEventListener('mousedown', (e) => {
  if (!toolMenu.classList.contains('hidden') && !toolMenu.contains(e.target)) hideToolMenu();
});

// menu commands from the main process
window.fasttrack.onCommand((cmd) => {
  const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName || '');
  if (typing && (cmd === 'undo' || cmd === 'redo' || cmd === 'delete')) return;
  const map = {
    open: importDialog,
    export: doExport,
    undo: cmdUndo,
    redo: cmdRedo,
    split: cmdSplit,
    duplicate: cmdDuplicate,
    delete: cmdDelete,
  };
  map[cmd]?.();
});

// ---- keyboard ----

window.addEventListener('keydown', (e) => {
  const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName || '');
  if (typing) {
    if (e.key === 'Escape' || e.key === 'Enter') document.activeElement.blur();
    return;
  }
  switch (e.key) {
    case ' ':
      e.preventDefault();
      togglePlay();
      break;
    case 'Enter':
      seek(0);
      break;
    case 't':
    case 'T':
      if (toolMenu.classList.contains('hidden')) showToolMenu();
      else hideToolMenu();
      break;
    case 'n':
    case 'N':
      setSnap(!state.snap);
      break;
    case 'a':
    case 'A':
    case '1':
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        setSelection(state.clips.map((c) => c.id));
        onChange();
      } else {
        setTool('pointer');
      }
      break;
    case 'c':
    case 'C':
    case '2':
      if (!e.metaKey && !e.ctrlKey) setTool('scissors');
      break;
    case 'f':
    case 'F':
    case '3':
      if (!e.metaKey && !e.ctrlKey) setTool('fade');
      break;
    case 'Escape':
      hideToolMenu();
      break;
    case 'Backspace':
    case 'Delete':
      cmdDelete();
      break;
    case '=':
    case '+':
      if (e.metaKey) {
        e.preventDefault();
        zoomBy(1.4);
      }
      break;
    case '-':
      if (e.metaKey) {
        e.preventDefault();
        zoomBy(1 / 1.4);
      }
      break;
    default:
      break;
  }
});

// ---- drag & drop from Finder ----

const tlWrap = $('tl-wrap');

tlWrap.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  const { time, track } = clientPointToTimeTrack(e.clientX, e.clientY);
  setDropIndicator({ time: snapTime(time), track });
});
tlWrap.addEventListener('dragleave', () => setDropIndicator(null));
tlWrap.addEventListener('drop', async (e) => {
  e.preventDefault();
  setDropIndicator(null);
  const { time, track } = clientPointToTimeTrack(e.clientX, e.clientY);
  const files = [];
  for (const f of e.dataTransfer.files) {
    files.push({ name: f.name, data: await f.arrayBuffer() });
  }
  await addClips(files, snapTime(time), track);
});

// prevent the window itself from navigating on stray drops
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
