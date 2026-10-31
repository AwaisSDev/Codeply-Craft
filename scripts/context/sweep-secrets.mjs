// One-off cleanup of secrets stored before the stricter secret checks
// (SECURITY-SECRETS.md). DRY RUN unless --apply. Never prints a secret: only
// ids, kinds, counts and the reason each was flagged.
//
//   node scripts/context/sweep-secrets.mjs                        report only
//   node scripts/context/sweep-secrets.mjs --apply                clean (stop Codeply first; back up ~/.codeply)
//   node scripts/context/sweep-secrets.mjs --brain <file> --context <file> --vectors <file>
//
// What it looks at:
//   brain.db     memories (slot, value, text, history, challenger), the change log,
//                handoff facts: brain.sweepSecrets()
//   context.db   the event queue: text still waiting (redacted in place) or kept
//                after processing (cleared), and outcomes that quote a memory
//                (the quote replaced); sealed text is left alone (it needs the host
//                key; it is cleared by the normal 7-day purge)
//   vectors.db   embeddings of memories that are gone (deleted with them)
//
// Do not run this against a user's real files without the owner's approval
// (SECURITY-SECRETS.md, deployment checklist).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const lib = (n) => require(path.join(ROOT, 'codeply-cli/lib', n));
const BR = lib('brain.js');
const X = lib('secret-scan.js');
const { redact } = lib('context-redact.js');
const { loadDriver } = lib('session-db.js');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const apply = args.includes('--apply');
const home = path.join(os.homedir(), '.codeply');
const files = {
  brain: opt('brain', process.env.CODEPLY_BRAIN_DB || path.join(home, 'brain', 'brain.db')),
  context: opt('context', process.env.CODEPLY_CONTEXT_DB || path.join(home, 'context', 'context.db')),
  vectors: opt('vectors', path.join(home, 'context', 'vectors.db')),
};
const report = { apply, brain: null, context: null, vectors: null };
const driver = loadDriver();
if (!driver) { console.error('No SQLite driver (Node 22+ has node:sqlite).'); process.exit(2); }

// ─── brain.db ───────────────────────────────────────────────────────────────
let memoryIds = null;
if (fs.existsSync(files.brain)) {
  BR.configure({ file: files.brain });
  const r = BR.sweepSecrets({ apply });
  report.brain = { file: files.brain, deleted: r.deleted.length, cleaned: r.cleaned.length, changeLines: r.changes, handoffs: r.handoffs || 0, items: [...r.deleted.map((x) => ({ ...x, action: 'delete' })), ...r.cleaned.map((x) => ({ ...x, action: 'clean history/challenger' }))] };
  memoryIds = new Set(BR.list({ includeSecrets: true, includeExpired: true, limit: 1000 }).map((m) => m.id));
  if (memoryIds.size >= 1000) memoryIds = null; // too many to be sure; leave vectors alone
  BR.close();
}

// ─── context.db ─────────────────────────────────────────────────────────────
if (fs.existsSync(files.context)) {
  const db = driver.open(files.context);
  const out = { file: files.context, textRedacted: 0, textCleared: 0, outcomes: 0, sealedSkipped: 0 };
  for (const r of db.prepare('SELECT id, status, sensitive, text, outcome FROM events').all()) {
    if (r.text != null) {
      if (String(r.text).startsWith('v1:')) out.sealedSkipped++;
      else if (X.why(r.text, { topic: false }) || redact(r.text).found.length) {
        if (['pending', 'processing'].includes(r.status)) { out.textRedacted++; if (apply) db.prepare('UPDATE events SET text = ? WHERE id = ?').run(redact(r.text).text, r.id); }
        else { out.textCleared++; if (apply) db.prepare('UPDATE events SET text = NULL WHERE id = ?').run(r.id); }
      }
    }
    if (r.outcome) {
      let o; try { o = JSON.parse(r.outcome); } catch { o = null; }
      if (o && Array.isArray(o.actions) && o.actions.some((a) => X.observationWhy(a))) {
        out.outcomes++;
        if (apply) {
          o.actions = o.actions.map((a) => (X.observationWhy(a) ? { ...a, text: '(hidden: looked sensitive)', slot: '' } : a));
          db.prepare('UPDATE events SET outcome = ? WHERE id = ?').run(JSON.stringify(o), r.id);
        }
      }
    }
  }
  if (apply) { try { db.exec('PRAGMA secure_delete = ON'); db.exec('VACUUM'); db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) { out.vacuumError = e.message; } }
  db.close();
  report.context = out;
}

// ─── vectors.db ─────────────────────────────────────────────────────────────
if (fs.existsSync(files.vectors)) {
  const out = { file: files.vectors, orphans: 0 };
  if (memoryIds) {
    const db = driver.open(files.vectors);
    for (const r of db.prepare('SELECT memory_id FROM vectors').all()) {
      if (memoryIds.has(r.memory_id)) continue;
      out.orphans++;
      if (apply) db.prepare('DELETE FROM vectors WHERE memory_id = ?').run(r.memory_id);
    }
    if (apply) { try { db.exec('PRAGMA secure_delete = ON'); db.exec('VACUUM'); } catch (e) { out.vacuumError = e.message; } }
    db.close();
  } else out.skipped = 'no brain read (or over 1000 memories): vectors left as they are';
  report.vectors = out;
}

console.log(JSON.stringify(report, null, 2));
if (!apply) console.log('\nDry run: nothing was changed. Run again with --apply to clean (stop Codeply first, and back up ~/.codeply).');
