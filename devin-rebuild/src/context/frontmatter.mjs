/**
 * The small YAML subset rule and skill files use in their --- header:
 * scalars, quoted strings, inline [a, b] lists, block "- item" lists and
 * one level of nested maps. Anything fancier is kept as a raw string.
 */

function scalar(raw) {
  const v = raw.trim();
  if (v === '') return '';
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.startsWith('"') ? JSON.parse(v.replace(/\\'/g, "'")) : v.slice(1, -1).replace(/''/g, "'");
  }
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    return inner ? splitTop(inner).map(scalar) : [];
  }
  if (v === 'true' || v === 'false') return v === 'true';
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function splitTop(s) {
  const out = [];
  let cur = '';
  let q = null;
  for (const c of s) {
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === ',') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

export function parseYaml(text) {
  const out = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, rest] = m;
    if (rest.trim() === '' || rest.trim() === '|' || rest.trim() === '>') {
      // Block list, nested map or block scalar on the following indented lines.
      const block = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) block.push(lines[++i]);
      const items = block.filter((l) => l.trim());
      if (rest.trim() === '|' || rest.trim() === '>') {
        const indent = Math.min(...items.map((l) => l.match(/^\s*/)[0].length));
        const body = items.map((l) => l.slice(indent));
        out[key] = rest.trim() === '|' ? body.join('\n') : body.join(' ');
      } else if (items.length && items.every((l) => /^\s*-\s/.test(l) || /^\s*-$/.test(l))) {
        out[key] = items.map((l) => scalar(l.replace(/^\s*-\s?/, '')));
      } else if (items.length) {
        out[key] = parseYaml(items.map((l) => l.replace(/^\s{2}/, '')).join('\n'));
      } else {
        out[key] = '';
      }
      continue;
    }
    out[key] = scalar(rest);
  }
  return out;
}

/** Split "---\nyaml\n---\nbody" into { data, body }. No header: data is {}. */
export function parseFrontmatter(text) {
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(text);
  if (!m) return { data: {}, body: text, hasFrontmatter: false };
  return { data: parseYaml(m[1]), body: text.slice(m[0].length), hasFrontmatter: true };
}
