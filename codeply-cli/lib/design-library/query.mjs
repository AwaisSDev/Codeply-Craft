/**
 * Query interface for the private design reference library built in
 * index.json (914 apps / 6,433 real App Store screenshots across 10
 * categories, sourced from Apple's public iTunes Search API). Loaded lazily
 * and cached in memory - the file is ~2MB, cheap to hold for the life of one
 * Craft process, not worth re-reading per call.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(__dirname, 'index.json');

export const CATEGORY_LABELS = {
  productivity: 'Productivity',
  finance: 'Finance',
  shopping: 'Shopping',
  social: 'Social',
  travel: 'Travel',
  food_delivery: 'Food Delivery',
  health_fitness: 'Health & Fitness',
  education: 'Education',
  entertainment: 'Entertainment',
  real_estate: 'Real Estate',
};

let cached = null;
function load() {
  if (cached) return cached;
  cached = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
  return cached;
}

export function designLibraryConfigured() {
  try {
    load();
    return true;
  } catch {
    return false;
  }
}

export function listCategories() {
  const idx = load();
  return Object.entries(idx.categories).map(([key, apps]) => ({
    key,
    label: CATEGORY_LABELS[key] || key,
    appCount: apps.length,
    screenshotCount: apps.reduce((s, a) => s + a.screenshots.length, 0),
  }));
}

/**
 * Search the library by free-text term (matched against app name) and/or an
 * exact category key. Returns apps ranked by rating count (a rough proxy for
 * "this is the version of the pattern worth matching," not just whichever
 * came back first), each capped to `maxScreenshotsPerApp` URLs so a broad
 * query doesn't return hundreds of image links at once.
 */
export function searchLibrary({ term = '', category = '', maxApps = 8, maxScreenshotsPerApp = 4 } = {}) {
  const idx = load();
  const normTerm = term.trim().toLowerCase();
  const catKey = category.trim().toLowerCase().replace(/\s+/g, '_');

  const categories = catKey && idx.categories[catKey] ? [catKey] : Object.keys(idx.categories);

  function collect(matchTerm) {
    const results = [];
    for (const cat of categories) {
      for (const app of idx.categories[cat]) {
        if (matchTerm && !app.name.toLowerCase().includes(matchTerm)) continue;
        results.push({ ...app, category: cat });
      }
    }
    return results;
  }

  // The library only indexes app NAMES, not per-screen content - there is no
  // app literally called "settings" or "onboarding", so a natural
  // pattern-style query like that would always come back empty even though
  // the category itself has plenty of real screens worth looking at. A given
  // category is a reliable signal on its own; falling back to its top-rated
  // apps (ignoring the term) beats returning nothing.
  let results = collect(normTerm);
  let usedFallback = false;
  if (!results.length && normTerm && catKey && idx.categories[catKey]) {
    results = collect('');
    usedFallback = true;
  }

  results.sort((a, b) => (b.ratingCount || 0) - (a.ratingCount || 0));
  results = results.slice(0, maxApps).map((app) => ({
    name: app.name,
    category: app.category,
    categoryLabel: CATEGORY_LABELS[app.category] || app.category,
    rating: app.rating ? Math.round(app.rating * 10) / 10 : null,
    appStoreUrl: app.appStoreUrl,
    screenshots: app.screenshots.slice(0, maxScreenshotsPerApp),
  }));

  results.usedFallback = usedFallback;
  return results;
}
