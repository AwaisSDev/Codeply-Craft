/**
 * Builds a private, internal reference library of real app screenshots for
 * design work. Sourced entirely from Apple's public iTunes Search API
 * (https://itunes.apple.com/search) - official, free, unauthenticated, and
 * returns screenshotUrls apps publish themselves for their own App Store
 * listing. Not scraped from inside running apps (that's the gray area that
 * got the unofficial Mobbin client killed). Output is never republished
 * publicly - it's a local index used only to inform design work in this
 * project.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, 'index.json');

const CATEGORIES = {
  productivity: [
    'Notion', 'Todoist', 'Things 3', 'TickTick', 'Asana', 'Trello', 'ClickUp', 'Linear', 'Evernote', 'Microsoft To Do',
    'Google Keep', 'Any.do', 'OmniFocus', 'Bear', 'Notability', 'GoodNotes', 'Craft Docs', 'Obsidian', 'Milanote', 'Miro',
    'Basecamp', 'Monday.com', 'Airtable', 'Coda', 'Zapier', 'IFTTT', 'Toggl Track', 'RescueTime', 'Forest', 'Habitica',
    'Streaks', 'Fantastical', 'Timepage', 'Google Calendar', 'Microsoft Outlook', 'Spark Mail', 'Superhuman', 'Simplenote', 'Day One', 'Journey',
    'Pocket', 'Instapaper', 'Readwise', 'Raindrop.io', '1Password', 'LastPass', 'Dashlane', 'Bitwarden', 'Adobe Scan', 'CamScanner',
    'PDF Expert', 'Documents by Readdle', 'WPS Office', 'Microsoft Word', 'Microsoft Excel', 'Microsoft PowerPoint', 'Google Docs', 'Google Sheets', 'Google Drive', 'Dropbox',
    'Box', 'Microsoft OneDrive', 'Zoom', 'Google Meet', 'Microsoft Teams', 'Cisco Webex Meetings', 'Loom', 'Calendly', 'TeamViewer', 'AnyDesk',
    'Sunsama', 'Motion', 'Structured', 'TimeTree', 'Clockify', 'Harvest', 'WorkFlowy', 'Roam Research', 'Logseq', 'Remember The Milk',
    'Google Tasks', 'Apple Notes', 'Microsoft OneNote', 'Standard Notes', 'Joplin', 'Zoho Notebook', 'Zoho Projects', 'Smartsheet', 'Wrike', 'Height',
    'Confluence', 'Jira', 'GitHub', 'GitLab', 'Flow', 'Focus To-Do', 'Be Focused', 'Complice', 'Amazing Marvin', 'Sorted3',
  ],
  finance: [
    'Robinhood', 'Cash App', 'Venmo', 'Mint: Budget & Finance', 'PayPal', 'Revolut', 'Chime', 'Coinbase', 'Wise', 'Credit Karma',
    'Zelle', 'Fidelity Investments', 'Charles Schwab', 'E*TRADE', 'Webull', 'SoFi', 'Ally Bank', 'Capital One Mobile', 'Chase Mobile', 'Bank of America Mobile Banking',
    'Wells Fargo Mobile', 'American Express', 'Discover Mobile', 'Acorns', 'Stash', 'Betterment', 'Wealthfront', 'YNAB', 'PocketGuard', 'Monarch Money',
    'Empower', 'NerdWallet', 'Truebill', 'Rocket Money', 'Klarna', 'Afterpay', 'Affirm', 'Splitwise', 'Zelle', 'Google Pay',
    'Apple Wallet', 'Samsung Wallet', 'Binance', 'Kraken', 'Gemini', 'Crypto.com', 'Trust Wallet', 'MetaMask', 'Plaid', 'Varo Bank',
    'Current', 'MoneyLion', 'Dave', 'Brigit', 'Empower Finance', 'Simplifi by Quicken', 'Quicken', 'QuickBooks', 'FreshBooks', 'Xero',
    'Wave', 'Square Point of Sale', 'Stripe Dashboard', 'Toast', 'Payoneer', 'TransferWise', 'Remitly', 'WorldRemit', 'Western Union', 'OFX',
    'TD Bank', 'US Bank', 'PNC Mobile', 'Citi Mobile', 'Navy Federal Credit Union', 'USAA Mobile', 'Marcus by Goldman Sachs', 'Public.com', 'M1 Finance', 'Vanguard',
    'TD Ameritrade Mobile', 'Interactive Brokers', 'TradingView', 'Yahoo Finance', 'Bloomberg', 'CNBC', 'Personal Capital', 'Tally', 'Digit', 'Qapital',
    'Prism', 'Albert', 'Even', 'Level Money', 'Honeydue', 'Zeta', 'Copilot Money', 'Lunch Money', 'Wallet by BudgetBakers', 'Spendee',
  ],
  shopping: [
    'Amazon Shopping', 'Etsy', 'eBay', 'SHEIN', 'ASOS', 'Nike', 'Instacart', 'Target', 'Wish', 'Zappos',
    'Walmart', 'Best Buy', 'Home Depot', "Lowe's", 'Costco', 'Sephora', 'Ulta Beauty', 'H&M', 'Zara', 'Uniqlo',
    'Adidas', 'Puma', 'Foot Locker', 'Vinted', 'Depop', 'Poshmark', 'ThredUp', 'Mercari', 'OfferUp', 'Facebook Marketplace',
    'Temu', 'AliExpress', 'Alibaba', 'Wayfair', 'IKEA', 'Overstock', 'Chewy', 'Petco', 'Kroger', 'Whole Foods Market',
    'Safeway', 'Shipt', 'Gopuff', 'Shopify', 'StockX', 'GOAT', 'Grailed', 'Rakuten', 'Honey', 'Capital One Shopping',
    'Groupon', 'RetailMeNot', 'Flipp', 'Ibotta', 'Fetch Rewards', 'Shopkick', 'Michaels', "Kohl's", 'Macy\'s', 'Nordstrom',
    'JCPenney', "Victoria's Secret", 'Gap', 'Old Navy', 'Banana Republic', 'American Eagle', 'Urban Outfitters', 'Forever 21', 'Lululemon', 'Under Armour',
    'Sephora Collection', 'Bath & Body Works', 'CVS Pharmacy', 'Walgreens', 'Rite Aid', 'GameStop', 'PlayStation App', 'Xbox', 'Steam', 'Newegg',
    'B&H Photo', 'REI', "Dick's Sporting Goods", 'Academy Sports', 'Sam\'s Club', 'BJ\'s Wholesale', 'Aldi', 'Trader Joe\'s', 'Fresh Direct', 'Boxed',
    'Zulily', 'Wildberries', 'Farfetch', 'SSENSE', 'Net-a-Porter', 'The RealReal', 'Carousell', 'OLX', 'Letgo', 'Craigslist',
  ],
  social: [
    'Instagram', 'WhatsApp Messenger', 'Telegram Messenger', 'Discord', 'Slack', 'X', 'Snapchat', 'TikTok', 'Messenger', 'LinkedIn',
    'Facebook', 'Pinterest', 'Reddit', 'Tumblr', 'BeReal', 'Threads', 'Mastodon', 'Bluesky', 'Clubhouse', 'Nextdoor',
    'Signal', 'Viber', 'WeChat', 'Line', 'KakaoTalk', 'Skype', 'Google Chat', 'Twitch', 'YouTube', 'YouTube Kids',
    'Quora', 'Yelp', 'Meetup', 'Bumble', 'Tinder', 'Hinge', 'OkCupid', 'Match', 'Grindr', 'Her',
    'Coffee Meets Bagel', 'Plenty of Fish', 'Badoo', 'Wizz', 'Yubo', 'Marco Polo', 'GroupMe', 'Band', 'Amino', 'Fanbase',
    'Poparazzi', 'Locket Widget', 'Gas', 'NGL', 'Sendit', 'LMK', 'Yik Yak', 'Fizz', 'Geneva', 'Circle',
    'Litmatch', 'Tagged', 'MeetMe', 'Skout', 'Hily', 'Feeld', 'Lex', 'Chappy', 'Taimi', 'Zoosk',
    'eharmony', 'Christian Mingle', 'JDate', 'Raya', 'Wingman', 'Once', 'Happn', 'Bristlr', 'Down Dating', 'Pure',
    'Wapa', 'Scruff', 'Jack\'d', 'Growlr', 'Surge', 'Chispa', 'BLK', 'CoffeeMeetsBagel', 'FriendsDate', 'Meetup Local',
    'Fetlife', 'Alt.com', 'Grouper', 'Timeleft', 'Cocktail Party', 'Peanut', 'Bumble BFF', 'Meetup+', 'Discord Nitro', 'Steam Chat',
  ],
  travel: [
    'Airbnb', 'Booking.com', 'Uber', 'Lyft', 'Google Maps', 'Expedia', 'Skyscanner', 'Hopper', 'Tripadvisor', 'Waze',
    'Kayak', 'Trivago', 'Hotels.com', 'Vrbo', 'Priceline', 'Southwest Airlines', 'Delta', 'United Airlines', 'American Airlines', 'JetBlue',
    'Ryanair', 'easyJet', 'British Airways', 'Emirates', 'Qatar Airways', 'Turkish Airlines', 'Lufthansa', 'Air France', 'Marriott Bonvoy', 'Hilton Honors',
    'IHG Hotels & Resorts', 'World of Hyatt', 'Best Western', 'Choice Hotels', 'Google Flights', 'Rome2rio', 'Omio', 'FlixBus', 'Greyhound', 'Amtrak',
    'Trainline', 'TripIt', 'CityMapper', 'Transit', 'Moovit', 'Apple Maps', 'HERE WeGo', 'Maps.me', 'GasBuddy', 'Parkopedia',
    'SpotHero', 'Turo', 'Zipcar', 'Getaround', 'Enterprise Rent-A-Car', 'Hertz', 'Avis', 'National Car Rental', 'Sixt', 'Rentalcars.com',
    'Grab', 'Gojek', 'Ola', 'Bolt', 'DiDi', 'FreeNow', 'Careem', 'Curb', 'BlaBlaCar', 'Couchsurfing',
    'HostelWorld', 'Agoda', 'Travelocity', 'Orbitz', 'CheapOair', 'Google Trips', 'Roadtrippers', 'The Vacationer', 'PackPoint', 'XE Currency',
    'Duolingo', 'Google Translate', 'iTranslate', 'TripCase', 'FlightAware', 'FlightRadar24', 'MyRadar', 'Windy', 'AccuWeather', 'The Weather Channel',
    'National Parks', 'AllTrails', 'Komoot', 'Gaia GPS', 'Wikiloc', 'Yelp', 'OpenTable', 'Resy', 'The Fork', 'Time Out',
  ],
  food_delivery: [
    'DoorDash', 'Uber Eats', 'Grubhub', 'Deliveroo', 'OpenTable', 'Starbucks', "McDonald's", 'Postmates', "Domino's", 'Chick-fil-A',
    "Wendy's", 'Burger King', 'Taco Bell', 'Panera Bread', 'Chipotle', 'Subway', "Papa John's", 'Pizza Hut', "Dunkin'", 'Panda Express',
    'Shake Shack', "Culver's", 'In-N-Out', 'Five Guys', 'Sonic Drive-In', 'Jack in the Box', 'KFC', 'Popeyes', 'Whataburger', "Raising Cane's",
    'Grubhub Guarantee', 'Seamless', 'Caviar', 'ChowNow', 'Toast Takeout', 'Slice', 'EatStreet', 'Waitr', 'Foodpanda', 'Zomato',
    'Swiggy', 'Just Eat', 'iFood', 'Rappi', 'Talabat', 'Careem NOW', 'Wolt', 'Glovo', 'Bolt Food', 'Yandex Eats',
    'Meituan', 'Ele.me', 'Baemin', "Yogiyo", 'GrabFood', 'foodpanda Taiwan', 'Menulog', 'HungryPanda', 'ezCater', 'Cater2.me',
    'Resy', 'Yelp Reservations', 'The Fork', 'Tock', 'Sevenrooms', 'Reserve', 'Bon Appetour', 'HowUdish', 'Feastly', 'EatWith',
    'Blue Apron', 'HelloFresh', 'Home Chef', 'Sunbasket', 'EveryPlate', 'Green Chef', 'Factor', 'Freshly', 'Daily Harvest', 'Gobble',
    'Instacart', 'Shipt', 'Gopuff', 'Amazon Fresh', 'FreshDirect', 'Peapod', 'Boxed', 'Thrive Market', 'Misfits Market', 'Imperfect Foods',
    'Starbucks Rewards', 'Dutch Bros', 'Tim Hortons', 'Krispy Kreme', "Jimmy John's", 'Firehouse Subs', "Jersey Mike's", 'Qdoba', 'Moe\'s Southwest Grill', 'El Pollo Loco',
  ],
  health_fitness: [
    'Strava', 'MyFitnessPal', 'Headspace', 'Calm', 'Peloton', 'Fitbit', 'Nike Run Club', 'WHOOP', 'Noom', 'Sleep Cycle',
    'Apple Fitness+', 'Garmin Connect', 'Samsung Health', 'Google Fit', 'Fitbod', 'Freeletics', 'Nike Training Club', 'Adidas Training', 'JEFIT', 'Strong',
    'Sworkit', 'Aaptiv', 'Daily Yoga', 'Down Dog', 'Yoga Studio', 'Glo', 'Alo Moves', 'Centr', 'Fiit', 'Ladder',
    'Future', 'Tonal', 'Zwift', 'TrainingPeaks', 'Wahoo Fitness', 'Runkeeper', 'MapMyRun', 'MapMyFitness', 'Couch to 5K', 'Runna',
    'Cronometer', 'Lose It!', 'Lifesum', 'Fooducate', 'Yazio', 'Carb Manager', 'Fastic', 'Zero Fasting', 'DoFasting', 'BodyFast',
    'Sleep Score', 'Pillow', 'AutoSleep', 'SleepWatch', 'Oura', 'WHOOP Journal', 'Rise Sleep', 'Insight Timer', 'Ten Percent Happier', 'Waking Up',
    'Simple Habit', 'Breathwrk', 'Balance', 'Reflectly', 'Sanvello', 'Talkspace', 'BetterHelp', 'Cerebral', 'Calm Kids', 'Smiling Mind',
    'WW (WeightWatchers)', 'Weight Watchers', 'Noom Coach', 'Fitbit Coach', 'Sworkit Kids', 'GymRat', 'Fitness Buddy', 'Gymshark Training', 'Alan Fitness', 'Sweat',
    'ClassPass', 'Mindbody', 'Gympass', 'Barry\'s', 'Orangetheory Fitness', 'F45 Training', 'CrossFit', 'SoulCycle', 'Planet Fitness', 'Life Time',
    '23andMe', 'Clue Period Tracker', 'Flo Period Tracker', 'Ovia', 'Glow', 'Natural Cycles', 'Fitbit Blaze', 'Garmin Vivosmart', 'Withings Health Mate', 'iHealth MyVitals',
  ],
  education: [
    'Duolingo', 'Khan Academy', 'Coursera', 'Udemy', 'Quizlet', 'Google Classroom', 'Brilliant', 'Skillshare', 'Photomath', 'Babbel',
    'Rosetta Stone', 'Busuu', 'Memrise', 'HelloTalk', 'Tandem', 'Lingoda', 'Drops', 'Mondly', 'Anki', 'Kahoot!',
    'Blackboard', 'Canvas Student', 'Schoology', 'Remind', 'ClassDojo', 'Seesaw', 'Edmodo', 'IXL', 'Prodigy Math', 'Epic',
    'ABCmouse', 'Starfall', 'Reading Eggs', 'Scratch', 'Codecademy', 'SoloLearn', 'Grasshopper', 'Mimo', 'Brilliant.org', 'edX',
    'FutureLearn', 'LinkedIn Learning', 'MasterClass', 'Skillshare Learn', 'Pluralsight', 'Treehouse', 'Datacamp', 'Codewars', 'freeCodeCamp', 'CodeCombat',
    'Wolfram Alpha', 'Photomath Plus', 'Mathway', 'Symbolab', 'GeoGebra', 'Desmos', 'PrepScholar', 'Magoosh', 'Kaplan', 'Princeton Review',
    'Quizizz', 'GoNoodle', 'ABC Kids', 'PBS Kids', 'Toca Boca', 'Lightbot', 'Tynker', 'CodeSpark', 'Osmo', 'Endless Alphabet',
    'Elevate', 'Peak', 'Lumosity', 'CogniFit', 'BrainHQ', 'Fit Brains Trainer', 'Photomath Solver', 'Socratic', 'Chegg Study', 'Course Hero',
    'StuDocu', 'GradeSaver', 'SparkNotes', 'CliffsNotes', 'Grammarly', 'Hemingway Editor', 'ProWritingAid', 'Quillbot', 'Wordtune', 'Forest Study',
    'Focus Keeper', 'StudyBunny', 'Habitica Learn', 'Flashcards+', 'Brainscape', 'StudyBlue', 'Turboscribe', 'Otter.ai', 'ELSA Speak', 'Speekly',
  ],
  entertainment: [
    'Netflix', 'Spotify', 'YouTube', 'Disney+', 'Max', 'Twitch', 'SoundCloud', 'Apple Music', 'Hulu', 'Prime Video',
    'Peacock', 'Paramount+', 'ESPN', 'YouTube TV', 'YouTube Music', 'Pandora', 'iHeartRadio', 'TuneIn Radio', 'Deezer', 'Tidal',
    'Amazon Music', 'Audible', 'Spotify Kids', 'Podcasts', 'Overcast', 'Pocket Casts', 'Castbox', 'Stitcher', 'Apple Podcasts', 'Google Podcasts',
    'IMDb', 'Letterboxd', 'Rotten Tomatoes', 'Fandango', 'AMC Theatres', 'Cinemark', 'Regal', 'Plex', 'Roku', 'Tubi',
    'Pluto TV', 'Crackle', 'Vudu', 'FandangoNOW', 'BritBox', 'Crunchyroll', 'Funimation', 'VRV', 'Kanopy', 'Hoopla',
    'Apple TV', 'Google TV', 'Fire TV', 'Chromecast', 'Sling TV', 'FuboTV', 'DirecTV Stream', 'Philo', 'Xumo Play', 'Freevee',
    'DAZN', 'NBA App', 'NFL App', 'MLB App', 'NHL App', 'FIFA+', 'UFC', 'WWE Network', 'Bleacher Report', 'theScore',
    'Steam Link', 'PlayStation App', 'Xbox App', 'Nintendo Switch Online', 'Epic Games', 'Discord', 'Genshin Impact', 'Among Us', 'Minecraft', 'Roblox',
    'TikTok Lite', 'Vine Camera', 'Dubsmash', 'Triller', 'Likee', 'Kwai', 'Byte', 'Clash', 'Reels', 'Snapchat Spotlight',
    'MX Player', 'JioCinema', 'Hotstar', 'Viu', 'iQIYI', 'Youku', 'Bilibili', 'WeTV', 'Rakuten Viki', 'Mubi',
  ],
  real_estate: [
    'Zillow', 'Redfin', 'Realtor.com', 'Trulia', 'Apartments.com', 'OfferUp', 'Nextdoor', 'Facebook', 'Craigslist', 'HomeSnap',
    'Compass', 'Homes.com', 'RentCafe', 'Zumper', 'Rent.com', 'Apartment List', 'HotPads', 'PadMapper', 'RadPad', 'ForRent.com',
    'LoopNet', 'CoStar', 'CityFeet', 'Crexi', 'Ten-X', 'Auction.com', 'HomeLight', 'Opendoor', 'Offerpad', 'Knock',
    'Better.com', 'Rocket Mortgage', 'LendingTree', 'Bankrate', 'Zillow Rentals', 'Zillow Premier Agent', 'RE/MAX', 'Keller Williams', 'Coldwell Banker', 'Century 21',
    'Sotheby\'s International Realty', 'Berkshire Hathaway HomeServices', 'eXp Realty', 'Redfin Agent', 'Movoto', 'Homesnap Pro', 'RealScout', 'Homie', 'Clever Real Estate', 'Ojo Labs',
    'Roofstock', 'Fundrise', 'RealtyMogul', 'DiversyFund', 'Groundfloor', 'PeerStreet', 'Yardi', 'AppFolio', 'Buildium', 'RentRedi',
    'TenantCloud', 'Cozy', 'RentSpree', 'ShowingTime', 'Dotloop', 'DocuSign', 'HomeAdvisor', 'Angi', 'Thumbtack', 'TaskRabbit',
    'Porch', 'Houzz', 'Sweeten', 'BuildZoom', 'Handy', 'Lawn Love', 'Nextdoor Business', 'Front Door', '2-10 Home Buyers Warranty', 'American Home Shield',
    'Trulia Rentals', 'ApartmentGuide', 'RENTCafe Resident', 'PadSplit', 'Bungalow', 'Common', 'Roomi', 'SpareRoom', 'Roomster', 'Roomies',
    'HomeToGo', 'Vrbo Owner', 'Airbnb Host', 'Furnished Finder', 'Landing', 'Blueground', 'Sonder', 'WhyHotel', 'Kasa Living', 'Zeus Living',
  ],
};

async function fetchApp(name, attempt = 1) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(name)}&country=us&entity=software&limit=1`;
  const res = await fetch(url);
  if (res.status === 429 && attempt <= 4) {
    const backoff = attempt * 4000;
    console.log(`  ratelimit ${name} -> retrying in ${backoff}ms (attempt ${attempt + 1})`);
    await new Promise((r) => setTimeout(r, backoff));
    return fetchApp(name, attempt + 1);
  }
  if (!res.ok) throw new Error(`iTunes search failed for "${name}": ${res.status}`);
  const data = await res.json();
  const app = data.results?.[0];
  if (!app) return null;
  return {
    id: app.trackId,
    name: app.trackName,
    genre: app.primaryGenreName,
    icon: app.artworkUrl512,
    rating: app.averageUserRating ?? null,
    ratingCount: app.userRatingCount ?? null,
    appStoreUrl: app.trackViewUrl,
    screenshots: app.screenshotUrls || [],
    ipadScreenshots: app.ipadScreenshotUrls || [],
  };
}

async function buildCategory(categoryKey, appNames) {
  const apps = [];
  const seenIds = new Set();
  for (const name of appNames) {
    try {
      const app = await fetchApp(name);
      if (app && app.screenshots.length > 0 && !seenIds.has(app.id)) {
        seenIds.add(app.id);
        apps.push(app);
        console.log(`  ok   ${name} -> ${app.screenshots.length} screenshots`);
      } else if (app && seenIds.has(app.id)) {
        console.log(`  dup  ${name} -> already have "${app.name}"`);
      } else {
        console.log(`  skip ${name} -> not found or no screenshots`);
      }
    } catch (err) {
      console.log(`  fail ${name} -> ${err.message}`);
    }
    // be polite to Apple's free public API
    await new Promise((r) => setTimeout(r, 1500));
  }
  return apps;
}

async function loadExisting() {
  try {
    const raw = await (await import('node:fs/promises')).readFile(OUT_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function main() {
  const only = process.argv[2]; // optional: build just one category, e.g. `node build.mjs productivity`
  const targets = only ? { [only]: CATEGORIES[only] } : CATEGORIES;
  if (only && !CATEGORIES[only]) {
    console.error(`Unknown category "${only}". Known: ${Object.keys(CATEGORIES).join(', ')}`);
    process.exit(1);
  }

  const existing = await loadExisting();
  const index = {
    generatedAt: new Date().toISOString(),
    source: 'Apple iTunes Search API (public, unauthenticated)',
    categories: existing?.categories || {},
  };

  for (const [key, appNames] of Object.entries(targets)) {
    console.log(`\n${key} (${appNames.length} apps)`);
    index.categories[key] = await buildCategory(key, appNames);
    // write after every category so a later failure never loses earlier progress
    await mkdir(__dirname, { recursive: true });
    await writeFile(OUT_PATH, JSON.stringify(index, null, 2));
  }

  console.log(`\nWrote ${OUT_PATH}`);
}

main();
