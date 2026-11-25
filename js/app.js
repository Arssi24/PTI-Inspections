/* PTI Inspections
   Backend: Supabase (Postgres + Auth + Storage) — see supabase/schema.sql and js/supabaseClient.js.
   Every fleet's data is isolated by Row Level Security, keyed on fleet_code. */

// The minimum length enforcement itself stays fully active — this is just the config for it,
// not shown on-screen to drivers anymore (per the uncle's request), but still blocks Save &
// Upload if a recording comes in short. Every type (PTI, Hook, Drop) needs at least 1 minute.
const MIN_SECONDS = { PTI: 60, HOOK: 60, DROP: 60, BASELINE: 60 };

const state = {
  role: 'driver',
  signupRole: 'driver',
  managerSignupMode: 'join',
  pendingAuthEmail: '',
  silentRetryInFlight: false,
  activeVideoObjectUrls: [],
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
  recordedVideoBlob: null,
  recordedVideoDurationSec: 0,
  defectTapArmed: false,
  previewVideoUrl: null,
  scanStream: null,
  scanLoopHandle: null,
  defects: [],
  finalDurationSec: 0,
  dashSection: 'pti',
  driversFilter: 'all',
  dashRange: 'today',
  dashFrom: '',
  dashTo: '',
  dashDriver: '',
  dashType: '',
  dashUnit: '',
  dashSearch: '',
  dashKnownDrivers: [],
  dashKnownUnits: [],
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function showScreen(id) {
  const splash = document.getElementById('boot-splash');
  if (splash) splash.remove();
  if (id !== 'screen-record' && typeof stopLiveCamera === 'function') stopLiveCamera();
  $$('.screen').forEach((s) => s.classList.remove('active'));
  const el = document.getElementById(id);
  el.classList.add('active');
  window.scrollTo(0, 0);
}

function typeLabel(t) { return t === 'BASELINE' ? 'ASSIGNED TRUCK' : t; }

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Fully custom play/seek/±15s controls, replacing native <video controls> entirely. iOS
// Safari's own native skip buttons turned out to reset blob-sourced video back to 0:00
// instead of actually skipping — that's Apple's player UI, not something fixable from here,
// so this small player is fully self-implemented instead, guaranteeing consistent behavior
// everywhere it's used (recording review screen, History/Dashboard entry cards).
function initCustomVideoPlayer(video, opts) {
  const mgr = Boolean(opts && opts.manager);
  if (video.dataset.cvpReady) return;
  video.dataset.cvpReady = '1';
  video.controls = false;
  video.removeAttribute('controls');

  const bar = document.createElement('div');
  bar.className = 'cvp-controls';
  const playBtnHtml = `
    <button class="cvp-btn cvp-play" type="button" title="Play/Pause">
      <svg class="icon cvp-icon-play" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>
      <svg class="icon cvp-icon-pause" viewBox="0 0 24 24" fill="currentColor" style="display:none;"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
    </button>`;
  if (mgr) {
    // Manager layout: play + time on the left, then -15s, seek bar, +15s, and a full-screen button.
    bar.innerHTML = `
      ${playBtnHtml}
      <span class="cvp-time cvp-time-left">0:00 / 0:00</span>
      <button class="cvp-btn cvp-skip cvp-back" type="button" title="Back 15 seconds">−15s</button>
      <div class="cvp-seekwrap"><input type="range" class="cvp-seek" min="0" max="1000" value="0" step="1" /><div class="cvp-ticks"></div></div>
      <button class="cvp-btn cvp-skip cvp-fwd" type="button" title="Forward 15 seconds">+15s</button>
      <button class="cvp-btn cvp-fs" type="button" title="Full screen">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
      </button>
    `;
  } else {
    bar.innerHTML = `
      ${playBtnHtml}
      <button class="cvp-btn cvp-skip cvp-back" type="button" title="Back 15 seconds">−15s</button>
      <div class="cvp-seekwrap"><input type="range" class="cvp-seek" min="0" max="1000" value="0" step="1" /><div class="cvp-ticks"></div></div>
      <button class="cvp-btn cvp-skip cvp-fwd" type="button" title="Forward 15 seconds">+15s</button>
      <span class="cvp-time">0:00 / 0:00</span>
    `;
  }
  let shell = null;
  let bigPlay = null;
  if (mgr) {
    // video + big centre play button live in a stage; stage + controls live in a shell (so full screen keeps the controls)
    shell = document.createElement('div');
    shell.className = 'cvp-shell';
    const stage = document.createElement('div');
    stage.className = 'cvp-stage';
    video.parentNode.insertBefore(shell, video);
    stage.appendChild(video);
    bigPlay = document.createElement('button');
    bigPlay.type = 'button';
    bigPlay.className = 'cvp-bigplay';
    bigPlay.title = 'Play';
    bigPlay.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="8 5 19 12 8 19 8 5"/></svg>';
    stage.appendChild(bigPlay);
    shell.appendChild(stage);
    shell.appendChild(bar);
    // click anywhere on the picture to play / pause
    stage.addEventListener('click', () => { if (video.paused) video.play(); else video.pause(); });
    const toggleFs = () => {
      const inFs = document.fullscreenElement || document.webkitFullscreenElement;
      if (inFs) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
      const req = shell.requestFullscreen || shell.webkitRequestFullscreen;
      if (req) req.call(shell);
      else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); // iPhone
    };
    bar.querySelector('.cvp-fs').addEventListener('click', toggleFs);
    stage.addEventListener('dblclick', toggleFs);
  } else {
    video.insertAdjacentElement('afterend', bar);
  }

  const playBtn = bar.querySelector('.cvp-play');
  const iconPlay = bar.querySelector('.cvp-icon-play');
  const iconPause = bar.querySelector('.cvp-icon-pause');
  const seek = bar.querySelector('.cvp-seek');
  const timeLabel = bar.querySelector('.cvp-time');
  let dragging = false;

  // Safari's own recordings report no length, so fall back to the length we measured ourselves.
  const safeDuration = () => {
    if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;
    const known = parseFloat(video.dataset.knownDuration || '');
    return known > 0 ? known : 0;
  };

  function updateTime() {
    const dur = safeDuration();
    timeLabel.textContent = `${fmtTime(video.currentTime || 0)} / ${fmtTime(dur)}`;
    if (!dragging && dur > 0) seek.value = String((video.currentTime / dur) * 1000);
  }
  function updatePlayIcon() {
    iconPlay.style.display = video.paused ? 'block' : 'none';
    iconPause.style.display = video.paused ? 'none' : 'block';
    if (bigPlay) bigPlay.style.display = video.paused ? 'flex' : 'none';
  }

  playBtn.addEventListener('click', () => { if (video.paused) video.play(); else video.pause(); });
  video.addEventListener('play', updatePlayIcon);
  video.addEventListener('pause', updatePlayIcon);
  video.addEventListener('ended', updatePlayIcon);
  video.addEventListener('timeupdate', updateTime);
  video.addEventListener('loadedmetadata', updateTime);
  video.addEventListener('durationchange', updateTime);

  seek.addEventListener('input', () => {
    dragging = true;
    const dur = safeDuration();
    if (dur > 0) timeLabel.textContent = `${fmtTime((seek.value / 1000) * dur)} / ${fmtTime(dur)}`;
  });
  seek.addEventListener('change', () => {
    const dur = safeDuration();
    if (dur > 0) video.currentTime = (seek.value / 1000) * dur;
    dragging = false;
  });

  bar.querySelector('.cvp-back').addEventListener('click', () => {
    video.currentTime = Math.max(0, (video.currentTime || 0) - 15);
  });
  bar.querySelector('.cvp-fwd').addEventListener('click', () => {
    const dur = safeDuration();
    video.currentTime = dur > 0 ? Math.min(dur, (video.currentTime || 0) + 15) : (video.currentTime || 0) + 15;
  });

  const ticks = bar.querySelector('.cvp-ticks');
  let markTimes = [];
  function drawTicks() {
    ticks.innerHTML = '';
    const dur = safeDuration();
    if (!dur) return;
    markTimes.forEach((t) => {
      const tick = document.createElement('span');
      tick.style.left = Math.min(100, Math.max(0, (t / dur) * 100)) + '%';
      ticks.appendChild(tick);
    });
  }
  video.cvpSetMarks = () => { /* time flags are no longer shown - only the photos matter */ };
  video.addEventListener('durationchange', drawTicks);
  video.addEventListener('loadedmetadata', drawTicks);

  updatePlayIcon();
  updateTime();
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
  $('#btn-verify-signup-otp').addEventListener('click', onVerifySignupOtp);
  $('#btn-logout').addEventListener('click', logout);
  $('#btn-logout-dash').addEventListener('click', logout);
  $('#btn-history').addEventListener('click', openHistory);

  $$('.mode-card').forEach((card) => {
    card.addEventListener('click', () => startFlow(card.dataset.type));
  });

  $$('[data-back]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.id === 'btn-record-close' && typeof liveRecordingActive === 'function' && liveRecordingActive()
          && !confirm('Stop and discard this recording?')) return;
      stopScanLoop();
      resetRecordVideoElement();
      showScreen(btn.dataset.back);
    });
  });

  $('#btn-manual-submit').addEventListener('click', onManualUnitSubmit);
  initPlayerEventLog();
  $('#rec-diag').addEventListener('toggle', () => { if ($('#rec-diag').open) fillDiagDetails(); });
  $('#btn-play-raw').addEventListener('click', () => playDiagVersion('raw'));
  $('#btn-play-rebuilt').addEventListener('click', () => playDiagVersion('rebuilt'));
  $('#btn-play-patched').addEventListener('click', () => playDiagVersion('patched'));
  const showRecMode = () => {
    const wc = wantWcMode();
    $('#rec-mode-note').textContent = `Next recording uses: ${wc ? 'the new recorder (own video writer)' : "Safari's built-in recorder"}`;
    $('#btn-mode-canvas').classList.toggle('active', wc);
    $('#btn-mode-direct').classList.toggle('active', !wc);
  };
  $('#btn-mode-canvas').addEventListener('click', () => { try { localStorage.setItem('pti_rec_mode2', 'wc'); } catch (e) { /* ignore */ } showRecMode(); });
  $('#btn-mode-direct').addEventListener('click', () => { try { localStorage.setItem('pti_rec_mode2', 'safari'); } catch (e) { /* ignore */ } showRecMode(); });
  showRecMode();
  $('#btn-live-close').addEventListener('click', () => $('#btn-record-close').click());
  $('#btn-live-record').addEventListener('click', onLiveRecordToggle);
  $('#btn-torch').addEventListener('click', toggleLiveTorch);
  $('#drivers-search').addEventListener('input', applyDriversSearch);
  $('#units-search').addEventListener('input', applyUnitsSearch);
  setupManagerCodeChip();
  $('#btn-add-driver').addEventListener('click', onAddDriver);
  $('#btn-ad-another').addEventListener('click', resetAddDriverForm);
  $('#btn-ad-drivers').addEventListener('click', () => switchDashTab('drivers'));
  $('#btn-side-toggle').addEventListener('click', () => setSideDrawer(!$('#screen-dashboard').classList.contains('side-open')));
  $('#dash-scrim').addEventListener('click', () => setSideDrawer(false));
  $('#ov-all-link').addEventListener('click', () => switchDashTab('inspections'));
  $('#btn-copy-fleet-code').addEventListener('click', async () => {
    const btn = $('#btn-copy-fleet-code');
    try { await navigator.clipboard.writeText(state.fleetCode || ''); btn.textContent = 'Copied'; } catch (e) { btn.textContent = 'Select & copy'; }
    setTimeout(() => { btn.textContent = 'Copy'; }, 1800);
  });
  [['#bar-managers', '#managers-body'], ['#bar-drivers', '#drivers-body']].forEach(([barSel, bodySel]) => {
    $(barSel).addEventListener('click', () => {
      const bar = $(barSel);
      const open = !bar.classList.contains('open');
      bar.classList.toggle('open', open);
      bar.setAttribute('aria-expanded', open ? 'true' : 'false');
      $(bodySel).style.display = open ? 'block' : 'none';
    });
  });
  let dashSearchTimer = null;
  $('#dash-search').addEventListener('input', () => {
    clearTimeout(dashSearchTimer);
    dashSearchTimer = setTimeout(() => { state.dashSearch = $('#dash-search').value; renderDashboard(); }, 300);
  });
  $('#btn-live-fit').addEventListener('click', toggleLiveFit);
  $('#live-tap-overlay').addEventListener('click', onLiveTapOverlay);
  $('#btn-retry-live').addEventListener('click', enterRecordScreen);
  $('#btn-live-fallback').addEventListener('click', () => {
    if (liveRecordingActive() && !confirm('Stop and discard this recording?')) return;
    stopLiveCamera();
    $('#recorder-live').style.display = 'none';
    $('#recorder-launching').style.display = 'block';
  });
  $('#btn-select-video').addEventListener('click', openVideoLibrary);
  $('#native-library-input').addEventListener('change', onNativeVideoSelected);
  $('#review-tap-overlay').addEventListener('click', onReviewTapOverlay);
  $('#btn-retake').addEventListener('click', onRetake);
  $('#btn-save-upload').addEventListener('click', onSaveUpload);
  $('#btn-upload-done').addEventListener('click', () => {
    resetRecordVideoElement();
    showScreen('screen-home');
  });
  $('#btn-upload-retry').addEventListener('click', () => { showUploadScreen(); runUpload(); });
  $('#btn-upload-discard').addEventListener('click', async () => {
    if (!confirm('Discard this recording? This cannot be undone.')) return;
    if (pendingUpload) {
      try { await queueRemovePendingUpload(pendingUpload.id); } catch (err) { console.error(err); }
    }
    pendingUpload = null;
    window.onbeforeunload = null;
    showScreen('screen-home');
    checkPendingUploads();
  });
  $('#btn-retry-pending').addEventListener('click', retryOldestPendingUpload);
  window.addEventListener('online', () => { if (state.role === 'driver') checkPendingUploads(); });

  // Only the plain range chips (data-range attribute) use this click-to-select pattern.
  // The date input is its own real, normally-rendered control — see its CSS comment.
  $$('#filter-time .chip[data-range]').forEach((chip) => {
    chip.addEventListener('click', () => {
      $$('#filter-time .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      state.dashRange = chip.dataset.range;
      clearDateRangeInputs();
      renderDashboard();
    });
  });
  // From / to calendar: everything between the two dates (either one can be left empty).
  const onRangeChange = () => {
    state.dashFrom = $('#filter-from').value;
    state.dashTo = $('#filter-to').value;
    if (!state.dashFrom && !state.dashTo) {
      clearDateRangeInputs();
      state.dashRange = 'today';
      $$('#filter-time .chip').forEach((c) => c.classList.toggle('active', c.dataset.range === 'today'));
    } else {
      state.dashRange = 'range';
      $$('#filter-time .chip').forEach((c) => c.classList.remove('active'));
      $('#range-box').classList.add('active');
      $('#filter-range-clear').style.display = 'inline-block';
    }
    if (typeof syncDateBtns === 'function') syncDateBtns();
    renderDashboard();
  };
  $('#filter-from').addEventListener('change', onRangeChange);
  $('#filter-to').addEventListener('change', onRangeChange);
  $('#filter-range-clear').addEventListener('click', () => {
    $('#filter-from').value = '';
    $('#filter-to').value = '';
    onRangeChange();
  });
  $('#filter-type').addEventListener('change', (e) => { state.dashType = e.target.value; renderDashboard(); });
  $$('#dh-chips .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.dashType = chip.dataset.dh;
      $$('#dh-chips .chip').forEach((c) => c.classList.toggle('active', c === chip));
      renderDashboard();
    });
  });

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

  const cachedProfile = readCachedProfile();
  if (cachedProfile) {
    loginAs(cachedProfile);
    verifySessionInBackground(cachedProfile);
    return;
  }

  let loggedIn = false;
  try {
    // Bounded so a slow/unreachable Supabase project (paused project, dead network, etc.)
    // can never leave the app hanging on launch — it fails open to the login screen after
    // a few seconds instead of waiting indefinitely on a fetch that may never resolve.
    loggedIn = await withTimeout(tryAutoLogin(), 8000);
  } catch (err) {
    console.error('Auto-login check failed or timed out:', err);
  }
  if (!loggedIn) showScreen('screen-login');
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out after ' + ms + 'ms')), ms)),
  ]);
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
  if (!$('#signup-consent').checked) {
    showAuthError(errEl, 'Please tick the box to agree to the Terms of Use and Privacy Policy.');
    return;
  }
  if (phone.replace(/\D/g, '').length < 10) {
    showAuthError(errEl, 'Enter your phone number (at least 10 digits).');
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
  let managerCode = '';
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
      showAuthError(errEl, 'Enter the fleet code.');
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
    managerCode = $('#signup-manager-security-code').value.trim();
    if (!managerCode) {
      showAuthError(errEl, 'Enter the manager security code. Another manager can show it to you on their dashboard.');
      return;
    }
    let codeOk = false;
    try {
      codeOk = await sbCheckManagerCode(fleetCode, managerCode);
    } catch (err) {
      showAuthError(errEl, 'Could not check the security code (the database update may not be installed yet).');
      return;
    }
    if (!codeOk) {
      showAuthError(errEl, 'Wrong manager security code. Ask a manager on your team to check it on their dashboard.');
      return;
    }
  }

  const btn = $('#btn-signup');
  btn.disabled = true;
  try {
    // Profile (and fleet, for managers) are created server-side by the handle_new_user()
    // DB trigger — see supabase/schema.sql — from this metadata. That's what lets signup
    // work correctly whether or not "Confirm email" is turned on: the trigger runs inside
    // the same transaction as the auth.users insert, before any client session exists.
    const { data, error } = await sbSignUp(email, password, { name, phone, role, fleet_code: fleetCode, manager_code: managerCode }, currentSiteUrl());
    if (error) {
      showAuthError(errEl, error.message);
      return;
    }
    if (!data.session) {
      state.pendingAuthEmail = email;
      showCheckEmailScreen('Enter the 6-digit code we just emailed you.');
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
    state.pendingAuthEmail = email;
    showScreen('screen-set-new-password');
  } finally {
    btn.disabled = false;
  }
}

async function onSetNewPasswordSubmit() {
  const code = $('#reset-otp-code').value.trim();
  const password = $('#new-password').value;
  const passwordConfirm = $('#new-password-confirm').value;
  const errEl = $('#new-password-error');
  errEl.style.display = 'none';
  if (!code) {
    showAuthError(errEl, 'Enter the 6-digit code we emailed you.');
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
  const btn = $('#btn-set-new-password');
  btn.disabled = true;
  try {
    // Verifying the code is what actually signs them in (recovery-type OTP creates a real
    // session) — updateUser only works once that session exists, so this has to go first.
    const { error: otpError } = await sbVerifyOtp(state.pendingAuthEmail, code, 'recovery');
    if (otpError) {
      showAuthError(errEl, otpError.message);
      return;
    }
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

async function onVerifySignupOtp() {
  const code = $('#signup-otp-code').value.trim();
  const errEl = $('#signup-otp-error');
  errEl.style.display = 'none';
  if (!code) {
    showAuthError(errEl, 'Enter the 6-digit code we emailed you.');
    return;
  }
  const btn = $('#btn-verify-signup-otp');
  btn.disabled = true;
  try {
    const { data, error } = await sbVerifyOtp(state.pendingAuthEmail, code, 'signup');
    if (error) {
      showAuthError(errEl, error.message);
      return;
    }
    const profile = await sbGetProfile(data.user.id);
    if (!profile) {
      showAuthError(errEl, 'Verified — give it a few seconds, then try logging in.');
      return;
    }
    await loginAs(profile);
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

const PROFILE_CACHE_KEY = 'pti_cached_profile';

function readCachedProfile() {
  try {
    const hasSession = Object.keys(localStorage).some((k) => /^sb-.*-auth-token$/.test(k));
    if (!hasSession) return null;
    const p = JSON.parse(localStorage.getItem(PROFILE_CACHE_KEY) || 'null');
    return p && p.id && p.role ? p : null;
  } catch (e) {
    return null;
  }
}

function cacheProfile(profile) {
  try { localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(profile)); } catch (e) { /* storage unavailable */ }
}

function clearCachedProfile() {
  try { localStorage.removeItem(PROFILE_CACHE_KEY); } catch (e) { /* storage unavailable */ }
}

async function verifySessionInBackground(cached) {
  try {
    const user = await withTimeout(sbGetSessionUser(), 20000);
    if (!user || user.id !== cached.id) {
      if (!navigator.onLine) return;
      clearCachedProfile();
      showScreen('screen-login');
      return;
    }
    const fresh = await withTimeout(sbGetProfile(user.id), 20000);
    if (!fresh) {
      clearCachedProfile();
      showScreen('screen-login');
      return;
    }
    cacheProfile(fresh);
    if (fresh.role !== cached.role || fresh.fleet_code !== cached.fleet_code) {
      location.reload();
      return;
    }
    state.driverName = fresh.name;
    state.driverEmail = fresh.email;
    state.driverPhone = fresh.phone || '';
  } catch (err) {
    console.warn('Background session check failed (likely offline) — staying on cached profile', err);
  }
}

async function loginAs(profile) {
  cacheProfile(profile);
  state.userId = profile.id;
  state.driverName = profile.name;
  state.driverEmail = profile.email;
  state.driverPhone = profile.phone || '';
  state.role = profile.role;
  state.fleetCode = profile.fleet_code;

  if (profile.role === 'driver') {
    $('#home-driver-name').textContent = profile.name.split(' ')[0];
    showScreen('screen-home');
    checkPendingUploads();
  } else {
    $('#fleet-code-value').textContent = profile.fleet_code;
    state.fleetCode = profile.fleet_code;
    $('#side-user-name').textContent = profile.name || 'Fleet manager';
    $('#side-user-avatar').textContent = (profile.name || 'M').trim().charAt(0).toUpperCase();
    state.dashDriver = '';
    state.dashUnit = '';
    state.dashType = '';
    state.dashSearch = '';
    $('#dash-search').value = '';
    $('#filter-driver-input').value = '';
    $('#filter-unit-input').value = '';
    $('#filter-type').value = '';
    showScreen('screen-dashboard');
    switchDashTab('overview');
  }
}

async function logout() {
  clearCachedProfile();
  await sbSignOut();
  showScreen('screen-login');
}

/* ---------------- driver flow: pick type -> scan -> record ---------------- */

function startFlow(type) {
  state.currentType = type;
  state.scanTargetTitle = type === 'PTI' ? 'Scan unit for Pre-Trip Inspection'
    : type === 'BASELINE' ? 'Scan the truck or trailer for its Assigned Truck Video'
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
    // HOOK and DROP are trailer-only operations — only PTI can be done against either kind,
    // since a pre-trip walkaround covers the truck and whatever trailer's attached.
    const relevant = (state.currentType === 'PTI' || state.currentType === 'BASELINE') ? units : units.filter((u) => u.kind === 'trailer');
    state.availableUnits = relevant.map((u) => u.unit);
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
  if (state.currentType === 'BASELINE') {
    // Only the FIRST video of a truck counts (and is kept forever) — check before recording.
    if (state.baselineChecking) return false;
    state.baselineChecking = true;
    sbFindAssignedVideo(state.fleetCode, match).then((existing) => {
      if (existing) {
        errEl.textContent = `${match} already has its permanent Assigned Truck Video (recorded ${new Date(existing.created_at).toLocaleDateString()}). Open "Assigned Truck Video" on the home screen to watch it.`;
        errEl.style.display = 'block';
        return;
      }
      stopScanLoop();
      state.currentUnit = match;
      $('#manual-unit').value = '';
      enterRecordScreen();
    }).catch((err) => {
      console.warn('Could not check the assigned truck video', err);
      errEl.textContent = 'Could not check this truck right now — check your connection and try again.';
      errEl.style.display = 'block';
    }).finally(() => { state.baselineChecking = false; });
    return false;
  }
  stopScanLoop();
  state.currentUnit = match;
  $('#manual-unit').value = '';
  enterRecordScreen();
  return true;
}

/* ---------------- recording screen ---------------- */
// Recording itself happens in the phone's real Camera app now, not our own live camera view —
// that's the actual fix for videos that played a few seconds then errored out. The browser's
// MediaRecorder API writes broken duration/seek metadata into whatever it records; the real
// Camera app doesn't have that bug. This screen hands off to it, then reviews the result and
// lets the driver flag defects by scrubbing to a moment and tapping (armed via the flag
// button below, same one-tap-to-arm pattern the old flashlight toggle used).

async function enterRecordScreen() {
  showScreen('screen-record');
  $('#record-title').textContent = `${typeLabel(state.currentType)} · ${state.currentUnit}`;
  $('#recorder-launching').style.display = 'none';
  $('#recorder-live').style.display = 'none';
  $('#recorder-review').style.display = 'none';
  $('#live-defect-count').textContent = '';
  $('#defect-count-wrap').style.visibility = 'hidden';
  $('#defect-count').textContent = '0';
  $('#min-warning').style.display = 'none';
  disarmDefectTap();
  state.defects = [];
  renderReviewMarks();
  state.recordedVideoBlob = null;
  state.recordedVideoDurationSec = 0;
  state.currentLocation = null;
  captureLocation();
  revokePreviewUrl();
  resetRecordVideoElement();
  const liveOk = await startLiveCamera();
  if (!$('#screen-record').classList.contains('active')) return;
  $(liveOk ? '#recorder-live' : '#recorder-launching').style.display = 'block';
}

// Fallback path: pick a video already recorded in the phone's Camera app (full quality).
function openVideoLibrary() {
  $('#native-library-input').value = '';
  $('#native-library-input').click();
}

async function onNativeVideoSelected(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  await loadRecordedFile(file);
}

async function loadRecordedFile(file, knownSec) {
  const video = $('#record-video');
  video.dataset.knownDuration = knownSec > 0 ? String(knownSec) : '';
  revokePreviewUrl();
  state.previewVideoUrl = URL.createObjectURL(file);
  video.src = state.previewVideoUrl;
  initCustomVideoPlayer(video);
  if (!(knownSec > 0)) fixBrokenDuration(video);

  await new Promise((resolve) => {
    if (video.readyState >= 1) resolve();
    else video.addEventListener('loadedmetadata', resolve, { once: true });
  });

  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const infoEl = $('#video-info');
  if (infoEl) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    const low = vw && vh && Math.min(vw, vh) < 720;
    infoEl.className = 'video-info' + (low ? ' video-info-low' : '');
    infoEl.textContent = vw && vh
      ? `Video quality: ${Math.max(vw, vh)}×${Math.min(vw, vh)} · ${mb} MB${Number.isFinite(video.duration) && video.duration > 0 ? ' · ' + ((file.size * 8) / video.duration / 1e6).toFixed(1) + ' Mbps' : ''}${low ? ' — low resolution. For a clearer video, record in the Camera app and use Select My Video.' : ''}`
      : '';
  }

  state.recordedVideoBlob = file;
  const reported = Number.isFinite(video.duration) ? video.duration : 0;
  // Trust our own timer when the player reports nothing, or a length that is clearly off.
  state.recordedVideoDurationSec = knownSec > 0 && (!reported || Math.abs(reported - knownSec) > Math.max(3, knownSec * 0.2)) ? knownSec : reported;
  state.finalDurationSec = state.recordedVideoDurationSec;

  const min = MIN_SECONDS[state.currentType];
  const tooShort = state.recordedVideoDurationSec > 0 && state.recordedVideoDurationSec < min;
  $('#min-warning').style.display = tooShort ? 'block' : 'none';
  $('#btn-save-upload').disabled = tooShort;

  $('#recorder-launching').style.display = 'none';
  $('#recorder-live').style.display = 'none';
  $('#recorder-review').style.display = 'block';
  if (state.defects.length) {
    $('#defect-count-wrap').style.visibility = 'visible';
    $('#defect-count').textContent = state.defects.length;
  }
  renderReviewMarks();
}

function onFlagDefectToggle() {
  if (state.defectTapArmed) { disarmDefectTap(); return; }
  const video = $('#record-video');
  state.resumeAfterMark = !video.paused && !video.ended;
  video.pause();
  state.defectTapArmed = true;
  $('#btn-flag-defect').classList.add('active');
  $('#review-arm-hint').style.display = 'block';
  $('#review-tap-overlay').style.display = 'block';
}

function disarmDefectTap() {
  state.defectTapArmed = false;
  const flagBtn = $('#btn-flag-defect');
  if (flagBtn) flagBtn.classList.remove('active');
  const hint = $('#review-arm-hint');
  if (hint) hint.style.display = 'none';
  const overlay = $('#review-tap-overlay');
  if (overlay) overlay.style.display = 'none';
}

function onReviewTapOverlay(e) {
  if (!state.defectTapArmed) return;
  const overlay = $('#review-tap-overlay');
  // Coordinates are computed against the <video> element itself, not the overlay div — the
  // overlay's own box can extend past the video now that the custom controls bar shares the
  // same wrapper, and marker placement needs to stay accurate to the actual video frame.
  const video = $('#record-video');
  const rect = video.getBoundingClientRect();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  const xPct = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  const yPct = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));

  playShutterSound();
  const dot = document.createElement('div');
  dot.className = 'marker-dot';
  dot.style.left = (clientX - overlay.getBoundingClientRect().left) + 'px';
  dot.style.top = (clientY - overlay.getBoundingClientRect().top) + 'px';
  overlay.appendChild(dot);
  setTimeout(() => dot.remove(), 550);

  capturePhotoWithMarker(xPct, yPct);
  disarmDefectTap();
  if (state.resumeAfterMark) {
    state.resumeAfterMark = false;
    video.play().catch(() => {});
  }
}

function renderReviewMarks() {
  const box = $('#mark-chips');
  if (!box) return;
  box.innerHTML = '';
  state.defects.forEach((d, i) => {
    const chip = document.createElement('span');
    chip.className = 'mark-chip';
    chip.innerHTML = `<button type="button" class="mark-chip-go">&#9873; ${fmtTime(d.t)}</button><button type="button" class="mark-chip-x" title="Remove this mark">&times;</button>`;
    chip.querySelector('.mark-chip-go').addEventListener('click', () => {
      const v = $('#record-video');
      v.currentTime = Math.max(0, d.t - 2);
      v.play().catch(() => {});
    });
    chip.querySelector('.mark-chip-x').addEventListener('click', () => {
      state.defects.splice(i, 1);
      $('#defect-count').textContent = state.defects.length;
      renderReviewMarks();
    });
    box.appendChild(chip);
  });
  const v = $('#record-video');
  if (v && v.cvpSetMarks) v.cvpSetMarks(state.defects.map((d) => d.t));
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

// #record-video only ever plays a real file now (src), never a live stream (srcObject) — but
// still gets explicitly reset between attempts so a previous recording's audio can't keep
// playing invisibly after navigating away or retaking.
function resetRecordVideoElement() {
  const video = $('#record-video');
  if (!video) return;
  video.pause();
  video.removeAttribute('src');
  video.controls = false;
  video.load();
}

function revokePreviewUrl() {
  if (state.previewVideoUrl) {
    URL.revokeObjectURL(state.previewVideoUrl);
    state.previewVideoUrl = null;
  }
}

function onRetake() {
  if (!confirm('Delete this recording and start over? This cannot be undone.')) return;
  enterRecordScreen();
}

let sharedAudioCtx = null;
function playShutterSound() {
  // iPhone-screenshot style: one quick bright camera "snap" with a tiny softer click right behind it.
  try {
    sharedAudioCtx = sharedAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = sharedAudioCtx;
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    const len = Math.floor(ctx.sampleRate * 0.2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const master = ctx.createDynamicsCompressor();
    const out = ctx.createGain();
    out.gain.value = 1.3;
    master.connect(out); out.connect(ctx.destination);
    const env = (g, t, peak, dur) => {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + 0.001);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    };
    [
      { t: 0.0,   hp: 2600, ping: 5200, nd: 0.016, pd: 0.035, body: 200, bd: 0.035, g: 1.0 },
      { t: 0.052, hp: 1800, ping: 3300, nd: 0.02,  pd: 0.04,  body: 150, bd: 0.04,  g: 0.5 },
    ].forEach((c) => {
      // snap of noise
      const src = ctx.createBufferSource(); src.buffer = buf;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = c.hp;
      const ng = ctx.createGain(); env(ng, now + c.t, 0.9 * c.g, c.nd);
      src.connect(hp); hp.connect(ng); ng.connect(master);
      src.start(now + c.t); src.stop(now + c.t + c.nd + 0.02);
      // metallic ring
      const src2 = ctx.createBufferSource(); src2.buffer = buf;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = c.ping; bp.Q.value = 9;
      const pg = ctx.createGain(); env(pg, now + c.t, 1.6 * c.g, c.pd);
      src2.connect(bp); bp.connect(pg); pg.connect(master);
      src2.start(now + c.t); src2.stop(now + c.t + c.pd + 0.02);
      // body thump
      const osc = ctx.createOscillator(); osc.type = 'triangle';
      osc.frequency.setValueAtTime(c.body, now + c.t);
      osc.frequency.exponentialRampToValueAtTime(c.body * 0.4, now + c.t + c.bd);
      const og = ctx.createGain(); env(og, now + c.t, 0.7 * c.g, c.bd);
      osc.connect(og); og.connect(master);
      osc.start(now + c.t); osc.stop(now + c.t + c.bd + 0.02);
    });
  } catch (err) {
    console.warn('Could not play shutter sound', err);
  }
}


function capturePhotoWithMarker(xPct, yPct, sourceVideo, atSeconds) {
  const video = sourceVideo || $('#record-video');
  const w = video.videoWidth || video.width;
  const h = video.videoHeight || video.height;
  if (!w || !h) return;
  const canvas = $('#record-canvas');
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
  // video.currentTime — the exact paused moment being reviewed — not a live-recording timer,
  // since flagging now happens by scrubbing to a moment afterward, not tapping mid-recording.
  state.defects.push({ id: 'd_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7), t: atSeconds != null ? atSeconds : video.currentTime, x: xPct, y: yPct, photo: dataUrl });

  $('#defect-count-wrap').style.visibility = 'visible';
  $('#defect-count').textContent = state.defects.length;
  renderReviewMarks();
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

// Shows/hides the "recording waiting to upload" banner on Home, and — if there's actually a
// connection right now — kicks off an automatic retry IN THE BACKGROUND, without ever
// switching screens. (Earlier version of this jumped straight to the full-screen upload
// view, which meant opening the app could suddenly hijack into a slow/stuck upload attempt
// instead of just showing Home — exactly what looked like "the app is slow to open.")
async function checkPendingUploads() {
  const banner = $('#pending-upload-banner');
  if (!banner) return;
  let items = [];
  try {
    items = await queueGetAllPendingUploads();
  } catch (err) {
    console.error('Could not read offline upload queue', err);
    return;
  }
  if (items.length === 0) {
    banner.style.display = 'none';
    return;
  }
  $('#pending-upload-title').textContent = items.length === 1
    ? '1 recording waiting to upload'
    : `${items.length} recordings waiting to upload`;
  banner.style.display = 'flex';
  if (navigator.onLine && !state.silentRetryInFlight) {
    state.silentRetryInFlight = true;
    silentRetryPendingUpload(items[0]).finally(() => { state.silentRetryInFlight = false; });
  }
}

// Background counterpart to retryOldestPendingUpload() below — same upload, but reports
// progress into the Home-screen banner instead of taking over the whole screen. Used for the
// automatic retry; the banner's own "Retry Now" button still uses the full-screen version,
// since that's an explicit tap where showing full progress is exactly what's expected.
async function silentRetryPendingUpload(record) {
  const titleEl = $('#pending-upload-title');
  try {
    await performUpload(record, (fraction) => {
      if (titleEl) titleEl.textContent = `Uploading in background… ${Math.round(fraction * 100)}%`;
    });
  } catch (err) {
    console.warn('Background retry failed — will try again next time the app opens or comes back online', err);
  } finally {
    checkPendingUploads();
  }
}

async function retryOldestPendingUpload() {
  let items = [];
  try {
    items = await queueGetAllPendingUploads();
  } catch (err) {
    console.error('Could not read offline upload queue', err);
    return;
  }
  if (items.length === 0) {
    $('#pending-upload-banner').style.display = 'none';
    return;
  }
  pendingUpload = items[0];
  showUploadScreen();
  await runUpload();
}

async function onSaveUpload() {
  revokePreviewUrl();
  // state.recordedVideoBlob is the real file handed back by the phone's Camera app (via
  // onNativeVideoSelected) — used directly, not reassembled from recorder chunks anymore.
  const mimeType = (state.recordedVideoBlob && state.recordedVideoBlob.type) || 'video/mp4';
  const videoExt = mimeType.includes('mp4') || mimeType.includes('quicktime') ? 'mp4' : 'webm';
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
    videoBlob: state.recordedVideoBlob,
    videoExt,
  };
  // Persisted to disk BEFORE we even try the network — so a driver with zero signal can
  // close the app entirely and the recording is still sitting there safely next time they
  // open it, instead of only living in memory and vanishing if the app gets closed.
  try {
    await queueSavePendingUpload(pendingUpload);
  } catch (err) {
    console.error('Could not save to offline queue', err);
  }
  showUploadScreen();
  runUpload();
}

function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

let uploadSpeedMark = null;
function setUploadProgress(fraction, info) {
  const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  $('#upload-progress-fill').style.width = pct + '%';
  $('#upload-percent').textContent = pct + '%';
  const det = $('#upload-detail');
  if (det && info && info.total) {
    const mb = (n) => (n / 1048576).toFixed(n >= 10485760 ? 0 : 1);
    const now = Date.now();
    if (!uploadSpeedMark || info.loaded < uploadSpeedMark.loaded) uploadSpeedMark = { t: now, loaded: info.loaded, speed: 0 };
    if (now - uploadSpeedMark.t >= 2000) {
      uploadSpeedMark = { t: now, loaded: info.loaded, speed: (info.loaded - uploadSpeedMark.loaded) / ((now - uploadSpeedMark.t) / 1000) };
    }
    const sp = uploadSpeedMark.speed;
    const left = sp > 0 ? Math.ceil((info.total - info.loaded) / sp) : 0;
    det.textContent = `${mb(info.loaded)} of ${mb(info.total)} MB` + (sp > 0 ? ` · ${(sp / 1048576).toFixed(1)} MB/s · about ${left >= 60 ? Math.ceil(left / 60) + ' min' : left + ' sec'} left` : '');
  }
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
  uploadSpeedMark = null;
  if ($('#upload-detail')) $('#upload-detail').textContent = '';
  setUploadProgress(0);
  startUploadTimer();
  window.onbeforeunload = () => 'An upload is still in progress. Leave anyway?';
}

// The actual network work, with zero UI assumptions — used both by the full-screen flow
// (fresh recording, or an explicit "Retry Now" tap) and by the silent background retry that
// runs on app open/regained connectivity. Throws on failure; the queue entry is only removed
// once the database row is actually confirmed written.
async function performUpload(p, onProgress) {
  const photoBlobs = [];
  for (const d of p.defectsRaw) {
    const res = await fetch(d.photo);
    photoBlobs.push(await res.blob());
  }
  const totalBytes = p.videoBlob.size + photoBlobs.reduce((s, b) => s + b.size, 0) || 1;
  let uploadedBytes = 0;

  const videoPath = `${p.fleetCode}/${p.type}/${p.id}/video.${p.videoExt}`;
  const report = (loaded) => onProgress((uploadedBytes + loaded) / totalBytes, { loaded: uploadedBytes + loaded, total: totalBytes });

  // Small marked photos first (instant), then the big video (resumable, in pieces).
  const defects = [];
  for (let i = 0; i < p.defectsRaw.length; i++) {
    const d = p.defectsRaw[i];
    const blob = photoBlobs[i];
    const photoPath = `${p.fleetCode}/${p.type}/${p.id}/defect-${i}.jpg`;
    await sbUploadFast(photoPath, blob, report, `${p.id}-d${i}`);
    uploadedBytes += blob.size;
    report(0);
    defects.push({ id: d.id, t: d.t, x: d.x, y: d.y, photo_path: photoPath });
  }

  await sbUploadFast(videoPath, p.videoBlob, report, `${p.id}-video`);
  uploadedBytes += p.videoBlob.size;
  report(0);

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
  if (error) {
    if (p.type === 'BASELINE' && (error.code === '23505' || /duplicate|unique/i.test(error.message || ''))) {
      try { await queueRemovePendingUpload(p.id); } catch (e) { /* ignore */ }
      throw new Error(`${p.unit} already has its permanent Assigned Truck Video (someone recorded it first), so this one was not saved.`);
    }
    throw error;
  }

  try {
    await queueRemovePendingUpload(p.id);
  } catch (err) {
    console.error('Could not clear offline queue entry', err);
  }
}

async function runUpload() {
  const p = pendingUpload;
  if (!p) return;
  try {
    await performUpload(p, setUploadProgress);
    checkPendingUploads();

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

function revokeActiveVideoObjectUrls() {
  state.activeVideoObjectUrls.forEach((u) => URL.revokeObjectURL(u));
  state.activeVideoObjectUrls = [];
}

async function openHistory() {
  showScreen('screen-history');
  revokeActiveVideoObjectUrls();
  const list = $('#history-list');
  list.innerHTML = '<div class="empty-state">Loading…</div>';

  const all = await sbGetInspections(state.fleetCode);
  const mine = all.filter((r) => r.driver_email === state.driverEmail);
  list.innerHTML = '';
  if (mine.length === 0) {
    list.innerHTML = '<div class="empty-state">No submissions yet.<br>Run a PTI, Hook, or Drop to see it here.</div>';
    return;
  }
  // Build every card's signed URLs in parallel instead of one at a time — with a lot of
  // history piled up, awaiting each card fully before starting the next turned "open
  // history" into a slow, seemingly-frozen wait (one network round-trip per card, back to
  // back). This fetches all of them concurrently, so total wait is roughly the time of the
  // single slowest card instead of the sum of every card.
  const cards = await Promise.all(mine.map((r) => renderEntryCard(r, false)));
  cards.forEach((card) => list.appendChild(card));
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

// Copies qrcodejs's synchronously-drawn output into a canvas we own (no timer / <img>
// hand-off to race against). Nothing is drawn over the code itself — the in-app scanner is
// jsQR, which has zero tolerance for anything covering the QR, so the unit number goes on
// its own strip below the code (see buildLabeledQrCanvas), never on top of it.
function buildQrCanvas(text, size) {
  const stage = document.createElement('div');
  new QRCode(stage, { text, width: size, height: size, correctLevel: QRCode.CorrectLevel.M });

  const out = document.createElement('canvas');
  out.width = size;
  out.height = size;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);

  const srcCanvas = stage.querySelector('canvas');
  const srcImg = stage.querySelector('img');
  if (srcCanvas) {
    ctx.drawImage(srcCanvas, 0, 0, size, size);
  } else if (srcImg && srcImg.complete && srcImg.naturalWidth) {
    ctx.drawImage(srcImg, 0, 0, size, size);
  }
  return out;
}

// QR code with the unit number printed on a white strip *below* it — one image, but nothing
// overlaps the code, so it scans exactly like a plain QR. Used for the printable download.
function buildLabeledQrCanvas(text, size) {
  const qr = buildQrCanvas(text, size);
  const pad = Math.round(size * 0.06);
  const bandH = Math.round(size * 0.2);
  const out = document.createElement('canvas');
  out.width = size;
  out.height = size + bandH;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(qr, 0, 0);

  ctx.strokeStyle = '#e4e7ec';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(pad, size + 1);
  ctx.lineTo(size - pad, size + 1);
  ctx.stroke();

  let fs = Math.round(bandH * 0.6);
  const fontAt = (px) => `700 ${px}px -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
  ctx.font = fontAt(fs);
  while (fs > 10 && ctx.measureText(text).width > size - pad * 2) {
    fs -= 1;
    ctx.font = fontAt(fs);
  }
  ctx.fillStyle = '#2a2f50';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, size / 2, size + bandH / 2 + 2);
  return out;
}

function renderQrInto(el, text, size) {
  el.innerHTML = '';
  if (!window.QRCode) {
    el.textContent = text;
    return;
  }
  const canvas = buildQrCanvas(text, size);
  canvas.style.display = 'block';
  canvas.style.width = size + 'px';
  canvas.style.height = size + 'px';
  el.appendChild(canvas);
}

function triggerImageDownload(dataUrl, filename) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function downloadUnitQr(unit) {
  if (!window.QRCode) return;
  const canvas = buildLabeledQrCanvas(unit, 560);
  const filename = `${unit}-qr-code.png`;
  const dataUrl = canvas.toDataURL('image/png');
  const isIos = /iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  // iOS Safari ignores <a download> — it just opens the image. Web Share with a real File
  // is the native "Save to Photos / Files" path there (same reasoning as downloadFile()).
  if (isIos && navigator.share && canvas.toBlob) {
    canvas.toBlob((blob) => {
      if (!blob) { triggerImageDownload(dataUrl, filename); return; }
      const file = new File([blob], filename, { type: 'image/png' });
      navigator.share({ files: [file], title: `${unit} QR code` }).catch((err) => {
        if (err && err.name === 'AbortError') return;
        triggerImageDownload(dataUrl, filename);
      });
    }, 'image/png');
    return;
  }
  triggerImageDownload(dataUrl, filename);
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
    row.dataset.search = `${u.unit} ${u.kind === 'truck' ? 'truck' : 'trailer'}`.toLowerCase();
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
    renderQrInto(row.querySelector('.unit-qr-thumb'), u.unit, 60);
    row.querySelector('.unit-download-btn').addEventListener('click', () => downloadUnitQr(u.unit));
    row.querySelector('.unit-remove-btn').addEventListener('click', async () => {
      const kindLabel = u.kind === 'truck' ? 'truck' : 'trailer';
      if (!confirm(`Delete the QR code for ${kindLabel} ${u.unit}? Drivers won't be able to scan it anymore.`)) return;
      await sbDeleteUnit(u.id);
      renderUnitsList();
    });
    list.appendChild(row);
  });
  applyUnitsSearch();
}

// Hides unit rows that don't match what is typed in the Trucks & Trailers search bar.
function applyUnitsSearch() {
  const input = $('#units-search');
  const list = $('#units-list');
  if (!input || !list) return;
  const words = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let shown = 0;
  list.querySelectorAll('.unit-row').forEach((row) => {
    const hay = row.dataset.search || '';
    const match = words.every((w) => hay.includes(w));
    row.style.display = match ? '' : 'none';
    if (match) shown += 1;
  });
  let none = list.querySelector('.units-no-match');
  if (words.length && shown === 0 && list.querySelector('.unit-row')) {
    if (!none) {
      none = document.createElement('div');
      none.className = 'empty-state units-no-match';
      list.appendChild(none);
    }
    none.textContent = 'No truck or trailer matches "' + input.value.trim() + '".';
  } else if (none) {
    none.remove();
  }
}

// Manager security code on the dashboard: tap Show to reveal it, "New code" (tap twice) changes it.
function setupManagerCodeChip() {
  const valEl = $('#mgr-code-value');
  const showBtn = $('#btn-mgr-code-show');
  const newBtn = $('#btn-mgr-code-new');
  if (!valEl || !showBtn || !newBtn) return;
  let shown = false;
  let confirmTimer = null;
  const MASK = '••••••••';
  const hide = () => { shown = false; valEl.textContent = MASK; showBtn.textContent = 'Show'; };
  const resetNew = () => { clearTimeout(confirmTimer); newBtn.textContent = 'New code'; newBtn.dataset.armed = ''; };
  showBtn.addEventListener('click', async () => {
    if (shown) { hide(); return; }
    showBtn.disabled = true;
    try {
      valEl.textContent = (await sbGetManagerCode()) || '—';
      shown = true;
      showBtn.textContent = 'Hide';
    } catch (err) {
      console.error('Could not read manager code', err);
      valEl.textContent = 'not set up yet';
    }
    showBtn.disabled = false;
  });
  newBtn.addEventListener('click', async () => {
    if (!newBtn.dataset.armed) {
      newBtn.dataset.armed = '1';
      newBtn.textContent = 'Tap again to confirm';
      confirmTimer = setTimeout(resetNew, 4000);
      return;
    }
    resetNew();
    newBtn.disabled = true;
    try {
      valEl.textContent = await sbRegenerateManagerCode();
      shown = true;
      showBtn.textContent = 'Hide';
    } catch (err) {
      console.error('Could not change manager code', err);
      valEl.textContent = 'could not change it';
    }
    newBtn.disabled = false;
  });
}

async function renderManagersList() {
  const list = $('#managers-list');
  if (!list) return;
  let managers = [];
  try {
    managers = await sbGetFleetManagers(state.fleetCode);
  } catch (err) {
    $('#managers-count').textContent = '–';
    list.innerHTML = '<div class="empty-state">Could not load fleet managers — try again in a moment.</div>';
    return;
  }
  $('#managers-count').textContent = String(managers.length);
  list.innerHTML = '';
  if (managers.length === 0) {
    list.innerHTML = '<div class="empty-state">No fleet managers found.</div>';
    return;
  }
  managers.forEach((m) => {
    const row = document.createElement('div');
    row.className = 'entry-card driver-row';
    const you = m.id === state.userId;
    row.innerHTML = `
      <div class="driver-avatar">${escapeHtml((m.name || '?').trim().charAt(0).toUpperCase())}</div>
      <div class="driver-row-info">
        <div class="entry-unit">${escapeHtml(m.name)}${you ? '<span class="pti-unit">You</span>' : ''}</div>
        <div class="entry-meta"><span>${escapeHtml(m.email)}</span>${m.phone ? `<span>${escapeHtml(m.phone)}</span>` : ''}</div>
      </div>`;
    list.appendChild(row);
  });
}

async function renderDriversList() {
  renderManagersList();
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
  let recent = null;
  try {
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    recent = await sbGetRecentInspections(state.fleetCode, since);
  } catch (err) {
    recent = null;
  }
  let perDriver = null;
  try { perDriver = await sbGetDriverCounts(state.fleetCode); } catch (err) { perDriver = null; }
  let counts = { green: 0, yellow: 0, red: 0 };
  drivers.forEach((d) => {
    d._counts = perDriver ? (perDriver[d.id] || { PTI: 0, DROP: 0, HOOK: 0, total: 0 }) : null;
    d._pti = recent ? computePtiStatus(d, recent) : null;
    if (d._pti) counts[d._pti.level] += 1;
  });
  if (recent) {
    const rank = { red: 0, yellow: 1, green: 2 };
    drivers.sort((a, b) => rank[a._pti.level] - rank[b._pti.level] || (a.name || '').localeCompare(b.name || ''));
  }
  $('#drivers-count').textContent = String(drivers.length);
  statsEl.innerHTML = `
    <button type="button" class="stat-card drv-filter" data-drvfilter="all"><div class="stat-num">${drivers.length}</div><div class="stat-label">Active drivers</div></button>
    ${recent ? `
    <button type="button" class="stat-card drv-filter" data-drvfilter="green"><div class="stat-num"><span class="pti-dot pti-green"></span>${counts.green}</div><div class="stat-label">PTI done today</div></button>
    <button type="button" class="stat-card drv-filter" data-drvfilter="yellow"><div class="stat-num"><span class="pti-dot pti-yellow"></span>${counts.yellow}</div><div class="stat-label">Not yet</div></button>
    <button type="button" class="stat-card drv-filter" data-drvfilter="red"><div class="stat-num"><span class="pti-dot pti-red"></span>${counts.red}</div><div class="stat-label">Missing PTI</div></button>
    ` : ''}
  `;
  // Tap a status card to show only those drivers; tap it again (or "Active drivers") to see everyone.
  statsEl.querySelectorAll('.drv-filter').forEach((btn) => {
    btn.addEventListener('click', () => {
      const f = btn.dataset.drvfilter;
      state.driversFilter = (f === 'all' || state.driversFilter === f) ? 'all' : f;
      applyDriversSearch();
    });
  });
  if (drivers.length === 0) {
    list.innerHTML = '<div class="empty-state">No drivers have joined with your fleet code yet.</div>';
    return;
  }
  drivers.forEach((d) => {
    const row = document.createElement('div');
    row.className = 'entry-card driver-row';
    row.dataset.search = [d.name, d.email, d.assigned_unit].filter(Boolean).join(' ').toLowerCase();
    row.dataset.level = d._pti ? d._pti.level : '';
    renderDriverRowView(row, d);
    list.appendChild(row);
  });
  applyDriversSearch();
}

// Hides driver rows that don't match what is typed in the search bar (name, login or assigned truck/trailer).
function applyDriversSearch() {
  const input = $('#drivers-search');
  const list = $('#drivers-list');
  if (!input || !list) return;
  const q = input.value.trim().toLowerCase();
  const words = q ? q.split(/\s+/) : [];
  let shown = 0;
  const lvl = state.driversFilter || 'all';
  list.querySelectorAll('.driver-row').forEach((row) => {
    const hay = row.dataset.search || '';
    const match = words.every((w) => hay.includes(w)) && (lvl === 'all' || row.dataset.level === lvl);
    row.style.display = match ? '' : 'none';
    if (match) shown += 1;
  });
  document.querySelectorAll('#drivers-stats .drv-filter').forEach((b) => {
    const f = b.dataset.drvfilter;
    b.classList.toggle('active-filter', f !== 'all' && f === lvl);
  });
  let none = list.querySelector('.drivers-no-match');
  if ((words.length || lvl !== 'all') && shown === 0) {
    if (!none) {
      none = document.createElement('div');
      none.className = 'empty-state drivers-no-match';
      list.appendChild(none);
    }
    none.textContent = words.length ? 'No driver or truck matches "' + input.value.trim() + '".' : 'No drivers in this group.';
  } else if (none) {
    none.remove();
  }
}

// A driver who hasn't uploaded a PTI by this hour (manager's local time) turns from yellow to red.
const PTI_DEADLINE_HOUR = 12;

function computePtiStatus(driver, inspections) {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const mine = inspections.filter((r) => r.driver_id === driver.id);
  const todayPti = mine.find((r) => r.type === 'PTI' && new Date(r.created_at) >= startOfToday);
  const fmt = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (todayPti) {
    return { level: 'green', text: `PTI done at ${fmt(new Date(todayPti.created_at))}`, unit: todayPti.unit };
  }
  const last = mine[0];
  const lastPti = mine.find((r) => r.type === 'PTI');
  const lastText = lastPti
    ? `last PTI ${new Date(lastPti.created_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}`
    : 'no PTI in the last 7 days';
  const unit = last ? last.unit : (driver.assigned_unit || '');
  const pastDeadline = new Date().getHours() >= PTI_DEADLINE_HOUR;
  return pastDeadline
    ? { level: 'red', text: `No PTI today — ${lastText}`, unit }
    : { level: 'yellow', text: `No PTI yet today — ${lastText}`, unit };
}

function closeAllDriverMenus() {
  $$('.driver-menu.show').forEach((m) => m.classList.remove('show'));
}

function renderDriverRowView(row, d) {
  row.classList.remove('driver-row-editing');
  row.onclick = (e) => { if (e.target.closest('.driver-menu-wrap')) return; openDriverWindow(d); };
  row.title = 'Open all of ' + (d.name || 'this driver') + "'s inspections";
  row.innerHTML = `
    <div class="driver-avatar">${escapeHtml((d.name || '?').trim().charAt(0).toUpperCase())}</div>
    <div class="driver-row-info">
      <div class="entry-unit">${d._pti ? `<span class="pti-dot pti-${d._pti.level}"></span>` : ''}${escapeHtml(d.name)}${d._pti && d._pti.unit ? `<span class="pti-unit">${escapeHtml(d._pti.unit)}</span>` : ''}</div>
      ${d._pti ? `<div class="pti-status pti-status-${d._pti.level}">${escapeHtml(d._pti.text)}</div>` : ''}
      <div class="entry-meta"><span>${escapeHtml(d.email)}</span>${d.phone ? `<span>${escapeHtml(d.phone)}</span>` : ''}</div>
      ${d.assigned_unit ? `<div class="driver-assigned">Assigned: ${escapeHtml(d.assigned_unit)}</div>` : ''}
    </div>
    ${d._counts ? `<button type="button" class="driver-count" title="PTI ${d._counts.PTI} · Drop ${d._counts.DROP} · Hook ${d._counts.HOOK} — tap to open them all"><span class="driver-count-num">${d._counts.total}</span><span class="driver-count-label">${d._counts.total === 1 ? 'inspection' : 'inspections'}</span></button>` : ''}
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

// Checks (with a throw-away connection that does not touch the manager's own session) that the
// driver can really sign in with this login + password.
async function verifyDriverLogin(email, password) {
  try {
    const cfg = window.SUPABASE_CONFIG;
    const c = window.supabase.createClient(cfg.url, cfg.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { error } = await c.auth.signInWithPassword({ email, password });
    if (error) return { ok: false, message: error.message };
    try { await c.auth.signOut(); } catch (e) { /* ignore */ }
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : 'could not check' };
  }
}

function renderDriverRowEdit(row, d) {
  row.classList.add('driver-row-editing');
  row.onclick = null;
  row.title = '';
  row.innerHTML = `
    <div class="driver-avatar">${escapeHtml((d.name || '?').trim().charAt(0).toUpperCase())}</div>
    <div class="driver-row-info driver-edit-form">
      <label class="driver-edit-label">Driver name</label>
      <input class="field field-inline driver-edit-name" value="${escapeHtml(d.name)}" placeholder="Driver name" />
      <label class="driver-edit-label">Login (what the driver types to sign in)</label>
      <input class="field field-inline driver-edit-email" type="text" name="drv-login" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" value="${escapeHtml(d.email)}" placeholder="name@gmail.com" />
      <label class="driver-edit-label">New password: exactly what you type here becomes the password (leave empty to keep the current one)</label>
      <input class="field field-inline driver-edit-pass" type="text" name="drv-newpass" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="Type the new password" />
      <label class="driver-edit-label">Assigned truck/trailer (optional)</label>
      <input class="field field-inline driver-edit-unit" value="${escapeHtml(d.assigned_unit || '')}" placeholder="Assigned truck/trailer (optional)" />
      <div class="driver-edit-msg" style="display:none;"></div>
      <div class="driver-edit-actions">
        <button class="btn btn-secondary driver-edit-cancel" type="button">Cancel</button>
        <button class="btn btn-primary driver-edit-save" type="button">Save</button>
      </div>
    </div>
  `;
  const msgEl = row.querySelector('.driver-edit-msg');
  const showMsg = (text, kind) => {
    msgEl.textContent = text;
    msgEl.className = 'driver-edit-msg ' + (kind || '');
    msgEl.style.display = text ? 'block' : 'none';
  };
  row.querySelector('.driver-edit-cancel').addEventListener('click', () => renderDriverRowView(row, d));
  const saveBtn = row.querySelector('.driver-edit-save');
  saveBtn.addEventListener('click', async () => {
    const newName = row.querySelector('.driver-edit-name').value.trim();
    let newEmail = row.querySelector('.driver-edit-email').value.trim().toLowerCase();
    const newPass = row.querySelector('.driver-edit-pass').value;   // used exactly as typed
    const newUnit = row.querySelector('.driver-edit-unit').value.trim();
    if (!newName) { showMsg('Name cannot be empty.', 'error'); return; }
    if (!newEmail) newEmail = String(d.email || '').toLowerCase();
    if (!newEmail.includes('@')) newEmail += '@gmail.com';
    if (newPass && newPass.length < 6) { showMsg('The password needs at least 6 characters.', 'error'); return; }
    const loginChanged = newEmail !== String(d.email || '').toLowerCase();
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    showMsg('', '');
    try {
      await sbManagerUpdateDriver(d.id, { name: newName, email: newEmail, password: newPass, unit: newUnit });
    } catch (err) {
      console.error('Update driver failed', err);
      const msg = err && err.message ? err.message : 'try again';
      showMsg(/manager_update_driver|schema cache|does not exist/i.test(msg)
        ? 'The database part of this feature is not installed yet.'
        : 'Could not save: ' + msg, 'error');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
      return;
    }
    if (!newPass && !loginChanged) { renderDriversList(); return; }
    // Saved. Prove it works, then show the driver's details on screen.
    let verifyHtml = '';
    if (newPass) {
      saveBtn.textContent = 'Checking…';
      const v = await verifyDriverLogin(newEmail, newPass);
      verifyHtml = v.ok
        ? '<div class="driver-done-ok">✔ Checked: this login and password work.</div>'
        : `<div class="driver-done-bad">Saved, but the check could not log in (${escapeHtml(v.message)}). Try Edit again.</div>`;
    }
    row.innerHTML = `
      <div class="driver-avatar">${escapeHtml(newName.charAt(0).toUpperCase())}</div>
      <div class="driver-row-info driver-edit-form">
        <div class="driver-done-title">Saved for ${escapeHtml(newName)}</div>
        <div class="driver-done-box">
          <div>Login: <strong>${escapeHtml(newEmail)}</strong></div>
          <div>Password: <strong>${newPass ? escapeHtml(newPass) : '(unchanged)'}</strong></div>
        </div>
        ${verifyHtml}
        <div class="driver-done-note">Tell the driver now. The password can't be looked up later, but you can always set a new one.</div>
        <div class="driver-edit-actions"><button class="btn btn-primary driver-done-btn" type="button">Done</button></div>
      </div>`;
    row.querySelector('.driver-done-btn').addEventListener('click', () => renderDriversList());
  });
}

/* ---------------- fleet manager dashboard ---------------- */

const DASH_PAGE_TITLES = {
  overview: ['Dashboard', 'Today at a glance, synced in real time'],
  inspections: ['Inspections', 'PTIs: videos and flagged photos from every driver'],
  drophook: ['Drop & Hook', 'Trailer drops and hooks, kept apart from the PTIs'],
  units: ['Trucks & Trailers', 'Your fleet units and their QR codes'],
  drivers: ['Drivers', 'Everyone signed up with your fleet code'],
  adddriver: ['Add Driver', 'Create a driver account that is linked to your fleet'],
  assigned: ['Assigned Truck Video', 'The first video of every truck, recorded by drivers before use. Kept forever.'],
  settings: ['Settings', 'Fleet codes and your account'],
};

function setSideDrawer(open) {
  const scr = $('#screen-dashboard');
  if (scr) scr.classList.toggle('side-open', Boolean(open));
}

// 'pti' = only PTIs. 'dh' = only Drops and Hooks (with an All / Drop / Hook filter).
function setDashSection(sec) {
  state.dashSection = sec;
  state.dashType = '';
  const chips = $('#dh-chips');
  if (chips) {
    chips.style.display = sec === 'dh' ? 'flex' : 'none';
    chips.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c.dataset.dh === ''));
  }
  const sel = $('#filter-type'); if (sel) sel.value = '';
}

function switchDashTab(panel) {
  $$('.dash-tab').forEach((t) => t.classList.toggle('active', t.dataset.panel === panel));
  const panelId = panel === 'drophook' ? 'inspections' : panel; // PTIs and Drop & Hook share one list view
  $$('.dash-panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${panelId}`));
  const titles = DASH_PAGE_TITLES[panel] || ['', ''];
  $('#dash-page-title').textContent = titles[0];
  $('#dash-page-sub').textContent = titles[1];
  $$('#screen-dashboard video').forEach((v) => { try { v.pause(); } catch (e) { /* ignore */ } });
  setSideDrawer(false);
  try { window.scrollTo(0, 0); } catch (e) { /* ignore */ }
  if (panel === 'overview') renderOverview();
  if (panel === 'units') renderUnitsList();
  if (panel === 'inspections' || panel === 'drophook') {
    setDashSection(panel === 'drophook' ? 'dh' : 'pti');
    renderDashboard();
  }
  if (panel === 'drivers') renderDriversList();
  if (panel === 'adddriver') resetAddDriverForm();
  if (panel === 'assigned' && typeof renderAssignedPanel === 'function') renderAssignedPanel();
  if (panel === 'settings') fillSettingsPanel();
}

/* ---------------- dashboard overview ---------------- */

async function renderOverview() {
  const statsEl = $('#ov-stats');
  const attEl = $('#ov-attention');
  const latestEl = $('#ov-latest');
  if (!statsEl) return;
  attEl.innerHTML = '<div class="ov-empty">Loading…</div>';
  latestEl.innerHTML = '<div class="ov-empty">Loading…</div>';
  let all = [];
  let drivers = [];
  try {
    const weekIso = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    let total = 0;
    [all, drivers, total] = await Promise.all([sbGetInspections(state.fleetCode, { since: weekIso }), sbGetFleetDrivers(state.fleetCode), sbCountInspections(state.fleetCode)]);
    state.ovTotal = total;
    if (state.role === 'manager') all = await purgeExpiredInspections(all);
  } catch (err) {
    statsEl.innerHTML = '';
    attEl.innerHTML = '<div class="ov-empty">Could not load — try again in a moment.</div>';
    latestEl.innerHTML = '';
    return;
  }
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todays = all.filter((r) => new Date(r.created_at) >= startOfToday);
  const flaggedToday = todays.filter((r) => r.defects && r.defects.length > 0).length;
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const recent = all.filter((r) => new Date(r.created_at).getTime() >= weekAgo);
  const counts = { green: 0, yellow: 0, red: 0 };
  const needs = [];
  drivers.forEach((d) => {
    const st = computePtiStatus(d, recent);
    counts[st.level] += 1;
    if (st.level !== 'green') needs.push({ d, st });
  });
  needs.sort((a, b) => (a.st.level === 'red' ? 0 : 1) - (b.st.level === 'red' ? 0 : 1) || (a.d.name || '').localeCompare(b.d.name || ''));

  statsEl.innerHTML = `
    <button class="stat-card" type="button" data-go="inspections"><div class="stat-num">${todays.length}</div><div class="stat-label">Inspections today</div></button>
    <button class="stat-card" type="button" data-go="drivers"><div class="stat-num">${counts.green}<span class="stat-of"> / ${drivers.length}</span></div><div class="stat-label">Drivers done with PTI</div></button>
    <button class="stat-card red" type="button" data-go="drivers"><div class="stat-num">${counts.red}</div><div class="stat-label">Missing PTI</div></button>
    <button class="stat-card orange" type="button" data-go="inspections"><div class="stat-num">${flaggedToday}</div><div class="stat-label">Flagged today</div></button>
    <button class="stat-card" type="button" data-go="inspections"><div class="stat-num">${state.ovTotal != null ? state.ovTotal : all.length}</div><div class="stat-label">Total on record</div></button>
  `;
  statsEl.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => switchDashTab(b.dataset.go)));

  if (drivers.length === 0) {
    attEl.innerHTML = '<div class="ov-empty">No drivers yet. Use <strong>Add Driver</strong> in the menu to create one.</div>';
  } else if (needs.length === 0) {
    attEl.innerHTML = '<div class="ov-empty">Everyone has done their PTI today.</div>';
  } else {
    attEl.innerHTML = needs.slice(0, 8).map(({ d, st }) => `
      <div class="ov-row clickable" data-go="drivers">
        <span class="pti-dot pti-${st.level}"></span>
        <div class="ov-row-main"><div class="ov-row-title">${escapeHtml(d.name)}</div><div class="ov-row-sub">${escapeHtml(st.text)}</div></div>
      </div>`).join('') + (needs.length > 8 ? `<div class="ov-empty">+ ${needs.length - 8} more in Drivers</div>` : '');
    attEl.querySelectorAll('[data-go]').forEach((r) => r.addEventListener('click', () => switchDashTab(r.dataset.go)));
  }

  if (all.length === 0) {
    latestEl.innerHTML = '<div class="ov-empty">No inspections yet.</div>';
  } else {
    latestEl.innerHTML = all.slice(0, 7).map((r) => `
      <div class="ov-row clickable" data-go="${r.type === 'PTI' ? 'inspections' : 'drophook'}">
        <span class="entry-type ${escapeHtml(r.type)}">${escapeHtml(r.type)}</span>
        <div class="ov-row-main"><div class="ov-row-title">${escapeHtml(r.unit)} · ${escapeHtml(r.driver_name)}</div><div class="ov-row-sub">${escapeHtml(fmtWhen(new Date(r.created_at).getTime()))}${r.defects && r.defects.length ? ` · ${r.defects.length} flagged` : ''}</div></div>
      </div>`).join('');
    latestEl.querySelectorAll('[data-go]').forEach((r) => r.addEventListener('click', () => switchDashTab(r.dataset.go)));
  }
}

/* ---------------- add driver (manager creates the account) ---------------- */

function resetAddDriverForm() {
  ['#ad-name', '#ad-email', '#ad-phone', '#ad-password', '#ad-password2', '#ad-unit'].forEach((s) => { const el = $(s); if (el) el.value = ''; });
  const f = $('#ad-fleet'); if (f) f.value = state.fleetCode || '';
  const e = $('#ad-error'); if (e) e.style.display = 'none';
  const b = $('#btn-add-driver'); if (b) { b.disabled = false; b.textContent = 'Create Driver Account'; }
  $('#add-driver-form').style.display = 'block';
  $('#add-driver-done').style.display = 'none';
}

async function onAddDriver() {
  const errEl = $('#ad-error');
  const showErr = (m) => { errEl.textContent = m; errEl.style.display = 'block'; };
  errEl.style.display = 'none';
  const name = $('#ad-name').value.trim();
  let email = $('#ad-email').value.trim().toLowerCase();
  const phone = $('#ad-phone').value.trim();
  const password = $('#ad-password').value;
  const password2 = $('#ad-password2').value;
  const unit = $('#ad-unit').value.trim();
  if (!name || !email || !password) { showErr('Fill in the name, login and password.'); return; }
  if (!email.includes('@')) email += '@gmail.com';
  if (phone.replace(/\D/g, '').length < 10) { showErr('Enter the driver\'s phone number (at least 10 digits).'); return; }
  if (password.length < 6) { showErr('Password must be at least 6 characters.'); return; }
  if (password !== password2) { showErr('Passwords don\'t match — check both fields.'); return; }

  const btn = $('#btn-add-driver');
  btn.disabled = true;
  btn.textContent = 'Creating…';
  let newId = null;
  try {
    // A throw-away connection, so the manager stays logged in as themselves.
    const cfg = window.SUPABASE_CONFIG;
    const c = window.supabase.createClient(cfg.url, cfg.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error } = await c.auth.signUp({
      email, password,
      options: { data: { name, phone, role: 'driver', fleet_code: state.fleetCode, manager_code: '' } },
    });
    if (error) throw error;
    newId = data && data.user ? data.user.id : null;
    if (data && data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      throw new Error('That login is already used by someone else.');
    }
    try { await c.auth.signOut(); } catch (e) { /* ignore */ }
  } catch (err) {
    console.error('Add driver failed', err);
    const msg = err && err.message ? err.message : 'try again';
    showErr(/already|registered/i.test(msg) ? 'That login is already used by someone else.' : 'Could not create the account: ' + msg);
    btn.disabled = false;
    btn.textContent = 'Create Driver Account';
    return;
  }
  if (newId && unit) {
    try { await sbUpdateDriver(newId, { assigned_unit: unit }); } catch (e) { console.warn('Could not set assigned unit', e); }
  }
  let verifyHtml = '';
  const v = await verifyDriverLogin(email, password);
  verifyHtml = v.ok
    ? '<div class="driver-done-ok">✔ Checked: this login and password work.</div>'
    : `<div class="driver-done-bad">Created, but the check could not log in (${escapeHtml(v.message)}). Try the Drivers tab → Edit to set the password again.</div>`;
  $('#ad-done-title').textContent = `Driver created: ${name}`;
  $('#ad-done-box').innerHTML = `<div>Login: <strong>${escapeHtml(email)}</strong></div><div>Password: <strong>${escapeHtml(password)}</strong></div>${unit ? `<div>Truck/trailer: <strong>${escapeHtml(unit)}</strong></div>` : ''}`;
  $('#ad-done-check').innerHTML = verifyHtml;
  $('#add-driver-form').style.display = 'none';
  $('#add-driver-done').style.display = 'block';
}

/* ---------------- settings ---------------- */

function fillSettingsPanel() {
  const fc = $('#fleet-code-value-2'); if (fc) fc.textContent = state.fleetCode || '—';
  const n = $('#set-name'); if (n) n.textContent = state.driverName || '—';
  const e = $('#set-email'); if (e) e.textContent = state.driverEmail || '—';
  ['#pw-current', '#pw-new', '#pw-new2'].forEach((s) => { const el = $(s); if (el) el.value = ''; });
  const pe = $('#pw-error'); if (pe) pe.style.display = 'none';
  const po = $('#pw-ok'); if (po) po.style.display = 'none';
}

function clearDateRangeInputs() {
  state.dashFrom = '';
  state.dashTo = '';
  const f = $('#filter-from'); if (f) f.value = '';
  const t = $('#filter-to'); if (t) t.value = '';
  const b = $('#range-box'); if (b) b.classList.remove('active');
  const c = $('#filter-range-clear'); if (c) c.style.display = 'none';
  if (typeof syncDateBtns === 'function') syncDateBtns();
}

// Earliest date the Inspections list needs from the server for the current time filter.
function dashSinceIso() {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const r = state.dashRange;
  if (r === 'today') return new Date(todayStart - 86400000).toISOString(); // a day of slack for time zones
  if (r === '7d') return new Date(todayStart - 7 * 86400000).toISOString();
  if (r === '30d') return new Date(todayStart - 30 * 86400000).toISOString();
  if (r === 'range') {
    const a = state.dashFrom ? new Date(state.dashFrom + 'T00:00:00').getTime() : null;
    const b = state.dashTo ? new Date(state.dashTo + 'T00:00:00').getTime() : null;
    const lo = a != null && b != null ? Math.min(a, b) : (a != null ? a : b);
    if (a != null && b == null) return new Date(a - 86400000).toISOString();
    if (a == null && b != null) return null; // "up to" a date: everything older is needed
    return new Date(lo - 86400000).toISOString();
  }
  return null;
}

function inRange(ts, range) {
  const now = new Date();
  const startOfDay = (dt) => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime();
  const todayStart = startOfDay(now);
  if (range === 'today') return ts >= todayStart;
  if (range === '7d') return ts >= todayStart - 6 * 86400000;
  if (range === '30d') return ts >= todayStart - 29 * 86400000;
  if (range === 'range') {
    const fromStart = state.dashFrom ? new Date(state.dashFrom + 'T00:00:00').getTime() : null;
    const toStart = state.dashTo ? new Date(state.dashTo + 'T00:00:00').getTime() : null;
    let lo = fromStart;
    let hi = toStart != null ? toStart + 86400000 : null;
    // if the two dates were picked in the wrong order, treat them as a window anyway
    if (fromStart != null && toStart != null && fromStart > toStart) { lo = toStart; hi = fromStart + 86400000; }
    return (lo == null || ts >= lo) && (hi == null || ts < hi);
  }
  return true;
}

// Inspections (video + defect photos) older than this are deleted automatically the first
// time a manager opens the dashboard each day. Same delete path as the manual Delete button.
// Assigned Truck Videos (type BASELINE) are skipped here and kept forever.
const RETENTION_DAYS = 90; // 3 months
const PURGE_BATCH_LIMIT = 40;

async function purgeExpiredInspections(all) {
  try {
    const today = new Date().toDateString();
    if (localStorage.getItem('pti_last_purge') === today) return all;
    const cutoffIso = new Date(Date.now() - RETENTION_DAYS * 24 * 3600 * 1000).toISOString();
    const expired = await sbGetExpiredInspections(state.fleetCode, cutoffIso, PURGE_BATCH_LIMIT);
    if (expired.length === 0) {
      localStorage.setItem('pti_last_purge', today);
      return all;
    }
    const removedIds = new Set();
    for (const r of expired) {
      const paths = [r.video_path, ...(r.defects || []).map((d) => d.photo_path)].filter(Boolean);
      try {
        await sbDeleteStorageObjects(paths);
        await sbDeleteInspection(r.id);
        removedIds.add(r.id);
      } catch (err) {
        console.warn('Auto-delete skipped one inspection', r.id, err);
      }
    }
    if (removedIds.size === expired.length && expired.length < PURGE_BATCH_LIMIT) {
      localStorage.setItem('pti_last_purge', today);
    }
    return all.filter((r) => !removedIds.has(r.id));
  } catch (err) {
    console.warn('Auto-delete check failed', err);
    return all;
  }
}

// Search bar on the Inspections tab: every typed word must appear in the driver's name, login, or the truck/trailer.
function matchesDashSearch(r) {
  const q = (state.dashSearch || '').trim().toLowerCase();
  if (!q) return true;
  const hay = [r.driver_name, r.driver_email, r.unit].filter(Boolean).join(' ').toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

async function renderDashboard() {
  revokeActiveVideoObjectUrls();
  const list = $('#dash-list');
  list.innerHTML = '<div class="empty-state">Loading…</div>';

  let all = await sbGetInspections(state.fleetCode, { since: dashSinceIso() });
  if (state.role === 'manager') all = await purgeExpiredInspections(all);
  // Two separate sections: PTIs on one, Drops and Hooks on the other.
  all = all.filter((r) => (state.dashSection === 'dh' ? (r.type === 'HOOK' || r.type === 'DROP') : r.type === 'PTI'));
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
    matchesDashSearch(r) &&
    (!state.dashOnlyDefects || (r.defects && r.defects.length > 0))
  );

  const withDefects = all.filter((r) =>
    inRange(new Date(r.created_at).getTime(), state.dashRange) &&
    (!state.dashDriver || r.driver_name === state.dashDriver) &&
    (!state.dashType || r.type === state.dashType) &&
    (!state.dashUnit || r.unit === state.dashUnit) &&
    matchesDashSearch(r) &&
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
    state.dashSearch = '';
    $('#dash-search').value = '';
    state.dashType = '';
    $$('#dh-chips .chip').forEach((c) => c.classList.toggle('active', c.dataset.dh === ''));
    state.dashOnlyDefects = false;
    $$('#filter-time .chip').forEach((c) => c.classList.remove('active'));
    clearDateRangeInputs();
    $$('#filter-time .chip[data-range="all"]').forEach((c) => c.classList.add('active'));
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
  // Same fix as driver history — build cards concurrently, not one full round-trip at a time.
  const cards = await Promise.all(filtered.map((r) => renderEntryCard(r, true)));
  cards.forEach((card) => list.appendChild(card));
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
  // No `src` set here on purpose — pointing <video> straight at the remote signed URL makes
  // Safari treat it as a stream it needs to seek/probe, and a raw MediaRecorder file doesn't
  // have the index that requires, which is exactly what caused "plays a few seconds then
  // errors." Fully fetching the file into memory first and playing it as a local blob (like
  // the working right-after-recording preview already does) sidesteps that entirely — it's
  // loaded lazily, only once this specific entry is actually opened, not for every item in
  // the list.
  const videoHtml = videoUrl
    ? `<div class="entry-video-wrap">
         <div class="entry-video-loading">Loading video…</div>
         <video playsinline preload="none" style="display:none;" data-remote-url="${videoUrl}" data-marks="${escapeHtml(JSON.stringify((r.defects || []).map((d) => d.t)))}" data-known-duration="${Number(r.duration_sec) || 0}"></video>
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
        <span class="entry-type ${r.type}">${typeLabel(r.type)}</span>
        <span class="entry-unit">${unit}</span>
      </div>
      <div style="font-size:12.5px; color:var(--text-mute);">${fmtWhen(createdAtMs)}</div>
    </div>
    <div class="entry-meta">
      ${showDriver ? `<span class="entry-driver">${driverName}</span>` : ''}
      <span class="entry-video-hint">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        ${videoUrl ? `Watch video (${fmtTime(r.duration_sec)}) — tap to open` : 'Video unavailable'}
      </span>
      ${hasDefects ? `<span class="entry-defect-flag"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>${r.defects.length} defect${r.defects.length > 1 ? 's' : ''} flagged</span>` : '<span>No defects flagged</span>'}
    </div>
    <div class="entry-details">
      <div class="entry-detail-row">Unit ${unit} · ${typeLabel(r.type)} · ${new Date(r.created_at).toLocaleString()}</div>
      ${showDriver ? `<div class="entry-detail-row">Driver: ${driverName}${driverEmail ? ` · <a href="mailto:${driverEmail}">${driverEmail}</a>` : ''}${driverPhone ? ` · ${driverPhone}` : ''}</div>` : ''}
      <div class="entry-detail-row">Location: ${locationHtml}</div>
      ${videoHtml}
      ${hasDefects ? `<div class="mark-chips mark-chips-mgr"><span class="mark-chips-label">Driver flagged:</span>${r.defects.map((d) => `<span class="mark-chip"><button type="button" class="mark-chip-go" data-t="${d.t}">&#9873; ${fmtTime(d.t)}</button></span>`).join('')}</div>` : ''}
      ${photosHtml}
      ${state.role === 'manager' && r.type !== 'BASELINE' ? `
        <button class="entry-delete-btn" type="button">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
          Delete this inspection
        </button>
      ` : ''}
    </div>
  `;
  card.addEventListener('click', () => {
    const opening = !card.classList.contains('open');
    card.classList.toggle('open');
    if (opening) loadCardVideo(card);
    else card.querySelectorAll('video').forEach((v) => { try { v.pause(); } catch (e) { /* ignore */ } }); // closing the card stops the video
  });
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
        if (card.closest('#app-modal')) card.remove();
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
  card.querySelectorAll('.mark-chips-mgr .mark-chip-go').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await loadCardVideo(card);
      const v = card.querySelector('.entry-video-wrap video');
      if (!v) return;
      const t = Math.max(0, parseFloat(btn.dataset.t) - 2);
      const go = () => { v.currentTime = t; v.play().catch(() => {}); };
      if (v.readyState >= 1) go(); else v.addEventListener('loadedmetadata', go, { once: true });
    });
  });
  const drvLink = card.querySelector('.entry-driver');
  if (drvLink && state.role === 'manager' && r.driver_id) {
    drvLink.classList.add('entry-driver-link');
    drvLink.title = "See all of this driver's inspections";
    drvLink.addEventListener('click', (e) => {
      e.stopPropagation();
      openDriverWindow({ id: r.driver_id, name: r.driver_name, email: r.driver_email, phone: r.driver_phone });
    });
  }
  card.querySelector('.mark-chips-mgr')?.addEventListener('click', (e) => e.stopPropagation());
  card.querySelector('.entry-video-wrap')?.addEventListener('click', (e) => e.stopPropagation());
  card.querySelector('.entry-video-actions')?.addEventListener('click', (e) => e.stopPropagation());
  return card;
}

// Safari's MediaRecorder writes MP4s (and Chrome's writes WebMs) with broken duration
// metadata — a documented Safari bug where the moov atom's duration fields all report 0.
// That breaks both the reported length and the ability to seek at all (forward-seeking has
// nowhere valid to land, so it resets to 0). Well-known workaround: forcing a seek to a huge
// timestamp makes the browser actually scan the file to find the real end, fixing both.
// Harmless no-op if the duration was already fine.
function fixBrokenDuration(video) {
  const tryFix = () => {
    if (Number.isFinite(video.duration) && video.duration > 0) return;
    const onTimeUpdate = () => {
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.currentTime = 0;
    };
    video.addEventListener('timeupdate', onTimeUpdate);
    video.currentTime = 1e101;
  };
  if (video.readyState >= 1) tryFix();
  else video.addEventListener('loadedmetadata', tryFix, { once: true });
}

async function loadCardVideo(card) {
  const video = card.querySelector('.entry-video-wrap video');
  const loadingEl = card.querySelector('.entry-video-loading');
  if (!video || video.dataset.loaded) return;
  const remoteUrl = video.dataset.remoteUrl;
  if (!remoteUrl) return;
  video.dataset.loaded = '1'; // set immediately so re-toggling the card doesn't re-fetch
  const applyMarks = () => {
    try { if (video.cvpSetMarks) video.cvpSetMarks(JSON.parse(video.dataset.marks || '[]')); } catch (e) { /* no marks */ }
  };
  try {
    // Download the whole file first and play it locally. Streaming straight from the remote
    // URL is what made Safari stall after a couple of seconds, so this is the reliable path.
    const res = await fetch(remoteUrl);
    if (!res.ok) throw new Error(`Could not fetch video (${res.status})`);
    const total = Number(res.headers.get('content-length')) || 0;
    let blob;
    if (res.body && res.body.getReader && total) {
      const reader = res.body.getReader();
      const parts = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        if (loadingEl) loadingEl.textContent = `Loading video… ${Math.min(99, Math.round((got / total) * 100))}%`;
      }
      blob = new Blob(parts, { type: res.headers.get('content-type') || 'video/mp4' });
    } else {
      blob = await res.blob();
    }
    const objectUrl = URL.createObjectURL(blob);
    state.activeVideoObjectUrls.push(objectUrl);
    video.src = objectUrl;
    initCustomVideoPlayer(video, { manager: state.role === 'manager' });
    applyMarks();
    video.style.display = 'block';
    if (loadingEl) loadingEl.style.display = 'none';
    if (!(parseFloat(video.dataset.knownDuration) > 0)) fixBrokenDuration(video);
  } catch (err) {
    console.error('Could not load video', err);
    if (loadingEl) loadingEl.textContent = 'Could not load video — check your connection and try again.';
    video.dataset.loaded = ''; // allow retry on next open
  }
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

    // iOS Safari has never reliably honored <a download> for media blobs — it just opens/
    // navigates to the blob URL instead of saving a file, which is exactly what looked like
    // "took me to a page but nothing downloaded." navigator.share() with a real File is the
    // actual iOS-native way to save/send a file — it opens the share sheet with "Save Video"
    // (Photos), "Save to Files", and direct app targets (including straight into CapCut).
    const file = new File([blob], filename, { type: blob.type || 'video/webm' });
    // Try sharing directly rather than gating on canShare() first — canShare() can be overly
    // conservative about certain file types (e.g. .webm) and report "not shareable" even when
    // share() itself would have worked, silently pushing us into the broken iOS fallback below.
    if (navigator.share) {
      try {
        await navigator.share({ files: [file], title: filename });
        return;
      } catch (shareErr) {
        if (shareErr && shareErr.name === 'AbortError') return; // user cancelled the share sheet
        console.warn('navigator.share failed, falling back to direct download link', shareErr);
      }
    }

    // Desktop browsers (and any platform without Web Share support) — the classic pattern
    // works fine there.
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 4000);
  } catch (err) {
    if (err && err.name === 'AbortError') return; // user cancelled the share sheet — not an error
    console.error('Download failed', err);
    alert('Could not download the video — try again.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
}
