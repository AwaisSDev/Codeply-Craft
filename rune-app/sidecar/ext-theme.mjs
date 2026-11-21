// Themes: the routes behind Settings > Appearance.
//   GET  /ext/theme/fonts            installed font families
//   GET  /ext/theme/images?q=        picture search (Openverse, then Wikimedia Commons); thumbnails
//                                    are saved to disk so the app only reads local files
//   POST /ext/theme/fetch  {url}     downloads one of those results into the backgrounds folder
//   POST /ext/theme/generate {prompt, mode, fonts}
//                                    asks the signed-in model (Haze) for a theme and returns it
//                                    as strict, validated JSON
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const UA = 'CodeplyDesktopThemes/1.0 (theme backgrounds; https://codeply.app)';
const MAX_IMAGE = 12 * 1024 * 1024;
const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

const bgDir = (ctx) => { const d = path.join(ctx.DATA, 'backgrounds'); fs.mkdirSync(path.join(d, 'thumbs'), { recursive: true }); return d; };
// Only pictures the search listed can be fetched, so this route is not a general downloader.
const listed = (ctx) => (ctx.shared.themeUrls ||= new Set());

// ---------- fonts ----------

const STYLE_WORDS = /\s+(Bold|Italic|Oblique|Light|Semilight|Semibold|SemiBold|Black|Thin|Regular|Medium|Heavy|ExtraBold|ExtraLight|Condensed|Narrow|Demi|Book)(\s+(Bold|Italic|Oblique|Light|Semibold|Condensed))*$/i;
const NOT_TEXT = /(symbol|wingdings|webdings|dingbats|marlett|mdl2|icons?\b|emoji|holomdl|ornament|barcode|braille|\bocr\b|music)/i;

function tidy(name) {
  let n = String(name).replace(/\s*\((TrueType|OpenType|All res|VGA res|8514 res)\)\s*$/i, '').trim();
  for (let i = 0; i < 3; i++) n = n.replace(STYLE_WORDS, '').trim();
  return n;
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

async function installedFonts() {
  const names = new Set();
  if (process.platform === 'win32') {
    for (const key of ['HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts', 'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts']) {
      const out = await run('reg', ['query', key]);
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^\s+(.+?)\s+REG_(?:SZ|EXPAND_SZ)\s+/);
        if (m) for (const part of m[1].split(' & ')) names.add(tidy(part));
      }
    }
  } else {
    const out = await run('fc-list', [':', 'family']);
    for (const line of out.split('\n')) { const first = line.split(',')[0].trim(); if (first) names.add(tidy(first)); }
  }
  return [...names].filter((n) => n && n.length < 40 && !NOT_TEXT.test(n) && /^[\p{L}\p{N} ._+-]+$/u.test(n))
    .sort((a, b) => a.localeCompare(b)).slice(0, 150);
}

// ---------- pictures ----------

async function getJson(url, ms = 7000) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`${new URL(url).hostname} answered ${r.status}`);
  return r.json();
}

const clean = (s, n) => String(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, n);

async function openverse(q) {
  const u = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&page_size=20&mature=false&extension=jpg,png,webp&category=photograph,illustration`;
  const j = await getJson(u, 6000);
  return (j.results || []).filter((r) => r.url && r.thumbnail && (r.width || 0) >= 1000 && /^https:/.test(r.url)).map((r) => ({
    title: clean(r.title, 80) || 'Untitled', thumb: r.thumbnail, url: r.url,
    credit: clean(`${r.creator || 'Unknown'} · ${String(r.license || '').toUpperCase()}${r.license_version ? ' ' + r.license_version : ''} · Openverse`, 120),
  }));
}

async function commons(q) {
  const u = 'https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrlimit=24&format=json&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=1600'
    + `&gsrsearch=${encodeURIComponent(q + ' filetype:bitmap')}`;
  const j = await getJson(u, 9000);
  const pages = Object.values((j.query && j.query.pages) || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
  const out = [];
  for (const p of pages) {
    const i = p.imageinfo && p.imageinfo[0];
    if (!i || !TYPES[i.mime] || (i.width || 0) < 1000) continue;
    const url = i.thumburl || i.url;
    if (!/^https:\/\/(upload|thumb)\.wikimedia\.org\//.test(url)) continue;
    const meta = i.extmetadata || {};
    out.push({
      title: clean(String(p.title || '').replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, ''), 80),
      thumb: url.replace(/\/\d+px-/, '/330px-'), url,
      credit: clean(`${(meta.Artist && meta.Artist.value) || 'Unknown'} · ${(meta.LicenseShortName && meta.LicenseShortName.value) || 'open licence'} · Wikimedia Commons`, 120),
    });
  }
  return out;
}

async function download(url, to, limit) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000), redirect: 'follow' });
  if (!r.ok) throw new Error(`The picture's host answered ${r.status}.`);
  const type = String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!TYPES[type]) throw new Error('That is not a picture this app can use.');
  const chunks = [];
  let size = 0;
  for await (const c of r.body) { size += c.length; if (size > limit) throw new Error('That picture is too large.'); chunks.push(c); }
  const file = `${to}.${TYPES[type]}`;
  fs.writeFileSync(file, Buffer.concat(chunks));
  return file;
}

async function searchImages(ctx, q) {
  let hits = [];
  let failure = '';
  for (const source of [openverse, commons]) {
    try { hits = await source(q); } catch (e) { failure = e.message; hits = []; }
    if (hits.length) break;
  }
  if (!hits.length && failure) throw Object.assign(new Error(`Picture search is unavailable (${failure}).`), { status: 502 });
  const dir = path.join(bgDir(ctx), 'thumbs');
  const done = await Promise.all(hits.slice(0, 12).map(async (h) => {
    try {
      const base = path.join(dir, crypto.createHash('sha1').update(h.thumb).digest('hex').slice(0, 20));
      const have = ['jpg', 'png', 'webp', 'gif'].map((x) => `${base}.${x}`).find((f) => fs.existsSync(f));
      const file = have || await download(h.thumb, base, 2 * 1024 * 1024);
      listed(ctx).add(h.url);
      return { ...h, thumb: file };
    } catch { return null; }
  }));
  return done.filter(Boolean);
}

// ---------- the model's theme ----------

const hexColour = (v) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v.trim()) ? v.trim().toLowerCase() : null);
const SIZES = ['small', 'default', 'large', 'larger'];
const WEIGHTS = ['light', 'regular', 'medium', 'bold'];
const idx = (list, v, dflt) => {
  const i = list.indexOf(String(v).toLowerCase());
  return i >= 0 ? i : Number.isInteger(v) ? Math.min(list.length - 1, Math.max(0, v)) : dflt;
};

/** Checks the model's JSON and returns only what is safe to use; throws when nothing is. */
export function validateTheme(raw, fonts = []) {
  const t = raw && typeof raw === 'object' ? (raw.theme && typeof raw.theme === 'object' ? raw.theme : raw) : {};
  const c = t.colors && typeof t.colors === 'object' ? t.colors : {};
  const colors = {};
  for (const k of ['bg', 'side', 'text', 'accent']) { const v = hexColour(c[k]); if (v) colors[k] = v; }
  if (!colors.bg && !colors.accent && !colors.text) throw Object.assign(new Error('The model did not return usable colours. Try describing it differently.'), { status: 422 });
  const theme = {
    name: clean(t.name, 40) || 'Custom theme',
    mode: t.mode === 'light' ? 'light' : 'dark',
    colors,
  };
  if (t.font && typeof t.font === 'object') {
    const asked = clean(t.font.family, 40);
    const known = ['Geist', 'Inter', ...fonts].find((f) => f.toLowerCase() === asked.toLowerCase());
    theme.font = { family: known || '', size: idx(SIZES, t.font.size, 1), weight: idx(WEIGHTS, t.font.weight, 1) };
  }
  const b = t.background && typeof t.background === 'object' ? t.background : null;
  if (b) {
    const kind = ['none', 'ascii', 'dots', 'picture'].includes(b.kind) ? b.kind : 'none';
    if (kind === 'ascii' || kind === 'dots') {
      const art = (Array.isArray(b.art) ? b.art : String(b.art || '').split('\n')).slice(0, 60)
        .map((l) => String(l).replace(/[^\x20-\x7e]/g, ' ').replace(/\s+$/, '').slice(0, 120));
      if (art.filter((l) => l.trim()).length >= 3) theme.background = { kind, art };
    } else if (kind === 'picture') {
      const query = clean(b.query, 80);
      if (query) theme.background = { kind, query };
    } else theme.background = { kind: 'none' };
  }
  return theme;
}

const SYSTEM = `You design colour themes for a desktop coding app called Codeply. Reply with ONE JSON object and nothing else (no prose, no code fences).
Schema:
{
  "name": "2-3 word theme name",
  "mode": "dark" | "light",
  "colors": { "bg": "#rrggbb main background", "side": "#rrggbb sidebar, a step away from bg", "text": "#rrggbb main text", "accent": "#rrggbb buttons and highlights" },
  "font": { "family": "one name from the allowed list, or empty", "size": "small|default|large|larger", "weight": "light|regular|medium|bold" },
  "background": { "kind": "none" | "ascii" | "dots" | "picture", "art": ["lines of ASCII art"], "query": "search words for a picture" }
}
Rules:
- Colours are 6-digit hex. Text must contrast strongly with bg (at least 7:1); accent must be visible on bg. Keep bg quiet; put the mood in accent and the background.
- "font" and "background" are optional: include them only when the request suggests them. Default font size and regular weight unless asked.
- background "ascii" or "dots": "art" is 25 to 40 lines, each at most 100 characters, drawn with the density ramp " .:-=+*#%@" (space is empty, @ is the brightest). The art is shown dim behind the app, so make a simple recognisable scene (a skyline, moon, mountains, waves, rain). Do not include "query".
- background "picture": give "query" (2-5 words, a photo that would suit) and no "art".
- Never include anything else.`;

async function generate(ctx, body) {
  const prompt = clean(body.prompt, 400);
  if (!prompt) throw Object.assign(new Error('Describe the theme you want.'), { status: 400 });
  const fonts = (Array.isArray(body.fonts) ? body.fonts : []).map((f) => clean(f, 40)).filter(Boolean).slice(0, 80);
  const ai = ctx.need('ai.js');
  const messages = [
    { role: 'system', content: `${SYSTEM}\nAllowed font families: Geist, Inter${fonts.length ? ', ' + fonts.join(', ') : ''}.` },
    { role: 'user', content: `Theme request: ${prompt}\nThe app is currently in ${body.mode === 'light' ? 'light' : 'dark'} mode.` },
  ];
  const r = await ai.chatJson(messages, { route: { auto: true }, maxTokens: 2500, temperature: 0.8, haze: { product: 'craft', surface: 'theme', chatId: 'rune-theme' } });
  if (!r || !r.success) throw Object.assign(new Error((r && r.error) || 'The model could not make a theme.'), { status: 502 });
  return { theme: validateTheme(r.json, fonts) };
}

// ---------- routes ----------

export function route(ctx, req, res, url, p, reply) {
  if (!p.startsWith('/ext/theme/')) return false;
  const fail = (e) => reply(e.status || 500, { error: e.message || 'Something went wrong.' });
  if (req.method === 'GET' && p === '/ext/theme/fonts') {
    return installedFonts().then((fonts) => { reply(200, { fonts }); return true; }, (e) => { fail(e); return true; });
  }
  if (req.method === 'GET' && p === '/ext/theme/images') {
    const q = clean(url.searchParams.get('q'), 80);
    if (!q) { reply(400, { error: 'Type what to look for.' }); return true; }
    return searchImages(ctx, q).then((hits) => { reply(200, { hits }); return true; }, (e) => { fail(e); return true; });
  }
  if (req.method === 'POST' && p === '/ext/theme/fetch') {
    return ctx.readJson(req).then(async (body) => {
      const u = String(body.url || '');
      if (!listed(ctx).has(u)) throw Object.assign(new Error('Search for the picture first.'), { status: 400 });
      const base = path.join(bgDir(ctx), crypto.createHash('sha1').update(u).digest('hex').slice(0, 20));
      const have = ['jpg', 'png', 'webp', 'gif'].map((x) => `${base}.${x}`).find((f) => fs.existsSync(f));
      reply(200, { path: have || await download(u, base, MAX_IMAGE) });
    }).then(() => true, (e) => { fail(e); return true; });
  }
  if (req.method === 'POST' && p === '/ext/theme/generate') {
    return ctx.readJson(req).then((body) => generate(ctx, body)).then((out) => { reply(200, out); return true; }, (e) => { fail(e); return true; });
  }
  reply(404, { error: 'Not found.' });
  return true;
}
