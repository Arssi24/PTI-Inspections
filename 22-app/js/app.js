// ---------- Kisra mascot (original geometric crow silhouette) ----------
const CROW_SVG = `
<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <polygon points="50,14 66,40 58,40 68,58 54,54 60,86 50,70 40,86 46,54 32,58 42,40 34,40" fill="#D4A94A" opacity="0.12"/>
  <path d="M50 20 C34 20 22 34 22 50 C22 62 30 70 38 74 L34 86 L44 78 C46 79 48 79.5 50 79.5 C52 79.5 54 79 56 78 L66 86 L62 74 C70 70 78 62 78 50 C78 34 66 20 50 20 Z" fill="#17151F" stroke="#D4A94A" stroke-width="1.5"/>
  <path d="M22 48 L6 44 L22 56 Z" fill="#17151F" stroke="#D4A94A" stroke-width="1.5" stroke-linejoin="round"/>
  <path d="M78 48 L94 44 L78 56 Z" fill="#17151F" stroke="#D4A94A" stroke-width="1.5" stroke-linejoin="round"/>
  <path d="M46 46 L30 50 L46 52 Z" fill="#D4A94A"/>
  <circle cx="58" cy="46" r="4" fill="#D4A94A"/>
</svg>`;

document.querySelectorAll('.kisra-badge').forEach(el => { el.innerHTML = CROW_SVG; });

// ---------- State ----------
const STORAGE_KEY = 'kisra22_state';

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return {
    name: '', age: null, tag: null, ageBracket: 'adult',
    streak: 0, lastCompletionDate: null, lastFactDate: null,
    todayAnswered: false, todayCorrect: false,
    unlockedBadges: [], onboarded: false, plan: null,
  };
}
function saveState() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }

let state = loadState();

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;
}
function daysBetween(a, b) {
  const [ay,am,ad] = a.split('-').map(Number);
  const [by,bm,bd] = b.split('-').map(Number);
  const da = new Date(ay, am-1, ad), db = new Date(by, bm-1, bd);
  return Math.round((db - da) / 86400000);
}
function dayIndexSinceEpoch() {
  const d = new Date();
  return Math.floor(d.getTime() / 86400000);
}

// ---------- Onboarding ----------
const stepOrder = ['name', 'age', 'tag', 'intro'];
let stepIndex = 0;

function showStep(id) {
  document.querySelectorAll('.onboard-step').forEach(el => el.classList.remove('active'));
  document.querySelector(`.onboard-step[data-step="${id}"]`).classList.add('active');
}

function buildTagGrid() {
  const grid = document.getElementById('tag-grid');
  grid.innerHTML = '';
  Object.entries(TAGS).forEach(([key, t]) => {
    const el = document.createElement('div');
    el.className = 'tag-option';
    el.dataset.tag = key;
    el.innerHTML = `<span class="tag-emoji">${t.emoji}</span><span class="tag-label">${t.label}</span>`;
    el.addEventListener('click', () => {
      document.querySelectorAll('.tag-option').forEach(o => o.classList.remove('selected'));
      el.classList.add('selected');
      state.tag = key;
      document.getElementById('btn-tag-next').disabled = false;
    });
    grid.appendChild(el);
  });
}

document.getElementById('btn-name-next').addEventListener('click', () => {
  const val = document.getElementById('input-name').value.trim();
  if (!val) return;
  state.name = val;
  document.getElementById('name-echo').textContent = val;
  showStep('age');
});

document.getElementById('btn-age-next').addEventListener('click', () => {
  const val = document.getElementById('input-age').value;
  if (!val || val < 10 || val > 99) return;
  state.age = Number(val);
  state.ageBracket = getAgeBracket(state.age).id;
  showStep('tag');
});

document.getElementById('btn-tag-next').addEventListener('click', () => {
  showStep('intro');
});

document.getElementById('btn-intro-done').addEventListener('click', () => {
  state.onboarded = true;
  saveState();
  enterMainApp();
});

buildTagGrid();

// ---------- Main app ----------
function enterMainApp() {
  document.getElementById('screen-onboarding').classList.remove('active');
  document.getElementById('screen-main').classList.add('active');
  refreshHome();
  refreshAchievements();
}

function greetingForHour() {
  const h = new Date().getHours();
  if (h < 5) return 'Still up?';
  if (h < 12) return 'Morning.';
  if (h < 18) return 'Afternoon.';
  return 'Evening.';
}

function todaysFact() {
  const facts = FACTS[state.tag] || FACTS.hustle;
  const idx = dayIndexSinceEpoch() % facts.length;
  return facts[idx];
}

function refreshHome() {
  document.getElementById('home-greeting').textContent = `${greetingForHour()} ${state.name}.`;
  document.getElementById('streak-count').textContent = state.streak;

  // reset today's flags if it's a new day
  const t = todayStr();
  if (state.lastFactDate !== t) {
    state.todayAnswered = false;
    state.todayCorrect = false;
    state.lastFactDate = t;
    // streak resets if more than 1 day was skipped since last completion
    if (state.lastCompletionDate && daysBetween(state.lastCompletionDate, t) > 1) {
      state.streak = 0;
    }
    saveState();
    document.getElementById('streak-count').textContent = state.streak;
  }

  document.getElementById('fact-text').textContent = 'Tap to reveal.';
  document.getElementById('btn-reveal').textContent = 'Reveal fact';
  factRevealed = false;

  const factCard = document.getElementById('fact-card');
  const quizCard = document.getElementById('quiz-card');
  const doneCard = document.getElementById('done-card');

  if (state.todayAnswered) {
    factCard.classList.add('hidden');
    quizCard.classList.add('hidden');
    doneCard.classList.remove('hidden');
    document.getElementById('done-text').textContent = state.todayCorrect
      ? flavorLine(`Streak's at ${state.streak}. Don't get comfortable.`, getAgeBracket(state.age))
      : `Didn't land, but the streak's still alive. See you tomorrow.`;
    document.getElementById('home-sub').textContent = 'Already handled today.';
  } else {
    factCard.classList.remove('hidden');
    quizCard.classList.add('hidden');
    doneCard.classList.add('hidden');
    document.getElementById('home-sub').textContent = "Let's not break the streak today.";
  }
}

let factRevealed = false;

document.getElementById('btn-reveal').addEventListener('click', () => {
  const fact = todaysFact();
  const revealBtn = document.getElementById('btn-reveal');

  if (!factRevealed) {
    document.getElementById('fact-text').textContent = fact.fact;
    revealBtn.textContent = 'Take the quiz';
    factRevealed = true;
    return;
  }

  factRevealed = false;
  revealBtn.textContent = 'Reveal fact';
  document.getElementById('fact-card').classList.add('hidden');
  const quizCard = document.getElementById('quiz-card');
  quizCard.classList.remove('hidden');
  document.getElementById('quiz-question').textContent = fact.q;
  const optsEl = document.getElementById('quiz-options');
  optsEl.innerHTML = '';
  document.getElementById('quiz-feedback').textContent = '';
  fact.options.forEach((opt, i) => {
    const btn = document.createElement('button');
    btn.className = 'quiz-option';
    btn.textContent = opt;
    btn.addEventListener('click', () => answerQuiz(i, fact));
    optsEl.appendChild(btn);
  });
});

function answerQuiz(choiceIdx, fact) {
  const buttons = document.querySelectorAll('#quiz-options .quiz-option');
  buttons.forEach(b => b.classList.add('disabled'));
  const correct = choiceIdx === fact.correct;
  buttons[choiceIdx].classList.add(correct ? 'correct' : 'wrong');
  if (!correct) buttons[fact.correct].classList.add('correct');

  const feedback = document.getElementById('quiz-feedback');
  feedback.textContent = correct ? "That's right." : "Not quite — but you showed up.";

  state.todayAnswered = true;
  state.todayCorrect = correct;
  if (correct) {
    state.streak += 1;
    state.lastCompletionDate = todayStr();
    checkBadges();
  }
  saveState();

  setTimeout(() => refreshHome(), 900);
}

// ---------- Achievements ----------
const BADGE_DEFS = [
  { id: 3, icon: '🥉', name: '3-day streak' },
  { id: 7, icon: '🥈', name: '7-day streak' },
  { id: 30, icon: '🥇', name: '30-day streak' },
  { id: 100, icon: '💎', name: '100-day streak' },
];

function checkBadges() {
  BADGE_DEFS.forEach(b => {
    if (state.streak >= b.id && !state.unlockedBadges.includes(b.id)) {
      state.unlockedBadges.push(b.id);
    }
  });
}

function refreshAchievements() {
  document.getElementById('ach-streak-count').textContent = state.streak;
  const grid = document.getElementById('badge-grid');
  grid.innerHTML = '';
  BADGE_DEFS.forEach(b => {
    const unlocked = state.unlockedBadges.includes(b.id);
    const el = document.createElement('div');
    el.className = 'badge' + (unlocked ? ' unlocked' : '');
    el.innerHTML = `<span class="badge-icon">${b.icon}</span><div class="badge-name">${b.name}</div><div class="badge-req">${unlocked ? 'Unlocked' : b.id + ' days'}</div>`;
    grid.appendChild(el);
  });
}

// ---------- Nav ----------
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`view-${btn.dataset.view}`).classList.add('active');
    if (btn.dataset.view === 'achievements') refreshAchievements();
  });
});

// ---------- Paywall ----------
document.querySelectorAll('.plan-card').forEach(card => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.plan-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    state.plan = card.dataset.plan;
  });
});
document.getElementById('btn-subscribe').addEventListener('click', () => {
  alert(state.plan ? `Preview only — no real charge. Plan selected: ${state.plan}.` : 'Pick a plan first.');
});

// ---------- Nudge simulation (Phase 1 stand-in for real usage-detection) ----------
function randomNudgeLine() {
  const roasts = ROASTS[state.tag] || ROASTS.hustle;
  const base = roasts[Math.floor(Math.random() * roasts.length)];
  return flavorLine(base, getAgeBracket(state.age || 25));
}

document.getElementById('btn-demo-nudge').addEventListener('click', () => {
  const overlay = document.getElementById('nudge-overlay');
  document.getElementById('nudge-text').textContent = randomNudgeLine();
  overlay.classList.remove('hidden');

  if ('Notification' in window) {
    if (Notification.permission === 'granted') {
      fireNotification();
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then(p => { if (p === 'granted') fireNotification(); });
    }
  }
});

function fireNotification() {
  const text = document.getElementById('nudge-text').textContent;
  if (navigator.serviceWorker && navigator.serviceWorker.ready) {
    navigator.serviceWorker.ready.then(reg => {
      reg.showNotification('Kisra', { body: text, icon: 'icons/icon.svg', tag: 'kisra-nudge' });
    }).catch(() => {});
  }
}

document.getElementById('btn-nudge-dismiss').addEventListener('click', () => {
  document.getElementById('nudge-overlay').classList.add('hidden');
});

// ---------- Boot ----------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('service-worker.js').catch(() => {});
}

if (state.onboarded) {
  document.getElementById('input-name').value = state.name;
  enterMainApp();
} else {
  showStep('name');
}
