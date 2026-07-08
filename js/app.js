/* PTI Inspections
   Backend: Supabase (Postgres + Auth + Storage) — see supabase/schema.sql and js/supabaseClient.js.
   Every fleet's data is isolated by Row Level Security, keyed on fleet_code. */

const MIN_SECONDS = { PTI: 4 * 60, HOOK: 60, DROP: 60 };

const state = {
  role: 'driver',
  signupRole: 'driver',
  managerSignupMode: 'create',
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

  $$('#signup-role-toggle .role-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('#signup-role-toggle .role-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.signupRole = btn.dataset.role;
      $('#signup-fleet-code-field').style.display = state.signupRole === 'driver' ? 'block' : 'none';
      $('#manager-mode-field').style.display = state.signupRole === 'manager' ? 'block' : 'none';
    });
  });

  $$('.manager-mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.manager-mode-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.managerSignupMode = btn.dataset.mode;
      $('#manager-create-hint').style.display = state.managerSignupMode === 'create' ? 'block' : 'none';
      $('#manager-join-code-field').style.display = state.managerSignupMode === 'join' ? 'block' : 'none';
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
    tab.addEventListener('click', () => switchDashTab(tab.dataset.panel));
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
  $('#btn-torch-toggle').addEventListener('click', onToggleTorch);
  $('#btn-retake').addEventListener('click', onRetake);
  $('#btn-save-upload').addEventListener('click', onSaveUpload);
  $('#btn-upload-done').addEventListener('click', () => showScreen('screen-home'));
  $('#btn-upload-retry').addEventListener('click', () => { showUploadScreen(); runUpload(); });
  $('#btn-upload-discard').addEventListener('click', () => {
    if (!confirm('Discard this recording? This cannot be undone.')) return;
    pendingUpload = null;
    window.onbeforeunload = null;
    showScreen('screen-home');
  });

  $('#record-video').parentElement.querySelector('#marker-layer').addEventListener('click', onTapFlag);
  $('.record-stage').addEventListener('click', onTapFlag);

  // Only the plain range chips (data-range attribute) use this click-to-select pattern.
  // The date chip is its own thing below — a real <input type="date"> sits invisibly on
  // top of it, so it opens the native picker from a genuine tap, not a JS-triggered one.
  $$('#filter-time .chip[data-range]').forEach((chip) => {
    chip.addEventListener('click', () => {
      $$('#filter-time .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      state.dashRange = chip.dataset.range;
      renderDashboard();
    });
  });
  $('#filter-date-input').addEventListener('change', (e) => {
    if (!e.target.value) return;
    state.dashRange = 'date';
    state.dashCustomDate = e.target.value;
    $$('#filter-time .chip').forEach((c) => c.classList.remove('active'));
    $('#date-chip-wrap').classList.add('active');
    $('#chip-pick-date').textContent = new Date(e.target.value + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    renderDashboard();
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
  setupCombobox({
    inputEl: $('#manual-unit'),
    listEl: $('#manual-unit-list'),
    getOptions: () => state.availableUnits || [],
    onSelect: () => { $('#manual-unit-error').style.display = 'none'; },
  });

  document.addEventListener('click', closeAllDriverMenus);

  $('#lightbox-close').addEventListener('click', () => $('#photo-lightbox').classList.remove('show'));
  $('#photo-lightbox').addEventListener('click', (e) => {
    if (e.target.id === 'photo-lightbox') $('#photo-lightbox').classList.remove('show');
  });

  $$('.password-toggle-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = btn.previousElementSibling;
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      btn.querySelector('.eye-on').style.display = showing ? 'block' : 'none';
      btn.querySelector('.eye-off').style.display = showing ? 'none' : 'block';
      btn.title = showing ? 'Show password' : 'Hide password';
    });
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
  const passwordConfirm = $('#signup-password-confirm').value;
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
  if (password !== passwordConfirm) {
    showAuthError(errEl, 'Passwords don\'t match — check both fields.');
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
  if (role === 'manager' && state.managerSignupMode === 'join') {
    const entered = $('#signup-manager-fleet-code').value.trim();
    if (!entered) {
      showAuthError(errEl, 'Enter the existing fleet code from another manager on your team.');
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
      showAuthError(errEl, "Couldn't find that fleet code — double check with your team.");
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
    const { data, error } = await sbSignUp(email, password, { name, phone, role, fleet_code: fleetCode }, currentSiteUrl());
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
  const passwordConfirm = $('#new-password-confirm').value;
  const errEl = $('#new-password-error');
  errEl.style.display = 'none';
  if (password.length < 6) {
    showAuthError(errEl, 'Password must be at least 6 characters.');
    return;
  }
  if (password !== passwordConfirm) {
    showAuthError(errEl, 'Passwords don\'t match — check both fields.');
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
  $('#manual-unit').value = '';
  $('#manual-unit-error').style.display = 'none';
  showScreen('screen-scan');
  startScanCamera();
  loadAvailableUnits();
}

async function loadAvailableUnits() {
  try {
    const units = await sbGetUnits(state.fleetCode);
    state.availableUnits = units.map((u) => u.unit);
  } catch (err) {
    console.warn('Could not load units list', err);
    state.availableUnits = [];
  }
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
  let lastRejected = null;
  let lastRejectedAt = 0;

  function tick() {
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = window.jsQR ? jsQR(imageData.data, imageData.width, imageData.height) : null;
      if (code && code.data) {
        const raw = code.data.trim();
        // Skip re-showing the same rejection every single frame while a bad sticker
        // is still in view — only re-check it once the cooldown passes.
        const now = Date.now();
        if (raw !== lastRejected || now - lastRejectedAt > 2000) {
          const accepted = onUnitScanned(raw);
          if (accepted) return;
          lastRejected = raw;
          lastRejectedAt = now;
        }
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

// Single gatekeeper for BOTH the camera scan and manual-entry paths, so a code/number can
// only ever start a recording if it's an actual registered unit for this fleet — never an
// arbitrary QR code or typo. Returns true if accepted (caller should stop scanning), false
// if rejected (caller should keep scanning / let the driver try again).
function onUnitScanned(rawCode) {
  const errEl = $('#manual-unit-error');
  const unitCode = (rawCode || '').trim();
  const match = (state.availableUnits || []).find((u) => u.toLowerCase() === unitCode.toLowerCase());
  if (!match) {
    errEl.textContent = `"${unitCode}" isn't a registered truck/trailer for your fleet — check the sticker, or ask your fleet manager.`;
    errEl.style.display = 'block';
    return false;
  }
  errEl.style.display = 'none';
  stopScanLoop();
  state.currentUnit = match;
  $('#manual-unit').value = '';
  enterRecordScreen();
  return true;
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
  $('#marker-layer').innerHTML = '';
  state.defects = [];
  state.recordedChunks = [];
  state.elapsedSec = 0;
  state.currentLocation = null;
  captureLocation();

  $('#btn-torch-toggle').style.display = 'none';
  $('#btn-torch-toggle').classList.remove('active');
  state.torchOn = false;

  const video = $('#record-video');
  $('#camera-warning').style.display = 'none';
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: true,
    });
    video.srcObject = state.stream;
    await video.play();
    setUpTorchIfAvailable();
  } catch (err) {
    console.warn('Camera/mic permission denied:', err);
    $('#camera-warning').style.display = 'block';
    $('#btn-record-toggle').disabled = true;
  }
}

function setUpTorchIfAvailable() {
  const track = state.stream && state.stream.getVideoTracks()[0];
  const caps = track && track.getCapabilities ? track.getCapabilities() : null;
  if (caps && caps.torch) {
    $('#btn-torch-toggle').style.display = 'flex';
  }
}

async function onToggleTorch() {
  const track = state.stream && state.stream.getVideoTracks()[0];
  if (!track) return;
  state.torchOn = !state.torchOn;
  try {
    await track.applyConstraints({ advanced: [{ torch: state.torchOn }] });
    $('#btn-torch-toggle').classList.toggle('active', state.torchOn);
  } catch (err) {
    console.warn('Torch toggle failed:', err);
    state.torchOn = false;
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
  if (!confirm('Delete this recording and start over? This cannot be undone.')) return;
  enterRecordScreen();
}

let sharedAudioCtx = null;
function playShutterSound() {
  try {
    sharedAudioCtx = sharedAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = sharedAudioCtx;
    const now = ctx.currentTime;
    [{ delay: 0, freq: 1800 }, { delay: 0.06, freq: 1200 }].forEach(({ delay, freq }) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + delay);
      gain.gain.linearRampToValueAtTime(0.25, now + delay + 0.003);
      gain.gain.exponentialRampToValueAtTime(0.001, now + delay + 0.04);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + delay);
      osc.stop(now + delay + 0.05);
    });
  } catch (err) {
    console.warn('Could not play shutter sound', err);
  }
}

function onTapFlag(e) {
  const btn = $('#btn-record-toggle');
  if (!btn.classList.contains('recording')) return;
  if (e.target.closest('.record-bottom')) return; // dead zone around the controls — no accidental flags
  if (e.target.closest('.record-topbar')) return; // same for the close button/badges up top

  const stage = document.querySelector('.record-stage');
  const rect = stage.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const xPct = x / rect.width;
  const yPct = y / rect.height;

  playShutterSound();

  const dot = document.createElement('div');
  dot.className = 'marker-dot';
  dot.style.left = x + 'px';
  dot.style.top = y + 'px';
  $('#marker-layer').appendChild(dot);
  setTimeout(() => dot.remove(), 550);

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
  // The inspections table's id column is a real Postgres `uuid`, so every fallback
  // path here must still produce a valid UUID string, not just a unique-looking one.
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

let pendingUpload = null;
let uploadStartTime = null;
let uploadTimerHandle = null;

function onSaveUpload() {
  const mimeType = state.recorder && state.recorder.mimeType ? state.recorder.mimeType : 'video/webm';
  const videoExt = mimeType.includes('mp4') ? 'mp4' : 'webm';
  pendingUpload = {
    id: newId(),
    type: state.currentType,
    unit: state.currentUnit,
    driverName: state.driverName,
    driverEmail: state.driverEmail,
    driverPhone: state.driverPhone,
    fleetCode: state.fleetCode,
    location: state.currentLocation,
    durationSec: Math.round(state.finalDurationSec),
    defectsRaw: state.defects,
    videoBlob: new Blob(state.recordedChunks.slice(), { type: mimeType }),
    videoExt,
  };
  showUploadScreen();
  runUpload();
}

function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function setUploadProgress(fraction) {
  const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  $('#upload-progress-fill').style.width = pct + '%';
  $('#upload-percent').textContent = pct + '%';
}

function startUploadTimer() {
  uploadStartTime = Date.now();
  clearInterval(uploadTimerHandle);
  $('#upload-elapsed').textContent = '0:00';
  uploadTimerHandle = setInterval(() => {
    $('#upload-elapsed').textContent = formatElapsed(Date.now() - uploadStartTime);
  }, 250);
}

function showUploadScreen() {
  showScreen('screen-uploading');
  $('#upload-icon').className = 'upload-icon';
  $('#upload-icon').innerHTML = '<svg class="icon upload-spinner-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-9-9"/></svg>';
  $('#upload-title').textContent = 'Uploading…';
  $('#upload-sub').textContent = "Keep this screen open until it finishes — closing early can lose the upload.";
  $('#upload-progress-wrap').style.display = 'block';
  $('#upload-error-actions').style.display = 'none';
  $('#btn-upload-done').style.display = 'none';
  setUploadProgress(0);
  startUploadTimer();
  window.onbeforeunload = () => 'An upload is still in progress. Leave anyway?';
}

async function runUpload() {
  const p = pendingUpload;
  if (!p) return;
  try {
    const photoBlobs = [];
    for (const d of p.defectsRaw) {
      const res = await fetch(d.photo);
      photoBlobs.push(await res.blob());
    }
    const totalBytes = p.videoBlob.size + photoBlobs.reduce((s, b) => s + b.size, 0) || 1;
    let uploadedBytes = 0;

    const videoPath = `${p.fleetCode}/${p.type}/${p.id}/video.${p.videoExt}`;
    await sbUploadBlobWithProgress(videoPath, p.videoBlob, (loaded) => {
      setUploadProgress((uploadedBytes + loaded) / totalBytes);
    });
    uploadedBytes += p.videoBlob.size;
    setUploadProgress(uploadedBytes / totalBytes);

    const defects = [];
    for (let i = 0; i < p.defectsRaw.length; i++) {
      const d = p.defectsRaw[i];
      const blob = photoBlobs[i];
      const photoPath = `${p.fleetCode}/${p.type}/${p.id}/defect-${i}.jpg`;
      await sbUploadBlobWithProgress(photoPath, blob, (loaded) => {
        setUploadProgress((uploadedBytes + loaded) / totalBytes);
      });
      uploadedBytes += blob.size;
      setUploadProgress(uploadedBytes / totalBytes);
      defects.push({ id: d.id, t: d.t, x: d.x, y: d.y, photo_path: photoPath });
    }

    const { error } = await sbInsertInspection({
      id: p.id,
      type: p.type,
      unit: p.unit,
      driver_id: state.userId,
      driver_name: p.driverName,
      driver_email: p.driverEmail,
      driver_phone: p.driverPhone,
      fleet_code: p.fleetCode,
      duration_sec: p.durationSec,
      defects,
      video_path: videoPath,
      lat: p.location ? p.location.lat : null,
      lng: p.location ? p.location.lng : null,
      location_accuracy_m: p.location ? p.location.accuracyM : null,
    });
    if (error) throw error;

    clearInterval(uploadTimerHandle);
    window.onbeforeunload = null;
    pendingUpload = null;
    $('#upload-icon').className = 'upload-icon success';
    $('#upload-icon').innerHTML = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    $('#upload-title').textContent = 'Upload Complete';
    $('#upload-sub').textContent = 'Your inspection was saved successfully.';
    $('#upload-progress-wrap').style.display = 'none';
    $('#btn-upload-done').style.display = 'block';
  } catch (err) {
    console.error('Upload failed', err);
    clearInterval(uploadTimerHandle);
    window.onbeforeunload = null;
    $('#upload-icon').className = 'upload-icon error';
    $('#upload-icon').innerHTML = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
    $('#upload-title').textContent = 'Upload Failed';
    $('#upload-sub').textContent = "Your recording is still here — don't close the app. Check your connection and try again.";
    $('#upload-progress-wrap').style.display = 'none';
    $('#upload-error-detail').textContent = (err && err.message) ? err.message : String(err);
    $('#upload-error-actions').style.display = 'block';
  }
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
      const kindLabel = u.kind === 'truck' ? 'truck' : 'trailer';
      if (!confirm(`Delete the QR code for ${kindLabel} ${u.unit}? Drivers won't be able to scan it anymore.`)) return;
      await sbDeleteUnit(u.id);
      renderUnitsList();
    });
    list.appendChild(row);
  });
}

async function renderDriversList() {
  const list = $('#drivers-list');
  const statsEl = $('#drivers-stats');
  list.innerHTML = '';
  let drivers;
  try {
    drivers = await sbGetFleetDrivers(state.fleetCode);
  } catch (err) {
    statsEl.innerHTML = '';
    list.innerHTML = '<div class="empty-state">Could not load drivers — try again in a moment.</div>';
    return;
  }
  statsEl.innerHTML = `
    <div class="stat-card"><div class="stat-num">${drivers.length}</div><div class="stat-label">Active drivers</div></div>
  `;
  if (drivers.length === 0) {
    list.innerHTML = '<div class="empty-state">No drivers have joined with your fleet code yet.</div>';
    return;
  }
  drivers.forEach((d) => {
    const row = document.createElement('div');
    row.className = 'entry-card driver-row';
    renderDriverRowView(row, d);
    list.appendChild(row);
  });
}

function closeAllDriverMenus() {
  $$('.driver-menu.show').forEach((m) => m.classList.remove('show'));
}

function renderDriverRowView(row, d) {
  row.classList.remove('driver-row-editing');
  row.innerHTML = `
    <div class="driver-avatar">${escapeHtml((d.name || '?').trim().charAt(0).toUpperCase())}</div>
    <div class="driver-row-info">
      <div class="entry-unit">${escapeHtml(d.name)}</div>
      <div class="entry-meta"><span>${escapeHtml(d.email)}</span>${d.phone ? `<span>${escapeHtml(d.phone)}</span>` : ''}</div>
      ${d.assigned_unit ? `<div class="driver-assigned">Assigned: ${escapeHtml(d.assigned_unit)}</div>` : ''}
    </div>
    <div class="driver-menu-wrap">
      <button class="unit-icon-btn driver-menu-btn" title="More options" type="button">
        <svg class="icon" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
      </button>
      <div class="driver-menu">
        <button class="driver-menu-item" data-action="edit" type="button">Edit</button>
        <button class="driver-menu-item danger" data-action="remove" type="button">Remove</button>
      </div>
    </div>
  `;
  row.querySelector('.driver-menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = row.querySelector('.driver-menu');
    const willShow = !menu.classList.contains('show');
    closeAllDriverMenus();
    if (willShow) menu.classList.add('show');
  });
  row.querySelector('[data-action="edit"]').addEventListener('click', () => {
    closeAllDriverMenus();
    renderDriverRowEdit(row, d);
  });
  row.querySelector('[data-action="remove"]').addEventListener('click', async () => {
    closeAllDriverMenus();
    if (!confirm(`Remove ${d.name} from your fleet? They'll need to sign up again to rejoin.`)) return;
    await sbRemoveDriver(d.id);
    renderDriversList();
  });
}

function renderDriverRowEdit(row, d) {
  row.classList.add('driver-row-editing');
  row.innerHTML = `
    <div class="driver-avatar">${escapeHtml((d.name || '?').trim().charAt(0).toUpperCase())}</div>
    <div class="driver-row-info driver-edit-form">
      <input class="field field-inline driver-edit-name" value="${escapeHtml(d.name)}" placeholder="Driver name" />
      <input class="field field-inline driver-edit-unit" value="${escapeHtml(d.assigned_unit || '')}" placeholder="Assigned truck/trailer (optional)" />
      <div class="driver-edit-actions">
        <button class="btn btn-secondary driver-edit-cancel" type="button">Cancel</button>
        <button class="btn btn-primary driver-edit-save" type="button">Save</button>
      </div>
    </div>
  `;
  row.querySelector('.driver-edit-cancel').addEventListener('click', () => renderDriverRowView(row, d));
  row.querySelector('.driver-edit-save').addEventListener('click', async () => {
    const newName = row.querySelector('.driver-edit-name').value.trim();
    const newUnit = row.querySelector('.driver-edit-unit').value.trim();
    if (!newName) { alert('Name cannot be empty.'); return; }
    const saveBtn = row.querySelector('.driver-edit-save');
    saveBtn.disabled = true;
    try {
      await sbUpdateDriver(d.id, { name: newName, assigned_unit: newUnit || null });
      renderDriversList();
    } catch (err) {
      alert('Could not save changes — try again.');
      saveBtn.disabled = false;
    }
  });
}

/* ---------------- fleet manager dashboard ---------------- */

function switchDashTab(panel) {
  $$('.dash-tab').forEach((t) => t.classList.toggle('active', t.dataset.panel === panel));
  $$('.dash-panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${panel}`));
  if (panel === 'units') renderUnitsList();
  if (panel === 'inspections') renderDashboard();
  if (panel === 'drivers') renderDriversList();
}

function inRange(ts, range) {
  const now = new Date();
  const startOfDay = (dt) => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime();
  const todayStart = startOfDay(now);
  if (range === 'today') return ts >= todayStart;
  if (range === '7d') return ts >= todayStart - 6 * 86400000;
  if (range === 'date' && state.dashCustomDate) {
    const picked = new Date(state.dashCustomDate + 'T00:00:00').getTime();
    return ts >= picked && ts < picked + 86400000;
  }
  return true;
}

async function renderDashboard() {
  const list = $('#dash-list');
  list.innerHTML = '<div class="empty-state">Loading…</div>';

  const all = await sbGetInspections(state.fleetCode);
  const registeredUnits = (await sbGetUnits(state.fleetCode)).map((u) => u.unit);

  const existingDrivers = Array.from(new Set(all.map((r) => r.driver_name))).sort();
  state.dashKnownDrivers = existingDrivers;
  // Only currently-registered units, not every unit name ever seen in past inspections —
  // otherwise deleted trucks/trailers keep cluttering this list forever.
  state.dashKnownUnits = Array.from(new Set(registeredUnits)).sort();

  const filtered = all.filter((r) =>
    inRange(new Date(r.created_at).getTime(), state.dashRange) &&
    (!state.dashDriver || r.driver_name === state.dashDriver) &&
    (!state.dashType || r.type === state.dashType) &&
    (!state.dashUnit || r.unit === state.dashUnit) &&
    (!state.dashOnlyDefects || (r.defects && r.defects.length > 0))
  );

  const withDefects = all.filter((r) =>
    inRange(new Date(r.created_at).getTime(), state.dashRange) &&
    (!state.dashDriver || r.driver_name === state.dashDriver) &&
    (!state.dashType || r.type === state.dashType) &&
    (!state.dashUnit || r.unit === state.dashUnit) &&
    r.defects && r.defects.length > 0
  ).length;
  $('#dash-stats').innerHTML = `
    <button class="stat-card" type="button" data-stat="inspections"><div class="stat-num">${filtered.length}</div><div class="stat-label">Inspections in view</div></button>
    <button class="stat-card ${state.dashOnlyDefects ? 'active' : ''}" type="button" data-stat="defects"><div class="stat-num">${withDefects}</div><div class="stat-label">With flagged defects</div></button>
    <button class="stat-card" type="button" data-stat="drivers"><div class="stat-num">${existingDrivers.length}</div><div class="stat-label">Active drivers</div></button>
    <button class="stat-card" type="button" data-stat="total"><div class="stat-num">${all.length}</div><div class="stat-label">Total on record</div></button>
  `;
  $('#dash-stats [data-stat="inspections"]').addEventListener('click', () => {
    $('#dash-list').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('#dash-stats [data-stat="defects"]').addEventListener('click', () => {
    state.dashOnlyDefects = !state.dashOnlyDefects;
    renderDashboard();
  });
  $('#dash-stats [data-stat="drivers"]').addEventListener('click', () => switchDashTab('drivers'));
  $('#dash-stats [data-stat="total"]').addEventListener('click', () => {
    state.dashRange = 'all';
    state.dashDriver = '';
    state.dashUnit = '';
    state.dashType = '';
    state.dashOnlyDefects = false;
    $$('#filter-time .chip').forEach((c) => c.classList.remove('active'));
    $('#chip-pick-date').textContent = 'Pick Date';
    $('#filter-driver-input').value = '';
    $('#filter-unit-input').value = '';
    $('#filter-type').value = '';
    renderDashboard();
  });

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
    photosHtml = `<div class="entry-photos">${r.defects.map((d, i) => `<img src="${urls[i] || ''}" data-full="${urls[i] || ''}" title="Flagged at ${fmtTime(d.t)}" />`).join('')}</div>`;
  }

  const videoUrl = r.video_path ? await sbSignedUrl(r.video_path) : null;
  const videoHtml = videoUrl
    ? `<div class="entry-video-wrap">
         <video controls playsinline preload="metadata" src="${videoUrl}"></video>
         <div class="entry-video-actions">
           <button class="entry-download-btn" data-video-url="${videoUrl}" data-video-name="${unit}-${r.type}-${r.id}.${videoUrl.includes('.mp4') ? 'mp4' : 'webm'}" type="button">
             <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
             Download video
           </button>
         </div>
       </div>`
    : '<div class="entry-detail-row">Video unavailable.</div>';

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
      ${videoHtml}
      ${photosHtml}
      ${state.role === 'manager' ? `
        <button class="entry-delete-btn" type="button">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
          Delete this inspection
        </button>
      ` : ''}
    </div>
  `;
  card.addEventListener('click', () => card.classList.toggle('open'));
  card.querySelectorAll('.entry-photos img').forEach((img) => {
    img.addEventListener('click', (e) => {
      e.stopPropagation();
      openLightbox(img.dataset.full);
    });
  });
  const deleteBtn = card.querySelector('.entry-delete-btn');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete this ${r.type} inspection for ${unit}? This permanently removes the video and photos too — it can't be undone.`)) return;
      deleteBtn.disabled = true;
      deleteBtn.textContent = 'Deleting…';
      try {
        const paths = [r.video_path, ...(r.defects || []).map((d) => d.photo_path)].filter(Boolean);
        await sbDeleteStorageObjects(paths);
        await sbDeleteInspection(r.id);
        renderDashboard();
      } catch (err) {
        alert('Could not delete — try again: ' + (err.message || err));
        deleteBtn.disabled = false;
      }
    });
  }
  const downloadBtn = card.querySelector('.entry-download-btn');
  if (downloadBtn) {
    downloadBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      downloadFile(downloadBtn.dataset.videoUrl, downloadBtn.dataset.videoName, downloadBtn);
    });
  }
  card.querySelector('video, .entry-video-actions')?.addEventListener('click', (e) => e.stopPropagation());
  return card;
}

function openLightbox(url) {
  if (!url) return;
  $('#lightbox-img').src = url;
  $('#photo-lightbox').classList.add('show');
}

async function downloadFile(url, filename, btn) {
  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Downloading…';
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 4000);
  } catch (err) {
    console.error('Download failed', err);
    alert('Could not download the video — try again.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
}
