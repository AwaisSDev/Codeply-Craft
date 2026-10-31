// The Decide model's input: one plain-text sequence with the time, the known
// memories (as [m1]..[mK] markers the merge head points at), the known
// projects and the events. The training data (data/dump.mjs) and the runtime
// provider (dtw-provider.mjs) both build it here, so they cannot disagree.
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(import.meta.url);
const P = require(path.join(ROOT, 'codeply-cli/lib/context-prompt.js'));

export const MAX_KNOWN = 8;
const TRUST = { user: 'user', mixed: 'user and others', external: 'someone else' };

/**
 * @param {{ events: object[], known?: object[], now: number, tz?: string, projects?: string[] }} o
 * @returns {{ text: string, events: { start: number, end: number }[], mems: { start: number, end: number, index: number }[] }}
 *   events[i]: where event i's text sits in `text`; mems[k]: the "[mK]" marker of known memory k
 */
export function buildInput(o) {
  let text = `now ${P.localTime(o.now, o.tz)}${o.tz ? ` ${o.tz}` : ''}\n`;
  const projects = (o.projects || []).slice(0, 12);
  if (projects.length) text += `projects: ${projects.join(', ')}\n`;
  const mems = [];
  (o.known || []).slice(0, MAX_KNOWN).forEach((m, k) => {
    const marker = `[m${k + 1}]`;
    mems.push({ start: text.length, end: text.length + marker.length, index: k });
    text += `${marker} ${m.kind}${m.project ? ` (${m.project})` : ''} · ${m.slot || '-'}: ${m.value || m.text}\n`;
  });
  const events = [];
  (o.events || []).forEach((e, i) => {
    text += `[e${i + 1}] ${e.source} · from ${TRUST[e.trust] || 'someone else'}${e.project ? ` · project ${e.project}` : ''}\n`;
    events.push({ start: text.length, end: text.length + String(e.text || '').length });
    text += `${e.text}\n`;
  });
  return { text, events, mems };
}
