/* PTI Inspections
   Backend: Supabase (Postgres + Auth + Storage) — see supabase/schema.sql and js/supabaseClient.js.
   Every fleet's data is isolated by Row Level Security, keyed on fleet_code. */

const MIN_SECONDS = { PTI: 4 * 60, HOOK: 60, DROP: 60 };

const state = {
  role: 'driver',
  signupRole: 'driver',
  userId: null,
  driverName: '',
  driverEmail: '',
  driverPhone: '',
  fleetCode: '',
  unitKind: 'truck',
  currentType: null,
  currentUnit: null,
  currentLocation: null,
  scanTargetTitle: '',
  recorder: null,
  recordedChunks: [],
  stream: null,
  scanStream: null,
  scanLoopHandle: null,
  timerHandle: null,
  startedAt: null,
  elapsedSec: 0,
  defects: [],
  finalDurationSec: 0,
  dashRange: 'today',
  dashDriver: '',
  dashType: '',
  dashUnit: '',
  dashKnownDrivers: [],
  dashKnownUnits: [],
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function showScreen(id) {
  $$('.screen').forEach((s) => s.classList.remove('active'));
  const el = document.getElementById(id);
  el.classList.add('active');
  window.scrollTo(0, 0);
}

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function fmtWhen(ts) {
  const d = new Date(ts);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/* ---------------- searchable combobox (driver / unit filters) ---------------- */

function setupCombobox({ inputEl, listEl, getOptions, onSelect }) {
  function render(query) {
    const q = query.trim().toLowerCase();
    const options = getOptions().filter((o) => o.toLowerCase().includes(q));
    let html = '<div class="combo-option combo-all" data-value="">Show all</div>';
    if (options.length === 0) {
      html += '<div class="combo-option combo-empty">No matches</div>';
    } else {
      html += options.map((o) => `<div class="combo-option" data-value="${escapeHtml(o)}">${escapeHtml(o)}</div>`).join('');
    }
    listEl.innerHTML = html;
    listEl.classList.add('show');
  }

  inputEl.addEventListener('focus', () => render(inputEl.value));
  inputEl.addEventListener('input', () => {
    render(inputEl.value);
    if (inputEl.value.trim() === '') onSelect('');
  });
  inputEl.addEventListener('blur', () => {
    setTimeout(() => listEl.classList.remove('show'), 150);
  });
  listEl.addEventListener('mousedown', (e) => {
    const opt = e.target.closest('.combo-option');
    if (!opt || opt.classList.contains('combo-empty')) return;
    e.preventDefault();
    const val = opt.dataset.value || '';
    inputEl.value = val;
    onSelect(val);
    listEl.classList.remove('show');
  });
}

/* ---------------- init ---------------- */

document.addEventListener('DOMContentLoaded', init);

async function init() {
  if (!SUPABASE_READY) {
    $('.demo-note').innerHTML = '<strong>Supabase is not configured yet.</strong> Fill in <code>js/supabase-config.js</code> with your project URL and anon key (Supabase dashboard → Settings → API), then reload.';
    $('.demo-note').style.background = '#fdeaea';
    $('.demo-note').style.borderColor = '#f3c6c6';
  }

  // A password-recovery link creates a real (temporary) session, so it'd otherwise sail
  // straight past this screen via tryAutoLogin() below and land on home/dashboard instead
  // of letting the user actually set a new password. Catch it two ways: the URL Supabase
  // redirects back with (belt), and the auth event it fires once detected (suspenders).
  const isRecoveryLink = window.location.hash.includes('type=recovery') || window.location.search.includes('type=recovery');
  if (SUPABASE_READY) {
    sbOnAuthEvent((event) => {
      if (event === 'PASSWORD_RECOVERY') showScreen('screen-set-new-password');
    });
  }
  if (isRecoveryLink) {
    showScreen('screen-set-new-password');
  }

  $$('.auth-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.auth-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const which = tab.dataset.tab;
      $('#tab-signup').style.display = which === 'signup' ? 'block' : 'none';
      $('#tab-login').style.display = which === 'login' ? 'block' : 'none';
    });
  });

  $$('#tab-signup .role-toggle .role-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('#tab-signup .role-toggle .role-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.signupRole = btn.dataset.role;
      $('#signup-fleet-code-field').style.display = state.signupRole === 'driver' ? 'block' : 'none';
      $('#signup-fleet-code-hint').style.display = state.signupRole === 'manager' ? 'block' : 'none';
    });
  });

  $$('#panel-units .role-toggle .kind-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('#panel-units .role-toggle .kind-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.unitKind = btn.dataset.kind;
    });
  });

  $$('.dash-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.dash-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      $$('.dash-panel').forEach((p) => p.classList.remove('active'));
      $(`#panel-${tab.dataset.panel}`).classList.add('active');
      if (tab.dataset.panel === 'units') renderUnitsList();
      if (tab.dataset.panel === 'inspections') renderDashboard();
    });
  });

  $('#btn-add-unit').addEventListener('click', onAddUnit);

  $('#btn-signup').addEventListener('click', onSignup);
  $('#btn-login').addEventListener('click', onLoginSubmit);
  $('#btn-show-forgot-password').addEventListener('click', () => showScreen('screen-forgot-password'));
  $('#btn-send-reset').addEventListener('click', onForgotPasswordSubmit);
  $('#btn-set-new-password').addEventListener('click', onSetNewPasswordSubmit);
  $('#btn-logout').addEventListener('click', logout);
  $('#btn-logout-dash').addEventListener('click', logout);
  $('#btn-history').addEventListener('click', openHistory);

  $$('.mode-card').forEach((card) => {
    card.addEventListener('click', () => startFlow(card.dataset.type));
  });

  $$('[data-back]').forEach((btn) => {
    btn.addEventListener('click', () => {
      stopScanLoop();
      stopCameraStream();
      showScreen(btn.dataset.back);
    });
  });

  $('#btn-manual-submit').addEventListener('click', onManualUnitSubmit);
  $('#btn-record-toggle').addEventListener('click', onRecordToggle);
  $('#btn-retake').addEventListener('click', onRetake);
  $('#btn-save-upload').addEventListener('click', onSaveUpload);

  $('#record-video').parentElement.querySelector('#marker-layer').addEventListener('click', onTapFlag);
  $('.record-stage').addEventListener('click', onTapFlag);

  $$('#filter-time .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      $$('#filter-time .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      state.dashRange = chip.dataset.range;
      renderDashboard();
    });
  });
  $('#filter-type').addEventListener('change', (e) => { state.dashType = e.target.value; renderDashboard(); });

  setupCombobox({
    inputEl: $('#filter-driver-input'),
    listEl: $('#filter-driver-list'),
    getOptions: () => state.dashKnownDrivers || [],
    onSelect: (val) => { state.dashDriver = val; renderDashboard(); },
  });
  setupCombobox({
    inputEl: $('#filter-unit-input'),
    listEl: $('#filter-unit-list'),
    getOptions: () => state.dashKnownUnits || [],
    onSelect: (val) => { state.dashUnit = val; renderDashboard(); },
  });

  if (isRecoveryLink) return;

  let loggedIn = false;
  try {
    loggedIn = await tryAutoLogin();
  } catch (err) {
    console.error('Auto-login check failed:', err);
  }
  if (!loggedIn) showScreen('screen-login');
}

/* ---------------- auth ---------------- */

function showAuthError(el, msg) {
  el.textContent = msg;
  el.style.display = 'block';
}

async function onSignup() {
  const name = $('#signup-name').value.trim();
  const email = $('#signup-email').value.trim().toLowerCase();
  const phone = $('#signup-phone').value.trim();
  const password = $('#signup-password').value;
  const role = state.signupRole;
  const errEl = $('#signup-error');
  errEl.style.display = 'none';

  if (!name || !email || !password) {
    showAuthError(errEl, 'Fill in your name, email, and password.');
    return;
  }
  if (password.length < 6) {
    showAuthError(errEl, 'Password must be at least 6 characters.');
    return;
  }

  let fleetCode = null;
  if (role === 'driver') {
    const entered = $('#signup-fleet-code').value.trim();
    if (!entered) {
      showAuthError(errEl, 'Enter the fleet access code your fleet manager gave you.');
      return;
    }
    let fleet;
    try {
      fleet = await sbFindFleetByCode(entered);
    } catch (err) {
      showAuthError(errEl, 'Could not verify that code — try again.');
      return;
    }
    if (!fleet) {
      showAuthError(errEl, 'Invalid access code — check with your fleet manager.');
      return;
    }
    fleetCode = fleet.code;
  }

  const btn = $('#btn-signup');
  btn.disabled = true;
  try {
    // Profile (and fleet, for managers) are created server-side by the handle_new_user()
    // DB trigger — see supabase/schema.sql — from this metadata. That's what lets signup
    // work correctly whether or not "Confirm email" is turned on: the trigger runs inside
    // the same transaction as the auth.users insert, before any client session exists.
    const { data, error } = await sbSignUp(email, password, { name, phone, role, fleet_code: fleetCode });
    if (error) {
      showAuthError(errEl, error.message);
      return;
    }
    if (!data.session) {
      showCheckEmailScreen('Click the confirmation link we just emailed you, then come back and log in.');
      return;
    }
    const profile = await sbGetProfile(data.user.id);
    if (!profile) {
      showAuthError(errEl, 'Account created — give it a few seconds and try logging in.');
      return;
    }
    await loginAs(profile);
  } finally {
    btn.disabled = false;
  }
}

function showCheckEmailScreen(message) {
  $('#check-email-message').textContent = message;
  showScreen('screen-check-email');
}

function currentSiteUrl() {
  return window.location.origin + window.location.pathname;
}

async function onForgotPasswordSubmit() {
  const email = $('#forgot-email').value.trim().toLowerCase();
  const errEl = $('#forgot-error');
  errEl.style.display = 'none';
  if (!email) {
    showAuthError(errEl, 'Enter your email first.');
    return;
  }
  const btn = $('#btn-send-reset');
  btn.disabled = true;
  try {
    const { error } = await sbSendPasswordReset(email, currentSiteUrl());
    if (error) {
      showAuthError(errEl, error.message);
      return;
    }
    showCheckEmailScreen("If that email has an account, we've sent a password reset link to it.");
  } finally {
    btn.disabled = false;
  }
}

async function onSetNewPasswordSubmit() {
  const password = $('#new-password').value;
  const errEl = $('#new-password-error');
  errEl.style.display = 'none';
  if (password.length < 6) {
    showAuthError(errEl, 'Password must be at least 6 characters.');
    return;
  }
  const btn = $('#btn-set-new-password');
  btn.disabled = true;
  try {
    const { error } = await sbUpdatePassword(password);
    if (error) {
      showAuthError(errEl, error.message);
      return;
    }
    const user = await sbGetSessionUser();
    const profile = user ? await sbGetProfile(user.id) : null;
    if (profile) {
      await loginAs(profile);
    } else {
      showScreen('screen-login');
    }
  } finally {
    btn.disabled = false;
  }
}

async function onLoginSubmit() {
  const email = $('#login-email').value.trim().toLowerCase();
  const password = $('#login-password').value;
  const errEl = $('#login-error');
  errEl.style.display = 'none';

  const btn = $('#btn-login');
  btn.disabled = true;
  try {
    const { data, error } = await sbSignIn(email, password);
    if (error) {
      showAuthError(errEl, 'Email or password not recognized.');
      return;
    }
    const profile = await sbGetProfile(data.user.id);
    if (!profile) {
      showAuthError(errEl, 'Account found but profile is missing — contact support.');
      return;
    }
    await loginAs(profile);
  } finally {
    btn.disabled = false;
  }
}

async function tryAutoLogin() {
  const user = await sbGetSessionUser();
  if (!user) return false;
  const profile = await sbGetProfile(user.id);
  if (!profile) return false;
  await loginAs(profile);
  return true;
}

async function loginAs(profile) {
  state.userId = profile.id;
  state.driverName = profile.name;
  state.driverEmail = profile.email;
  state.driverPhone = profile.phone || '';
  state.role = profile.role;
  state.fleetCode = profile.fleet_code;

  if (profile.role === 'driver') {
    $('#home-driver-name').textContent = profile.name.split(' ')[0];
    showScreen('screen-home');
  } else {
    $('#fleet-code-value').textContent = profile.fleet_code;
    state.dashDriver = '';
    state.dashUnit = '';
    state.dashType = '';
    $('#filter-driver-input').value = '';
    $('#filter-unit-input').value = '';
    $('#filter-type').value = '';
    showScreen('screen-dashboard');
    renderDashboard();
  }
}

async function logout() {
  await sbSignOut();
  showScreen('screen-login');
}

/* ---------------- driver flow: pick type -> scan -> record ---------------- */

function startFlow(type) {
  state.currentType = type;
  state.scanTargetTitle = type === 'PTI' ? 'Scan unit for Pre-Trip Inspection'
    : type === 'HOOK' ? 'Scan trailer to Hook'
    : 'Scan trailer to Drop';
  $('#scan-title').textContent = state.scanTargetTitle;
  showScreen('screen-scan');
  startScanCamera();
}

async function startScanCamera() {
  const video = $('#scan-video');
  try {
    state.scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = state.scanStream;
    await video.play();
    scanLoop();
  } catch (err) {
    console.warn('Camera unavailable, manual entry only:', err);
  }
}

function scanLoop() {
  const video = $('#scan-video');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  function tick() {
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = window.jsQR ? jsQR(imageData.data, imageData.width, imageData.height) : null;
      if (code && code.data) {
        onUnitScanned(code.data.trim());
        return;
      }
    }
    state.scanLoopHandle = requestAnimationFrame(tick);
  }
  state.scanLoopHandle = requestAnimationFrame(tick);
}

function stopScanLoop() {
  if (state.scanLoopHandle) cancelAnimationFrame(state.scanLoopHandle);
  state.scanLoopHandle = null;
  if (state.scanStream) {
    state.scanStream.getTracks().forEach((t) => t.stop());
    state.scanStream = null;
  }
}

function onManualUnitSubmit() {
  const val = $('#manual-unit').value.trim();
  if (!val) return;
  onUnitScanned(val);
}

function onUnitScanned(unitCode) {
  stopScanLoop();
  state.currentUnit = unitCode;
  $('#manual-unit').value = '';
  enterRecordScreen();
}

/* ---------------- recording screen ---------------- */

async function enterRecordScreen() {
  showScreen('screen-record');
  $('#record-type-badge').textContent = state.currentType;
  $('#record-unit-badge').textContent = state.currentUnit;
  $('#record-min-req').textContent = `min ${fmtTime(MIN_SECONDS[state.currentType])}`;
  $('#record-timer').textContent = '0:00';
  $('#controls-live').style.display = 'flex';
  $('#controls-stopped').style.display = 'none';
  $('#btn-record-toggle').classList.remove('recording');
  $('#btn-record-toggle').disabled = false;
  $('#camera-warning').style.display = 'none';
  $('#defect-count-wrap').style.visibility = 'hidden';
  $('#defect-count').textContent = '0';
  $('#tap-hint').style.display = 'block';
  $('#marker-layer').innerHTML = '';
  state.defects = [];
  state.recordedChunks = [];
  state.elapsedSec = 0;
  state.currentLocation = null;
  captureLocation();

  const video = $('#record-video');
  $('#camera-warning').style.display = 'none';
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: true,
    });
    video.srcObject = state.stream;
    await video.play();
  } catch (err) {
    console.warn('Camera/mic permission denied:', err);
    $('#tap-hint').style.display = 'none';
    $('#camera-warning').style.display = 'block';
    $('#btn-record-toggle').disabled = true;
  }
}

function captureLocation() {
  const label = $('#record-location-text');
  label.textContent = 'Locating…';
  if (!navigator.geolocation) {
    label.textContent = 'Location unavailable on this device';
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.currentLocation = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracyM: Math.round(pos.coords.accuracy),
      };
      label.textContent = `Location captured (±${state.currentLocation.accuracyM}m)`;
    },
    (err) => {
      console.warn('Location denied/unavailable:', err);
      state.currentLocation = null;
      label.textContent = 'Location permission denied';
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
  );
}

function pickMimeType() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4',
  ];
  for (const c of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) return c;
  }
  return '';
}

function onRecordToggle() {
  const btn = $('#btn-record-toggle');
  const isRecording = btn.classList.contains('recording');
  if (!isRecording) {
    startRecording();
    btn.classList.add('recording');
  } else {
    stopRecording();
  }
}

function startRecording() {
  if (!state.stream) return;
  const mimeType = pickMimeType();
  try {
    state.recorder = mimeType ? new MediaRecorder(state.stream, { mimeType }) : new MediaRecorder(state.stream);
  } catch (err) {
    state.recorder = new MediaRecorder(state.stream);
  }
  state.recordedChunks = [];
  state.recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) state.recordedChunks.push(e.data); };
  state.recorder.start(500);

  state.startedAt = Date.now();
  state.elapsedSec = 0;
  state.timerHandle = setInterval(() => {
    state.elapsedSec = (Date.now() - state.startedAt) / 1000;
    $('#record-timer').textContent = fmtTime(state.elapsedSec);
  }, 200);
}

function stopRecording() {
  clearInterval(state.timerHandle);
  state.finalDurationSec = state.elapsedSec;
  $('#btn-record-toggle').classList.remove('recording');

  if (state.recorder && state.recorder.state !== 'inactive') {
    state.recorder.stop();
  }

  $('#controls-live').style.display = 'none';
  $('#tap-hint').style.display = 'none';
  $('#controls-stopped').style.display = 'block';

  const min = MIN_SECONDS[state.currentType];
  const tooShort = state.finalDurationSec < min;
  $('#min-warning').style.display = tooShort ? 'block' : 'none';
  $('#btn-save-upload').disabled = tooShort;

  stopCameraStream();
}

function stopCameraStream() {
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
}

function onRetake() {
  enterRecordScreen();
}

function onTapFlag(e) {
  const btn = $('#btn-record-toggle');
  if (!btn.classList.contains('recording')) return;

  const stage = document.querySelector('.record-stage');
  const rect = stage.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const xPct = x / rect.width;
  const yPct = y / rect.height;

  const dot = document.createElement('div');
  dot.className = 'marker-dot';
  dot.style.left = x + 'px';
  dot.style.top = y + 'px';
  $('#marker-layer').appendChild(dot);
  setTimeout(() => dot.remove(), 4000);

  capturePhotoWithMarker(xPct, yPct);
}

function capturePhotoWithMarker(xPct, yPct) {
  const video = $('#record-video');
  if (!video.videoWidth || !video.videoHeight) return;
  const canvas = $('#record-canvas');
  const w = video.videoWidth;
  const h = video.videoHeight;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, w, h);

  const px = xPct * w;
  const py = yPct * h;
  const r = Math.max(w, h) * 0.035;
  ctx.lineWidth = Math.max(4, r * 0.18);
  ctx.strokeStyle = '#e0332f';
  ctx.beginPath();
  ctx.arc(px, py, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = ctx.lineWidth + 3;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath();
  ctx.arc(px, py, r + ctx.lineWidth, 0, Math.PI * 2);
  ctx.globalCompositeOperation = 'destination-over';
  ctx.globalCompositeOperation = 'source-over';

  const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
  state.defects.push({ id: 'd_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7), t: state.elapsedSec, x: xPct, y: yPct, photo: dataUrl });

  $('#defect-count-wrap').style.visibility = 'visible';
  $('#defect-count').textContent = state.defects.length;
}

function newId() {
  return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('id_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10));
}

async function onSaveUpload() {
  const type = state.currentType;
  const unit = state.currentUnit;
  const driverName = state.driverName;
  const driverEmail = state.driverEmail;
  const driverPhone = state.driverPhone;
  const fleetCode = state.fleetCode;
  const location = state.currentLocation;
  const durationSec = Math.round(state.finalDurationSec);
  const defectsRaw = state.defects;
  const mimeType = state.recorder && state.recorder.mimeType ? state.recorder.mimeType : 'video/webm';
  const chunks = state.recordedChunks.slice();
  const id = newId();

  showToast();
  showScreen('screen-home');

  try {
    const videoBlob = new Blob(chunks, { type: mimeType });
    const videoExt = mimeType.includes('mp4') ? 'mp4' : 'webm';
    const videoPath = `${fleetCode}/${id}/video.${videoExt}`;
    await sbUploadBlob(videoPath, videoBlob);

    const defects = [];
    for (let i = 0; i < defectsRaw.length; i++) {
      const d = defectsRaw[i];
      const photoPath = `${fleetCode}/${id}/defect-${i}.jpg`;
      await sbUploadDataUrl(photoPath, d.photo);
      defects.push({ id: d.id, t: d.t, x: d.x, y: d.y, photo_path: photoPath });
    }

    const { error } = await sbInsertInspection({
      id,
      type,
      unit,
      driver_id: state.userId,
      driver_name: driverName,
      driver_email: driverEmail,
      driver_phone: driverPhone,
      fleet_code: fleetCode,
      duration_sec: durationSec,
      defects,
      video_path: videoPath,
      lat: location ? location.lat : null,
      lng: location ? location.lng : null,
      location_accuracy_m: location ? location.accuracyM : null,
    });
    if (error) throw error;
  } catch (err) {
    console.error('Upload failed', err);
  } finally {
    finishToast();
  }
}

let toastTimer = null;
function showToast() {
  const toast = $('#upload-toast');
  toast.classList.remove('done');
  toast.querySelector('.toast-title').textContent = 'Uploading…';
  toast.querySelector('.toast-sub').textContent = "Safe to close the app — it'll keep going in the background.";
  toast.classList.add('show');
}
function finishToast() {
  const toast = $('#upload-toast');
  toast.classList.add('done');
  toast.querySelector('.toast-title').textContent = 'Uploaded ✓';
  toast.querySelector('.toast-sub').textContent = 'Synced to fleet dashboard.';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
}

/* ---------------- driver history ---------------- */

async function openHistory() {
  showScreen('screen-history');
  const list = $('#history-list');
  list.innerHTML = '<div class="empty-state">Loading…</div>';

  const all = await sbGetInspections(state.fleetCode);
  const mine = all.filter((r) => r.driver_email === state.driverEmail);
  list.innerHTML = '';
  if (mine.length === 0) {
    list.innerHTML = '<div class="empty-state">No submissions yet.<br>Run a PTI, Hook, or Drop to see it here.</div>';
    return;
  }
  for (const r of mine) {
    list.appendChild(await renderEntryCard(r, false));
  }
}

/* ---------------- fleet units (trucks & trailers) ---------------- */

async function onAddUnit() {
  const input = $('#unit-number-input');
  const val = input.value.trim().toUpperCase();
  const errEl = $('#unit-add-error');
  errEl.style.display = 'none';

  if (!val) {
    showAuthError(errEl, 'Enter a unit number.');
    return;
  }

  const { error } = await sbInsertUnit({ unit: val, kind: state.unitKind, fleet_code: state.fleetCode });
  if (error) {
    showAuthError(errEl, error.code === '23505' ? 'That unit is already in your fleet.' : 'Could not add unit — try again.');
    return;
  }
  input.value = '';
  renderUnitsList();
}

function renderQrInto(el, text, size) {
  el.innerHTML = '';
  if (!window.QRCode) {
    el.textContent = text;
    return;
  }
  new QRCode(el, { text, width: size, height: size, correctLevel: QRCode.CorrectLevel.M });
}

function downloadUnitQr(unit) {
  const holder = document.createElement('div');
  renderQrInto(holder, unit, 500);
  const canvas = holder.querySelector('canvas');
  if (!canvas) return;
  const link = document.createElement('a');
  link.download = `${unit}-qr-code.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
}

async function renderUnitsList() {
  const mine = await sbGetUnits(state.fleetCode);
  const list = $('#units-list');
  list.innerHTML = '';
  if (mine.length === 0) {
    list.innerHTML = '<div class="empty-state">No trucks or trailers added yet.</div>';
    return;
  }
  mine.forEach((u) => {
    const row = document.createElement('div');
    row.className = 'entry-card unit-row';
    row.innerHTML = `
      <div class="unit-row-left">
        <div class="unit-qr-thumb"></div>
        <div>
          <span class="kind-badge ${u.kind}">${u.kind === 'truck' ? 'TRUCK' : 'TRAILER'}</span>
          <div class="entry-unit">${escapeHtml(u.unit)}</div>
        </div>
      </div>
      <div class="unit-row-actions">
        <button class="unit-icon-btn unit-download-btn" title="Download QR code to print">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </button>
        <button class="unit-icon-btn unit-remove-btn" title="Remove from fleet">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
        </button>
      </div>
    `;
    renderQrInto(row.querySelector('.unit-qr-thumb'), u.unit, 56);
    row.querySelector('.unit-download-btn').addEventListener('click', () => downloadUnitQr(u.unit));
    row.querySelector('.unit-remove-btn').addEventListener('click', async () => {
      await sbDeleteUnit(u.id);
      renderUnitsList();
    });
    list.appendChild(row);
  });
}


/* ---------------- fleet manager dashboard ---------------- */

function inRange(ts, range) {
  const now = new Date();
  const startOfDay = (dt) => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime();
  const todayStart = startOfDay(now);
  if (range === 'today') return ts >= todayStart;
  if (range === 'yesterday') return ts >= todayStart - 86400000 && ts < todayStart;
  if (range === '7d') return ts >= todayStart - 6 * 86400000;
  return true;
}

async function renderDashboard() {
  const list = $('#dash-list');
  list.innerHTML = '<div class="empty-state">Loading…</div>';

  const all = await sbGetInspections(state.fleetCode);
  const registeredUnits = (await sbGetUnits(state.fleetCode)).map((u) => u.unit);

  const existingDrivers = Array.from(new Set(all.map((r) => r.driver_name))).sort();
  const existingUnits = Array.from(new Set([...registeredUnits, ...all.map((r) => r.unit)])).sort();
  state.dashKnownDrivers = existingDrivers;
  state.dashKnownUnits = existingUnits;

  const filtered = all.filter((r) =>
    inRange(new Date(r.created_at).getTime(), state.dashRange) &&
    (!state.dashDriver || r.driver_name === state.dashDriver) &&
    (!state.dashType || r.type === state.dashType) &&
    (!state.dashUnit || r.unit === state.dashUnit)
  );

  const withDefects = filtered.filter((r) => r.defects && r.defects.length > 0).length;
  $('#dash-stats').innerHTML = `
    <div class="stat-card"><div class="stat-num">${filtered.length}</div><div class="stat-label">Inspections in view</div></div>
    <div class="stat-card"><div class="stat-num">${withDefects}</div><div class="stat-label">With flagged defects</div></div>
    <div class="stat-card"><div class="stat-num">${existingDrivers.length}</div><div class="stat-label">Active drivers</div></div>
    <div class="stat-card"><div class="stat-num">${all.length}</div><div class="stat-label">Total on record</div></div>
  `;

  list.innerHTML = '';
  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty-state">No inspections match these filters.</div>';
    return;
  }
  for (const r of filtered) {
    list.appendChild(await renderEntryCard(r, true));
  }
}

async function renderEntryCard(r, showDriver) {
  const card = document.createElement('div');
  card.className = 'entry-card';
  const hasDefects = r.defects && r.defects.length > 0;
  const unit = escapeHtml(r.unit);
  const driverName = escapeHtml(r.driver_name);
  const driverEmail = escapeHtml(r.driver_email);
  const driverPhone = escapeHtml(r.driver_phone);
  const createdAtMs = new Date(r.created_at).getTime();

  const locationHtml = (r.lat != null && r.lng != null)
    ? `<a href="https://www.google.com/maps?q=${r.lat},${r.lng}" target="_blank" rel="noopener">${r.lat.toFixed(5)}, ${r.lng.toFixed(5)} (±${r.location_accuracy_m}m)</a>`
    : 'Not recorded';

  let photosHtml = '';
  if (hasDefects) {
    const urls = await Promise.all(r.defects.map((d) => sbSignedUrl(d.photo_path)));
    photosHtml = `<div class="entry-photos">${r.defects.map((d, i) => `<img src="${urls[i] || ''}" title="Flagged at ${fmtTime(d.t)}" />`).join('')}</div>`;
  }

  card.innerHTML = `
    <div class="entry-top">
      <div style="display:flex; align-items:center; gap:10px;">
        <span class="entry-type ${r.type}">${r.type}</span>
        <span class="entry-unit">${unit}</span>
      </div>
      <div style="font-size:12.5px; color:var(--text-mute);">${fmtWhen(createdAtMs)}</div>
    </div>
    <div class="entry-meta">
      ${showDriver ? `<span class="entry-driver">${driverName}</span>` : ''}
      <span>Video: ${fmtTime(r.duration_sec)}</span>
      ${hasDefects ? `<span class="entry-defect-flag"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>${r.defects.length} defect${r.defects.length > 1 ? 's' : ''} flagged</span>` : '<span>No defects flagged</span>'}
    </div>
    <div class="entry-details">
      <div class="entry-detail-row">Unit ${unit} · ${r.type} · ${new Date(r.created_at).toLocaleString()}</div>
      ${showDriver ? `<div class="entry-detail-row">Driver: ${driverName}${driverEmail ? ` · <a href="mailto:${driverEmail}">${driverEmail}</a>` : ''}${driverPhone ? ` · ${driverPhone}` : ''}</div>` : ''}
      <div class="entry-detail-row">Location: ${locationHtml}</div>
      ${photosHtml}
    </div>
  `;
  card.addEventListener('click', () => card.classList.toggle('open'));
  return card;
}
