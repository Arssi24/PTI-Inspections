/* PTI Inspections — clickable demo
   Storage: IndexedDB, standing in for Supabase (Postgres + Storage) until the real backend is wired up.
   Everyone hitting this page in the same browser shares one "fleet" of data, simulating real-time sync. */

const MIN_SECONDS = { PTI: 4 * 60, HOOK: 60, DROP: 60 };
const DEFAULT_FLEET_CODE = 'YLM100';
const DEMO_UNITS = [
  { unit: 'TRK-104', kind: 'truck' },
  { unit: 'TRK-207', kind: 'truck' },
  { unit: 'TRL-318', kind: 'trailer' },
  { unit: 'TRL-422', kind: 'trailer' },
  { unit: 'TRK-509', kind: 'truck' },
];

const ACCOUNTS_KEY = 'pti_accounts';
const SESSION_KEY = 'pti_session';
const SEED_ACCOUNTS = [
  { name: 'Mike Reyes', email: 'mike@demo.pti', phone: '(630) 555-0114', password: 'demo123', role: 'driver', fleetCode: DEFAULT_FLEET_CODE },
  { name: 'Dana Kowalski', email: 'dana@demo.pti', phone: '(630) 555-0128', password: 'demo123', role: 'driver', fleetCode: DEFAULT_FLEET_CODE },
  { name: 'Carlos Tran', email: 'carlos@demo.pti', phone: '(630) 555-0139', password: 'demo123', role: 'driver', fleetCode: DEFAULT_FLEET_CODE },
  { name: 'Ola Petrenko', email: 'ola@demo.pti', phone: '(630) 555-0147', password: 'demo123', role: 'driver', fleetCode: DEFAULT_FLEET_CODE },
  { name: 'Dana (Dispatch)', email: 'dispatch@demo.pti', phone: '(630) 555-0100', password: 'demo123', role: 'manager', fleetCode: DEFAULT_FLEET_CODE },
];

function loadAccounts() {
  try { return JSON.parse(localStorage.getItem(ACCOUNTS_KEY)) || []; } catch (e) { return []; }
}
function saveAccounts(accounts) {
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
}
function findAccount(email) {
  return loadAccounts().find((a) => a.email.toLowerCase() === email.toLowerCase());
}
function findManagerByFleetCode(code) {
  return loadAccounts().find((a) => a.role === 'manager' && a.fleetCode.toLowerCase() === code.toLowerCase());
}
function ensureSeedAccounts() {
  if (loadAccounts().length === 0) saveAccounts(SEED_ACCOUNTS);
}
function genFleetCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = 'F' + Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (findManagerByFleetCode(code));
  return code;
}

const state = {
  role: 'driver',
  signupRole: 'driver',
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

function init() {
  ensureSeedAccounts();
  ensureSeedUnits();

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
  $('#btn-logout').addEventListener('click', logout);
  $('#btn-logout-dash').addEventListener('click', logout);
  $('#btn-history').addEventListener('click', openHistory);
  $('#btn-show-demo-qrs').addEventListener('click', openDemoQrs);

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

  if (!tryAutoLogin()) showScreen('screen-login');
}

/* ---------------- auth ---------------- */

function showAuthError(el, msg) {
  el.textContent = msg;
  el.style.display = 'block';
}

function onSignup() {
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
  if (findAccount(email)) {
    showAuthError(errEl, 'An account with that email already exists — log in instead.');
    return;
  }

  let fleetCode;
  if (role === 'driver') {
    const entered = $('#signup-fleet-code').value.trim();
    if (!entered) {
      showAuthError(errEl, 'Enter the fleet access code your fleet manager gave you.');
      return;
    }
    const manager = findManagerByFleetCode(entered);
    if (!manager) {
      showAuthError(errEl, 'Invalid access code — check with your fleet manager.');
      return;
    }
    fleetCode = manager.fleetCode;
  } else {
    fleetCode = genFleetCode();
  }

  const account = { name, email, phone, password, role, fleetCode };
  const accounts = loadAccounts();
  accounts.push(account);
  saveAccounts(accounts);
  loginAs(account);
}

function onLoginSubmit() {
  const email = $('#login-email').value.trim().toLowerCase();
  const password = $('#login-password').value;
  const errEl = $('#login-error');
  errEl.style.display = 'none';

  const account = findAccount(email);
  if (!account || account.password !== password) {
    showAuthError(errEl, 'Email or password not recognized.');
    return;
  }
  loginAs(account);
}

function tryAutoLogin() {
  const email = localStorage.getItem(SESSION_KEY);
  if (!email) return false;
  const account = findAccount(email);
  if (!account) return false;
  loginAs(account);
  return true;
}

function loginAs(account) {
  state.driverName = account.name;
  state.driverEmail = account.email;
  state.driverPhone = account.phone || '';
  state.role = account.role;
  state.fleetCode = account.fleetCode;
  localStorage.setItem(SESSION_KEY, account.email);
  if (account.role === 'driver') {
    $('#home-driver-name').textContent = account.name.split(' ')[0];
    showScreen('screen-home');
  } else {
    $('#fleet-code-value').textContent = account.fleetCode;
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

function logout() {
  localStorage.removeItem(SESSION_KEY);
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

async function onSaveUpload() {
  const type = state.currentType;
  const unit = state.currentUnit;
  const driverName = state.driverName;
  const driverEmail = state.driverEmail;
  const driverPhone = state.driverPhone;
  const fleetCode = state.fleetCode;
  const location = state.currentLocation;
  const durationSec = Math.round(state.finalDurationSec);
  const defects = state.defects;
  const mimeType = state.recorder && state.recorder.mimeType ? state.recorder.mimeType : 'video/webm';
  const chunks = state.recordedChunks.slice();

  const id = 'insp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const createdAt = Date.now();

  showToast();
  showScreen('screen-home');

  try {
    const videoBlob = new Blob(chunks, { type: mimeType });
    await dbPut('videos', { id, blob: videoBlob });
    await dbPut('inspections', {
      id, type, unit, driverName, driverEmail, driverPhone, fleetCode, durationSec, defects, createdAt, mimeType, location,
    });
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
  $('.toast-title', toast) || null;
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
  const all = await dbGetAll('inspections');
  const mine = all
    .filter((r) => r.driverEmail === state.driverEmail && r.fleetCode === state.fleetCode)
    .sort((a, b) => b.createdAt - a.createdAt);
  const list = $('#history-list');
  list.innerHTML = '';
  if (mine.length === 0) {
    list.innerHTML = '<div class="empty-state">No submissions yet.<br>Run a PTI, Hook, or Drop to see it here.</div>';
    return;
  }
  mine.forEach((r) => list.appendChild(renderEntryCard(r, false)));
}

/* ---------------- fleet units (trucks & trailers) ---------------- */

async function ensureSeedUnits() {
  const existing = await dbGetAll('units');
  if (existing.length > 0) return;
  for (const d of DEMO_UNITS) {
    await dbPut('units', { id: 'unit_' + d.unit, unit: d.unit, kind: d.kind, fleetCode: DEFAULT_FLEET_CODE, addedAt: Date.now() });
  }
}

async function onAddUnit() {
  const input = $('#unit-number-input');
  const val = input.value.trim().toUpperCase();
  const errEl = $('#unit-add-error');
  errEl.style.display = 'none';

  if (!val) {
    showAuthError(errEl, 'Enter a unit number.');
    return;
  }
  const existing = await dbGetAll('units');
  const dupe = existing.find((u) => u.fleetCode === state.fleetCode && u.unit.toLowerCase() === val.toLowerCase());
  if (dupe) {
    showAuthError(errEl, 'That unit is already in your fleet.');
    return;
  }

  await dbPut('units', {
    id: 'unit_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    unit: val,
    kind: state.unitKind,
    fleetCode: state.fleetCode,
    addedAt: Date.now(),
  });
  input.value = '';
  renderUnitsList();
}

async function renderUnitsList() {
  const all = await dbGetAll('units');
  const mine = all.filter((u) => u.fleetCode === state.fleetCode).sort((a, b) => a.unit.localeCompare(b.unit));
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
        <span class="kind-badge ${u.kind}">${u.kind === 'truck' ? 'TRUCK' : 'TRAILER'}</span>
        <span class="entry-unit">${escapeHtml(u.unit)}</span>
      </div>
      <button class="unit-remove-btn" title="Remove from fleet">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
      </button>
    `;
    row.querySelector('.unit-remove-btn').addEventListener('click', async () => {
      await dbDelete('units', u.id);
      renderUnitsList();
    });
    list.appendChild(row);
  });
}

/* ---------------- demo QR codes ---------------- */

async function openDemoQrs() {
  showScreen('screen-demo-qrs');
  const grid = $('#qr-grid');
  const fallback = $('#qr-fallback-note');
  grid.innerHTML = '';

  const allUnits = await dbGetAll('units');
  const units = allUnits.filter((u) => u.fleetCode === state.fleetCode).sort((a, b) => a.unit.localeCompare(b.unit));

  if (units.length === 0) {
    grid.style.display = 'none';
    fallback.style.display = 'block';
    $('#qr-fallback-units').textContent = 'None yet — ask your fleet manager to add trucks/trailers.';
    return;
  }
  if (!window.QRCode) {
    grid.style.display = 'none';
    fallback.style.display = 'block';
    $('#qr-fallback-units').textContent = units.map((u) => u.unit).join(', ');
    return;
  }
  grid.style.display = 'grid';
  fallback.style.display = 'none';

  units.forEach(({ unit }) => {
    const card = document.createElement('div');
    card.className = 'qr-card';
    const qrHolder = document.createElement('div');
    card.appendChild(qrHolder);
    const label = document.createElement('div');
    label.className = 'qr-label';
    label.textContent = unit;
    card.appendChild(label);
    grid.appendChild(card);
    new QRCode(qrHolder, { text: unit, width: 150, height: 150, correctLevel: QRCode.CorrectLevel.M });
  });
}

/* ---------------- fleet manager dashboard ---------------- */

function inRange(ts, range) {
  const now = new Date();
  const d = new Date(ts);
  const startOfDay = (dt) => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime();
  const todayStart = startOfDay(now);
  if (range === 'today') return ts >= todayStart;
  if (range === 'yesterday') return ts >= todayStart - 86400000 && ts < todayStart;
  if (range === '7d') return ts >= todayStart - 6 * 86400000;
  return true;
}

async function renderDashboard() {
  const allRaw = await dbGetAll('inspections');
  const all = allRaw.filter((r) => r.fleetCode === state.fleetCode).sort((a, b) => b.createdAt - a.createdAt);

  const registeredUnits = (await dbGetAll('units')).filter((u) => u.fleetCode === state.fleetCode).map((u) => u.unit);

  const existingDrivers = Array.from(new Set(all.map((r) => r.driverName))).sort();
  const existingUnits = Array.from(new Set([...registeredUnits, ...all.map((r) => r.unit)])).sort();
  state.dashKnownDrivers = existingDrivers;
  state.dashKnownUnits = existingUnits;

  const filtered = all.filter((r) =>
    inRange(r.createdAt, state.dashRange) &&
    (!state.dashDriver || r.driverName === state.dashDriver) &&
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

  const list = $('#dash-list');
  list.innerHTML = '';
  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty-state">No inspections match these filters.</div>';
    return;
  }
  filtered.forEach((r) => list.appendChild(renderEntryCard(r, true)));
}

function renderEntryCard(r, showDriver) {
  const card = document.createElement('div');
  card.className = 'entry-card';
  const hasDefects = r.defects && r.defects.length > 0;
  const unit = escapeHtml(r.unit);
  const driverName = escapeHtml(r.driverName);
  const driverEmail = escapeHtml(r.driverEmail);
  const driverPhone = escapeHtml(r.driverPhone);

  const locationHtml = r.location
    ? `<a href="https://www.google.com/maps?q=${r.location.lat},${r.location.lng}" target="_blank" rel="noopener">${r.location.lat.toFixed(5)}, ${r.location.lng.toFixed(5)} (±${r.location.accuracyM}m)</a>`
    : 'Not recorded';

  card.innerHTML = `
    <div class="entry-top">
      <div style="display:flex; align-items:center; gap:10px;">
        <span class="entry-type ${r.type}">${r.type}</span>
        <span class="entry-unit">${unit}</span>
      </div>
      <div style="font-size:12.5px; color:var(--text-mute);">${fmtWhen(r.createdAt)}</div>
    </div>
    <div class="entry-meta">
      ${showDriver ? `<span class="entry-driver">${driverName}</span>` : ''}
      <span>Video: ${fmtTime(r.durationSec)}</span>
      ${hasDefects ? `<span class="entry-defect-flag"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>${r.defects.length} defect${r.defects.length > 1 ? 's' : ''} flagged</span>` : '<span>No defects flagged</span>'}
    </div>
    <div class="entry-details">
      <div class="entry-detail-row">Unit ${unit} · ${r.type} · ${new Date(r.createdAt).toLocaleString()}</div>
      ${showDriver ? `<div class="entry-detail-row">Driver: ${driverName}${driverEmail ? ` · <a href="mailto:${driverEmail}">${driverEmail}</a>` : ''}${driverPhone ? ` · ${driverPhone}` : ''}</div>` : ''}
      <div class="entry-detail-row">Location: ${locationHtml}</div>
      ${hasDefects ? `<div class="entry-photos">${r.defects.map((d) => `<img src="${d.photo}" title="Flagged at ${fmtTime(d.t)}" />`).join('')}</div>` : ''}
    </div>
  `;
  card.addEventListener('click', () => card.classList.toggle('open'));
  return card;
}
