/* Manager + driver extras added in v59 (loaded after app.js; uses its helpers):
   - calendar popup with left / right month arrows
   - a pop-up window listing every inspection one driver made
   - Assigned Truck Video: first video of each truck, recorded by a driver, permanent
   - change-your-own-password in Settings                                                      */

/* ---------------- calendar (left / right month arrows) ---------------- */

const CAL = { pop: null, off: null, key: null };

function calIso(y, m, d) { return y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0'); }
function calNice(iso) {
  const p = iso.split('-').map(Number);
  return new Date(p[0], p[1] - 1, p[2]).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function syncDateBtns() {
  [['from', 'Start date'], ['to', 'End date']].forEach(([k, label]) => {
    const i = $('#filter-' + k);
    const b = $('#filter-' + k + '-btn');
    if (!i || !b) return;
    b.textContent = i.value ? calNice(i.value) : label;
    b.classList.toggle('has-value', !!i.value);
  });
}

function closeCalendar() {
  if (CAL.pop) { CAL.pop.remove(); CAL.pop = null; }
  if (CAL.off) { CAL.off(); CAL.off = null; }
}

function openCalendar(btn, input) {
  if (CAL.pop && CAL.key === input.id) { closeCalendar(); return; }
  closeCalendar();
  CAL.key = input.id;
  const other = input.id === 'filter-from' ? $('#filter-to') : $('#filter-from');
  const now = new Date();
  const todayIso = calIso(now.getFullYear(), now.getMonth(), now.getDate());
  const seed = (input.value || other.value || todayIso).split('-').map(Number);
  let vy = seed[0];
  let vm = seed[1] - 1;

  const pop = document.createElement('div');
  pop.className = 'cal-pop';
  pop.addEventListener('click', (e) => e.stopPropagation());
  $('#screen-dashboard').appendChild(pop);
  CAL.pop = pop;

  const pick = (iso) => {
    input.value = iso;
    closeCalendar();
    input.dispatchEvent(new Event('change'));
  };

  const draw = () => {
    const first = new Date(vy, vm, 1).getDay();
    const days = new Date(vy, vm + 1, 0).getDate();
    const lo = $('#filter-from').value;
    const hi = $('#filter-to').value;
    let cells = '';
    for (let i = 0; i < first; i += 1) cells += '<span class="cal-blank"></span>';
    for (let d = 1; d <= days; d += 1) {
      const iso = calIso(vy, vm, d);
      const cls = ['cal-day'];
      if (iso === todayIso) cls.push('today');
      if (iso === input.value) cls.push('sel');
      else if (lo && hi && iso > (lo < hi ? lo : hi) && iso < (lo < hi ? hi : lo)) cls.push('between');
      else if (iso === other.value) cls.push('other');
      cells += '<button type="button" class="' + cls.join(' ') + '" data-iso="' + iso + '">' + d + '</button>';
    }
    const title = new Date(vy, vm, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    pop.innerHTML =
      '<div class="cal-head">' +
        '<button type="button" class="cal-nav" data-nav="-1" aria-label="Previous month"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>' +
        '<div class="cal-title">' + title + '</div>' +
        '<button type="button" class="cal-nav" data-nav="1" aria-label="Next month"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></button>' +
      '</div>' +
      '<div class="cal-week"><span>Su</span><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span></div>' +
      '<div class="cal-grid">' + cells + '</div>' +
      '<div class="cal-foot"><button type="button" class="cal-link" data-act="today">Today</button><button type="button" class="cal-link" data-act="clear">Clear</button></div>';
    pop.querySelectorAll('.cal-nav').forEach((n) => n.addEventListener('click', () => {
      vm += Number(n.dataset.nav);
      if (vm < 0) { vm = 11; vy -= 1; }
      if (vm > 11) { vm = 0; vy += 1; }
      draw();
    }));
    pop.querySelectorAll('.cal-day').forEach((c) => c.addEventListener('click', () => pick(c.dataset.iso)));
    pop.querySelector('[data-act="today"]').addEventListener('click', () => pick(todayIso));
    pop.querySelector('[data-act="clear"]').addEventListener('click', () => pick(''));
  };
  draw();

  // place under the button, kept inside the window
  const r = btn.getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  let left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';

  const onDoc = () => closeCalendar();
  const onKey = (e) => { if (e.key === 'Escape') closeCalendar(); };
  setTimeout(() => document.addEventListener('click', onDoc), 0);
  document.addEventListener('keydown', onKey);
  CAL.off = () => { document.removeEventListener('click', onDoc); document.removeEventListener('keydown', onKey); };
}

/* ---------------- pop-up window (shared) ---------------- */

const MODAL = { urlMark: 0, token: 0 };

function openModal(title, sub) {
  MODAL.token += 1;
  MODAL.urlMark = state.activeVideoObjectUrls.length;
  $('#modal-title').textContent = title || '';
  $('#modal-sub').textContent = sub || '';
  const body = $('#modal-body');
  body.innerHTML = '';
  $('#app-modal').style.display = 'flex';
  document.body.classList.add('modal-open');
  return body;
}

function closeModal() {
  const m = $('#app-modal');
  if (!m || m.style.display === 'none') return;
  MODAL.token += 1;
  m.querySelectorAll('video').forEach((v) => { try { v.pause(); } catch (e) { /* ignore */ } });
  $('#modal-body').innerHTML = '';
  m.style.display = 'none';
  document.body.classList.remove('modal-open');
  // free the videos that were loaded inside the window (leave the ones behind it alone)
  state.activeVideoObjectUrls.splice(MODAL.urlMark).forEach((u) => URL.revokeObjectURL(u));
}

/* ---------------- one driver's inspections in a window ---------------- */

async function openDriverWindow(d) {
  const sub = [d.email, d.phone, d.assigned_unit ? 'Assigned: ' + d.assigned_unit : ''].filter(Boolean).join(' · ');
  const body = openModal(d.name || 'Driver', sub);
  const myToken = MODAL.token;
  body.innerHTML = '<div class="empty-state">Loading…</div>';
  let rows;
  try {
    rows = await sbGetInspections(state.fleetCode, { driverId: d.id });
  } catch (err) {
    if (myToken === MODAL.token) body.innerHTML = '<div class="empty-state">Could not load this driver\'s inspections — try again.</div>';
    return;
  }
  if (myToken !== MODAL.token) return; // window was closed meanwhile

  let filter = 'ALL';
  let shown = 20;
  const count = (t) => rows.filter((r) => (t === 'ALL' ? true : t === 'PTI' ? r.type === 'PTI' : r.type === t)).length;
  body.innerHTML =
    '<div class="drvwin-chips">' +
      [['ALL', 'All'], ['PTI', 'PTI'], ['DROP', 'Drop'], ['HOOK', 'Hook']].map(([k, label]) =>
        '<button type="button" class="chip' + (k === 'ALL' ? ' active' : '') + '" data-f="' + k + '">' + label + ' <span class="chip-n">' + count(k) + '</span></button>').join('') +
    '</div>' +
    '<div class="entry-list drvwin-list"></div>' +
    '<button type="button" class="btn btn-secondary drvwin-more" style="display:none;">Show more</button>';
  const list = body.querySelector('.drvwin-list');
  const moreBtn = body.querySelector('.drvwin-more');

  const draw = async () => {
    const mine = rows.filter((r) => filter === 'ALL' || r.type === filter);
    list.innerHTML = '';
    if (mine.length === 0) {
      list.innerHTML = '<div class="empty-state">' + (rows.length ? 'Nothing of this kind yet.' : 'This driver has no inspections on record.') + '</div>';
      moreBtn.style.display = 'none';
      return;
    }
    const slice = mine.slice(0, shown);
    const cards = await Promise.all(slice.map((r) => renderEntryCard(r, false)));
    if (myToken !== MODAL.token) return;
    list.innerHTML = '';
    cards.forEach((c) => list.appendChild(c));
    moreBtn.style.display = mine.length > shown ? 'block' : 'none';
    moreBtn.textContent = 'Show more (' + (mine.length - shown) + ' left)';
  };
  body.querySelectorAll('.drvwin-chips .chip').forEach((c) => c.addEventListener('click', () => {
    body.querySelectorAll('.drvwin-chips .chip').forEach((x) => x.classList.toggle('active', x === c));
    filter = c.dataset.f;
    shown = 20;
    draw();
  }));
  moreBtn.addEventListener('click', () => { shown += 20; draw(); });
  draw();
}

/* ---------------- Assigned Truck Video ---------------- */
// A driver records one per truck/trailer (type 'BASELINE' inspection). The first one is permanent.

const ASSIGNED = { rows: [], shown: 20 };

// Manager panel: every assigned truck video in the fleet.
async function renderAssignedPanel() {
  const list = $('#assigned-list');
  const more = $('#assigned-more');
  list.innerHTML = '<div class="empty-state">Loading…</div>';
  more.style.display = 'none';
  try {
    ASSIGNED.rows = await sbGetAssignedVideos(state.fleetCode);
  } catch (err) {
    list.innerHTML = '<div class="empty-state">Could not load — try again in a moment.</div>';
    return;
  }
  ASSIGNED.shown = 20;
  drawAssignedPanel();
}

async function drawAssignedPanel() {
  const list = $('#assigned-list');
  const more = $('#assigned-more');
  const words = $('#assigned-search').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hit = ASSIGNED.rows.filter((r) => {
    const hay = [r.unit, r.driver_name, r.driver_email].filter(Boolean).join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  if (hit.length === 0) {
    list.innerHTML = '<div class="empty-state">' + (ASSIGNED.rows.length ? 'No truck or driver matches that.' : 'No assigned truck videos yet.<br>Drivers record them from <strong>Assigned Truck Video</strong> on their home screen.') + '</div>';
    more.style.display = 'none';
    return;
  }
  const slice = hit.slice(0, ASSIGNED.shown);
  const token = (ASSIGNED.token = (ASSIGNED.token || 0) + 1);
  const cards = await Promise.all(slice.map((r) => renderEntryCard(r, true)));
  if (token !== ASSIGNED.token) return;
  list.innerHTML = '';
  cards.forEach((c) => list.appendChild(c));
  more.style.display = hit.length > ASSIGNED.shown ? 'block' : 'none';
  more.textContent = 'Show more (' + (hit.length - ASSIGNED.shown) + ' left)';
}

// Driver screen: record one, watch your truck's, look up any other.
async function openBaselineScreen() {
  showScreen('screen-baseline');
  const mineEl = $('#baseline-mine');
  const listEl = $('#baseline-list');
  $('#baseline-search').value = '';
  listEl.innerHTML = '';
  mineEl.innerHTML = '<div class="empty-state small">Loading…</div>';
  let unit = '';
  try { const p = await sbGetProfile(state.userId); unit = ((p && p.assigned_unit) || '').trim(); } catch (e) { /* none */ }
  if (!unit) {
    mineEl.innerHTML = '<div class="empty-state small">No truck is assigned to you yet. Use the search below to look one up.</div>';
    return;
  }
  try {
    const v = await sbFindAssignedVideo(state.fleetCode, unit);
    mineEl.innerHTML = '';
    if (!v) {
      mineEl.innerHTML = '<div class="empty-state small"><strong>' + escapeHtml(unit) + '</strong> has no Assigned Truck Video yet. Tap the button above to record it — the first one is kept forever.</div>';
    } else {
      mineEl.appendChild(await renderEntryCard(v, true));
    }
  } catch (err) {
    mineEl.innerHTML = '<div class="empty-state small">Could not load — try again in a moment.</div>';
  }
}

let baselineSearchTimer = null;
function onBaselineSearch() {
  clearTimeout(baselineSearchTimer);
  baselineSearchTimer = setTimeout(async () => {
    const q = $('#baseline-search').value.trim();
    const listEl = $('#baseline-list');
    if (!q) { listEl.innerHTML = ''; return; }
    listEl.innerHTML = '<div class="empty-state small">Searching…</div>';
    try {
      const rows = (await sbGetAssignedVideos(state.fleetCode)).filter((r) => String(r.unit).toLowerCase().includes(q.toLowerCase())).slice(0, 10);
      if ($('#baseline-search').value.trim() !== q) return;
      if (rows.length === 0) { listEl.innerHTML = '<div class="empty-state small">No assigned truck video for "' + escapeHtml(q) + '" yet.</div>'; return; }
      const cards = await Promise.all(rows.map((r) => renderEntryCard(r, true)));
      listEl.innerHTML = '';
      cards.forEach((c) => listEl.appendChild(c));
    } catch (err) {
      listEl.innerHTML = '<div class="empty-state small">Could not search — try again.</div>';
    }
  }, 250);
}

/* ---------------- manager: change own password ---------------- */

async function onChangeMgrPassword() {
  const errEl = $('#pw-error');
  const okEl = $('#pw-ok');
  errEl.style.display = 'none';
  okEl.style.display = 'none';
  const cur = $('#pw-current').value;
  const np = $('#pw-new').value;
  const np2 = $('#pw-new2').value;
  const fail = (m) => { errEl.textContent = m; errEl.style.display = 'block'; };
  if (!cur || !np || !np2) { fail('Fill in all three boxes.'); return; }
  if (np.length < 8) { fail('Use at least 8 characters for the new password.'); return; }
  if (np !== np2) { fail('The two new passwords are not the same.'); return; }
  if (np === cur) { fail('The new password is the same as the old one.'); return; }
  const btn = $('#btn-change-password');
  btn.disabled = true;
  btn.textContent = 'Updating…';
  try {
    const { error } = await sbChangeOwnPassword(state.driverEmail, cur, np);
    if (error) { fail(error.message || 'Could not change the password.'); return; }
    ['#pw-current', '#pw-new', '#pw-new2'].forEach((s) => { $(s).value = ''; });
    okEl.textContent = 'Password updated. You are still logged in.';
    okEl.style.display = 'block';
  } catch (err) {
    fail('Could not change the password — check your connection and try again.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Update password';
  }
}

/* ---------------- wiring ---------------- */

document.addEventListener('DOMContentLoaded', () => {
  const on = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, fn); };
  on('#filter-from-btn', 'click', (e) => { e.stopPropagation(); openCalendar(e.currentTarget, $('#filter-from')); });
  on('#filter-to-btn', 'click', (e) => { e.stopPropagation(); openCalendar(e.currentTarget, $('#filter-to')); });
  syncDateBtns();
  on('#modal-close', 'click', closeModal);
  on('#app-modal', 'click', (e) => { if (e.target.id === 'app-modal') closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  on('#btn-baseline', 'click', openBaselineScreen);
  on('#baseline-search', 'input', onBaselineSearch);
  on('#btn-record-assigned', 'click', () => startFlow('BASELINE'));
  on('#assigned-search', 'input', () => { ASSIGNED.shown = 20; drawAssignedPanel(); });
  on('#assigned-more', 'click', () => { ASSIGNED.shown += 20; drawAssignedPanel(); });
  on('#btn-change-password', 'click', onChangeMgrPassword);
});
