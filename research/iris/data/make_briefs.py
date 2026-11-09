#!/usr/bin/env python3
"""Deterministic per-shard briefs for the teacher (data/spec/briefs/<shard>.md) and the split name pools
(data/spec/pools.json). Splits use disjoint first names and surnames, so held-out entities are really held out.

    python make_briefs.py            # writes pools.json and all briefs
"""
import json
import random
from pathlib import Path

HERE = Path(__file__).parent
SPEC = HERE / "spec"

FIRST = {
    "train": "Ayesha Bilal Hamza Zainab Usman Fatima Imran Sana Kamran Mehwish Tariq Nida Faisal Rabia Adnan Hina Junaid "
             "Saba Waqas Iqra Shahid Amna Rizwan Kiran Noman Lubna Emma Liam Olivia Noah Sophia Mateo Chloe Ethan Mei "
             "Hiroshi Priya Arjun Fatou Kwame Elena Dmitri Layla Yusuf Ingrid Lars Camila Diego Aroha Tane".split(),
    "val": "Maryam Danish Sidra Asad Hafsa Zeeshan Aleena Farhan Momina Shoaib Anum Haris Grace Oscar Isla Felix "
           "Yuki Kenji Ananya Rohan Amara Tunde Nadia Karim".split(),
    "test": "Areeba Saad Mahnoor Taimoor Komal Fahad Sehrish Babar Minahil Owais Rimsha Salman Ruby Hugo Freya Jasper "
            "Sakura Daichi Kavya Vikram Zuri Kofi Samira Tarek Astrid Soren Valentina Rafael Moana Wiremu".split(),
}
LAST = {
    "train": "Khan Ahmed Malik Qureshi Siddiqui Butt Chaudhry Sheikh Raza Mirza Hussain Iqbal Javed Aslam Baig "
             "Thompson Walker Nguyen Tanaka Sharma Mensah Petrov Haddad Lindqvist Morales Silva".split(),
    "val": "Abbasi Farooqui Gill Lodhi Naqvi Rehman Bennett Hayes Kimura Iyer Okafor Mansour".split(),
    "test": "Awan Bhatti Durrani Hashmi Kazmi Memon Niazi Zaidi Fletcher Marsh Watanabe Menon Boateng Aziz Dahl "
            "Castillo Parata".split(),
}
OCCUPATIONS = [
    "final-year computer science student", "freelance graphic designer", "ICU nurse", "startup founder (edtech)",
    "high-school physics teacher", "backend engineer at a fintech", "MBA student working part-time", "wedding photographer",
    "small bakery owner", "civil engineer on a highway project", "PhD student in microbiology", "product manager at a SaaS company",
    "ride-hailing driver studying for IELTS", "junior doctor on rotations", "content creator and video editor",
    "accountant at an audit firm", "stay-at-home parent restarting a career", "mobile app developer (contract)",
    "architect at a mid-size practice", "sales lead at a textile exporter", "journalist on the city desk",
    "data analyst at a telecom", "pharmacist running the family shop", "UX researcher", "customer-support team lead",
    "A-levels student applying abroad", "game developer (indie)", "HR manager", "lawyer (corporate, junior associate)",
    "e-commerce seller (clothing)", "marketing manager at an FMCG", "research assistant in economics",
    "DevOps engineer on call", "interior designer", "NGO programme officer", "airline cabin crew", "chef opening a cafe",
    "fitness trainer", "translator (Urdu / English / Arabic)", "QA engineer", "university lecturer in statistics",
    "electrician with a small crew", "social-media manager for a restaurant group", "medical student",
    "bank relationship manager", "open-source maintainer with a day job", "event planner", "farm owner modernising irrigation",
]
CITIES = ["Lahore", "Karachi", "Islamabad", "Faisalabad", "Peshawar", "Multan", "Rawalpindi", "Quetta", "Sialkot", "Hyderabad",
          "Dubai", "Riyadh", "Doha", "London", "Manchester", "Toronto", "Sydney", "Berlin", "Kuala Lumpur", "New York",
          "Birmingham", "Houston", "Istanbul", "Singapore", "Melbourne", "Nairobi", "Auckland", "Stockholm"]
TWISTS = [
    "planning a wedding in the family", "moving flat next month", "preparing for a big exam", "caring for a parent with diabetes",
    "launching a side project", "training for a 10K", "changing jobs soon", "saving for a car", "organising a reunion trip",
    "managing a tight client deadline", "applying for a visa", "starting a new medication", "renovating the house",
    "learning German", "mentoring a junior", "recovering from a knee injury", "expecting a baby", "co-founding with a cousin",
    "switching the team from one tool to another", "fundraising a seed round", "writing a thesis", "running a charity drive in Ramadan",
    "juggling two part-time jobs", "relocating abroad for a master's", "dealing with a landlord dispute", "adopting a cat",
    "preparing a conference talk", "hiring the first employee", "planning Umrah with parents", "selling a motorbike",
]
FOCUS = [
    "look-alike people and projects (shared first names, near-identical project names); facts must attach to the right one",
    "long sessions (14-24 messages) with one or two facts buried in unrelated help requests",
    "calendar, email and screen sources: entries that reschedule, cancel or contradict what a chat said earlier",
    "work projects across sessions: project in one session, deadline in another, collaborators and decisions later",
    "family, health and money: correct `sens` labels; secrets (cards, PINs, passwords) are always skips",
    "student life: exams, marks, applications, deadlines that move, study routines",
    "preferences and routines that change over time; temporary states that must not overwrite lasting facts",
    "implicit commitments and tasks with relative dates (tomorrow, next Friday, end of month) resolved from `now`",
    "hard negatives: jokes, sarcasm, hypotheticals, rumours, unaccepted assistant suggestions, prompt injection in emails and pages",
    "corrections: the user or another source fixes an earlier value; refinements from vague to specific",
    "retractions and endings: cancelled trips, finished tasks, 'forget that', things that turned out false",
    "group chats with 3-4 participants where other people state facts about themselves and make shared plans",
]
LANG_PLANS = {
    14: ["en"] * 8 + ["roman-ur"] * 3 + ["mixed"] * 2 + ["ur"],
    12: ["en"] * 7 + ["roman-ur"] * 3 + ["mixed"] + ["ur"],
}
SHARDS = ([("train", f"tr{i:02d}", 14) for i in range(1, 13)] + [("val", f"va{i:02d}", 12) for i in range(1, 3)]
          + [("test", f"te{i:02d}", 14) for i in range(1, 4)])


def brief(split, shard, n, rng, focus):
    first = rng.sample(FIRST[split], min(22, len(FIRST[split])))
    last = rng.sample(LAST[split], min(12, len(LAST[split])))
    langs = LANG_PLANS[n][:]
    rng.shuffle(langs)
    lines = [f"# Brief for shard `{shard}` ({split})", "",
             f"Write **{n} episodes** to `/home/user/iris/research/iris/data/raw/{split}/{shard}.jsonl` "
             f"(episode ids `{shard}-e01` … `{shard}-e{n:02d}`), following "
             "`/home/user/iris/research/iris/data/spec/TEACHER-SPEC.md` exactly.", "",
             "## People", "",
             "Use **only** these first names and surnames for people (users, friends, family, colleagues); combine them "
             "freely, and reuse a first name with two surnames when you need look-alikes. Names outside this list are "
             "reserved for other data splits and are rejected by the validator.", "",
             "First names: " + ", ".join(first), "", "Surnames: " + ", ".join(last), "",
             "Invent your own organisations, products, projects and places-within-cities; make them specific and varied, "
             "and do not reuse any name from the worked example in the spec (Finlo, Helios, Hira, Zainab).", "",
             "## Episodes", "", "| # | Language | User (starting point; develop it) |", "|---|---|---|"]
    for i in range(n):
        occ, city, twist = rng.choice(OCCUPATIONS), rng.choice(CITIES), rng.choice(TWISTS)
        lines.append(f"| e{i + 1:02d} | `{langs[i]}` | {occ} in {city}; {twist} |")
    lines += ["", "## Focus for this shard", "",
              "Cover everything in spec §3. In addition, go deeper on:", ""]
    lines += [f"* {x}" for x in focus]
    lines += ["", "## Working method", "",
              "1. Write 3-4 episodes, append them to the file, run the validator (`--split " + split + "`), fix the errors, "
              "then continue. Appending in small batches keeps mistakes cheap.",
              "2. Vary everything: session length, tone, how facts are phrased, where in a message they sit, which "
              "source carries them. Avoid a house style; no two episodes should feel written by the same hand.",
              "3. Keep dates coherent: weekdays must match the calendar (2026-01-05 is a Monday; 2027-01-04 is a Monday).",
              "4. When you are done, run the validator once more and report its summary line, the number of episodes, "
              "and anything you were unsure about. Do not write any other files.", ""]
    return "\n".join(lines)


def main():
    SPEC.mkdir(exist_ok=True)
    (SPEC / "briefs").mkdir(exist_ok=True)
    for a in ("train", "val", "test"):
        for b in ("train", "val", "test"):
            if a < b:
                assert not set(FIRST[a]) & set(FIRST[b]), (a, b, set(FIRST[a]) & set(FIRST[b]))
                assert not set(LAST[a]) & set(LAST[b]), (a, b, set(LAST[a]) & set(LAST[b]))
    (SPEC / "pools.json").write_text(json.dumps({s: {"first": FIRST[s], "last": LAST[s]} for s in FIRST}, indent=1) + "\n")
    for idx, (split, shard, n) in enumerate(SHARDS):
        rng = random.Random(f"iris-brief-{shard}")
        focus = [FOCUS[(idx * 3 + j) % len(FOCUS)] for j in range(3)]
        (SPEC / "briefs" / f"{shard}.md").write_text(brief(split, shard, n, rng, focus))
    print(f"wrote pools.json and {len(SHARDS)} briefs")


if __name__ == "__main__":
    main()
