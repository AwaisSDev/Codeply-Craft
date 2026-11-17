// Run: node sidecar/ext-skills.test.mjs (the skills route on codeply-cli's real library, and what
// a message's /skill and @mention refs put in front of the prompt, with lookups stubbed).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { route, refsPrompt, cleanRefs, wantsAgents, start } from './ext-skills.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, '..', '..', 'codeply-cli');
const require = createRequire(path.join(cli, 'lib', 'x.js'));

// ----- refs into the prompt -----
const env = {
  skill: (n) => (n === 'tdd-workflow' ? { name: 'tdd-workflow', path: '/skills/tdd-workflow/SKILL.md', body: '# TDD\nWrite the test first.' } : null),
  file: (p) => (p === 'src/a.js' ? { path: p, abs: '/proj/src/a.js', size: 12, text: 'const a = 1;' } : p === 'big.log' ? { path: p, abs: '/proj/big.log', size: 300000 } : p === 'src/' ? { path: p, abs: '/proj/src', dir: true } : null),
  agent: (n) => (n.toLowerCase() === 'joseph' ? { name: 'Joseph', role: 'Ops' } : null),
  app: (id) => (id === 'slack' ? { id: 'slack', title: 'Slack' } : null),
};
const note = refsPrompt([
  { kind: 'skill', name: 'tdd-workflow' },
  { kind: 'file', path: 'src/a.js' },
  { kind: 'file', path: 'big.log' },
  { kind: 'file', path: 'src/' },
  { kind: 'agent', name: 'Joseph' },
  { kind: 'app', id: 'slack', name: 'Slack' },
  { kind: 'skill', name: 'tdd-workflow' },
  { kind: 'bogus', name: 'x' },
], env);
assert.match(note, /^\[The user picked the skill "tdd-workflow" for this message\. Follow it\./);
assert.match(note, /SKILL: tdd-workflow\n```\n# TDD\nWrite the test first\.\n```/);
assert.match(note, /\/skills\/tdd-workflow\/SKILL\.md/);
assert.match(note, /- src\/a\.js \(\/proj\/src\/a\.js\):\n```\nconst a = 1;\n```/);
assert.match(note, /- big\.log \(\/proj\/big\.log, 293 KB: read it with your tools\)/);
assert.match(note, /- src\/ \(a folder: \/proj\/src\)/);
assert.match(note, /mentioned the agent Joseph \(Ops\)\. Ask it with ask_bot/);
assert.match(note, /use the app Slack for this\. Call it with use_app \(app = "slack"\)/);
assert.equal(note.match(/SKILL: tdd-workflow/g).length, 1, 'a skill picked twice goes in once');
assert.ok(note.endsWith(']\n\n'));
assert.equal(refsPrompt([], env), '');
assert.equal(refsPrompt(null, env), '');
assert.match(refsPrompt([{ kind: 'skill', name: 'nope' }], env), /no skill by that name/);
assert.match(refsPrompt([{ kind: 'agent', name: 'Zed' }], env), /no agent by that name/);
assert.match(refsPrompt([{ kind: 'app', id: 'notion', name: 'Notion' }], env), /"Notion", but it is not connected/);
assert.equal(cleanRefs(Array.from({ length: 30 }, (_, i) => ({ kind: 'file', path: `f${i}` }))).length, 12);
assert.ok(wantsAgents([{ kind: 'agent', name: 'Joseph' }]) && !wantsAgents([{ kind: 'skill', name: 'x' }]));

// ----- the route, on codeply-cli's real library -----
const ctx = {
  DEFAULT_CWD: os.tmpdir(),
  need: (name) => require(path.join(cli, 'lib', name)),
  inside: (root, rel) => path.resolve(root, rel),
  hooks: { prompt: [] },
};
let out;
const reply = (s, b) => { out = [s, b]; };
const t0 = Date.now();
assert.equal(await route(ctx, { method: 'GET' }, {}, new URL('http://x/ext/skills'), '/ext/skills', reply), true);
const ms = Date.now() - t0;
assert.equal(out[0], 200);
const builtIn = fs.readdirSync(path.join(cli, 'skills')).filter((d) => fs.existsSync(path.join(cli, 'skills', d, 'SKILL.md'))).length;
assert.ok(out[1].count >= builtIn && builtIn > 280, `every built-in skill: ${out[1].count} of ${builtIn}`);
const tdd = out[1].skills.find((s) => s.name === 'tdd-workflow');
assert.ok(tdd && tdd.description && tdd.source === 'built-in' && tdd.path.endsWith('SKILL.md'));
assert.ok(out[1].skills.every((s) => s.name && !/\n/.test(s.description)), 'one line each');
await route(ctx, { method: 'GET' }, {}, new URL('http://x/ext/skills/one?name=tdd-workflow'), '/ext/skills/one', reply);
assert.equal(out[0], 200);
assert.ok(out[1].body.length > 100);
await route(ctx, { method: 'GET' }, {}, new URL('http://x/ext/skills/one?name=nope'), '/ext/skills/one', reply);
assert.equal(out[0], 404);
assert.equal(await route(ctx, { method: 'GET' }, {}, new URL('http://x/ext/other'), '/ext/other', reply), false);

// ----- the hook engine.mjs calls, with the real skill body -----
start(ctx);
const hookNote = await ctx.hooks.prompt[0]({ cwd: os.tmpdir() }, [{ kind: 'skill', name: 'tdd-workflow' }]);
assert.match(hookNote, /SKILL: tdd-workflow/);
console.log(`ext-skills ok (${out && builtIn} built-in skills, listed in ${ms} ms)`);
