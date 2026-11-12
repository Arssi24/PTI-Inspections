/* In-app HD recorder: live camera preview, record button, flashlight, and a "Mark a Problem"
   button usable while recording. The raw MediaRecorder file is rebuilt into a proper seekable
   MP4 (see mp4Repair.js) and checked before it goes to the review screen. */

const LIVE_VIDEO_BPS = 6000000;
const LIVE_AUDIO_BPS = 128000;
const LIVE = {
  stream: null, recorder: null, chunks: [], t0: 0, timer: null,
  recording: false, armed: false, torchOn: false, wakeLock: null, finalElapsed: 0,
};

function pickLiveMime() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  const candidates = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4'];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
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
  try {
    LIVE.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
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
  v.srcObject = LIVE.stream;
  try { await v.play(); } catch (e) { /* autoplay handled by attribute */ }
  setupLiveTorch();
  setLiveControls('ready');
  try {
    const s = LIVE.stream.getVideoTracks()[0].getSettings();
    const info = $('#live-cam-info');
    info.className = 'video-info' + (Math.min(s.width || 0, s.height || 0) < 1000 ? ' video-info-low' : '');
    info.textContent = `Camera: ${Math.max(s.width || 0, s.height || 0)}×${Math.min(s.width || 0, s.height || 0)}${s.frameRate ? ' @ ' + Math.round(s.frameRate) + ' fps' : ''}`;
  } catch (e) { /* settings unavailable */ }
  return true;
}

function stopLiveCamera() {
  if (LIVE.timer) { clearInterval(LIVE.timer); LIVE.timer = null; }
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
  $('#btn-live-mark').disabled = mode !== 'recording';
  $('#rec-badge').style.display = mode === 'recording' ? 'flex' : 'none';
  $('#live-controls').style.display = mode === 'processing' ? 'none' : 'flex';
  $('#live-processing').style.display = mode === 'processing' ? 'block' : 'none';
  $('#live-record-label').textContent = mode === 'recording' ? 'Tap to stop' : 'Tap to start recording';
  if (mode !== 'recording') disarmLiveMark();
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

  let chosen = null;
  let rebuilt = null;
  const diag = { used: '', rawInfo: '', rebuiltInfo: '', rebuiltCheck: 'not run', rawCheck: 'not run', rebuildError: '', rawMime: mime, rawKB: Math.round(raw.size / 1024) };
  try {
    rebuilt = await repairMp4(raw);
    const check = await verifyPlayable(rebuilt);
    diag.rebuiltCheck = JSON.stringify(check);
    // A timeout is inconclusive (some browsers won't preload an unattached video), not a failure.
    if (check.ok || check.reason === 'timeout') chosen = rebuilt;
    else console.warn('Rebuilt video failed playback check', check);
  } catch (err) {
    console.warn('Video rebuild failed:', err);
    diag.rebuildError = String(err && err.message ? err.message : err);
  }
  if (!chosen) {
    const rawCheck = await verifyPlayable(raw);
    diag.rawCheck = JSON.stringify(rawCheck);
    if (rawCheck.ok) chosen = raw;
  }
  if (!chosen) {
    const keep = confirm("We couldn't confirm this recording will play back properly. Press OK to keep it anyway, or Cancel to discard it and record again.");
    if (!keep) { enterRecordScreen(); return; }
    chosen = rebuilt || raw;
  }
  diag.used = chosen === rebuilt ? 'rebuilt' : 'original';
  diag.rawInfo = await describeMp4(raw);
  diag.rebuiltInfo = rebuilt ? await describeMp4(rebuilt) : '(none)';
  diag.keyInfo = REPAIR_STATS.video || '';
  diag.picture = 'checking…';
  state.liveDiag = diag;
  state.liveRawBlob = raw;
  state.liveRebuiltBlob = rebuilt;
  state.liveRebuiltNoAudio = null;
  await loadRecordedFile(new File([chosen], 'walkaround.mp4', { type: 'video/mp4' }));
  renderRecordingDiag();
  measureFrameBrightness(chosen).then((r) => { diag.picture = r; refreshDiagText(); });
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
    d.rebuildError ? `Rebuild error: ${d.rebuildError}` : `Rebuilt check: ${d.rebuiltCheck}`,
    d.rawCheck !== 'not run' ? `Original check: ${d.rawCheck}` : '',
    `Key frames: ${d.keyInfo}`,
    `Picture: ${d.picture}`,
    '',
    'ORIGINAL FILE:', d.rawInfo,
    '',
    'REBUILT FILE:', d.rebuiltInfo,
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
  let blob = which === 'raw' ? state.liveRawBlob : state.liveRebuiltBlob;
  if (which === 'noaudio') {
    if (!state.liveRebuiltNoAudio && state.liveRawBlob) {
      try { state.liveRebuiltNoAudio = await repairMp4(state.liveRawBlob, { noAudio: true }); } catch (e) { alert('Could not build that version: ' + e.message); return; }
    }
    blob = state.liveRebuiltNoAudio;
  }
  if (!blob) { alert('That version is not available.'); return; }
  const v = $('#record-video');
  revokePreviewUrl();
  state.previewVideoUrl = URL.createObjectURL(blob);
  v.src = state.previewVideoUrl;
  state.recordedVideoBlob = new File([blob], 'walkaround.mp4', { type: 'video/mp4' });
  state.liveDiag.used = which === 'raw' ? 'original' : which === 'noaudio' ? 'rebuilt (no audio)' : 'rebuilt';
  PLAYER_EVENTS.length = 0;
  logPlayerEvent(`switched to ${which}`);
  state.liveDiag.picture = 'checking…';
  measureFrameBrightness(blob).then((r) => { state.liveDiag.picture = `${which}: ${r}`; refreshDiagText(); });
  v.play().catch(() => {});
}

/* ---- marking a problem while recording ---- */

function onLiveMarkToggle() {
  if (!LIVE.recording) return;
  if (LIVE.armed) { disarmLiveMark(); return; }
  LIVE.armed = true;
  $('#btn-live-mark').classList.add('active');
  $('#live-arm-hint').style.display = 'block';
  $('#live-tap-overlay').style.display = 'block';
}

function disarmLiveMark() {
  LIVE.armed = false;
  const b = document.getElementById('btn-live-mark');
  if (b) b.classList.remove('active');
  const h = document.getElementById('live-arm-hint');
  if (h) h.style.display = 'none';
  const o = document.getElementById('live-tap-overlay');
  if (o) o.style.display = 'none';
}

// The video is letterboxed inside its element (object-fit: contain), so map the tap onto the
// real picture area, not the element box.
function liveContentRect(video) {
  const r = video.getBoundingClientRect();
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return r;
  const scale = Math.min(r.width / vw, r.height / vh);
  const w = vw * scale;
  const h = vh * scale;
  return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, width: w, height: h };
}

function onLiveTapOverlay(e) {
  if (!LIVE.armed || !LIVE.recording) return;
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
  disarmLiveMark();
}
