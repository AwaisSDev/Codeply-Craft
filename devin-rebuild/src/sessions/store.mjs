/**
 * Saved conversations, one JSON file each under sessions/.
 *
 * Listing columns follow `devin list --format csv` as captured by REA:
 *   id,short_id,working_directory,last_activity_at,last_activity_ago,title
 * Sessions also get a readable name ("brisk-otter") usable anywhere an id is.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sessionsDir } from '../config/paths.mjs';

const ADJ = ['brisk', 'calm', 'bold', 'keen', 'quiet', 'swift', 'bright', 'lucky', 'merry', 'noble', 'proud', 'sunny', 'tidy', 'witty', 'zesty', 'amber', 'cosmic', 'gentle', 'jolly', 'nimble'];
const ANIMAL = ['otter', 'falcon', 'badger', 'heron', 'lynx', 'panda', 'raven', 'tiger', 'koala', 'marten', 'gecko', 'ibis', 'puffin', 'walrus', 'yak', 'bison', 'crane', 'dingo', 'ferret', 'newt'];

function fileFor(id) { return path.join(sessionsDir(), `${id}.json`); }

export function newSession({ cwd, model, mode }) {
  const id = crypto.randomUUID();
  const name = `${ADJ[crypto.randomInt(ADJ.length)]}-${ANIMAL[crypto.randomInt(ANIMAL.length)]}`;
  const now = new Date().toISOString();
  return { id, name, title: '', working_directory: cwd, created_at: now, last_activity_at: now, model, mode, messages: [], todos: [], usage: { input_tokens: 0, output_tokens: 0 }, workspace_dirs: [] };
}

export function saveSession(s) {
  s.last_activity_at = new Date().toISOString();
  fs.mkdirSync(sessionsDir(), { recursive: true });
  const tmp = `${fileFor(s.id)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, fileFor(s.id));
}

function readAll() {
  let names = [];
  try { names = fs.readdirSync(sessionsDir()).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const n of names) {
    try { out.push(JSON.parse(fs.readFileSync(path.join(sessionsDir(), n), 'utf8'))); } catch { /* skip corrupt */ }
  }
  return out.sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at));
}

export function listSessions({ cwd, all = false } = {}) {
  const list = readAll();
  return all || !cwd ? list : list.filter((s) => path.resolve(s.working_directory) === path.resolve(cwd));
}

/** Find by full id, name, or an unambiguous id prefix. */
export function findSession(target, opts = {}) {
  const list = listSessions({ all: true, ...opts });
  const exact = list.filter((s) => s.id === target || s.name === target);
  if (exact.length) return exact[0];
  const pref = list.filter((s) => s.id.startsWith(target));
  if (pref.length === 1) return pref[0];
  if (pref.length > 1) throw new Error(`'${target}' matches ${pref.length} sessions; use more characters`);
  return null;
}

export function deleteSession(id) { fs.rmSync(fileFor(id), { force: true }); }

export function ago(iso, now = Date.now()) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function summaryRow(s) {
  return { id: s.id, short_id: s.id.slice(0, 8), name: s.name, working_directory: s.working_directory, last_activity_at: s.last_activity_at, last_activity_ago: ago(s.last_activity_at), title: s.title || '' };
}

/** Markdown transcript, used by --export. */
export function exportMarkdown(s) {
  const lines = [`# ${s.title || 'Session'} (${s.name})`, '', `- id: ${s.id}`, `- directory: ${s.working_directory}`, `- model: ${s.model}`, ''];
  for (const m of s.messages) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    for (const b of blocks) {
      if (b.type === 'text' && b.text.trim()) lines.push(`## ${m.role === 'user' ? 'User' : 'Assistant'}`, '', b.text, '');
      else if (b.type === 'tool_use') lines.push(`### Tool: ${b.name}`, '', '```json', JSON.stringify(b.input, null, 2), '```', '');
      else if (b.type === 'tool_result') {
        const t = typeof b.content === 'string' ? b.content : (b.content || []).map((x) => x.text || '').join('');
        lines.push(`### Result${b.is_error ? ' (error)' : ''}`, '', '```', t.slice(0, 4000), '```', '');
      }
    }
  }
  return lines.join('\n');
}
