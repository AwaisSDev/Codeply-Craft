import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const idx = JSON.parse(readFileSync(path.join(__dirname, 'index.json'), 'utf8'));

const CATEGORY_LABELS = {
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

const rows = [];
for (const [cat, apps] of Object.entries(idx.categories)) {
  for (const a of apps) {
    rows.push({
      n: a.name,
      c: cat,
      r: a.rating ? Math.round(a.rating * 10) / 10 : null,
      rc: a.ratingCount || 0,
      s: a.screenshots.length,
      u: a.appStoreUrl,
      i: a.icon,
    });
  }
}
rows.sort((x, y) => y.s - x.s);

const out = { generatedAt: new Date().toISOString(), labels: CATEGORY_LABELS, rows };
writeFileSync(path.join(__dirname, 'table-data.json'), JSON.stringify(out));
console.log('rows:', rows.length);
