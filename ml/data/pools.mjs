// Value pools for the synthetic dataset. Everything here is invented: no real
// person's data. Names are common first names from many cultures; projects
// are made-up product names.

export const NAMES = [
  'Ayesha', 'Bilal', 'Sara', 'Omar', 'Zainab', 'Hamza', 'Fatima', 'Usman', 'Hira', 'Ali', 'Mariam', 'Danish',
  'Priya', 'Arjun', 'Neha', 'Rohan', 'Mei', 'Jun', 'Yuki', 'Kenji', 'Lena', 'Jonas', 'Sofia', 'Mateo',
  'Lucia', 'Diego', 'Amara', 'Kofi', 'Zara', 'Ibrahim', 'Leila', 'Tariq', 'Elena', 'Nikolai', 'Chloe', 'Liam',
  'Grace', 'Ethan', 'Nadia', 'Samir', 'Ines', 'Rafael', 'Hana', 'Minh', 'Aisha', 'Kwame', 'Olivia', 'Noah',
];
export const RELATIONS = ['sister', 'brother', 'mom', 'dad', 'wife', 'husband', 'friend', 'cofounder', 'boss', 'cousin', 'daughter', 'son', 'girlfriend', 'boyfriend', 'colleague', 'manager'];
export const CITIES = ['Lahore', 'Karachi', 'Islamabad', 'Dubai', 'London', 'Berlin', 'Toronto', 'Istanbul', 'Nairobi', 'Jakarta', 'Bangalore', 'Singapore', 'Madrid', 'Lisbon', 'Cairo', 'Riyadh', 'Austin', 'Melbourne', 'Seoul', 'Manila'];
export const PLACES = ['the dentist', 'the airport', 'a client meeting', 'the gym', 'my parents\' place', 'a workshop', 'the hospital', 'the office', 'a wedding', 'the bank', 'class', 'a conference'];
export const JOBS = ['software engineer', 'shopkeeper', 'nurse', 'teacher', 'product designer', 'farmer', 'accountant', 'student', 'HR manager', 'data analyst', 'freelance illustrator', 'civil engineer', 'pharmacist', 'marketing lead', 'lawyer', 'chef'];
export const PROJECTS = ['pantry-pal', 'LedgerLite', 'study-buddy', 'shop-app', 'FieldNotes', 'clinic-booking', 'tutor-match', 'HabitHive', 'invoice-bot', 'RoomRent', 'quiz-arena', 'farm-ledger', 'event-hub', 'PocketCFO', 'recipe-vault', 'MoveMate'];

/** Preference slots: [slot, values, phrasing hint]. */
export const PREFS = [
  ['reply length', ['short', 'detailed', 'bullet points', 'one paragraph']],
  ['editor theme', ['dark mode', 'light mode', 'high contrast']],
  ['code editor', ['VS Code', 'Neovim', 'Zed', 'JetBrains IDEs', 'Sublime Text']],
  ['package manager', ['pnpm', 'npm', 'yarn', 'bun']],
  ['meeting time', ['mornings', 'afternoons', 'late evenings', 'no meetings on Fridays']],
  ['drink', ['tea', 'black coffee', 'green tea', 'chai', 'iced latte']],
  ['music while working', ['lo-fi', 'jazz', 'silence', 'Coke Studio', 'classical music']],
  ['communication channel', ['WhatsApp', 'email', 'Slack', 'phone calls', 'voice notes']],
  ['language for replies', ['English', 'Urdu', 'Roman Urdu', 'Spanish', 'Arabic']],
  ['indentation', ['tabs', 'two spaces', 'four spaces']],
  ['favorite color', ['teal', 'navy blue', 'maroon', 'forest green', 'mustard yellow', 'lavender']],
  ['favorite food', ['biryani', 'sushi', 'tacos', 'nihari', 'pasta', 'dal chawal']],
  ['workout', ['running', 'swimming', 'weightlifting', 'yoga', 'cricket', 'cycling']],
  ['travel seat', ['window seat', 'aisle seat']],
  ['notification style', ['a daily summary', 'instant alerts', 'only urgent things']],
  ['writing tone', ['formal', 'casual', 'friendly but brief']],
  ['testing framework', ['Vitest', 'Jest', 'pytest', 'Playwright']],
  ['note-taking app', ['Notion', 'Obsidian', 'Apple Notes', 'paper notebooks']],
];
export const DISLIKES = ['long meetings', 'cold calls', 'spicy food', 'tabs', 'emojis in emails', 'early mornings', 'pop-ups', 'TypeScript enums', 'crowded places', 'voice notes'];

/** Project decisions: [slot, values]. */
export const DECISIONS = [
  ['database', ['Postgres', 'MySQL', 'SQLite', 'MongoDB', 'Supabase', 'Firebase']],
  ['auth', ['Supabase auth', 'Clerk', 'Auth0', 'magic links', 'passkeys']],
  ['hosting', ['Vercel', 'Netlify', 'Fly.io', 'Render', 'a VPS on Hetzner', 'Cloudflare Pages']],
  ['frontend framework', ['Next.js', 'SvelteKit', 'Vue', 'React Native', 'Flutter', 'Astro']],
  ['styling', ['Tailwind', 'CSS modules', 'styled-components']],
  ['payments', ['Stripe', 'JazzCash', 'Easypaisa', 'Paddle', 'cash on delivery']],
  ['backend language', ['TypeScript', 'Python', 'Go', 'Rust', 'PHP']],
  ['launch city', ['Lahore', 'Karachi', 'Dubai', 'London', 'Nairobi']],
  ['pricing', ['free tier plus 5 dollars a month', 'one-time 20 dollar license', 'free for students']],
  ['release date', ['the 15th', 'end of the month', 'next Friday', 'March']],
];
export const IDEAS = ['a referral program', 'a WhatsApp bot for orders', 'an offline mode', 'a dark theme', 'weekly email digests', 'a loyalty card', 'voice input', 'a public API', 'Urdu localization', 'a browser extension'];
export const REQUIREMENTS = ['must work offline', 'must support Urdu', 'has to load in under 2 seconds', 'needs an admin dashboard', 'must be GDPR compliant', 'needs SMS login', 'must run on cheap Android phones'];
export const TODOS = ['renew my passport', 'pay the electricity bill', 'call the plumber', 'book a dentist appointment', 'send the invoice to the client', 'buy a birthday gift for my mom', 'submit the tax return', 'back up my laptop', 'reply to the landlord', 'order printer ink'];
export const ROUTINES = [['gym', 'goes to the gym at 6am'], ['standup', 'has standup at 10am'], ['prayer', 'prays Fajr before work'], ['walk', 'walks after dinner'], ['reading', 'reads before bed'], ['market', 'visits the wholesale market on Mondays'], ['family call', 'calls their parents on Sundays']];
export const PERSON_FACTS = [['is a nurse', 'occupation', 'nurse'], ['loves sketching', 'hobby', 'sketching'], ['is allergic to peanuts', 'allergy', 'peanuts'], ['lives in Toronto', 'city', 'Toronto'], ['is a vegetarian', 'diet', 'vegetarian'], ['plays the guitar', 'hobby', 'guitar'], ['works at a bank', 'workplace', 'a bank'], ['is studying medicine', 'studies', 'medicine'], ['hates surprises', 'dislikes', 'surprises'], ['is learning Japanese', 'learning', 'Japanese']];
export const SMALL_TALK = [
  'thanks, that worked!', 'ok cool', 'can you explain that again?', 'lol nice', 'hmm let me think', 'fix the failing test please',
  'what does this error mean: TypeError undefined is not a function', 'rename the variable to userCount', 'show me the diff', 'good morning!',
  'run the build again', 'why is the button not centered', 'how do I center a div', 'make it blue', 'never mind', 'can you summarize this article for me',
  'what is the capital of Canada', 'translate this to French: see you tomorrow', 'continue', 'write a haiku about rain',
];
export const ASSISTANT = ['Got it.', 'Done.', 'Sure, here it is.', 'Okay, noted.', 'Updated.', 'Makes sense.', 'Here is what I changed.', 'All set.'];
export const FILLERS = ['', '', '', 'btw ', 'Also, ', 'oh and ', 'Quick thing: ', 'fyi ', 'Anyway, ', 'by the way, '];
export const TIMEZONES = ['Asia/Karachi', 'Asia/Dubai', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Toronto', 'Asia/Kolkata', 'Africa/Nairobi', 'Asia/Singapore', 'Australia/Melbourne'];
export const SECRETS = [
  (r) => `my ATM pin is ${r.int(1000, 9999)}`,
  (r) => `the wifi password is ${r.pick(['sunflower', 'k8!Lm2pq', 'Lahore2026', 'blue-cat-77'])}${r.int(10, 99)}`,
  (r) => `use this key sk-proj-${r.hex(28)}`,
  (r) => `the OTP was ${r.int(100000, 999999)}`,
  (r) => `my card is 4111 1111 1111 1111`,
];
