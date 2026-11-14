// The code view's inline edit (Ctrl K): the open file and an instruction in, the whole file as
// Wisp would rewrite it out. The app shows the difference line by line, and you accept or
// reject it there; nothing is written to disk until you save.
//
//   POST /ext/code/edit { path, text, instruction }  ->  { text } | { error }
//   POST /ext/code/rename { from, to }  /  POST /ext/code/delete { path }   (inside the project only)
const MAX = 60000;
const fenced = (s) => {
  const t = String(s || '');
  const m = /```[\w.+-]*\r?\n([\s\S]*?)\r?\n```/.exec(t);
  return m ? m[1] : t.replace(/^```[\w.+-]*\r?\n?/, '').replace(/\r?\n?```\s*$/, '');
};

import fs from 'node:fs';
import path from 'node:path';

/** `rel` resolved inside `root` (the project), or null when it would leave it. */
function inside(root, rel) {
  if (typeof rel !== 'string' || !rel.trim() || rel.includes('\0')) return null;
  const abs = path.resolve(root, rel);
  const r = path.relative(root, abs);
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? abs : null;
}

async function fileOp(ctx, url, p, b) {
  const q = url.searchParams.get('cwd');
  const root = q && fs.existsSync(q) ? path.resolve(q) : ctx.DEFAULT_CWD;
  if (p === '/ext/code/rename') {
    const from = inside(root, b.from); const to = inside(root, b.to);
    if (!from || !to) return { error: 'That path is outside the project.' };
    if (!fs.existsSync(from)) return { error: `${b.from} isn't there any more.` };
    if (fs.existsSync(to)) return { error: `${b.to} already exists.` };
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    return { ok: true };
  }
  const abs = inside(root, b.path);
  if (!abs) return { error: 'That path is outside the project.' };
  if (!fs.existsSync(abs)) return { ok: true };
  fs.rmSync(abs, { recursive: true, force: true });
  return { ok: true };
}

export async function route(ctx, req, res, url, p, reply) {
  if (req.method === 'POST' && (p === '/ext/code/rename' || p === '/ext/code/delete')) {
    const b = await ctx.readJson(req).catch(() => ({}));
    try { reply(200, await fileOp(ctx, url, p, b)); } catch (e) { reply(200, { error: e.message }); }
    return true;
  }
  if (req.method !== 'POST' || p !== '/ext/code/edit') return false;
  const b = await ctx.readJson(req).catch(() => ({}));
  const text = String(b.text || '');
  const instruction = String(b.instruction || '').trim();
  if (!instruction) { reply(200, { error: 'Say what to change.' }); return true; }
  if (text.length > MAX) { reply(200, { error: 'This file is too long to rewrite in one go. Ask in the chat instead.' }); return true; }
  try {
    const ai = ctx.need('ai.js');
    if (!ai) throw new Error('The model is not available in this engine.');
    const messages = [
      { role: 'system', content: 'You edit one source file. Apply the instruction to it and reply with the whole file after the change, in one fenced code block, nothing else. Change only what the instruction asks; keep everything else exactly as it was: formatting, comments, order, line endings.' },
      { role: 'user', content: `File: ${String(b.path || '')}\nInstruction: ${instruction}\n\n\`\`\`\n${text}\n\`\`\`` },
    ];
    const r = await ai.chat(messages, { route: { auto: true }, maxTokens: 16000, temperature: 0.1, haze: { product: 'craft', surface: 'edit', chatId: 'rune-edit' } });
    if (!r || !r.success) throw new Error((r && r.error) || 'The model could not make the change.');
    const out = fenced(r.data && r.data.choices && r.data.choices[0] && r.data.choices[0].message && r.data.choices[0].message.content);
    if (!out.trim()) throw new Error('The model sent back nothing.');
    // Keep the file's last newline as it was.
    reply(200, { text: text.endsWith('\n') && !out.endsWith('\n') ? `${out}\n` : out });
  } catch (e) {
    reply(200, { error: e.message || 'The edit failed.' });
  }
  return true;
}
