import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, 'index.json');

// [category, appId] pairs confirmed as wrong-category mismatches on manual review.
// Same app can be a correct match in one category and a mismatch in another
// (e.g. "BetterHelp" is a real health_fitness app but wrongly matched a
// real_estate search term), so removal is scoped per (category, id), not global.
const REMOVE = [
  ['productivity', 6470821480],  // "Zapia" matched from "Zapier" search - unrelated app
  ['productivity', 1038369065],  // "Flo Cycle & Period Tracker" matched from "Glo" - wrong app (correct in health_fitness)
  ['productivity', 1573566111],  // "Complices" matched from "Complice" - unrelated French dating app
  ['shopping', 6748155184],      // "Courtyard: TCG, Watches, Cards" - unrelated marketplace
  ['food_delivery', 1416720539], // "Tango Reserve by AgilQuest" matched from generic "Reserve" search - enterprise workspace booking, not food
  ['food_delivery', 6748155184], // "Courtyard" again - unrelated
  ['real_estate', 995252384],    // "BetterHelp - Therapy" matched from "Better.com" - wrong app (correct in health_fitness)
  ['real_estate', 1264782561],   // "Co-Star Personalized Astrology" matched from "CoStar" - astrology app, not commercial real estate data
  ['real_estate', 1457119021],   // "Rainbow - Ethereum Wallet" - unrelated crypto wallet
  ['real_estate', 407108860],    // "Cozi Family Organizer" - unrelated family calendar app
  ['real_estate', 880735556],    // "Gods of Olympus" matched from "Zeus Living" - unrelated mobile game
];

const idx = JSON.parse(readFileSync(OUT_PATH, 'utf8'));
let removed = 0;
for (const [cat, id] of REMOVE) {
  const before = idx.categories[cat].length;
  idx.categories[cat] = idx.categories[cat].filter((a) => a.id !== id);
  removed += before - idx.categories[cat].length;
}

idx.cleanedAt = new Date().toISOString();
writeFileSync(OUT_PATH, JSON.stringify(idx, null, 2));
console.log(`Removed ${removed} confirmed-mismatch entries.`);

let totalApps = 0, totalShots = 0;
for (const [cat, apps] of Object.entries(idx.categories)) {
  const shots = apps.reduce((s, a) => s + a.screenshots.length, 0);
  totalApps += apps.length;
  totalShots += shots;
  console.log(`${cat}: ${apps.length} apps, ${shots} screenshots`);
}
console.log(`\nFinal: ${totalApps} apps, ${totalShots} screenshots`);
