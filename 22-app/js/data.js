// Content banks for "22" — expand these over time.
// Each fact ships with a locked-in quiz question.

const TAGS = {
  hustle: { label: "Business / Hustle", emoji: "💼" },
  fitness: { label: "Fitness", emoji: "💪" },
  school: { label: "School / Student", emoji: "🎓" },
  style: { label: "Style / Beauty", emoji: "✨" },
};

const FACTS = {
  hustle: [
    { fact: "The average millionaire has 7 income streams.", q: "How many income streams does the average millionaire have?", options: ["3", "5", "7"], correct: 2 },
    { fact: "Warren Buffett bought his first stock at age 11.", q: "How old was Warren Buffett when he bought his first stock?", options: ["8", "11", "16"], correct: 1 },
    { fact: "Amazon started as an online bookstore run out of a garage.", q: "What did Amazon originally sell?", options: ["Electronics", "Books", "Clothes"], correct: 1 },
    { fact: "Sara Blakely started Spanx with $5,000 in savings.", q: "How much did Sara Blakely start Spanx with?", options: ["$5,000", "$50,000", "$500"], correct: 0 },
    { fact: "The word 'entrepreneur' comes from a French word meaning 'to undertake'.", q: "What language does 'entrepreneur' come from?", options: ["Spanish", "French", "Latin"], correct: 1 },
    { fact: "McDonald's makes more money from real estate than from selling burgers.", q: "What does McDonald's actually make more money from?", options: ["Burgers", "Real estate", "Merchandise"], correct: 1 },
    { fact: "Coca-Cola's secret formula is kept in a vault in Atlanta.", q: "Where is Coca-Cola's secret formula kept?", options: ["A bank in Zurich", "A vault in Atlanta", "A safe in NYC"], correct: 1 },
    { fact: "The first-ever online sale was a Sting CD, back in 1994.", q: "What was the first item ever sold online?", options: ["A book", "A Sting CD", "A pizza"], correct: 1 },
    { fact: "Most successful startups pivot from their original idea at least once.", q: "What do most successful startups do at least once?", options: ["Pivot", "Go public immediately", "Skip marketing"], correct: 0 },
    { fact: "Compound interest is sometimes called 'the eighth wonder of the world'.", q: "Compound interest is sometimes nicknamed what?", options: ["The eighth wonder of the world", "Free money", "The banker's trick"], correct: 0 },
  ],
  fitness: [
    { fact: "Muscle grows during sleep, not during the workout itself.", q: "When does muscle actually grow?", options: ["During the workout", "During sleep", "During warm-up"], correct: 1 },
    { fact: "It takes about 66 days on average to form a new habit, not 21.", q: "How many days does it take on average to form a habit?", options: ["21", "66", "100"], correct: 1 },
    { fact: "Your heart is roughly the size of your fist.", q: "Your heart is roughly the size of what?", options: ["Your fist", "A softball", "Your palm"], correct: 0 },
    { fact: "Short walks throughout the day still lower heart disease risk.", q: "What still lowers heart disease risk even in short bursts?", options: ["Walking", "Stretching", "Napping"], correct: 0 },
    { fact: "Stretching cold muscles can raise injury risk — warm up first.", q: "What should you do before stretching to avoid injury?", options: ["Warm up first", "Stretch harder", "Skip it"], correct: 0 },
    { fact: "Drinking enough water can temporarily boost your metabolism.", q: "What can temporarily boost your metabolism?", options: ["Drinking water", "Skipping meals", "Cold showers only"], correct: 0 },
    { fact: "Strength training builds bone density, not just muscle.", q: "Besides muscle, what does strength training build?", options: ["Bone density", "Height", "Lung capacity"], correct: 0 },
    { fact: "The 'afterburn effect' means you keep burning calories after a workout ends.", q: "What's the 'afterburn effect'?", options: ["Burning calories after the workout ends", "Sunburn from outdoor workouts", "Muscle soreness"], correct: 0 },
    { fact: "Sitting for long periods can offset the benefits of your daily workout.", q: "What can offset the benefits of your daily workout?", options: ["Long periods of sitting", "Drinking water", "Sleeping 8 hours"], correct: 0 },
    { fact: "Laughing 100 times burns about as many calories as 10-15 minutes of rowing.", q: "Laughing 100 times burns about as many calories as what?", options: ["10-15 min of rowing", "A full 5k run", "Nothing measurable"], correct: 0 },
  ],
  school: [
    { fact: "Octopuses have three hearts.", q: "How many hearts does an octopus have?", options: ["Two", "Three", "Four"], correct: 1 },
    { fact: "Honey never spoils.", q: "Which food essentially never spoils?", options: ["Honey", "Rice", "Bread"], correct: 0 },
    { fact: "A group of flamingos is called a 'flamboyance'.", q: "What's a group of flamingos called?", options: ["A flamboyance", "A flock", "A blush"], correct: 0 },
    { fact: "Bananas are technically berries, but strawberries aren't.", q: "Which of these is technically a berry?", options: ["Strawberry", "Banana", "Neither"], correct: 1 },
    { fact: "Sharks existed before trees did.", q: "Which came first?", options: ["Sharks", "Trees", "Same time"], correct: 0 },
    { fact: "There are more possible chess games than atoms in the observable universe.", q: "What outnumbers atoms in the observable universe?", options: ["Possible chess games", "Grains of sand on Earth", "Stars in the galaxy"], correct: 0 },
    { fact: "The shortest war in recorded history lasted about 38 minutes.", q: "About how long did the shortest recorded war last?", options: ["38 minutes", "3 hours", "1 day"], correct: 0 },
    { fact: "Venus is the only planet that spins clockwise.", q: "Which planet spins clockwise, unlike the others?", options: ["Venus", "Mars", "Mercury"], correct: 0 },
    { fact: "Your brain uses about 20% of your body's total energy.", q: "About what percent of your body's energy does your brain use?", options: ["5%", "20%", "50%"], correct: 1 },
    { fact: "The Eiffel Tower grows slightly taller in summer from heat expansion.", q: "Why does the Eiffel Tower get slightly taller in summer?", options: ["Heat expansion", "Optical illusion", "New construction"], correct: 0 },
  ],
  style: [
    { fact: "Crows are documented collecting shiny objects for no practical reason, purely because they like them.", q: "Why do crows collect shiny objects, per observation?", options: ["No practical reason, they just like them", "To build nests", "To attract mates only"], correct: 0 },
    { fact: "The color purple was once so rare it was reserved for royalty.", q: "Which color was once reserved for royalty because it was so rare?", options: ["Purple", "Green", "Orange"], correct: 0 },
    { fact: "Blue jeans were originally made for miners, not fashion.", q: "Who were blue jeans originally made for?", options: ["Miners", "Musicians", "Athletes"], correct: 0 },
    { fact: "High heels were originally worn by men — specifically Persian cavalry.", q: "Who originally wore high heels?", options: ["Persian cavalry (men)", "European queens", "Roman senators"], correct: 0 },
    { fact: "The tiny pocket in jeans was designed to hold pocket watches.", q: "What was the tiny pocket in jeans originally designed to hold?", options: ["Pocket watches", "Coins", "Keys"], correct: 0 },
    { fact: "Coco Chanel popularized the 'little black dress' in the 1920s.", q: "Who popularized the 'little black dress'?", options: ["Coco Chanel", "Audrey Hepburn", "Christian Dior"], correct: 0 },
    { fact: "Sunglasses were used in ancient China to hide judges' expressions in court.", q: "Why were sunglasses used by judges in ancient China?", options: ["To hide their expressions", "To block sun in outdoor court", "As a status symbol"], correct: 0 },
    { fact: "The necktie evolved from neckwear worn by Croatian mercenaries in the 1600s.", q: "The necktie evolved from neckwear worn by whom?", options: ["Croatian mercenaries", "British royalty", "French sailors"], correct: 0 },
    { fact: "White sneakers were once strictly athletic wear before going mainstream in the 80s.", q: "What were white sneakers before they went mainstream?", options: ["Strictly athletic wear", "Formal wear", "Work boots"], correct: 0 },
    { fact: "Pink was once considered a 'boy's color' and blue a 'girl's color' before it flipped.", q: "Which color was once considered a 'boy's color'?", options: ["Pink", "Blue", "Yellow"], correct: 0 },
  ],
};

const ROASTS = {
  hustle: [
    "your competitors aren't scrolling right now.",
    "the algorithm doesn't pay your rent.",
    "that reel isn't going to close the deal.",
    "somewhere, someone with your exact idea is executing it right now.",
    "you didn't open this app to check your business email, be honest.",
    "your future self is watching this scroll session disappointed.",
    "that inbox isn't going to zero itself.",
    "you have the same 24 hours as people who actually use them.",
    "this is not networking.",
    "the invoice you're avoiding still exists.",
    "your business plan called. it's been on read for 3 days.",
    "scrolling is not a growth strategy.",
    "you said 'quick check' 11 minutes ago.",
    "the market doesn't care that you're tired.",
    "close the app. open the spreadsheet.",
  ],
  fitness: [
    "the gym called. it's lonely.",
    "your workout clothes are just laundry right now.",
    "protein shake's getting warm.",
    "you had a leg day planned. this isn't it.",
    "your future abs are filing a complaint.",
    "that's not a stretch break, that's a scroll spiral.",
    "10 more minutes here or 10 more reps there. pick.",
    "the treadmill isn't going to walk itself.",
    "your streak doesn't care about your excuses.",
    "you said you'd go after 'one more video.' that was 20 videos ago.",
    "the couch is winning today.",
    "your water bottle is still full. that's a clue.",
    "this app isn't going to improve your mile time.",
    "get up. i'll wait. (i won't, i'm a notification.)",
    "you've scrolled further than you've walked today.",
  ],
  school: [
    "professor's not gonna grade the fyp.",
    "the essay isn't writing itself. shocking, i know.",
    "you opened this app to 'take a break' from studying 40 minutes ago.",
    "your GPA is watching this happen.",
    "that due date isn't moving, you are.",
    "flashcards don't make themselves.",
    "you'll remember this scroll session and not one fact from it.",
    "the textbook is right there. it's not contagious.",
    "future you has an exam. present you has a for-you-page.",
    "this is not 'research.'",
    "you said 5 more minutes. i counted. it wasn't 5.",
    "the group project isn't going to carry itself either.",
    "your notes app has one bullet point and 400 screenshots of memes.",
    "cramming later hits different when you scroll now.",
    "close this. open literally anything with your syllabus on it.",
  ],
  style: [
    "that fit pic isn't gonna style itself.",
    "you've rewatched the same 'get ready with me' three times.",
    "the closet reorganization you promised yourself is still chaos.",
    "you didn't open this app to buy the jacket you've had in your cart for a week. or did you.",
    "your Pinterest board has ideas. your closet has none of them executed.",
    "this isn't 'research' for your outfit, be honest.",
    "you said you'd try the look, not just watch 40 people try it.",
    "the mirror's still waiting.",
    "you have taste. you also have a scroll problem.",
    "that look you saved 2 weeks ago is still just saved.",
    "inspiration overload, execution zero.",
    "you know what looks good. now go put it on.",
    "the return window on that order is closing faster than your attention span.",
    "screenshotting outfits isn't the same as wearing them.",
    "put the phone down and try the fit on.",
  ],
};

// Light per-age flavor — applied on top of the base roast/fact lines, not a full rewrite per bracket.
const AGE_BRACKETS = [
  { id: "teen", min: 0, max: 17, suffixes: [" fr.", " no cap.", " bestie.", ""] },
  { id: "youngAdult", min: 18, max: 25, suffixes: [" ngl.", " lol.", ""] },
  { id: "adult", min: 26, max: 40, suffixes: ["", "", " just saying."] },
  { id: "older", min: 41, max: 200, suffixes: ["", "", " truly."] },
];

function getAgeBracket(age) {
  const n = Number(age);
  return AGE_BRACKETS.find((b) => n >= b.min && n <= b.max) || AGE_BRACKETS[2];
}

function flavorLine(line, ageBracket) {
  const pool = ageBracket.suffixes;
  const suffix = pool[Math.floor(Math.random() * pool.length)];
  if (!suffix) return line;
  return line.endsWith(".") ? line.slice(0, -1) + suffix : line + suffix;
}
