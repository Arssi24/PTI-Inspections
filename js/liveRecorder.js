/* In-app HD recorder: live camera preview, record button, flashlight, and a "Mark a Problem"
   button usable while recording. The raw MediaRecorder file is rebuilt into a proper seekable
   MP4 (see mp4Repair.js) and checked before it goes to the review screen. */

const LIVE_VIDEO_BPS = 6000000;
const LIVE_AUDIO_BPS = 128000;
const LIVE = {
  stream: null, recorder: null, chunks: [], t0: 0, timer: null,
  recording: false, armed: false, torchOn: false, wakeLock: null, finalElapsed: 0,
  frames: 0, lastFrameAt: 0, watchdog: null, stalled: false, events: [],
};

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
  if (v) {
    const sc = liveScales(v);
    const k = sc[mode === 'fit' ? 'contain' : mode === 'fill' ? 'cover' : 'wide'] / sc.contain;
    v.style.transform = k > 1.001 ? `scale(${k.toFixed(4)})` : '';
  }
  const label = document.getElementById('live-fit-label');
  if (label) label.textContent = FIT_LABELS[mode];
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
  const vtrack = LIVE.stream.getVideoTracks()[0];
  if (vtrack) {
    vtrack.addEventListener('mute', () => { logLiveEvent('camera track MUTED'); showLiveWarning('The camera stopped sending video. Keep the phone steady and the lens uncovered.'); });
    vtrack.addEventListener('unmute', () => { logLiveEvent('camera track unmuted'); });
    vtrack.addEventListener('ended', () => { logLiveEvent('camera track ENDED'); showLiveWarning('The camera stopped. Stop recording and start again.'); });
  }
  const countFrame = () => {
    LIVE.frames++;
    LIVE.lastFrameAt = performance.now();
    if (LIVE.stream && v.requestVideoFrameCallback) v.requestVideoFrameCallback(countFrame);
  };
  if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(countFrame);
  document.addEventListener('visibilitychange', onLiveVisibility);
  try {
    const s = LIVE.stream.getVideoTracks()[0].getSettings();
    const info = $('#live-cam-info');
    info.className = 'video-info' + (Math.min(s.width || 0, s.height || 0) < 1000 ? ' video-info-low' : '');
    info.textContent = `Camera ${s.width || '?'}×${s.height || '?'}${s.frameRate ? ' @ ' + Math.round(s.frameRate) + ' fps' : ''} · preview ${v.videoWidth || '?'}×${v.videoHeight || '?'}`;
  } catch (e) { /* settings unavailable */ }
  return true;
}

function stopLiveCamera() {
  if (LIVE.timer) { clearInterval(LIVE.timer); LIVE.timer = null; }
  if (LIVE.watchdog) { clearInterval(LIVE.watchdog); LIVE.watchdog = null; }
  document.removeEventListener('visibilitychange', onLiveVisibility);
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
  if (v) v.srcObject = null;
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
    LIVE.recorder = new MediaRecorder(LIVE.stream, { mimeType, videoBitsPerSecond: LIVE_VIDEO_BPS, audioBitsPerSecond: LIVE_AUDIO_BPS });
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

function onLiveTapOverlay(e) {
  if (!LIVE.recording) return;
  const nowMs = performance.now();
  if (LIVE.lastMarkAt && nowMs - LIVE.lastMarkAt < 700) return;
  LIVE.lastMarkAt = nowMs;
  const video = $('#live-video');
  const overlay = $('#live-tap-overlay');
  const rect = liveContentRect(video);
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
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
