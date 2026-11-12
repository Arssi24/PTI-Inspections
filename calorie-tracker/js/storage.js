// Local-first storage layer (localStorage now, Supabase sync layer bolts on later
// once a project URL/anon key exist — see js/supabase-client.js).

const STORAGE_KEYS = {
  PROFILE: 'ct_profile',
  TARGETS: 'ct_targets',
  FOOD_LOGS: 'ct_food_logs',
  MY_FOODS: 'ct_my_foods',
};

function getProfile() {
  const raw = localStorage.getItem(STORAGE_KEYS.PROFILE);
  return raw ? JSON.parse(raw) : null;
}

function saveProfile(profile) {
  localStorage.setItem(STORAGE_KEYS.PROFILE, JSON.stringify(profile));
}

function getTargets() {
  const raw = localStorage.getItem(STORAGE_KEYS.TARGETS);
  return raw ? JSON.parse(raw) : null;
}

function saveTargets(targets) {
  localStorage.setItem(STORAGE_KEYS.TARGETS, JSON.stringify(targets));
}

function getFoodLogs() {
  const raw = localStorage.getItem(STORAGE_KEYS.FOOD_LOGS);
  return raw ? JSON.parse(raw) : [];
}

function saveFoodLogs(logs) {
  localStorage.setItem(STORAGE_KEYS.FOOD_LOGS, JSON.stringify(logs));
}

function addFoodLog(entry) {
  const logs = getFoodLogs();
  const withId = {
    id: crypto.randomUUID(),
    logged_at: new Date().toISOString(),
    source: 'manual',
    ...entry,
  };
  logs.push(withId);
  saveFoodLogs(logs);
  return withId;
}

function deleteFoodLog(id) {
  const logs = getFoodLogs().filter((l) => l.id !== id);
  saveFoodLogs(logs);
}

function getTodayLogs() {
  const today = new Date().toDateString();
  return getFoodLogs().filter((l) => new Date(l.logged_at).toDateString() === today);
}

function getMyFoods() {
  const raw = localStorage.getItem(STORAGE_KEYS.MY_FOODS);
  return raw ? JSON.parse(raw) : [];
}

function saveMyFoods(foods) {
  localStorage.setItem(STORAGE_KEYS.MY_FOODS, JSON.stringify(foods));
}

function addMyFood(food) {
  const foods = getMyFoods();
  // de-dupe by name, keep the newest values
  const filtered = foods.filter((f) => f.food_name.toLowerCase() !== food.food_name.toLowerCase());
  filtered.unshift({ id: crypto.randomUUID(), ...food });
  saveMyFoods(filtered.slice(0, 50));
}

// Consecutive-day streak, computed from distinct log dates (today counts once it has an entry)
function getCurrentStreak() {
  const logs = getFoodLogs();
  if (logs.length === 0) return 0;

  const dateSet = new Set(logs.map((l) => new Date(l.logged_at).toDateString()));
  let streak = 0;
  const cursor = new Date();

  while (dateSet.has(cursor.toDateString())) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}
