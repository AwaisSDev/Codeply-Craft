"""Vocabulary pools for the life simulator. Every pool is split deterministically (60 / 20 / 20 by position) so test
and stress lives use people, organisations and values never seen in training (as in the PASTE generator)."""

FIRST_F = ["Ayesha", "Sara", "Hina", "Zara", "Mina", "Nadia", "Iqra", "Sana", "Fatima", "Maryam", "Amna", "Rabia", "Sadia",
           "Noor", "Mahnoor", "Kiran", "Laiba", "Areeba", "Bushra", "Huma", "Saba", "Farah", "Komal", "Anum", "Emma", "Olivia",
           "Sofia", "Leila", "Priya", "Ananya", "Mei", "Yuki", "Chloe", "Amara", "Zainab", "Rania", "Elena", "Hannah", "Isabel",
           "Nora", "Aisha", "Lina", "Maya", "Tara", "Rhea", "Selin", "Defne", "Ingrid", "Clara", "Julia", "Naomi", "Ruth",
           "Grace", "Esha", "Mehwish", "Shiza", "Alina", "Hafsa", "Sumaira", "Uzma"]
FIRST_M = ["Ali", "Bilal", "Omar", "Usman", "Faraz", "Kamran", "Hamza", "Ahmed", "Hassan", "Zain", "Danish", "Saad", "Imran",
           "Tariq", "Junaid", "Waqas", "Fahad", "Adeel", "Shahid", "Asad", "Moiz", "Rehan", "Talha", "Yasir", "Liam", "Noah",
           "Lucas", "Mateo", "Arjun", "Rohan", "Kenji", "Hiro", "Daniel", "Samuel", "Karim", "Yusuf", "Emre", "Can", "Lars",
           "Felix", "Jonas", "Marco", "Diego", "Kwame", "Tunde", "Ravi", "Vikram", "Owen", "Ethan", "Leo", "Musa", "Idris",
           "Haris", "Sameer", "Nabeel", "Awais", "Shayan", "Ammar", "Rayyan", "Zeeshan"]
SURNAMES = ["Malik", "Khan", "Ahmed", "Butt", "Chaudhry", "Qureshi", "Siddiqui", "Shah", "Raza", "Iqbal", "Hussain", "Javed",
            "Mirza", "Sheikh", "Baig", "Rizvi", "Hashmi", "Farooq", "Aslam", "Nawaz", "Smith", "Garcia", "Patel", "Kim",
            "Nakamura", "Rossi", "Muller", "Novak", "Okafor", "Mensah", "Yilmaz", "Demir", "Silva", "Costa", "Larsen",
            "Berg", "Cohen", "Haddad", "Rahman", "Chen", "Singh", "Iyer", "Fernandes", "Lopez", "Dubois", "Martin",
            "Kowalski", "Petrov", "Andersson", "Ali"]
ORGS = ["Atlas Labs", "Northwind", "Bluefin Systems", "Crescent Bank", "Orbit Health", "Sapphire Textiles", "Kestrel AI",
        "Maple Logistics", "Helio Energy", "Juniper Media", "Indus Ventures", "Ravi Capital", "Margalla Robotics",
        "Lumen Studio", "Cobalt Analytics", "Harbor Foods", "Peak Robotics", "Saga Games", "Tidewater Labs", "Vertex Design",
        "Nimbus Cloud", "Aurora Bio", "Granite Partners", "Willow Schools", "Copper Fintech"]
SCHOOLS = ["NUST", "LUMS", "FAST", "UET Lahore", "Punjab University", "IBA Karachi", "COMSATS", "GIKI", "Habib University",
           "Aga Khan University", "University of Toronto", "TU Munich", "King's College London", "University of Melbourne"]
PROJECTS = ["Atlas", "Falcon", "Mehfil", "Chirag", "Neem", "Saffron", "Kite", "Zephyr", "Tarang", "Basil", "Orbit", "Sitara",
            "Pulse", "Lantern", "Quill", "Ember", "Raahi", "Banyan", "Halo", "Meridian", "Sparrow", "Nova", "Tundra",
            "Cedar", "Mosaic"]
PLACES = ["Cafe Aylanto", "Monal", "Butlers Chocolate Cafe", "the Gymkhana", "Packages Mall", "F-9 Park", "Liberty Market",
          "the office", "Gloria Jeans", "Cosa Nostra", "Tuscany Courtyard", "Espresso Lounge", "the library", "Jinnah Park",
          "Centaurus Mall", "Dolmen Mall", "Kolachi", "the campus cafe", "Second Cup", "Salt'n Pepper"]

# Open-vocabulary slots beyond the PASTE ontology (Iris cases from the owner's vision); (slot, kind, about, values)
IRIS_SLOTS = [
    ("brand colours", "preference", "user", ["teal and coral", "navy and gold", "black and lime", "forest green and cream",
                                              "burgundy and sand", "slate and orange", "purple and mint", "charcoal and amber"]),
    ("design style", "style", "user", ["minimal with lots of white space", "bold and playful", "editorial serif typography",
                                        "brutalist", "soft pastel gradients", "flat illustrations"]),
    ("academic goal", "fact", "user", ["an A in Linear Algebra", "a 3.7 GPA this semester", "a distinction in Data Structures",
                                        "an 85 in the physics midterm", "top 10 in the class", "an A minus in Operating Systems"]),
    ("midterm mark", "fact", "user", None),               # expanded per subject (SUBJECTS x MARKS) in life.py
    ("study plan", "routine", "user", ["two pomodoro blocks every evening", "past papers every Saturday",
                                        "flashcards before bed", "a study group on Wednesdays", "one chapter a day"]),
    ("hydration goal", "routine", "user", ["eight glasses of water a day", "2 litres a day", "a glass every hour at work",
                                            "3 litres on gym days"]),
    ("sleep target", "routine", "user", ["in bed by 11pm", "seven hours a night", "no screens after 10pm", "up at 6am"]),
    ("current project", "fact", "user", None),           # value = a project name from the life
    ("monthly budget", "fact", "user", ["50,000 rupees", "80,000 rupees", "1,200 dollars", "a strict 40k", "around 100k"]),
    ("reply style", "style", "user", ["short bullet points", "detailed explanations", "Urdu when casual", "no emojis",
                                       "code first, explanation after"]),
    ("tech stack", "decision", "project", ["Next.js and Supabase", "Django and Postgres", "Flutter and Firebase",
                                           "SvelteKit and SQLite", "FastAPI and Redis", "Electron and React"]),
    ("launch date", "decision", "project", ["15 December", "end of January", "the first week of March", "before Eid",
                                            "21 November"]),
]

SUBJECTS = ["Calculus", "Linear Algebra", "Data Structures", "Physics", "Statistics", "Economics", "Operating Systems",
            "Organic Chemistry", "Microeconomics", "Discrete Maths"]
MARKS = ["58 out of 100", "64 out of 100", "71 out of 100", "77 out of 100", "82 out of 100", "88 out of 100",
         "91 out of 100", "69 out of 100", "74 out of 100", "85 out of 100"]

# Sensitive items (always gold sensitivity secret / private); the text values are synthetic and invalid by design.
SENSITIVE = [
    ("card number", "secret", "finance", ["4111 1111 1111 1111", "5500 0000 0000 0004", "4000 0566 5566 5556"]),
    ("bank PIN", "secret", "credentials", ["4821", "0937", "7710"]),
    ("email password", "secret", "credentials", ["Tulip#2024", "blue-river-88", "Qwerty!771"]),
    ("CNIC number", "secret", "identity", ["35202-1234567-1", "61101-7654321-3", "42101-1112223-5"]),
    ("passport number", "secret", "identity", ["AB1234567", "CD7654321", "EF1928374"]),
    ("diagnosis", "private", "health", ["mild asthma", "type 2 diabetes", "a thyroid condition", "migraines"]),
    ("medication", "private", "health", ["metformin twice a day", "an inhaler before runs", "levothyroxine every morning"]),
    ("therapy", "private", "health", ["weekly therapy sessions", "a counsellor every other Thursday"]),
    ("salary", "private", "finance", ["220,000 rupees a month", "95,000 dollars a year", "1.4 million a year"]),
    ("home address", "private", "location", ["House 12, Street 4, F-7/2", "Flat 3B, Clifton Block 5", "14 Garden Road, Model Town"]),
]

# Why the user is talking to an assistant (facts are incidental to these purposes)
ASSISTANT_PURPOSES = [   # fact-neutral: a faithful render of the purpose states nothing memory-worthy about anyone (E60)
    "asks how compound interest works", "asks for a recipe idea for dinner", "asks to debug a Python error",
    "asks for a riddle", "asks how photosynthesis works", "asks for the rules of chess", "asks how to boil an egg perfectly",
    "asks to summarise an article", "asks to translate a sentence into French", "asks for a budget spreadsheet layout",
    "asks what an API is", "asks to proofread a sample paragraph", "asks to explain a statistics concept",
    "asks for a fun fact about space", "asks for productivity tips", "asks to compare two laptops",
    "asks how to set up a React project", "asks how vaccines work", "asks to rewrite a paragraph more formally",
    "asks for a packing list template", "asks how to convert cups to grams", "asks about healthy breakfast options",
]
CHAT_PURPOSES = ["saying hello after a while", "sending each other memes", "chatting about the weather", "trading jokes",
                 "reacting to a viral video", "talking about a cricket match on TV", "chatting about a news headline",
                 "complaining about the traffic today", "wishing each other a good day", "discussing a trending meme"]


def split_pool(items, split):
    n = len(items)
    a, b = int(0.6 * n), int(0.8 * n)
    return items[:a] if split in ("train", "pilot") else items[a:b] if split == "val" else items[b:]


def split_values(values, split):
    """Test / stress may use every value; train / val never see the last 20 % (as data/ontology.values)."""
    cut = len(values) - max(1, len(values) // 5)
    return values if split in ("test", "stress") else values[:cut]
