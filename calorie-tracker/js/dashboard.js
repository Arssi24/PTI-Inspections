(function () {
  const profile = getProfile();
  const targets = getTargets();

  if (!profile || !targets) {
    window.location.href = 'onboarding.html';
    return;
  }

  const MEAL_ORDER = ['breakfast', 'lunch', 'dinner', 'snacks'];
  const MEAL_LABELS = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snacks: 'Snacks' };

  const CALORIE_CIRCUMFERENCE = 2 * Math.PI * 78; // ~490
  const SUB_CIRCUMFERENCE = 2 * Math.PI * 24; // ~151

  function setRing(el, circumference, percent) {
    const clamped = Math.max(0, Math.min(1, percent));
    el.setAttribute('stroke-dasharray', circumference);
    el.setAttribute('stroke-dashoffset', circumference * (1 - clamped));
  }

  function renderHeader() {
    document.getElementById('dateLabel').textContent = new Date().toLocaleDateString(undefined, {
      weekday: 'long', month: 'short', day: 'numeric',
    });
    document.getElementById('streakCount').textContent = getCurrentStreak();
  }

  function renderRings(logs) {
    const totals = logs.reduce((acc, l) => {
      acc.calories += Number(l.calories) || 0;
      acc.protein += Number(l.protein) || 0;
      acc.carbs += Number(l.carbs) || 0;
      acc.fat += Number(l.fat) || 0;
      return acc;
    }, { calories: 0, protein: 0, carbs: 0, fat: 0 });

    setRing(document.getElementById('calorieRing'), CALORIE_CIRCUMFERENCE, totals.calories / targets.calorie_target);
    document.getElementById('ringCalorieText').textContent = Math.round(totals.calories);
    document.getElementById('ringTargetText').textContent = targets.calorie_target;

    const remaining = targets.calorie_target - totals.calories;
    const remainingEl = document.getElementById('remainingText');
    if (remaining >= 0) {
      remainingEl.innerHTML = `<b>${Math.round(remaining)}</b> calories left today`;
    } else {
      remainingEl.innerHTML = `<b>${Math.round(-remaining)}</b> calories over today`;
    }

    setRing(document.getElementById('proteinRing'), SUB_CIRCUMFERENCE, totals.protein / targets.protein_g);
    document.getElementById('proteinNums').textContent = `${Math.round(totals.protein)} / ${targets.protein_g}g`;

    setRing(document.getElementById('carbsRing'), SUB_CIRCUMFERENCE, totals.carbs / targets.carbs_g);
    document.getElementById('carbsNums').textContent = `${Math.round(totals.carbs)} / ${targets.carbs_g}g`;

    setRing(document.getElementById('fatRing'), SUB_CIRCUMFERENCE, totals.fat / targets.fat_g);
    document.getElementById('fatNums').textContent = `${Math.round(totals.fat)} / ${targets.fat_g}g`;
  }

  function renderMealGroups(logs) {
    const container = document.getElementById('mealGroups');
    container.innerHTML = '';

    if (logs.length === 0) {
      container.innerHTML = '<div class="empty-state">Nothing logged yet today.<br>Tap + to add your first food.</div>';
      return;
    }

    MEAL_ORDER.forEach((mealType) => {
      const items = logs
        .filter((l) => (l.meal_type || 'snacks') === mealType)
        .sort((a, b) => new Date(a.logged_at) - new Date(b.logged_at));

      if (items.length === 0) return;

      const group = document.createElement('div');
      group.className = 'meal-group';

      const label = document.createElement('div');
      label.className = 'meal-name';
      label.textContent = MEAL_LABELS[mealType];
      group.appendChild(label);

      items.forEach((item) => {
        const row = document.createElement('div');
        row.className = 'food-item';

        const time = new Date(item.logged_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

        row.innerHTML = `
          <div class="food-item-main">
            <div class="food-item-name">${escapeHtml(item.food_name)}</div>
            <div class="food-item-meta">${item.serving_size ? escapeHtml(item.serving_size) + ' · ' : ''}${time}</div>
          </div>
          <div class="food-item-cals">${Math.round(item.calories)}</div>
          <button class="food-item-delete" data-id="${item.id}" aria-label="Delete">✕</button>
        `;
        group.appendChild(row);
      });

      container.appendChild(group);
    });

    container.querySelectorAll('.food-item-delete').forEach((btn) => {
      btn.addEventListener('click', () => {
        deleteFoodLog(btn.dataset.id);
        refresh();
      });
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function refresh() {
    const logs = getTodayLogs();
    renderHeader();
    renderRings(logs);
    renderMealGroups(logs);
  }

  // ---- Manual entry modal ----
  const overlay = document.getElementById('modalOverlay');
  const fab = document.getElementById('addFoodFab');
  const cancelBtn = document.getElementById('mCancelBtn');
  const saveBtn = document.getElementById('mSaveBtn');

  function openModal() {
    ['mFoodName', 'mServing', 'mCalories', 'mProtein', 'mCarbs', 'mFat'].forEach((id) => {
      document.getElementById(id).value = '';
    });
    document.getElementById('mMealType').value = defaultMealForNow();
    overlay.classList.remove('hidden');
  }

  function closeModal() {
    overlay.classList.add('hidden');
  }

  function defaultMealForNow() {
    const h = new Date().getHours();
    if (h < 11) return 'breakfast';
    if (h < 16) return 'lunch';
    if (h < 21) return 'dinner';
    return 'snacks';
  }

  fab.addEventListener('click', openModal);
  cancelBtn.addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  saveBtn.addEventListener('click', () => {
    const name = document.getElementById('mFoodName').value.trim();
    const calories = Number(document.getElementById('mCalories').value) || 0;

    if (!name || calories <= 0) {
      document.getElementById('mFoodName').focus();
      return;
    }

    const entry = {
      food_name: name,
      meal_type: document.getElementById('mMealType').value,
      serving_size: document.getElementById('mServing').value.trim(),
      calories,
      protein: Number(document.getElementById('mProtein').value) || 0,
      carbs: Number(document.getElementById('mCarbs').value) || 0,
      fat: Number(document.getElementById('mFat').value) || 0,
      source: 'manual',
    };

    addFoodLog(entry);
    addMyFood(entry);

    if (navigator.vibrate) navigator.vibrate(15);

    closeModal();
    refresh();
  });

  refresh();
})();
