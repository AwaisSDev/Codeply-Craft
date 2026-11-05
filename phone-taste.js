// Codeply's taste skill on the phone (codeply-cli/skills/codeply-taste). On the PC the agent deals an art
// direction with design_direction (scripts/draw.mjs) and reads the guides; here the same library and guides are
// bundled as taste.json (scripts/prepare-mobile.js) and this deals the direction, so a design made on the phone
// follows the same direction sheet, type, palette and rules instead of a model's defaults.
//   CraftTaste.brief({ kind, text }) -> Promise<string>: the direction sheet and guides for the system prompt
(() => {
  'use strict';
  let lib = null;
  async function library() {
    if (lib) return lib;
    // Built into the phone app; in a dev checkout read the skill folder directly.
    try { const r = await fetch('taste.json', { cache: 'force-cache' }); if (r.ok) { lib = await r.json(); return lib; } } catch {}
    const base = 'codeply-cli/skills/codeply-taste/';
    const j = (n) => fetch(`${base}library/${n}.json`).then((r) => r.json());
    const t = (n) => fetch(`${base}${n}`).then((r) => (r.ok ? r.text() : ''));
    const [directions, palettes, type, skill, tells, copy, colour, typeGuide, layout] = await Promise.all([j('directions'), j('palettes'), j('type'), t('SKILL.md'), t('references/tells.md'), t('references/copy.md'), t('references/colour.md'), t('references/type.md'), t('references/layout.md')]);
    lib = { directions, palettes, type, guides: { skill, tells, copy, colour, type: typeGuide, layout } };
    return lib;
  }

  // The brief's sector and tone, read from its words (draw.mjs takes them as flags).
  const SECTOR_WORDS = [
    ['dev-tool', /\b(developer|api|cli|sdk|devtool|code|coding|open.?source|framework|database)\b/i],
    ['ai-product', /\b(ai|agent|llm|gpt|assistant|model)\b/i],
    ['saas', /\b(saas|dashboard|platform|crm|analytics|b2b|workspace|software)\b/i],
    ['finance', /\b(bank|finance|fintech|budget|money|invest|payments?|crypto|wallet)\b/i],
    ['restaurant', /\b(restaurant|cafe|café|coffee|bakery|bar|menu|food|pizza|sushi|kitchen)\b/i],
    ['hospitality', /\b(hotel|resort|travel|villa|stay|airbnb|retreat)\b/i],
    ['ecommerce', /\b(shop|store|ecommerce|e-commerce|sale|product page|checkout)\b/i],
    ['fashion', /\b(fashion|clothing|apparel|jewel|streetwear|boutique)\b/i],
    ['physical-product', /\b(hardware|device|headphones|speaker|bike|furniture|watch)\b/i],
    ['health', /\b(health|clinic|doctor|fitness|gym|yoga|wellness|therapy|medical)\b/i],
    ['education', /\b(school|course|learn|education|university|tutor|class)\b/i],
    ['event', /\b(event|conference|festival|concert|meetup|wedding|party|night)\b/i],
    ['music', /\b(music|band|album|dj|artist|record)\b/i],
    ['architecture', /\b(architect|architecture|interior)\b/i],
    ['real-estate', /\b(real estate|property|apartment|realtor|homes?)\b/i],
    ['agency', /\b(agency|studio|consultancy|marketing)\b/i],
    ['personal-portfolio', /\b(portfolio|resume|cv|my site|personal site|photographer|designer)\b/i],
    ['nonprofit', /\b(nonprofit|charity|foundation|ngo|donate)\b/i],
    ['consumer-app', /\b(app|habit|tracker|social|dating|game)\b/i],
  ];
  const TONE_WORDS = [['luxury', /\b(luxury|premium|elegant|high.?end)\b/i], ['playful', /\b(fun|playful|kids|cute|friendly)\b/i], ['bold', /\b(bold|loud|striking|brutal)\b/i], ['warm', /\b(warm|cozy|cosy|organic|handmade|calm)\b/i], ['technical', /\b(technical|precise|engineering|data)\b/i], ['editorial', /\b(editorial|magazine|journal|story|blog)\b/i], ['quiet', /\b(minimal|quiet|clean|simple|serene)\b/i]];
  const sectorOf = (t) => (SECTOR_WORDS.find(([, re]) => re.test(t)) || ['other'])[0];
  const toneOf = (t) => (TONE_WORDS.find(([, re]) => re.test(t)) || [''])[0];

  // Recent deals, so consecutive designs don't look alike (draw.mjs keeps the same history on the PC).
  const HKEY = 'craft-taste-history';
  const hist = () => { try { return JSON.parse(localStorage.getItem(HKEY) || '[]'); } catch { return []; } };
  const remember = (h) => { try { localStorage.setItem(HKEY, JSON.stringify([...hist(), h].slice(-12))); } catch {} };
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const fresh = (pool, slot, n) => { const recent = hist().slice(-n).map((h) => h[slot]); const f = pool.filter((x) => !recent.includes(x.id)); return f.length ? f : pool; };

  function deal(L, text) {
    const sector = sectorOf(text); const tone = toneOf(text);
    let dirs = L.directions.filter((d) => (d.sectors || []).includes(sector));
    if (tone) { const t = dirs.filter((d) => (d.tones || []).includes(tone)); if (t.length) dirs = t; }
    if (!dirs.length) dirs = L.directions;
    const dir = pick(fresh(dirs, 'direction', 4));
    const typePool = L.type.filter((t) => (dir.type || []).includes(t.id) || (dir.typeClasses || []).includes(t.class));
    const type = pick(fresh(typePool.length ? typePool : L.type, 'type', 6));
    const palPool = L.palettes.filter((p) => (dir.palettes || []).includes(p.id) || (p.tags || []).some((t) => (dir.paletteTags || []).includes(t)));
    const palette = pick(fresh(palPool.length ? palPool : L.palettes, 'palette', 6));
    remember({ direction: dir.id, type: type.id, palette: palette.id, sector, at: Date.now() });
    return { sector, tone, dir, type, palette };
  }
  const face = (f) => (f ? `${f.family}${f.settings ? ` (${f.settings})` : ''}${f.css ? `\n  Load it with:\n  ${String(f.css).replace(/\n/g, '\n  ')}` : ''}` : '');
  function sheet({ sector, tone, dir, type, palette }) {
    const pal = ['bg', 'surface', 'ink', 'muted', 'accent', 'accentInk'].filter((k) => palette[k]).map((k) => `--${k === 'accentInk' ? 'accent-ink' : k}: ${palette[k]}`).join('; ');
    return `ART DIRECTION (dealt from Codeply's research library for this brief: sector ${sector}${tone ? `, tone ${tone}` : ''}). Follow it.
Direction: ${dir.name}
Idea: ${dir.idea}
Composition: ${dir.composition}
Typography: ${dir.typography}
Type: display ${face(type.display)}
  text ${face(type.text)}${type.note ? `\n  ${type.note}` : ''}
Colour: ${dir.colour}
Palette "${palette.name}": ${pal}${palette.fields && palette.fields.length ? `; inverted fields: ${palette.fields.map((f) => `${f.bg} on ${f.ink}`).join(', ')}` : ''}. ${palette.note || ''}
Imagery: ${dir.imagery}
Richness: ${dir.richness}
Pitfalls: ${dir.pitfalls}`;
  }
  /** The system prompt part for one design: the dealt sheet, then the skill's guides. */
  async function brief({ kind, text }) {
    const L = await library();
    const s = deal(L, String(text || ''));
    const g = L.guides || {};
    const formats = String(g.skill || '').split('## Formats')[1] || '';
    return [
      kind === 'website' || kind === 'app' || !kind ? sheet(s) : `${sheet(s)}\n(For a ${kind}: use the palette and type above; the composition notes apply where they fit.)`,
      formats && `FORMATS (from the taste skill)\n${formats.split('\n## ')[0].trim()}`,
      g.tells && `WHAT LOOKS GENERATED (avoid all of it)\n${g.tells}`,
      g.copy && `COPY\n${g.copy}`,
      g.type && `TYPE\n${g.type}`,
      g.colour && `COLOUR\n${g.colour}`,
      (kind === 'website' || kind === 'app') && g.layout && `LAYOUT\n${g.layout}`,
    ].filter(Boolean).join('\n\n');
  }

  window.CraftTaste = { brief, deal: async (text) => deal(await library(), text), library };
})();
