// Run: node sidecar/ext-theme.test.mjs (checks the theme route's validation with the model stubbed).
import { validateTheme, route } from './ext-theme.mjs';
import assert from 'node:assert';

const good = validateTheme({ theme: { name: 'Rainy Tokyo', mode: 'dark', colors: { bg: '#0B1220', side: 'red', text: '#dbe6ff', accent: '#7c5cff' },
  font: { family: 'geist', size: 'large', weight: 'medium' },
  background: { kind: 'ascii', art: ['  @@  ', ' @@@@ ', '......', 'ééé'] } } }, ['Calibri']);
assert.deepEqual(good.colors, { bg: '#0b1220', text: '#dbe6ff', accent: '#7c5cff' });
assert.deepEqual(good.font, { family: 'Geist', size: 2, weight: 2 });
assert.equal(good.background.kind, 'ascii');
assert.equal(good.background.art[3], '');
assert.throws(() => validateTheme({ colors: { bg: 'blue' } }), /usable colours/);
assert.equal(validateTheme({ colors: { accent: '#fff000' }, font: { family: 'Evil<>' } }).font.family, '');
assert.equal(validateTheme({ colors: { accent: '#fff000' }, background: { kind: 'picture', query: 'foggy mountains' } }).background.query, 'foggy mountains');
assert.equal(validateTheme({ colors: { accent: '#fff000' }, background: { kind: 'dots', art: ['x'] } }).background, undefined);

// the route, with the model stubbed
const sent = [];
const ctx = { shared: {}, DATA: (await import('node:os')).tmpdir(),
  readJson: async (req) => req.body,
  need: () => ({ chatJson: async (messages) => { sent.push(messages); return { success: true, json: { theme: { name: 'Mist', mode: 'light', colors: { bg: '#f4f1ea', text: '#222222', accent: '#3b6ea5' } } } }; } }) };
let out;
const reply = (s, b) => { out = [s, b]; };
await route(ctx, { method: 'POST', body: { prompt: 'a quiet misty morning', mode: 'dark', fonts: ['Calibri'] } }, {}, new URL('http://x/ext/theme/generate'), '/ext/theme/generate', reply);
assert.equal(out[0], 200);
assert.equal(out[1].theme.mode, 'light');
assert.match(sent[0][0].content, /Allowed font families: Geist, Inter, Calibri/);
await route(ctx, { method: 'POST', body: { prompt: '' } }, {}, new URL('http://x/ext/theme/generate'), '/ext/theme/generate', reply);
assert.equal(out[0], 400);
console.log('ext-theme ok');
