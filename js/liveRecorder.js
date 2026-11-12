/* In-app HD recorder: live camera preview, record button, flashlight, and a "Mark a Problem"
   button usable while recording. The raw MediaRecorder file is rebuilt into a proper seekable
   MP4 (see mp4Repair.js) and checked before it goes to the review screen. */

const LIVE_VIDEO_BPS = 6000000;
const LIVE_AUDIO_BPS = 128000;
const LIVE = {
  stream: null, recorder: null, chunks: [], t0: 0, timer: null,
  recording: false, armed: false, torchOn: false, wakeLock: null, finalElapsed: 0,
  frames: 0, lastFrameAt: 0, watchdog: null, stalled: false, events: [],
  canvasMode: false, canvas: null, ctx: null, cstream: null, recStream: null, loopToken: 0,
};

// "Stable" mode records a fixed-size canvas that the camera is drawn onto, so the recorder never
// sees the camera picture change shape (tilting the phone flat or turning it). Safari's recorder
// stops writing video when that happens while the sound carries on.
const LIVE_CANVAS_W = 1080;
const LIVE_CANVAS_H = 1920;

function wantCanvasMode() {
  try { return (localStorage.getItem('pti_rec_mode') || 'canvas') === 'canvas'; } catch (e) { return true; }
}

function logLiveEvent(text) {
  const t = LIVE.recording ? liveElapsedSec().toFixed(1) + 's' : 'pre';
  LIVE.events.push(`${t} ${text}`);
  if (LIVE.events.length > 30) LIVE.events.shift();
}

function pickLiveMime() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  const candidates = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4'];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

const FIT_MODES = ['fit', 'wide', 'fill'];
const FIT_LABELS = { fit: 'Fit', wide: 'Wide', fill: 'Fill' };

function liveScales(video) {
  const cw = video.clientWidth || 1;
  const ch = video.clientHeight || 1;
  const vw = video.videoWidth || cw;
  const vh = video.videoHeight || ch;
  const contain = Math.min(cw / vw, ch / vh);
  const cover = Math.max(cw / vw, ch / vh);
  return { contain, cover, wide: Math.sqrt(contain * cover) };
}

// Fit = whole picture, Fill = crops to cover the screen, Wide = in between.
function applyLiveFit(mode) {
  if (!FIT_MODES.includes(mode)) mode = 'wide';
  LIVE.fitMode = mode;
  const v = document.getElementById('live-video');
  if (v && LIVE.canvasMode) {
    v.style.transform = '';
  } else if (v) {
    const sc = liveScales(v);
    const k = sc[mode === 'fit' ? 'contain' : mode === 'fill' ? 'cover' : 'wide'] / sc.contain;
    v.style.transform = k > 1.001 ? `scale(${k.toFixed(4)})` : '';
  }
  const label = document.getElementById('live-fit-label');
  if (label) label.textContent = FIT_LABELS[mode];
  updateLiveFrameBox();
}

function reapplyLiveFit() {
  if (LIVE.stream) applyLiveFit(LIVE.fitMode);
}

function toggleLiveFit() {
  const next = FIT_MODES[(FIT_MODES.indexOf(LIVE.fitMode || 'wide') + 1) % FIT_MODES.length];
  applyLiveFit(next);
  try { localStorage.setItem('pti_live_fit_mode', next); } catch (e) { /* storage unavailable */ }
}

function liveRecordingActive() {
  return LIVE.recording;
}

function liveElapsedSec() {
  return LIVE.recording ? (performance.now() - LIVE.t0) / 1000 : LIVE.finalElapsed;
}

async function startLiveCamera() {
  stopLiveCamera();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !pickLiveMime()) return false;
  // Ask for a tall picture when the phone is held upright so the preview fills the screen.
  const upright = window.innerHeight > window.innerWidth;
  try {
    LIVE.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: upright ? 1080 : 1920 },
        height: { ideal: upright ? 1920 : 1080 },
        aspectRatio: { ideal: upright ? 9 / 16 : 16 / 9 },
        frameRate: { ideal: 30 },
      },
      audio: true,
    });
  } catch (err) {
    console.warn('Live camera unavailable:', err);
    return false;
  }
  const screen = document.getElementById('screen-record');
  if (!screen || !screen.classList.contains('active')) {
    stopLiveCamera();
    return false;
  }
  const v = $('#live-video');
  v.muted = true;
  try { applyLiveFit(localStorage.getItem('pti_live_fit_mode') || 'wide'); } catch (e) { applyLiveFit('wide'); }
  v.srcObject = LIVE.stream;
  try { await v.play(); } catch (e) { /* autoplay handled by attribute */ }
  v.addEventListener('loadedmetadata', () => applyLiveFit(LIVE.fitMode), { once: true });
  window.removeEventListener('resize', reapplyLiveFit);
  window.addEventListener('resize', reapplyLiveFit);
  setupLiveTorch();
  setupLiveZoom();
  setLiveControls('ready');
  LIVE.events = [];
  LIVE.frames = 0;
  LIVE.lastFrameAt = performance.now();

  const cv = $('#live-canvas');
  LIVE.canvasMode = wantCanvasMode() && typeof cv.captureStream === 'function';
  if (LIVE.canvasMode) {
    cv.width = LIVE_CANVAS_W;
    cv.height = LIVE_CANVAS_H;
    LIVE.canvas = cv;
    LIVE.ctx = cv.getContext('2d', { alpha: false });
    cv.style.display = 'block';
    try {
      LIVE.cstream = cv.captureStream(30);
      LIVE.stream.getAudioTracks().forEach((t) => LIVE.cstream.addTrack(t));
      LIVE.recStream = LIVE.cstream;
    } catch (err) {
      console.warn('Canvas capture failed, recording the camera directly:', err);
      LIVE.canvasMode = false;
      cv.style.display = 'none';
      LIVE.recStream = LIVE.stream;
    }
  } else {
    cv.style.display = 'none';
    LIVE.recStream = LIVE.stream;
  }
  logLiveEvent(`recording pipeline: ${LIVE.canvasMode ? 'stable canvas ' + LIVE_CANVAS_W + 'x' + LIVE_CANVAS_H : 'direct camera'}`);
  v.addEventListener('resize', onLiveVideoResize);
  window.addEventListener('orientationchange', onLiveOrientation);
  startLiveDrawLoop(v);
  const vtrack = LIVE.stream.getVideoTracks()[0];
  if (vtrack) {
    vtrack.addEventListener('mute', () => { logLiveEvent('camera track MUTED'); showLiveWarning('The camera stopped sending video. Keep the phone steady and the lens uncovered.'); });
    vtrack.addEventListener('unmute', () => { logLiveEvent('camera track unmuted'); });
    vtrack.addEventListener('ended', () => { logLiveEvent('camera track ENDED'); showLiveWarning('The camera stopped. Stop recording and start again.'); });
  }
  document.addEventListener('visibilitychange', onLiveVisibility);
  try {
    const s = LIVE.stream.getVideoTracks()[0].getSettings();
    const info = $('#live-cam-info');
    info.className = 'video-info' + (Math.min(s.width || 0, s.height || 0) < 1000 ? ' video-info-low' : '');
    info.textContent = `Camera ${s.width || '?'}×${s.height || '?'}${s.frameRate ? ' @ ' + Math.round(s.frameRate) + ' fps' : ''} · preview ${v.videoWidth || '?'}×${v.videoHeight || '?'}${LIVE.canvasMode ? ' · recording ' + LIVE_CANVAS_W + '×' + LIVE_CANVAS_H : ''}`;
  } catch (e) { /* settings unavailable */ }
  return true;
}

function onLiveVideoResize() {
  const v = document.getElementById('live-video');
  logLiveEvent(`camera picture changed shape: ${v ? v.videoWidth + 'x' + v.videoHeight : '?'}`);
}

function onLiveOrientation() {
  logLiveEvent(`phone orientation changed (${window.orientation !== undefined ? window.orientation + ' deg' : 'unknown'})`);
}

function drawLiveFrame(v) {
  const vw = v.videoWidth;
  const vh = v.videoHeight;
  if (!vw || !vh || !LIVE.ctx) return;
  const W = LIVE_CANVAS_W;
  const H = LIVE_CANVAS_H;
  const contain = Math.min(W / vw, H / vh);
  const cover = Math.max(W / vw, H / vh);
  const mode = LIVE.fitMode || 'wide';
  const s = mode === 'fit' ? contain : mode === 'fill' ? cover : Math.sqrt(contain * cover);
  const w = vw * s;
  const h = vh * s;
  LIVE.ctx.fillStyle = '#000';
  LIVE.ctx.fillRect(0, 0, W, H);
  LIVE.ctx.drawImage(v, (W - w) / 2, (H - h) / 2, w, h);
  LIVE.drawRect = { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

// Runs once per camera frame: counts it and, in stable mode, paints it onto the recording canvas.
function startLiveDrawLoop(v) {
  const token = ++LIVE.loopToken;
  const step = () => {
    if (token !== LIVE.loopToken || !LIVE.stream) return;
    LIVE.frames++;
    LIVE.lastFrameAt = performance.now();
    if (LIVE.canvasMode) drawLiveFrame(v);
    if (LIVE.frames % 12 === 1) updateLiveFrameBox();
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(step);
    else requestAnimationFrame(step);
  };
  if (LIVE.canvasMode) drawLiveFrame(v);
  if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(step);
  else requestAnimationFrame(step);
}

function stopLiveCamera() {
  if (LIVE.timer) { clearInterval(LIVE.timer); LIVE.timer = null; }
  if (LIVE.watchdog) { clearInterval(LIVE.watchdog); LIVE.watchdog = null; }
  document.removeEventListener('visibilitychange', onLiveVisibility);
  window.removeEventListener('orientationchange', onLiveOrientation);
  LIVE.loopToken++;
  LIVE.drawRect = null;
  { const fb = document.getElementById('live-cam-frame'); if (fb) fb.style.display = 'none'; }
  if (LIVE.cstream) {
    LIVE.cstream.getTracks().forEach((t) => t.stop());
    LIVE.cstream = null;
  }
  LIVE.recStream = null;
  if (LIVE.recorder && LIVE.recorder.state !== 'inactive') {
    LIVE.recorder.onstop = null;
    try { LIVE.recorder.stop(); } catch (e) { /* already stopped */ }
  }
  LIVE.recorder = null;
  LIVE.recording = false;
  LIVE.armed = false;
  LIVE.torchOn = false;
  releaseLiveWakeLock();
  if (LIVE.stream) {
    LIVE.stream.getTracks().forEach((t) => t.stop());
    LIVE.stream = null;
  }
  const v = document.getElementById('live-video');
  if (v) { v.srcObject = null; v.removeEventListener('resize', onLiveVideoResize); }
}

async function requestLiveWakeLock() {
  try {
    if (navigator.wakeLock) LIVE.wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) { /* not available */ }
}

function releaseLiveWakeLock() {
  try { if (LIVE.wakeLock) LIVE.wakeLock.release(); } catch (e) { /* ignore */ }
  LIVE.wakeLock = null;
}

function setupLiveTorch() {
  const btn = $('#btn-torch');
  const hint = $('#live-torch-hint');
  const track = LIVE.stream && LIVE.stream.getVideoTracks()[0];
  const caps = track && track.getCapabilities ? track.getCapabilities() : {};
  const supported = Boolean(caps && caps.torch);
  btn.style.display = supported ? 'inline-flex' : 'none';
  btn.classList.remove('active');
  hint.style.display = supported ? 'none' : 'block';
}

// Start at the camera's normal 1x view, like the regular Camera app, where the phone allows it.
function setupLiveZoom() {
  const track = LIVE.stream && LIVE.stream.getVideoTracks()[0];
  const caps = track && track.getCapabilities ? track.getCapabilities() : {};
  if (caps && caps.zoom) {
    const z = Math.min(caps.zoom.max || 1, Math.max(caps.zoom.min || 1, 1));
    track.applyConstraints({ advanced: [{ zoom: z }] }).catch(() => {});
  }
}

async function toggleLiveTorch() {
  const track = LIVE.stream && LIVE.stream.getVideoTracks()[0];
  if (!track) return;
  const next = !LIVE.torchOn;
  try {
    await track.applyConstraints({ advanced: [{ torch: next }] });
    LIVE.torchOn = next;
    $('#btn-torch').classList.toggle('active', next);
  } catch (err) {
    console.warn('Torch not available:', err);
    $('#btn-torch').style.display = 'none';
    $('#live-torch-hint').style.display = 'block';
  }
}

// 'ready' | 'recording' | 'processing'
function setLiveControls(mode) {
  $('#btn-live-record').classList.toggle('recording', mode === 'recording');
  $('#btn-live-record').disabled = mode === 'processing';
  $('#live-tap-overlay').style.display = mode === 'recording' ? 'block' : 'none';
  $('#rec-badge').style.display = mode === 'recording' ? 'flex' : 'none';
  $('#live-controls').style.display = mode === 'processing' ? 'none' : 'flex';
  $('#live-processing').style.display = mode === 'processing' ? 'flex' : 'none';
  $('#live-record-label').textContent = mode === 'recording' ? 'Tap to stop' : 'Tap to start recording';
  if (mode !== 'recording') hideLiveHint();
}

function onLiveRecordToggle() {
  if (LIVE.recording) stopLiveRecording();
  else startLiveRecording();
}

function startLiveRecording() {
  if (!LIVE.stream) return;
  const mimeType = pickLiveMime();
  LIVE.chunks = [];
  try {
    LIVE.recorder = new MediaRecorder(LIVE.recStream || LIVE.stream, { mimeType, videoBitsPerSecond: LIVE_VIDEO_BPS, audioBitsPerSecond: LIVE_AUDIO_BPS });
  } catch (err) {
    console.warn('MediaRecorder failed to start:', err);
    alert('Could not start recording on this device. Use the Camera app instead.');
    return;
  }
  LIVE.recorder.ondataavailable = (e) => { if (e.data && e.data.size) LIVE.chunks.push(e.data); };
  LIVE.recorder.onstop = onLiveRecorderStopped;
  LIVE.recorder.start();
  LIVE.recording = true;
  LIVE.t0 = performance.now();
  state.defects = [];
  $('#live-defect-count').textContent = '';
  $('#rec-timer').textContent = '0:00';
  LIVE.timer = setInterval(() => { $('#rec-timer').textContent = fmtTime(liveElapsedSec()); }, 250);
  requestLiveWakeLock();
  setLiveControls('recording');
  hideLiveWarning();
  showLiveHint('Tap anywhere on the screen to mark a problem', 5000);
  LIVE.stalled = false;
  LIVE.watchdog = setInterval(() => {
    if (!LIVE.recording) return;
    const gap = performance.now() - LIVE.lastFrameAt;
    if (gap > 2500 && !LIVE.stalled) {
      LIVE.stalled = true;
      logLiveEvent(`preview video stalled (${(gap / 1000).toFixed(1)}s without a frame)`);
      showLiveWarning('Video stopped updating. Keep the lens uncovered. If it stays frozen, stop and record again.');
    } else if (gap < 1000 && LIVE.stalled) {
      LIVE.stalled = false;
      logLiveEvent('preview video resumed');
      hideLiveWarning();
    }
  }, 700);
  logLiveEvent('recording started');
}

function stopLiveRecording() {
  if (!LIVE.recorder || LIVE.recorder.state === 'inactive') return;
  LIVE.finalElapsed = liveElapsedSec();
  LIVE.recording = false;
  if (LIVE.timer) { clearInterval(LIVE.timer); LIVE.timer = null; }
  setLiveControls('processing');
  LIVE.recorder.stop();
}

async function onLiveRecorderStopped() {
  releaseLiveWakeLock();
  const mime = (LIVE.recorder && LIVE.recorder.mimeType) || 'video/mp4';
  const raw = new Blob(LIVE.chunks, { type: mime });
  LIVE.chunks = [];
  stopLiveCamera();

  // Safari's own file is the one thing that plays correctly, so it is kept exactly as recorded.
  // Edited copies (patched / rebuilt) are still available in the details panel for comparison.
  const diag = { used: 'original', rawInfo: '', patchedInfo: '', patchError: '', rawMime: mime, rawKB: Math.round(raw.size / 1024), picture: 'open this panel to measure', ready: false };
  state.liveDiag = diag;
  state.liveRawBlob = raw;
  state.livePatchedBlob = null;
  state.liveRebuiltBlob = null;
  diag.events = LIVE.events.slice();
  diag.liveFrames = LIVE.frames;
  await loadRecordedFile(new File([raw], 'walkaround.mp4', { type: 'video/mp4' }), LIVE.finalElapsed);
  renderRecordingDiag();
  const cut = await checkVideoCutShort(raw, LIVE.finalElapsed);
  const warn = document.getElementById('video-warning');
  if (warn) {
    if (cut) {
      warn.textContent = `Heads up: the picture stopped at ${fmtTime(cut.lastFrameAt)} but sound kept recording until ${fmtTime(cut.totalSec)}. The rest of this video will show a frozen frame. Please record again.`;
      warn.style.display = 'block';
    } else {
      warn.style.display = 'none';
    }
  }
}

async function fillDiagDetails() {
  const d = state.liveDiag;
  if (!d || d.ready) return;
  d.ready = true;
  d.rawInfo = await describeMp4(state.liveRawBlob);
  refreshDiagText();
  const current = state.liveRawBlob;
  if (current) measureFrameBrightness(current).then((r) => { d.picture = r; refreshDiagText(); });
}

/* ---- "Recording details" panel on the review screen ---- */

const PLAYER_EVENTS = [];

function logPlayerEvent(text) {
  const v = $('#record-video');
  PLAYER_EVENTS.push(`${v ? v.currentTime.toFixed(1) : '?'}s ${text}`);
  if (PLAYER_EVENTS.length > 14) PLAYER_EVENTS.shift();
  refreshDiagText();
}

function initPlayerEventLog() {
  const v = $('#record-video');
  ['error', 'stalled', 'waiting', 'ended', 'abort', 'emptied'].forEach((ev) => {
    v.addEventListener(ev, () => {
      const err = ev === 'error' && v.error ? ` code=${v.error.code} ${v.error.message || ''}` : '';
      logPlayerEvent(ev + err);
    });
  });
}

function refreshDiagText() {
  const el = $('#rec-diag-text');
  const d = state.liveDiag;
  if (!el || !d) return;
  el.textContent = [
    `Uploading: ${d.used}`,
    `Recorder format: ${d.rawMime} (${d.rawKB} KB)`,
    d.patchError ? `Patch error: ${d.patchError}` : '',
    `Picture: ${d.picture}`,
    '',
    'ORIGINAL FILE:', d.rawInfo,
    '',
    'PATCHED FILE:', d.patchedInfo,
    d.rebuiltInfo ? '' : '',
    d.rebuiltInfo ? 'REBUILT FILE:' : '', d.rebuiltInfo || '',
    d.keyInfo ? d.keyInfo : '',
    '',
    `Preview frames counted: ${d.liveFrames == null ? '-' : d.liveFrames}`,
    'RECORDING EVENTS:', (d.events && d.events.length ? d.events.join('\n') : '(none)'),
    '',
    'PLAYER EVENTS:', PLAYER_EVENTS.join('\n') || '(none)',
  ].filter((x) => x !== '').join('\n');
}

function renderRecordingDiag() {
  const box = $('#rec-diag');
  if (!box || !state.liveDiag) return;
  box.style.display = 'block';
  PLAYER_EVENTS.length = 0;
  refreshDiagText();
}

async function playDiagVersion(which) {
  let blob = null;
  if (which === 'raw') blob = state.liveRawBlob;
  else if (which === 'patched') {
    if (!state.livePatchedBlob && state.liveRawBlob) {
      try { state.livePatchedBlob = await patchMp4Durations(state.liveRawBlob); } catch (e) { alert('Could not build that version: ' + e.message); return; }
    }
    blob = state.livePatchedBlob;
  }
  else if (which === 'rebuilt') {
    if (!state.liveRebuiltBlob && state.liveRawBlob) {
      try {
        state.liveRebuiltBlob = await repairMp4(state.liveRawBlob);
        state.liveDiag.rebuiltInfo = await describeMp4(state.liveRebuiltBlob);
        state.liveDiag.keyInfo = `${REPAIR_STATS.video || ''}\nmatrix: ${REPAIR_STATS.matrix || ''}`;
      } catch (e) { alert('Could not build that version: ' + e.message); return; }
    }
    blob = state.liveRebuiltBlob;
  }
  if (!blob) { alert('That version is not available.'); return; }
  const v = $('#record-video');
  revokePreviewUrl();
  state.previewVideoUrl = URL.createObjectURL(blob);
  v.src = state.previewVideoUrl;
  state.recordedVideoBlob = new File([blob], 'walkaround.mp4', { type: 'video/mp4' });
  state.liveDiag.used = which === 'raw' ? 'original' : which === 'patched' ? 'patched original' : 'rebuilt';
  PLAYER_EVENTS.length = 0;
  logPlayerEvent(`switched to ${which}`);
  state.liveDiag.picture = 'checking…';
  measureFrameBrightness(blob).then((r) => { state.liveDiag.picture = `${which}: ${r}`; refreshDiagText(); });
  v.play().catch(() => {});
}

function showLiveWarning(text) {
  const el = document.getElementById('live-warning');
  if (el) { el.textContent = text; el.style.display = 'block'; }
}

function hideLiveWarning() {
  const el = document.getElementById('live-warning');
  if (el) el.style.display = 'none';
}

function onLiveVisibility() {
  logLiveEvent(`page ${document.visibilityState}`);
  if (document.visibilityState === 'hidden' && LIVE.recording) showLiveWarning('Recording was interrupted when the app left the screen.');
}

// Safari sometimes keeps recording sound after the picture has stopped. Look at the finished file
// and say so, instead of letting a half-recorded video go upload unnoticed.
async function checkVideoCutShort(blob, totalSec) {
  try {
    const buf = await blob.arrayBuffer();
    buf.fileStart = 0;
    const f = MP4Box.createFile();
    let info = null;
    f.onError = () => {};
    f.onReady = (i) => { info = i; };
    f.appendBuffer(buf);
    f.flush();
    if (!info) return null;
    const vt = info.tracks.find((t) => t.video);
    if (!vt) return null;
    const list = f.getTrackSamplesInfo(vt.id) || [];
    if (!list.length) return null;
    const last = list[list.length - 1];
    const lastFrameAt = last.dts / vt.timescale;
    const frames = list.length;
    if (totalSec - lastFrameAt > 3) return { lastFrameAt, totalSec, frames };
    return null;
  } catch (e) {
    return null;
  }
}

/* ---- marking a problem while recording ---- */

let liveHintTimer = null;

function showLiveHint(text, ms) {
  const h = document.getElementById('live-arm-hint');
  if (!h) return;
  h.textContent = text;
  h.style.display = 'block';
  if (liveHintTimer) clearTimeout(liveHintTimer);
  liveHintTimer = setTimeout(() => { h.style.display = 'none'; }, ms);
}

function hideLiveHint() {
  if (liveHintTimer) { clearTimeout(liveHintTimer); liveHintTimer = null; }
  const h = document.getElementById('live-arm-hint');
  if (h) h.style.display = 'none';
}

// The recording canvas is shown with object-fit: cover, so map a tap onto the canvas picture.
function liveCanvasRect() {
  const cv = LIVE.canvas;
  const r = cv.getBoundingClientRect();
  const scale = Math.max(r.width / cv.width, r.height / cv.height);
  const w = cv.width * scale;
  const h = cv.height * scale;
  return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, width: w, height: h };
}

// Map a tap on the screen onto the full camera picture, including any part that is cropped off
// screen in Wide / Fill mode.
function liveContentRect(video) {
  const r = video.getBoundingClientRect();
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return r;
  const sc = liveScales(video);
  const mode = LIVE.fitMode || 'wide';
  const scale = sc[mode === 'fit' ? 'contain' : mode === 'fill' ? 'cover' : 'wide'];
  const w = vw * scale;
  const h = vh * scale;
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  return { left: cx - w / 2, top: cy - h / 2, width: w, height: h };
}

// Where the real camera picture sits on the screen (the black bars around it are not part of it).
function liveCameraScreenRect() {
  const wrap = document.querySelector('.live-video-wrap');
  if (!wrap) return null;
  const wr = wrap.getBoundingClientRect();
  let r;
  if (LIVE.canvasMode && LIVE.canvas && LIVE.drawRect) {
    const cr = liveCanvasRect();
    const k = cr.width / LIVE.canvas.width;
    const d = LIVE.drawRect;
    r = { left: cr.left + d.x * k, top: cr.top + d.y * k, width: d.w * k, height: d.h * k };
  } else {
    const video = $('#live-video');
    if (!video || !video.videoWidth) return null;
    r = liveContentRect(video);
  }
  // only the part that is actually visible on screen
  const left = Math.max(r.left, wr.left);
  const top = Math.max(r.top, wr.top);
  const right = Math.min(r.left + r.width, wr.right);
  const bottom = Math.min(r.top + r.height, wr.bottom);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top, wrap: wr };
}

// Thin outline around the camera picture so the driver can see where tapping marks a problem.
function updateLiveFrameBox() {
  const wrap = document.querySelector('.live-video-wrap');
  if (!wrap) return;
  let box = document.getElementById('live-cam-frame');
  if (!box) {
    box = document.createElement('div');
    box.id = 'live-cam-frame';
    box.className = 'live-cam-frame';
    wrap.appendChild(box);
  }
  const r = liveCameraScreenRect();
  if (!r) { box.style.display = 'none'; return; }
  box.style.display = 'block';
  box.style.left = (r.left - r.wrap.left) + 'px';
  box.style.top = (r.top - r.wrap.top) + 'px';
  box.style.width = r.width + 'px';
  box.style.height = r.height + 'px';
}

function onLiveTapOverlay(e) {
  if (!LIVE.recording) return;
  const nowMs = performance.now();
  if (LIVE.lastMarkAt && nowMs - LIVE.lastMarkAt < 700) return;
  const video = LIVE.canvasMode && LIVE.canvas ? LIVE.canvas : $('#live-video');
  const overlay = $('#live-tap-overlay');
  const rect = LIVE.canvasMode && LIVE.canvas ? liveCanvasRect() : liveContentRect(video);
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  // Taps on the black bars (outside the camera picture) do nothing.
  const cam = liveCameraScreenRect();
  if (!cam || clientX < cam.left || clientX > cam.left + cam.width || clientY < cam.top || clientY > cam.top + cam.height) return;
  LIVE.lastMarkAt = nowMs;
  const xPct = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  const yPct = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));

  playShutterSound();
  const ob = overlay.getBoundingClientRect();
  const dot = document.createElement('div');
  dot.className = 'marker-dot';
  dot.style.left = (clientX - ob.left) + 'px';
  dot.style.top = (clientY - ob.top) + 'px';
  overlay.appendChild(dot);
  setTimeout(() => dot.remove(), 550);

  capturePhotoWithMarker(xPct, yPct, video, liveElapsedSec());
  $('#live-defect-count').textContent = `${state.defects.length} problem${state.defects.length === 1 ? '' : 's'} marked`;
  showLiveHint(`Marked at ${fmtTime(liveElapsedSec())}`, 1500);
}
