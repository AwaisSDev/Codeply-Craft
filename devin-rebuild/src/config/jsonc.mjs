/**
 * JSON with comments and trailing commas, read and edited in place.
 *
 * Config files are hand-edited, so writes keep what the user wrote: setting
 * or removing one member re-lays out only the object that holds it (each
 * member on its own line, original member text kept byte for byte) and
 * pretty-prints just the new value. This is the shape Devin CLI was observed
 * to write when `mcp add` touched an existing mcp_config.json.
 */

export function parse(text) {
  return parseTree(text).value;
}

/** Parse, returning { value, tree } where tree nodes carry source offsets. */
export function parseTree(text) {
  let i = 0;
  const err = (msg) => { throw new SyntaxError(`${msg} at offset ${i}`); };
  const ws = () => {
    for (;;) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '﻿') { i++; continue; }
      if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
      if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? text.length : e + 2; continue; }
      return;
    }
  };
  const str = () => {
    const start = i++;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    if (text[i] !== '"') err('Unterminated string');
    i++;
    return JSON.parse(text.slice(start, i));
  };
  const val = () => {
    ws();
    const start = i;
    const c = text[i];
    if (c === '{') {
      i++;
      const node = { type: 'object', start, end: 0, members: [], value: {} };
      for (;;) {
        ws();
        if (text[i] === '}') { i++; break; }
        if (text[i] !== '"') err('Expected property name');
        const keyStart = i;
        const key = str();
        ws();
        if (text[i] !== ':') err('Expected ":"');
        i++;
        const child = val();
        node.members.push({ key, keyStart, valueEnd: child.end, node: child });
        node.value[key] = child.value;
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; break; }
        err('Expected "," or "}"');
      }
      node.end = i;
      return node;
    }
    if (c === '[') {
      i++;
      const node = { type: 'array', start, end: 0, items: [], value: [] };
      for (;;) {
        ws();
        if (text[i] === ']') { i++; break; }
        const child = val();
        node.items.push(child);
        node.value.push(child.value);
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; break; }
        err('Expected "," or "]"');
      }
      node.end = i;
      return node;
    }
    if (c === '"') { const v = str(); return { type: 'string', start, end: i, value: v }; }
    const m = /^(-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 64));
    if (!m) err('Unexpected token');
    i += m[0].length;
    return { type: 'literal', start, end: i, value: JSON.parse(m[0]) };
  };
  const root = val();
  ws();
  if (i < text.length) err('Unexpected trailing content');
  return { value: root.value, tree: root };
}

const pad = (n) => ' '.repeat(n * 2);
const isPrim = (v) => v === null || typeof v !== 'object';

/** Pretty JSON with 2-space indent; arrays of scalars stay on one line. */
export function stringify(value, depth = 0) {
  if (isPrim(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    if (value.every(isPrim)) return '[' + value.map((v) => JSON.stringify(v)).join(', ') + ']';
    return '[\n' + value.map((v) => pad(depth + 1) + stringify(v, depth + 1)).join(',\n') + '\n' + pad(depth) + ']';
  }
  const keys = Object.keys(value).filter((k) => value[k] !== undefined);
  if (!keys.length) return '{}';
  return '{\n' + keys.map((k) => `${pad(depth + 1)}${JSON.stringify(k)}: ${stringify(value[k], depth + 1)}`).join(',\n') + '\n' + pad(depth) + '}';
}

function findObject(tree, keys) {
  let node = tree;
  let depth = 0;
  for (const k of keys) {
    if (node.type !== 'object') return null;
    const m = node.members.find((x) => x.key === k);
    if (!m) return { missingAt: depth, node, rest: keys.slice(depth) };
    node = m.node;
    depth++;
  }
  return node.type === 'object' ? { node, depth } : null;
}

function relayout(text, obj, depth, members) {
  const parts = members.map((m) => pad(depth + 1) + m);
  const body = parts.length ? '\n' + parts.join(',\n') + '\n' + pad(depth) : '';
  return text.slice(0, obj.start) + '{' + body + '}' + text.slice(obj.end);
}

/**
 * Set keys[...] = value, creating missing objects on the way.
 * Returns the new text. An empty or missing document starts as {}.
 */
export function setIn(text, keys, value) {
  if (!text || !text.trim()) text = '{}';
  const { tree } = parseTree(text);
  if (tree.type !== 'object') throw new Error('Config root is not an object');
  const parentKeys = keys.slice(0, -1);
  const last = keys[keys.length - 1];
  const found = findObject(tree, parentKeys);
  if (!found) throw new Error(`${parentKeys.join('.')} is not an object`);
  if (found.missingAt !== undefined) {
    // Build the missing chain as one new value on the deepest existing object.
    const nested = found.rest.slice(1).reduceRight((acc, k) => ({ [k]: acc }), { [last]: value });
    return setIn(text, parentKeys.slice(0, found.missingAt).concat(found.rest[0]), nested);
  }
  const { node, depth } = found;
  const existing = node.members.find((m) => m.key === last);
  if (existing) {
    return text.slice(0, existing.node.start) + stringify(value, depth + 1) + text.slice(existing.node.end);
  }
  const members = node.members.map((m) => text.slice(m.keyStart, m.valueEnd));
  members.push(`${JSON.stringify(last)}: ${stringify(value, depth + 1)}`);
  return relayout(text, node, depth, members);
}

/** Remove keys[...]; returns the text unchanged when it is not there. */
export function deleteIn(text, keys) {
  const { tree } = parseTree(text);
  const found = findObject(tree, keys.slice(0, -1));
  if (!found || found.missingAt !== undefined) return text;
  const { node, depth } = found;
  const last = keys[keys.length - 1];
  if (!node.members.some((m) => m.key === last)) return text;
  const members = node.members.filter((m) => m.key !== last).map((m) => text.slice(m.keyStart, m.valueEnd));
  return relayout(text, node, depth, members);
}
