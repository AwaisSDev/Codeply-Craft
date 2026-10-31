# ================= NOISE (41-70) =================
N = 41


def NZ(lang, anchor, *events):
    global N
    X(N, "noise", lang, anchor, list(events))
    N += 1


# one-off formality request
NZ("en", "A", C(
    "User: write this email formally, it's going to the dean: hey, attached the revised syllabus, lmk if anything's off. thx",
    "Assistant: Dear Dean,\n\nPlease find attached the revised syllabus for your review. Kindly let me know if any changes are required.\n\nKind regards,"))

# comparison question, not a preference
NZ("en", "B", C(
    "User: is Postgres better than Mongo for a chat app? like honestly",
    "Assistant: For most chat apps Postgres is the safer default: messages, users and rooms are relational, and you get transactions and solid indexing. Mongo can fit if your message shape varies a lot, but you'll end up rebuilding joins in code.",
    "User: hmm ok and what about for analytics later",
    "Assistant: Postgres again, or replicate into a columnar store when volume grows."))

# UI tweak requests
NZ("en", "C", C(
    "User: make the submit button blue and a bit more rounded",
    "Assistant: Done: background #2563eb, border-radius 10px.",
    "User: lighter blue",
    "Assistant: Changed to #3b82f6.",
    "User: perfect"))

# thanks, mixed
NZ("mixed", "F", C(
    "User: bhai you're a lifesaver, finally deploy ho gaya 🙏🙏 thank you so much",
    "Assistant: Glad it worked! 🎉"))

# joke + 'I love it'
NZ("en", "D", C(
    "User: tell me a joke about kubernetes",
    "Assistant: Why did the pod break up with the node? It needed more space, and it kept getting evicted.",
    "User: hahahaha ok that's terrible. I love it",
    "Assistant: I'm here all week."))

# trivia with 'I always forget'
NZ("en", "E", C(
    "User: what's the capital of Kazakhstan again, I always forget",
    "Assistant: Astana."))

# neighbour's car
NZ("en", "A", C(
    "User: my neighbour just got a new car, red, kind of boxy, with a spare wheel on the back door. what model could it be",
    "Assistant: Sounds like it could be a Suzuki Jimny, or an older Toyota RAV4 if it's bigger. A photo of the badge would settle it."))

# translation containing preference words
NZ("en", "E", C(
    "User: translate 'I love spicy food and I hate waking up early' into Arabic, it's for my class worksheet",
    "Assistant: أحب الطعام الحار وأكره الاستيقاظ مبكرًا\n(uḥibbu aṭ-ṭaʿām al-ḥārr wa akrahu al-istiqāẓ mubakkiran)"))

# coding question
NZ("en", "C", C(
    "User: difference between let and const in js? and is var ever ok",
    "Assistant: Both let and const are block-scoped; const can't be reassigned (though objects it points to can still change). var is function-scoped and hoisted, which causes surprises. In modern code, default to const, use let when you need to reassign, and avoid var.",
    "User: so const arrays can still push?",
    "Assistant: Yes. const stops reassignment of the binding, not mutation of the array."))

# emotional reaction to a bug
NZ("en", "D", C(
    "User: ugh this bug is driving me insane, been staring at it for an hour\nTypeError: Cannot read properties of undefined (reading 'map')",
    "Assistant: Your data is undefined on the first render. Use items?.map(...) or initialise the state with [].",
    "User: OMG. one hour. for that. kill me",
    "Assistant: Happens to everyone!"))

# one-off format request
NZ("en", "B", C(
    "User: can you answer in bullet points for this one? pros and cons of solar panels for a small house",
    "Assistant: - Pros: lower bills, protection from tariff hikes, little maintenance\n- Cons: upfront cost, depends on roof direction and shade, batteries are expensive"))

# Roman Urdu coding error
NZ("ur", "F", C(
    "User: yeh code mein error kyun aa raha hai? IndentationError: unexpected indent",
    "Assistant: Line 4 par shuru mein ek extra space hai. Usay hata dein taake indentation upar wali line jaisi ho jaye.",
    "User: acha theek ho gaya shukriya"))

# assistant-only content
NZ("en", "A", C(
    "User: continue",
    "Assistant: ...The fort's present form dates largely to Akbar's reign, when it was rebuilt in brick in the 1560s. Jahangir and Shah Jahan added palaces and gardens, including the Sheesh Mahal with its mirror-work ceilings. Aurangzeb built the Alamgiri Gate facing the Badshahi Mosque. Under Sikh rule the fort was used as a residence, and the British later turned parts of it into barracks. It was listed as a UNESCO World Heritage Site in 1981 together with the Shalimar Gardens."))

# nutrition question
NZ("en", "F", C(
    "User: how many calories in a samosa? the big potato ones",
    "Assistant: Roughly 250–300 kcal for a large potato samosa, depending on size and how much oil it soaks up."))

# other people's lives
NZ("en", "B", C(
    "User: my friend's sister is getting married in Istanbul next spring, what's a good gift for a Turkish wedding? I've never been to one",
    "Assistant: Gold is traditional: guests often pin gold coins or cash to the couple's sash during the 'takı' ceremony. If you're not attending, a nice homeware gift or a card with money works well."))

# sort a list
NZ("en", "C", C(
    "User: sort alphabetically: mango, apricot, lychee, banana, fig",
    "Assistant: apricot, banana, fig, lychee, mango"))

# one-off creative style
NZ("en", "B", C(
    "User: write a short poem about rain, make it sad and use lots of imagery",
    "Assistant: Grey threads stitch the window shut,\nthe gutters hum an empty tune,\na paper boat dissolves in ink\nbeneath a drowned and borrowed moon."))

# question about etiquette
NZ("en", "D", C(
    "User: is it rude to text your boss on a Sunday? asking for a friend lol",
    "Assistant: Usually fine if it's not urgent-sounding. Something like 'No rush, for Monday' takes the pressure off. Scheduling the message for Monday morning is even safer."))

# file-specific instruction
NZ("en", "D", C(
    "User: use tabs not spaces in this file pls, the linter here is set to tabs",
    "Assistant: Converted all indentation in utils.go to tabs.",
    "User: ty"))

# travel weather question
NZ("en", "E", C(
    "User: what's the weather usually like in Istanbul in March?",
    "Assistant: Cool and changeable: around 6–14°C, with rain on roughly a third of days. Bring layers and a waterproof jacket."))

# acknowledgements
NZ("en", "A", C(
    "User: ok",
    "Assistant: Anything else?",
    "User: nope, cool thanks"))

# cricket trivia, Roman Urdu
NZ("ur", "B", C(
    "User: 1992 ka world cup kis ne jeeta tha aur final kahan hua tha?",
    "Assistant: Pakistan ne jeeta tha. Final Melbourne Cricket Ground mein England ke khilaf hua tha, Pakistan 22 runs se jeeta."))

# currency conversion
NZ("en", "F", C(
    "User: convert 250 USD to PKR roughly",
    "Assistant: Around 70,000 PKR at about 280 per dollar. Check today's rate for the exact figure."))

# distant acquaintance
NZ("en", "C", C(
    "User: draft a LinkedIn comment congratulating someone from my old uni on her new job. I barely know her, keep it short and generic",
    "Assistant: Congratulations on the new role, well deserved! Wishing you every success."))

# one-off role-play
NZ("en", "C", C(
    "User: pretend you're a pirate and explain git rebase",
    "Assistant: Arr! Rebase be when ye take yer commits, hoist 'em off yer old branch, and lay 'em down one by one atop the fresh main, like plankin' a new deck. History looks straight as a mast, but never rebase a branch yer crew already pulled, or there'll be mutiny!",
    "User: lmao perfect"))

# summarise an article
NZ("en", "D", C(
    "User: summarize this in 3 lines: The rover's team said on Tuesday that the drill had collected its 30th rock core from the crater rim, a layered sample that may preserve signs of ancient water. Engineers had paused drilling for two weeks after a sensor fault. The samples will be cached for a future return mission.",
    "Assistant: The rover drilled its 30th rock core from the crater rim.\nThe layered sample may hold signs of ancient water.\nDrilling resumed after a two-week sensor fault; samples await a return mission."))

# trivia
NZ("en", "E", C(
    "User: do people in Japan really eat KitKats in flavours like wasabi??",
    "Assistant: Yes! Japan has had hundreds of regional and limited KitKat flavours, including wasabi, matcha, sake and sweet potato. They're popular souvenirs."))

# CSS back-and-forth
NZ("en", "A", C(
    "User: css grid question. I want 3 columns on desktop and 1 on mobile",
    "Assistant: .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; }\n@media (max-width: 640px) { .grid { grid-template-columns: 1fr; } }",
    "User: and if I want the first card to span 2 columns",
    "Assistant: .grid > :first-child { grid-column: span 2; } and reset it to span 1 inside the mobile media query.",
    "User: the gap looks huge on mobile",
    "Assistant: Lower it in the media query: gap: 0.5rem;",
    "User: works"))

# one-off length limit
NZ("en", "B", C(
    "User: for this summary only, keep it under 100 words: our Q3 numbers were flat, churn went up 2%, but enterprise signed 4 new logos and the support backlog halved",
    "Assistant: Q3 revenue was flat and churn rose 2%. Bright spots: enterprise added four new logos and the support backlog was cut in half. Priority for Q4: reduce churn while building on enterprise momentum."))

# recipe, one-off spice level (mixed)
NZ("mixed", "E", C(
    "User: yaar chicken karahi ki recipe batao, but iss baar thori kam mirch, guests ke saath chhote bachay hain",
    "Assistant: 1 kg chicken, 4 tamatar, adrak lehsan paste, 1 tsp namak, sirf aadha tsp lal mirch aur 2 hari mirchein bina beej ke. Tamatar ko chicken ke saath tez aanch pe bhoonein jab tak oil alag na ho, phir adrak, dhania aur kali mirch daal kar khatam karein."))
