"""Attribute ontology: 100 classes (spec §5.2; the class list fixed here replaces the attr_000.. placeholders).

Each class: name, Brain kind, which entity types it applies to, a value pool, and optional class-specific
phrasings. Value pools are split: the last 20 % of every pool (at least one value) is test-only, so the frozen
test set contains values never seen in training.
"""
P, F, R, S = "preference", "fact", "routine", "style"
D, I, Q, T = "decision", "idea", "requirement", "todo"
PERSON, USER, PROJECT = "person", "user", "project"
UP = (USER, PERSON)

# (name, kind, applies_to, values)
CLASSES = [
    # --- personal facts (user and people) ---
    ("home city", F, UP, ["Lahore", "Karachi", "Islamabad", "Multan", "Peshawar", "Quetta", "Faisalabad", "Dubai", "Manchester", "Toronto", "Berlin", "Doha"]),
    ("hometown", F, UP, ["Sialkot", "Hyderabad", "Abbottabad", "Gujranwala", "Bahawalpur", "Sukkur", "Mardan", "Murree"]),
    ("employer", F, UP, ["Atlas Labs", "Northwind", "Bluefin Systems", "Crescent Bank", "Orbit Health", "Sapphire Textiles", "Kestrel AI", "Maple Logistics", "Helio Energy", "Juniper Media"]),
    ("job title", F, UP, ["backend engineer", "product manager", "data analyst", "UX designer", "accountant", "high school teacher", "nurse", "civil engineer", "sales lead", "QA engineer"]),
    ("university", F, UP, ["NUST", "LUMS", "FAST", "UET Lahore", "Punjab University", "IBA Karachi", "COMSATS", "GIKI"]),
    ("degree", F, UP, ["computer science", "economics", "mechanical engineering", "physics", "business", "architecture", "psychology"]),
    ("birthday", F, UP, ["12 March", "3 July", "28 October", "1 January", "19 May", "7 September", "22 December", "14 February"]),
    ("phone model", F, UP, ["Pixel 9", "iPhone 16", "Galaxy S25", "OnePlus 13", "Nothing Phone 3", "Redmi Note 14"]),
    ("laptop", F, UP, ["ThinkPad X1", "MacBook Air", "Dell XPS 13", "Framework 13", "HP Spectre", "Zenbook 14"]),
    ("car", F, UP, ["Honda Civic", "Toyota Corolla", "Suzuki Swift", "Kia Sportage", "Hyundai Tucson", "MG HS"]),
    ("pet", F, UP, ["a cat called Mitthu", "a dog called Sheru", "a parrot called Rio", "two goldfish", "a rabbit called Bunty", "a cat called Simba"]),
    ("native language", F, UP, ["Urdu", "Punjabi", "Pashto", "Sindhi", "English", "Saraiki", "Balochi"]),
    ("neighbourhood", F, UP, ["DHA Phase 5", "Gulberg", "Clifton", "F-7", "Bahria Town", "Model Town", "Johar Town"]),
    ("commute", R, UP, ["by metro bus", "by bike", "on foot", "by car", "by Careem", "by train"]),
    ("allergy", F, UP, ["peanuts", "dust", "shellfish", "pollen", "penicillin", "cats"]),
    ("blood group", F, UP, ["O positive", "A positive", "B negative", "AB positive", "O negative"]),
    ("gym", F, UP, ["Shapes", "Fitness Hub", "Gold's Gym", "the university gym", "Ultimate Fitness"]),
    ("bank", F, UP, ["Meezan Bank", "HBL", "UBL", "Bank Alfalah", "Standard Chartered", "MCB"]),
    ("anniversary", F, UP, ["5 April", "18 August", "30 November", "9 June", "21 January"]),
    ("shoe size", F, UP, ["42", "43", "44", "39", "40", "45"]),
    # --- preferences ---
    ("favourite drink", P, UP, ["green tea", "black coffee", "chai", "lassi", "lemonade", "mint tea", "cold brew", "doodh patti"]),
    ("favourite food", P, UP, ["biryani", "nihari", "sushi", "pasta", "haleem", "karahi", "dal chawal", "pizza", "chapli kebab"]),
    ("favourite cuisine", P, UP, ["Thai", "Italian", "Turkish", "Lebanese", "Chinese", "Mexican", "Japanese"]),
    ("diet", P, UP, ["vegetarian", "vegan", "low-carb", "halal only", "pescatarian", "gluten-free"]),
    ("music genre", P, UP, ["jazz", "qawwali", "lo-fi", "indie rock", "classical", "Coke Studio stuff", "hip hop", "ghazals"]),
    ("favourite band", P, UP, ["Strings", "Junoon", "Noori", "Coldplay", "Radiohead", "Arctic Monkeys", "Kaavish"]),
    ("favourite sport", P, UP, ["cricket", "squash", "football", "badminton", "tennis", "table tennis", "hockey"]),
    ("favourite team", P, UP, ["Lahore Qalandars", "Karachi Kings", "Islamabad United", "Barcelona", "Liverpool", "Peshawar Zalmi"]),
    ("movie genre", P, UP, ["thrillers", "sci-fi", "romantic comedies", "documentaries", "horror films", "anime films"]),
    ("book genre", P, UP, ["fantasy", "biographies", "Urdu poetry", "history", "self-help", "crime novels"]),
    ("favourite author", P, UP, ["Mohsin Hamid", "Faiz Ahmed Faiz", "Ursula Le Guin", "Kamila Shamsie", "Agatha Christie", "Bano Qudsia"]),
    ("travel style", P, UP, ["backpacking", "beach resorts", "road trips", "city breaks", "mountain treks"]),
    ("seat preference", P, UP, ["window seat", "aisle seat", "front row", "exit row"]),
    ("favourite colour", P, UP, ["teal", "maroon", "navy blue", "mustard yellow", "olive green", "black"]),
    ("coffee order", P, UP, ["a flat white", "a double espresso", "an oat latte", "a cappuccino", "an iced americano"]),
    ("dessert", P, UP, ["gulab jamun", "cheesecake", "kheer", "brownies", "ras malai", "tiramisu"]),
    ("holiday destination", P, UP, ["Hunza", "Skardu", "Istanbul", "Bali", "Swat", "Naran", "Lisbon"]),
    ("game", P, UP, ["FIFA", "Valorant", "chess", "PUBG", "Minecraft", "ludo", "Elden Ring"]),
    ("TV show", P, UP, ["Humsafar", "Breaking Bad", "The Office", "Succession", "Dark", "Suno Chanda"]),
    ("streaming service", P, UP, ["Netflix", "Prime Video", "YouTube Premium", "Tapmad", "Disney+"]),
    ("notification preference", P, (USER,), ["email only", "no notifications after 9pm", "WhatsApp messages", "a daily digest", "push notifications"]),
    ("meeting preference", P, (USER,), ["mornings only", "no meetings on Fridays", "30-minute slots", "video off by default", "async updates instead"]),
    ("editor theme", P, (USER,), ["dark mode", "light mode", "solarized", "high contrast", "Dracula"]),
    ("keyboard layout", P, (USER,), ["Colemak", "QWERTY", "Dvorak", "a split ergonomic keyboard"]),
    ("operating system", P, (USER,), ["Linux", "macOS", "Windows", "Fedora", "Ubuntu"]),
    ("browser", P, (USER,), ["Firefox", "Chrome", "Arc", "Brave", "Safari"]),
    ("units", P, (USER,), ["metric units", "imperial units", "Celsius", "24-hour time"]),
    ("hotel preference", P, UP, ["quiet rooms", "a high floor", "breakfast included", "a pool", "late checkout"]),
    ("fragrance", P, UP, ["oud", "citrus scents", "nothing too strong", "musk", "lavender"]),
    ("flower", P, UP, ["jasmine", "roses", "tulips", "sunflowers", "marigolds"]),
    # --- routines ---
    ("wake-up time", R, UP, ["6am", "5:30am", "7am", "8am", "9am", "6:45am"]),
    ("gym days", R, UP, ["Monday and Thursday", "every weekday", "weekends", "Tuesday and Friday", "Wednesday evenings"]),
    ("work hours", R, UP, ["9 to 5", "10 to 6", "night shifts", "flexible hours", "8 to 4"]),
    ("standup time", R, (USER,), ["9:30am", "10am", "11am", "9am", "2pm"]),
    ("weekly call", R, UP, ["Sunday evenings with my parents", "Friday lunch with the team", "Saturday mornings with my sister", "Wednesday nights with friends"]),
    ("running routine", R, UP, ["5k every morning", "long runs on Sundays", "intervals on Tuesdays", "a jog after work"]),
    ("prayer time", R, UP, ["Fajr at the mosque", "Maghrib at home", "Jummah at the office mosque"]),
    ("grocery day", R, UP, ["Saturday", "Sunday morning", "Wednesday evening", "the first of the month"]),
    ("sleep time", R, UP, ["11pm", "midnight", "10:30pm", "1am"]),
    ("reading habit", R, UP, ["20 pages before bed", "audiobooks on the commute", "a book a month", "news first thing in the morning"]),
    # --- style (how they like to work with the assistant) ---
    ("reply length", S, (USER,), ["short answers", "detailed explanations", "bullet points", "one-line summaries"]),
    ("tone", S, (USER,), ["casual", "formal", "friendly but direct", "no small talk"]),
    ("response language", S, (USER,), ["Urdu", "English", "Roman Urdu", "a mix of English and Urdu"]),
    ("code style", S, (USER,), ["tabs", "four spaces", "two spaces", "Prettier defaults", "Black formatting"]),
    ("naming convention", S, (USER,), ["camelCase", "snake_case", "PascalCase for types", "kebab-case file names"]),
    ("commit message style", S, (USER,), ["conventional commits", "short imperative messages", "messages with ticket numbers", "emoji prefixes"]),
    ("explanation style", S, (USER,), ["examples first", "theory first", "step by step", "diagrams where possible"]),
    ("review preference", S, (USER,), ["blunt feedback", "gentle feedback", "line-by-line comments", "only the big issues"]),
    ("date format", S, (USER,), ["day-month-year", "ISO dates", "month-day-year", "written-out months"]),
    ("emoji use", S, (USER,), ["no emojis", "lots of emojis", "the occasional emoji"]),
    # --- project attributes ---
    ("deadline", Q, (PROJECT,), ["Friday", "end of the month", "15 November", "next sprint", "the 30th", "Monday morning"]),
    ("tech stack", D, (PROJECT,), ["Next.js and Postgres", "Django and React", "Flutter and Firebase", "Go and SQLite", "Rails and Redis", "FastAPI and Vue"]),
    ("database", D, (PROJECT,), ["Postgres", "MySQL", "MongoDB", "SQLite", "DynamoDB", "Supabase"]),
    ("hosting", D, (PROJECT,), ["Vercel", "AWS", "Fly.io", "Render", "a VPS on Hetzner", "Cloudflare"]),
    ("status", F, (PROJECT,), ["in design", "in beta", "blocked on legal", "launched", "paused", "in code review"]),
    ("budget", Q, (PROJECT,), ["2 lakh rupees", "5,000 dollars", "no budget yet", "10 lakh", "800 dollars a month"]),
    ("client", F, (PROJECT,), ["Crescent Bank", "a school in Lahore", "an NGO in Swat", "Orbit Health", "Juniper Media"]),
    ("lead", F, (PROJECT,), ["Sara", "Bilal", "Hina", "Omar", "Zara", "Usman"]),
    ("auth method", D, (PROJECT,), ["magic links", "Google sign-in", "passkeys", "email login", "phone OTP"]),
    ("main requirement", Q, (PROJECT,), ["offline support", "Urdu localisation", "under 2 seconds to load", "accessibility for screen readers", "audit logs"]),
    ("next task", T, (PROJECT,), ["write the onboarding flow", "fix the payment webhook", "add dark mode", "set up CI", "migrate the database", "draft the pitch deck"]),
    ("design idea", I, (PROJECT,), ["a map view", "voice input", "a weekly email digest", "gamified streaks", "a public API"]),
    ("launch date", Q, (PROJECT,), ["1 December", "after Eid", "early January", "the 20th", "next quarter"]),
    ("repo", F, (PROJECT,), ["on GitHub", "on GitLab", "in the company monorepo", "on Bitbucket"]),
    ("testing approach", D, (PROJECT,), ["unit tests only", "Playwright end-to-end tests", "manual QA", "property-based tests"]),
    ("design tool", D, (PROJECT,), ["Figma", "Penpot", "pen and paper", "Sketch"]),
    ("pricing model", D, (PROJECT,), ["a monthly subscription", "one-time purchase", "freemium", "pay per seat"]),
    ("target users", Q, (PROJECT,), ["small shop owners", "university students", "doctors", "freelancers", "parents"]),
    ("framework version", D, (PROJECT,), ["React 19", "Django 5", "Next 15", "Flutter 3.24"]),
    ("analytics", D, (PROJECT,), ["PostHog", "Plausible", "Google Analytics", "no analytics"]),
    # --- relations of other people (person only) ---
    ("relationship to user", F, (PERSON,), ["sister", "brother", "cousin", "coworker", "manager", "neighbour", "friend from university", "landlord"]),
    ("kids", F, (PERSON,), ["two daughters", "a baby son", "no kids", "three kids", "twin boys"]),
    ("spouse", F, (PERSON,), ["married to Ahmed", "married to Fatima", "engaged", "single"]),
    ("instrument", P, UP, ["guitar", "tabla", "piano", "violin", "flute"]),
    ("hobby", P, UP, ["photography", "calligraphy", "gardening", "baking", "chess", "hiking", "pottery"]),
    ("volunteer work", F, UP, ["at the Edhi centre", "teaching kids on weekends", "at an animal shelter", "with a blood donation drive"]),
    ("side project", F, UP, ["a cooking blog", "a Shopify store", "a YouTube channel", "a mobile game", "a podcast"]),
    ("learning", F, UP, ["Arabic", "Rust", "French", "guitar", "data science", "Chinese"]),
    ("charity", F, UP, ["the Indus Hospital", "a local mosque fund", "an orphanage in Multan", "a flood relief fund"]),
    ("favourite season", P, UP, ["winter", "monsoon", "spring", "autumn"]),
]
assert len(CLASSES) == 100, len(CLASSES)
NAMES = [c[0] for c in CLASSES]
INDEX = {c[0]: i for i, c in enumerate(CLASSES)}
KIND = {c[0]: c[1] for c in CLASSES}
APPLIES = {c[0]: c[2] for c in CLASSES}


def values(name, split):
    """Value pool for a split. Test and stress may use every value; train and val never see the test-only tail."""
    vals = CLASSES[INDEX[name]][3]
    cut = len(vals) - max(1, len(vals) // 5)
    return vals if split in ("test", "stress") else vals[:cut]


def test_only_values():
    out = set()
    for name, _, _, vals in CLASSES:
        cut = len(vals) - max(1, len(vals) // 5)
        out |= {(name, v) for v in vals[cut:]}
    return out
