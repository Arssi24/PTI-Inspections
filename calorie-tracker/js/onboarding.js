(function () {
  const TOTAL_STEPS = 7; // 0-6

  const state = {
    step: 0,
    sex: null,
    age: null,
    heightUnit: 'imperial',
    heightFeet: null,
    heightInches: null,
    heightCm: null,
    weightUnit: 'imperial',
    weight: null,
    activityLevel: null,
    goal: null,
    customTargets: null,
  };

  const steps = document.querySelectorAll('.step');
  const nextBtn = document.getElementById('nextBtn');
  const backBtn = document.getElementById('backBtn');
  const progressFill = document.getElementById('progressFill');

  // ---- Build activity options ----
  const activityGrid = document.getElementById('activityGrid');
  Object.entries(ACTIVITY_LABELS).forEach(([key, label]) => {
    const btn = document.createElement('button');
    btn.className = 'option-card';
    btn.dataset.field = 'activityLevel';
    btn.dataset.value = key;
    btn.innerHTML = `${label.title}<span class="option-desc">${label.desc}</span>`;
    activityGrid.appendChild(btn);
  });

  // ---- Option card selection (sex, goal, activity) ----
  document.querySelectorAll('.option-card[data-field]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const field = btn.dataset.field;
      const value = btn.dataset.value;
      state[field] = value;

      document.querySelectorAll(`.option-card[data-field="${field}"]`).forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      validateStep();
    });
  });

  // ---- Unit toggles ----
  function wireUnitToggle(toggleId, onUnitChange) {
    const toggle = document.getElementById(toggleId);
    toggle.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        toggle.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        onUnitChange(btn.dataset.unit);
      });
    });
  }

  wireUnitToggle('heightUnitToggle', (unit) => {
    state.heightUnit = unit;
    document.getElementById('heightImperial').classList.toggle('hidden', unit !== 'imperial');
    document.getElementById('heightMetric').classList.toggle('hidden', unit !== 'metric');
    validateStep();
  });

  wireUnitToggle('weightUnitToggle', (unit) => {
    state.weightUnit = unit;
    document.getElementById('weightLabel').textContent = unit === 'imperial' ? 'Weight (lbs)' : 'Weight (kg)';
    document.getElementById('weightInput').value = '';
    state.weight = null;
    validateStep();
  });

  // ---- Text inputs ----
  document.getElementById('ageInput').addEventListener('input', (e) => {
    state.age = e.target.value ? Number(e.target.value) : null;
    validateStep();
  });
  document.getElementById('heightFeetInput').addEventListener('input', (e) => {
    state.heightFeet = e.target.value ? Number(e.target.value) : null;
    validateStep();
  });
  document.getElementById('heightInchesInput').addEventListener('input', (e) => {
    state.heightInches = e.target.value ? Number(e.target.value) : null;
    validateStep();
  });
  document.getElementById('heightCmInput').addEventListener('input', (e) => {
    state.heightCm = e.target.value ? Number(e.target.value) : null;
    validateStep();
  });
  document.getElementById('weightInput').addEventListener('input', (e) => {
    state.weight = e.target.value ? Number(e.target.value) : null;
    validateStep();
  });

  // ---- Customize targets ----
  const customizeBtn = document.getElementById('customizeBtn');
  const customizeForm = document.getElementById('customizeForm');
  customizeBtn.addEventListener('click', () => {
    customizeForm.classList.toggle('hidden');
  });
  ['customCalories', 'customProtein', 'customCarbs', 'customFat'].forEach((id) => {
    document.getElementById(id).addEventListener('input', readCustomTargets);
  });

  function readCustomTargets() {
    const cal = document.getElementById('customCalories').value;
    const p = document.getElementById('customProtein').value;
    const c = document.getElementById('customCarbs').value;
    const f = document.getElementById('customFat').value;
    if (cal && p && c && f) {
      state.customTargets = {
        calorie_target: Number(cal),
        protein_g: Number(p),
        carbs_g: Number(c),
        fat_g: Number(f),
      };
    } else {
      state.customTargets = null;
    }
  }

  // ---- Step validation ----
  function validateStep() {
    let valid = false;
    switch (state.step) {
      case 0: valid = !!state.sex; break;
      case 1: valid = !!state.age && state.age > 0 && state.age < 120; break;
      case 2:
        valid = state.heightUnit === 'imperial'
          ? !!state.heightFeet && state.heightInches !== null && state.heightInches >= 0
          : !!state.heightCm;
        break;
      case 3: valid = !!state.weight && state.weight > 0; break;
      case 4: valid = !!state.activityLevel; break;
      case 5: valid = !!state.goal; break;
      case 6: valid = true; break;
    }
    nextBtn.disabled = !valid;
  }

  function computeAndRenderResults() {
    const profile = {
      sex: state.sex,
      age: state.age,
      units: state.heightUnit === 'imperial' && state.weightUnit === 'imperial' ? 'imperial' : 'mixed',
      activityLevel: state.activityLevel,
      goal: state.goal,
      heightFeet: state.heightFeet,
      heightInches: state.heightInches,
      height: state.heightCm,
      weight: state.weightUnit === 'imperial' ? state.weight : state.weight,
    };

    // calcAllTargets expects a single `units` mode for both height/weight;
    // normalize mixed-unit entries to metric before calculating.
    const weightForCalc = state.weightUnit === 'imperial' ? state.weight : kgToLbs(state.weight);
    const heightCmForCalc = state.heightUnit === 'imperial'
      ? ftInToCm(state.heightFeet, state.heightInches)
      : state.heightCm;
    const weightKgForCalc = state.weightUnit === 'imperial' ? lbsToKg(state.weight) : state.weight;

    const bmr = calcBMR({ sex: state.sex, weightKg: weightKgForCalc, heightCm: heightCmForCalc, age: state.age });
    const tdee = calcTDEE(bmr, state.activityLevel);
    const calorieTarget = calcCalorieTarget(tdee, state.goal);
    const macros = calcMacros({ calorieTarget, weightLb: weightForCalc, goal: state.goal });

    const targets = { bmr: Math.round(bmr), tdee: Math.round(tdee), calorie_target: calorieTarget, ...macros };

    document.getElementById('resultCalories').textContent = targets.calorie_target;
    document.getElementById('resultProtein').textContent = targets.protein_g + 'g';
    document.getElementById('resultCarbs').textContent = targets.carbs_g + 'g';
    document.getElementById('resultFat').textContent = targets.fat_g + 'g';

    document.getElementById('customCalories').value = targets.calorie_target;
    document.getElementById('customProtein').value = targets.protein_g;
    document.getElementById('customCarbs').value = targets.carbs_g;
    document.getElementById('customFat').value = targets.fat_g;

    state.computedTargets = targets;
    state.profileToSave = profile;
  }

  function goToStep(idx) {
    state.step = idx;
    steps.forEach((s) => s.classList.toggle('hidden', Number(s.dataset.step) !== idx));
    backBtn.classList.toggle('hidden', idx === 0);
    progressFill.style.width = `${((idx + 1) / TOTAL_STEPS) * 100}%`;
    nextBtn.textContent = idx === TOTAL_STEPS - 1 ? 'Start Tracking' : 'Continue';

    if (idx === 6) computeAndRenderResults();
    validateStep();
  }

  backBtn.addEventListener('click', () => {
    if (state.step > 0) goToStep(state.step - 1);
  });

  nextBtn.addEventListener('click', () => {
    if (state.step < TOTAL_STEPS - 1) {
      goToStep(state.step + 1);
      return;
    }

    // Final step — persist profile + targets, hand off to dashboard
    const targets = state.customTargets || state.computedTargets;
    saveProfile({
      sex: state.sex,
      age: state.age,
      heightUnit: state.heightUnit,
      heightFeet: state.heightFeet,
      heightInches: state.heightInches,
      heightCm: state.heightCm,
      weightUnit: state.weightUnit,
      weight: state.weight,
      activityLevel: state.activityLevel,
      goal: state.goal,
    });
    saveTargets(targets);
    window.location.href = 'dashboard.html';
  });

  goToStep(0);
})();
