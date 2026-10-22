// Run one person's simulated days through the real Codeply code.
//
//   node scripts/sim/run.mjs <persona> --bridge <dir> [--out <dir>]
//       every model call is written to <dir> for an AI agent to answer
//       (node scripts/sim/model-bridge.mjs next|reply <dir>)
//   SIM_BASE_URL=... SIM_API_KEY=... SIM_MODEL=... node scripts/sim/run.mjs <persona>
//       every model call goes to that OpenAI-compatible endpoint
//
// Personas: shopkeeper, farmer, manager, hr, artist (scripts/sim/personas.mjs).
// Everything lives in a throwaway home folder; nothing real is booked or sent.
import fs from 'fs';
import os from 'os';
import path from 'path';

const args = process.argv.slice(2);
const key = args[0];
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : ''; };
const { PERSONAS } = await import('./personas.mjs');
const persona = PERSONAS[key];
if (!persona) { console.error(`Pick a persona: ${Object.keys(PERSONAS).join(', ')}`); process.exit(2); }

// Before any engine module loads: a private home, the persona's time zone, text tool calls.
const home = fs.mkdtempSync(path.join(os.tmpdir(), `codeply-sim-${key}-`));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.TZ = persona.tz;
process.env.CODEPLY_TOOLS = 'text';
process.env.CODEPLY_TELEMETRY = '0';

const out = path.resolve(opt('out') || path.join('sim-out', key));
fs.rmSync(out, { recursive: true, force: true });
const bridgeDir = opt('bridge') ? path.resolve(opt('bridge')) : '';
const real = process.env.SIM_BASE_URL ? { baseUrl: process.env.SIM_BASE_URL, apiKey: process.env.SIM_API_KEY || '', model: process.env.SIM_MODEL || 'gpt-4o-mini' } : null;
if (!bridgeDir && !real) { console.error('Give --bridge <dir>, or set SIM_BASE_URL (and SIM_API_KEY, SIM_MODEL).'); process.exit(2); }
if (bridgeDir) { fs.rmSync(bridgeDir, { recursive: true, force: true }); fs.mkdirSync(bridgeDir, { recursive: true }); }

const { runPersona } = await import('./harness.mjs');
let results = [];
try {
  results = await runPersona(persona, { out, bridgeDir, real });
} catch (e) {
  console.error(e.stack || e.message);
  if (bridgeDir) fs.writeFileSync(path.join(bridgeDir, 'DONE'), `failed: ${e.message}\n`);
  process.exit(1);
}
const must = results.filter((r) => r.level === 'must');
const failed = must.filter((r) => !r.ok);
console.log(`\n${persona.name}: ${must.length - failed.length} of ${must.length} checks passed. Report: ${path.join(out, 'report.md')}`);
if (bridgeDir) fs.writeFileSync(path.join(bridgeDir, 'DONE'), 'finished\n');
process.exit(failed.length ? 1 : 0);
