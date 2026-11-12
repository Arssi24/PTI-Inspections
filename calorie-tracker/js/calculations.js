// Mifflin-St Jeor based calorie + macro targets

const ACTIVITY_MULTIPLIERS = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
};

const ACTIVITY_LABELS = {
  sedentary: { title: 'Sedentary', desc: 'Little or no exercise, desk job' },
  light: { title: 'Lightly Active', desc: 'Light exercise 1-3 days/week' },
  moderate: { title: 'Moderately Active', desc: 'Moderate exercise 3-5 days/week' },
  active: { title: 'Active', desc: 'Hard exercise 6-7 days/week' },
  very_active: { title: 'Very Active', desc: 'Physical job or 2x/day training' },
};

function lbsToKg(lbs) {
  return lbs * 0.453592;
}

function kgToLbs(kg) {
  return kg / 0.453592;
}

function ftInToCm(feet, inches) {
  return (feet * 12 + inches) * 2.54;
}

function cmToFtIn(cm) {
  const totalInches = cm / 2.54;
  const feet = Math.floor(totalInches / 12);
  const inches = Math.round(totalInches % 12);
  return { feet, inches };
}

function calcBMR({ sex, weightKg, heightCm, age }) {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  return sex === 'male' ? base + 5 : base - 161;
}

function calcTDEE(bmr, activityLevel) {
  const mult = ACTIVITY_MULTIPLIERS[activityLevel] || 1.2;
  return bmr * mult;
}

function calcCalorieTarget(tdee, goal) {
  if (goal === 'lose') return Math.round(tdee - 500);
  if (goal === 'gain') return Math.round(tdee + 400);
  return Math.round(tdee);
}

// Protein by bodyweight, fat as % of calories, carbs fill the remainder
function calcMacros({ calorieTarget, weightLb, goal }) {
  const proteinPerLb = goal === 'lose' ? 1.0 : goal === 'gain' ? 0.9 : 0.8;
  let proteinG = Math.round(weightLb * proteinPerLb);
  let proteinCal = proteinG * 4;

  let fatCal = calorieTarget * 0.25;
  let carbCal = calorieTarget - proteinCal - fatCal;

  if (carbCal < 0) {
    // very low target relative to bodyweight — protect a fat floor, let carbs absorb the squeeze
    fatCal = calorieTarget * 0.15;
    carbCal = Math.max(0, calorieTarget - proteinCal - fatCal);
  }

  const fatG = Math.round(fatCal / 9);
  const carbsG = Math.round(carbCal / 4);

  return { protein_g: proteinG, carbs_g: carbsG, fat_g: fatG };
}

function calcAllTargets(profile) {
  const weightKg = profile.units === 'imperial' ? lbsToKg(profile.weight) : profile.weight;
  const heightCm = profile.units === 'imperial' ? ftInToCm(profile.heightFeet, profile.heightInches) : profile.height;
  const weightLb = profile.units === 'imperial' ? profile.weight : kgToLbs(profile.weight);

  const bmr = calcBMR({ sex: profile.sex, weightKg, heightCm, age: profile.age });
  const tdee = calcTDEE(bmr, profile.activityLevel);
  const calorieTarget = calcCalorieTarget(tdee, profile.goal);
  const macros = calcMacros({ calorieTarget, weightLb, goal: profile.goal });

  return {
    bmr: Math.round(bmr),
    tdee: Math.round(tdee),
    calorie_target: calorieTarget,
    ...macros,
  };
}
