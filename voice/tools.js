// Voice mode's commands: files and the web without clicking through windows.
// "Move every image from the category folders into posts" is two commands, not
// forty drags. The results come back as text, so the next look needs no screenshot.
//
// Files stay inside the user's home folder, nothing is ever overwritten, and
// files are never deleted (only empty folders, and only to the Recycle Bin).
const { app, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const HOME = os.homedir();
const MAX_RESULT = 6000;

function known() {
  const get = (n) => { try { return app.getPath(n); } catch { return ''; } };
  return { desktop: get('desktop'), downloads: get('downloads'), documents: get('documents'), pictures: get('pictures'), music: get('music'), videos: get('videos'), home: HOME };
}

/** "Desktop\cats", "~/Pictures", "C:\Users\me\x" -> an absolute path inside home, or an error. */
function resolvePath(p) {
  let s = String(p || '').trim().replace(/^["']|["']$/g, '');
  if (!s) throw new Error('no path given');
  const k = known();
  s = s.replace(/^~(?=[\\/]|$)/, HOME);
  const first = s.split(/[\\/]/)[0].toLowerCase();
  if (!path.isAbsolute(s) && k[first]) s = path.join(k[first], s.slice(first.length));
  const abs = path.resolve(path.isAbsolute(s) ? s : path.join(HOME, s));
  const rel = path.relative(HOME, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${abs} is outside your user folder`);
  return abs;
}

// "*.jpg", "IMG_??.png": a simple wildcard on the last part of a path.
function globToRe(g) {
  return new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
}
function expand(src) {
  const abs = resolvePath(src);
  const base = path.basename(abs);
  if (!/[*?]/.test(base)) return fs.existsSync(abs) ? [abs] : [];
  const dir = path.dirname(abs);
  if (/[*?]/.test(dir)) throw new Error('wildcards only work in the file name, not in folder names');
  const re = globToRe(base);
  return fs.readdirSync(dir).filter((n) => re.test(n)).map((n) => path.join(dir, n));
}

// Never overwrite: "photo.jpg" becomes "photo (2).jpg" when the name is taken.
function freeName(dest) {
  if (!fs.existsSync(dest)) return dest;
  const ext = path.extname(dest); const stem = dest.slice(0, dest.length - ext.length);
  for (let i = 2; i < 1000; i++) { const c = `${stem} (${i})${ext}`; if (!fs.existsSync(c)) return c; }
  throw new Error(`no free name for ${dest}`);
}

function moveOne(from, toDir, copy) {
  const dest = freeName(path.join(toDir, path.basename(from)));
  if (copy) fs.cpSync(from, dest, { recursive: true, errorOnExist: true, force: false });
  else {
    try { fs.renameSync(from, dest); } catch (e) {
      if (e.code !== 'EXDEV') throw e; // another drive: copy, then remove the original
      fs.cpSync(from, dest, { recursive: true, errorOnExist: true, force: false });
      fs.rmSync(from, { recursive: true });
    }
  }
  return dest;
}

const size = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

const tools = {
  list(arg) {
    const dir = resolvePath(arg);
    const names = fs.readdirSync(dir, { withFileTypes: true });
    const lines = names.slice(0, 300).map((d) => {
      if (d.isDirectory()) return `${d.name}\\`;
      let st = null; try { st = fs.statSync(path.join(dir, d.name)); } catch {}
      return `${d.name}${st ? `  (${size(st.size)})` : ''}`;
    });
    return `${dir} has ${names.length} item${names.length === 1 ? '' : 's'}:\n${lines.join('\n') || '(empty)'}${names.length > 300 ? '\n(and more)' : ''}`;
  },
  mkdir(arg) {
    const dir = resolvePath(arg);
    if (fs.existsSync(dir)) return `${dir} already exists`;
    fs.mkdirSync(dir, { recursive: true });
    return `made ${dir}`;
  },
  // Only an empty folder, and only to the Recycle Bin: tidying up after a move, never losing anything.
  async rmdir(arg) {
    const dir = resolvePath(arg);
    if (dir === HOME || Object.values(known()).includes(dir)) throw new Error(`${dir} is one of your main folders`);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`${dir} is not a folder`);
    const left = fs.readdirSync(dir).filter((n) => n.toLowerCase() !== 'desktop.ini' && n !== '.DS_Store');
    if (left.length) throw new Error(`${dir} still has ${left.length} item${left.length === 1 ? '' : 's'} in it (${left.slice(0, 5).join(', ')}); move them out first`);
    await shell.trashItem(dir);
    return `moved the empty folder ${dir} to the Recycle Bin`;
  },
  movefile(arg) { return transfer(arg, false); },
  copyfile(arg) { return transfer(arg, true); },
  rename(arg) {
    const [src, name] = String(arg).split('|');
    if (!name || /[\\/]/.test(name)) throw new Error('use file|new name (just a name, no folders)');
    const from = resolvePath(src);
    if (!fs.existsSync(from)) throw new Error(`${from} doesn't exist`);
    const to = path.join(path.dirname(from), name.trim());
    if (fs.existsSync(to)) throw new Error(`${to} already exists`);
    fs.renameSync(from, to);
    return `renamed to ${to}`;
  },
  async open(arg) {
    const s = String(arg).trim();
    if (/^https?:\/\//i.test(s)) { await shell.openExternal(s); return `opened ${s}`; }
    const p = resolvePath(s);
    const err = await shell.openPath(p);
    if (err) throw new Error(err);
    return `opened ${p}`;
  },
  async fetch(arg, cliDir) {
    const web = require(path.join(cliDir, 'lib', 'web-tools.js'));
    const r = await web.fetchPage(String(arg).trim());
    if (!r.ok) throw new Error(r.error);
    return `${r.finalUrl}:\n${r.text}`;
  },
  async search(arg, cliDir) {
    const web = require(path.join(cliDir, 'lib', 'web-tools.js'));
    const r = await web.webSearch(String(arg).trim(), { num: 6 });
    if (!r.ok) throw new Error(r.error);
    return `search "${String(arg).trim()}":\n${r.text}`;
  },
};

// Move (or copy) "from|to folder"; the from part may use * and ?.
function transfer(arg, copy) {
  const [src, dst] = String(arg).split('|');
  if (!dst) throw new Error('use from|to');
  const files = expand(src);
  if (!files.length) return `nothing matched ${src.trim()}`;
  const toDir = resolvePath(dst);
  if (!fs.existsSync(toDir)) fs.mkdirSync(toDir, { recursive: true });
  if (!fs.statSync(toDir).isDirectory()) throw new Error(`${toDir} is not a folder`);
  const done = []; const failed = [];
  for (const f of files) {
    if (path.resolve(path.dirname(f)) === path.resolve(toDir)) continue; // already there
    try { done.push(path.basename(moveOne(f, toDir, copy))); } catch (e) { failed.push(`${path.basename(f)} (${e.message})`); }
  }
  return `${copy ? 'copied' : 'moved'} ${done.length} item${done.length === 1 ? '' : 's'} into ${toDir}${done.length ? `: ${done.slice(0, 40).join(', ')}${done.length > 40 ? ', ...' : ''}` : ''}${failed.length ? `. Failed: ${failed.join(', ')}` : ''}`;
}

/** Runs one command; always returns a short line for the model (errors included). */
async function run(kind, arg, cliDir) {
  const fn = tools[kind.toLowerCase()];
  if (!fn) return `${kind}: unknown command`;
  try {
    const out = await fn(arg, cliDir);
    const s = String(out);
    return s.length > MAX_RESULT ? `${s.slice(0, MAX_RESULT)}\n(cut off)` : s;
  } catch (e) {
    return `${kind.toLowerCase()} ${String(arg).slice(0, 120)} failed: ${e.message}`;
  }
}

/** The user's main folders, for the prompt. */
function folders() {
  const k = known();
  return Object.entries(k).filter(([, v]) => v).map(([n, v]) => `${n[0].toUpperCase()}${n.slice(1)}: ${v}`).join('; ');
}

module.exports = { run, folders, KINDS: ['LIST', 'MKDIR', 'MOVEFILE', 'COPYFILE', 'RENAME', 'RMDIR', 'OPEN', 'FETCH', 'SEARCH'] };
