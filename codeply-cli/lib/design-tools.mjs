/**
 * Codeply's design layer: the two tools skills/codeply-taste/SKILL.md works with.
 *
 *   design_direction  deals an art direction from the skill's research library
 *                     (scripts/draw.mjs): the script chooses, not the model, so
 *                     designs don't all come out as the category default.
 *   design_lint       checks a finished design: a static scan for the tells the
 *                     skill bans (scripts/lint.mjs), then a real render. In Craft
 *                     the render happens in Craft's own off-screen browser
 *                     (ctx.browser.render), measured with the skill's probe and
 *                     judged with its rules; the agent also gets screenshots.
 *                     In the terminal there is no browser: the scan alone runs.
 *
 * The scripts are plain Node with no dependencies. They run through this
 * process's own executable (Craft's, in Node mode), so nothing extra has to be
 * installed.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { probe, frame } from '../skills/codeply-taste/scripts/lib/probe.mjs';
import { judge } from '../skills/codeply-taste/scripts/lib/rules.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(HERE, '..', 'skills', 'codeply-taste', 'scripts');

function runScript(script, argv, cwd, timeoutMs = 30000) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(SCRIPTS, script), ...argv], {
      cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    }, (err, stdout, stderr) => resolve({
      code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
      out: String(stdout || '').trim(),
      err: String(stderr || '').trim() || (err && !stdout ? err.message : ''),
    }));
  });
}

// Inside the design's own folder only: a design run never reaches into anything else.
function insideCwd(p, cwd) {
  const abs = path.resolve(cwd, String(p || ''));
  const rel = path.relative(cwd, abs);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? abs : null;
}

const DIRECTION_FLAGS = ['sector', 'brief', 'tone', 'sections', 'have', 'keep', 'avoid', 'direction', 'redraw', 'list', 'site', 'seed'];

export async function design_direction(args, ctx) {
  const argv = [];
  for (const k of DIRECTION_FLAGS) {
    const v = args[k] == null ? '' : String(args[k]).trim();
    if (v) argv.push(`--${k}`, v);
  }
  if (/^(1|true|yes|3)$/i.test(String(args.options || '').trim())) argv.push('--options', '3');
  if (/^(1|true|yes)$/i.test(String(args.show || '').trim())) argv.push('--show');
  if (!argv.length) {
    return { ok: false, output: 'design_direction needs a <brief> and <sector> (or <direction>, <redraw>, <show>, <list>). Sectors: <list>sectors</list>.' };
  }
  argv.push('--out', path.join(ctx.cwd, '.taste-skill'));
  const r = await runScript('draw.mjs', argv, ctx.cwd);
  if (r.code !== 0 && !r.out) return { ok: false, output: `design_direction failed: ${r.err || 'no output'}` };
  // The sheet suggests asset commands for a terminal; in Codeply, pictures come from image_search / fetch_image.
  // Its wording is for a terminal: say it in this tool's parameters.
  const text = r.out
    .replace(/node \S*assets\.mjs/g, '(assets: use image_search, then fetch_image into assets/)')
    .replace(/the same command plus `?--direction <id>`?(?: \(and without --options\))?/g, 'design_direction with direction=<id>')
    .replace(/`?--(direction|redraw|options|keep|avoid|have|tone|sections|show)\b`?/g, '$1=')
    .replace(/ ?\(SKILL\.md steps? [\d, and]+\)/g, '');
  return { ok: true, output: text.slice(0, 24000), meta: { label: args.direction || args.redraw || args.sector || 'direction' } };
}

// What each kind of design is judged on. Rules about a web page's shape (a hero, a first
// action, footage, pictures, motion while scrolling) don't apply to a slide or a document.
const PAGE_RULES = ['no-hero', 'first-action', 'few-pictures', 'no-real-pictures', 'no-footage', 'still-page', 'empty-screens', 'long-pin', 'pinned-over-picture'];
const KIND = {
  website: { widths: [1440, 390], allow: [] },
  app: { widths: [390], allow: [...PAGE_RULES, 'ui-wrapper', 'card-rows', 'pill-nav', 'icon-cards'] },
  slides: { widths: [1280], height: 720, allow: [...PAGE_RULES, 'side-scroll', 'all-centred', 'measure'] },
  doc: { widths: [816], height: 1056, allow: [...PAGE_RULES, 'all-centred'] },
  poster: { widths: [1080], height: 1350, allow: [...PAGE_RULES, 'all-centred', 'side-scroll'] },
  social: { widths: [1080], height: 1080, allow: [...PAGE_RULES, 'all-centred', 'side-scroll'] },
  logo: { widths: [1200], height: 800, allow: [...PAGE_RULES, 'all-centred', 'font-count', 'size-count', 'body-size', 'small-text'] },
};
const MOBILE_H = 844;

export async function design_lint(args, ctx) {
  const file = insideCwd(args.path || 'index.html', ctx.cwd);
  if (!file || !fs.existsSync(file)) return { ok: false, output: `design_lint: no such file in this design: ${args.path || 'index.html'}.` };
  const kind = KIND[String(args.kind || 'website').trim().toLowerCase()] ? String(args.kind || 'website').trim().toLowerCase() : 'website';
  const spec = KIND[kind];
  const widths = String(args.widths || '').split(',').map((s) => parseInt(s, 10)).filter((n) => n >= 200 && n <= 2560);
  const useWidths = widths.length ? widths.slice(0, 3) : spec.widths;

  // Allowances: the kind's, the drawn direction's (draw.mjs grants some), and any the agent names with a reason.
  let allow = [...spec.allow];
  try { allow.push(...(JSON.parse(fs.readFileSync(path.join(ctx.cwd, '.taste-skill', 'direction.json'), 'utf8')).allow || [])); } catch {}
  allow.push(...String(args.allow || '').split(',').map((s) => s.trim()).filter(Boolean));
  allow = [...new Set(allow)];

  const findings = [];
  const scan = await runScript('lint.mjs', [file, '--json'], ctx.cwd);
  try {
    for (const f of JSON.parse(scan.out).findings || []) if (!allow.includes(f.id)) findings.push({ ...f, where: `${path.basename(f.file || file)}:${f.line || '?'}` });
  } catch { if (scan.err) findings.push({ level: 'WARN', id: 'lint', message: `The static scan did not run: ${scan.err.slice(0, 200)}` }); }

  const render = ctx.browser && typeof ctx.browser.render === 'function' ? ctx.browser.render : null;
  const images = [];
  const measured = [];
  if (render) {
    for (const w of useWidths) {
      const h = spec.height || (w < 600 ? MOBILE_H : Math.round(w * 0.625));
      const r = await render(pathToFileURL(file).href, { width: w, height: h, probe: probe.toString(), frame: frame.toString(), screens: kind === 'website' && w >= 1000 ? 4 : kind === 'doc' || kind === 'slides' ? 3 : 1 });
      if (!r || !r.ok) { findings.push({ level: 'FAIL', id: 'render', width: w, message: `The design did not render at ${w}px: ${(r && r.error) || 'unknown error'}` }); continue; }
      if (r.metrics && !r.metrics.error) {
        for (const f of judge(r.metrics, { width: w, allow })) findings.push(f);
        const m = r.metrics;
        measured.push(`@${w}px: ${m.page ? `${m.page.screens} screen(s), ${m.page.words} words, ${m.page.img} images` : ''}${m.type ? ` · type ${m.type.families.filter((f) => f.share >= 0.02).map((f) => f.family).join(', ')}` : ''}${m.hero ? ` · headline ${m.hero.lines} line(s) at ${m.hero.size}px` : ''}`);
      } else if (r.metrics && r.metrics.error) findings.push({ level: 'WARN', id: 'probe', width: w, message: `Could not measure at ${w}px: ${r.metrics.error}` });
      const covered = [...new Map((r.frames || []).filter(Boolean).flatMap((f, i) => (f.covered || []).map((c) => [c.text, { ...c, screen: i + 1 }]))).values()];
      if (covered.length && !allow.includes('covered-text')) findings.push({ level: 'FAIL', id: 'covered-text', width: w, message: 'Large text lies under another element: ' + covered.slice(0, 3).map((c) => `"${c.text}" (screen ${c.screen})`).join('; '), fix: 'Nothing may sit on top of a headline. Move the picture or raise the text above it with a ground.' });
      for (const e of (r.consoleErrors || []).slice(0, 2)) findings.push({ level: 'WARN', id: 'console', width: w, message: `Console error: ${String(e).slice(0, 200)}` });
      for (const img of r.images || []) if (images.length < 4) images.push(img);
    }
  }

  // The same rule at several widths: keep the first, note the others.
  const merged = [];
  for (const f of findings) {
    const same = merged.find((x) => x.id === f.id && x.level === f.level && f.id !== 'headline-lines');
    if (same && f.width) { same.alsoAt = [...(same.alsoAt || []), f.width]; continue; }
    merged.push(f);
  }
  const fails = merged.filter((f) => f.level === 'FAIL');
  const warns = merged.filter((f) => f.level === 'WARN');
  const lines = [`design_lint ${path.relative(ctx.cwd, file).split(path.sep).join('/')} as ${kind}${render ? ` at ${useWidths.join(', ')}px` : ' (static scan only: no browser here)'}`];
  if (measured.length) lines.push(...measured);
  if (!fails.length && !warns.length) lines.push('', 'No findings. Now judge the screenshots yourself: hierarchy, spacing, contrast, whether it looks designed rather than generated.');
  for (const [title, list] of [['FAIL (fix every one)', fails], ['WARN (fix, or keep with a reason you can state)', warns]]) {
    if (!list.length) continue;
    lines.push('', title);
    for (const f of list.slice(0, 20)) lines.push(`- [${f.id}]${f.width ? ` @${f.width}px` : ''}${f.alsoAt ? ` (+${f.alsoAt.join(', ')})` : ''}${f.where ? ` ${f.where}` : ''} ${f.message}${f.fix ? `\n  fix: ${f.fix}` : ''}`);
  }
  if (images.length) lines.push('', `${images.length} screenshot(s) attached: look at them before calling the design done.`);
  // The rules' fixes name the skill's terminal scripts; here, pictures come from the tools.
  const output = lines.join('\n')
    .replace(/scripts\/assets\.mjs(?: --video)?/g, 'image_search (then fetch_image into assets/)')
    .replace(/ ?\(SKILL\.md step \d+[^)]*\)/g, '');
  return {
    ok: true,
    output: output.slice(0, 20000),
    meta: { label: `${kind}${fails.length ? `, ${fails.length} to fix` : ', clean'}`, count: fails.length, ...(images.length ? { imageDataUrls: images } : {}) },
  };
}
