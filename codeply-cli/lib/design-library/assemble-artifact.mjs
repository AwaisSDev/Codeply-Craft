import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const template = readFileSync(path.join(__dirname, 'artifact-template.html'), 'utf8');
const data = JSON.parse(readFileSync(path.join(__dirname, 'table-data.json'), 'utf8'));

const totalApps = data.rows.length;
const totalShots = data.rows.reduce((s, r) => s + r.s, 0);
const generatedAt = new Date(data.generatedAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

const out = template
  .replace('__DATA_JSON__', JSON.stringify(data).replace(/</g, '\\u003c'))
  .replace('__GENERATED_AT__', generatedAt)
  .replace('__TOTAL_APPS__', String(totalApps))
  .replace('__TOTAL_SHOTS__', String(totalShots));

const outPath = process.argv[2];
writeFileSync(outPath, out);
console.log('wrote', outPath, '(' + (out.length / 1024).toFixed(0) + ' KB)');
