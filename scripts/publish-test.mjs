// End-to-end publishing (lib/publish.js) against fake Vercel, Supabase and
// GitHub servers on localhost and a local bare git remote. Nothing real is
// contacted and the user's ~/.codeply config is never touched. Run from
// engine-test.mjs.
import http from 'http';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { pathToFileURL } from 'url';
import { createRequire } from 'module';

export default async function publishTests({ check, tmp, CLI }) {
  const require = createRequire(import.meta.url);
  const config = require(path.join(CLI, 'lib/config.js'));
  const oauth = require(path.join(CLI, 'lib/oauth-connectors.js'));
  const publish = require(path.join(CLI, 'lib/publish.js'));
  const { executeTool } = await import(pathToFileURL(path.join(CLI, 'lib/tools.mjs')).href);

  const TOK = { vercel: 'vercel-test-token-123', supabase: 'sb-test-token-456', github: 'gh-test-token-789' };
  const bare = path.join(tmp, 'publish-remote.git');
  fs.mkdirSync(bare, { recursive: true });
  execFileSync('git', ['init', '--bare', '-q'], { cwd: bare });

  // ─── Fake APIs ───
  const calls = [];
  let deployStates = [];     // readyState sequence per deployment GET
  let deployCount = 0;
  const vercelProjects = new Map();
  const handle = (req, raw) => {
    const u = new URL(req.url, 'http://x');
    const [, svc, ...rest] = u.pathname.split('/');
    const p = '/' + rest.join('/');
    const json = /json/.test(req.headers['content-type'] || '') && raw.length ? JSON.parse(raw.toString('utf8')) : null;
    calls.push({ svc, method: req.method, path: p, query: u.search, body: json, raw, headers: req.headers });
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${TOK[svc]}` && !(svc === 'vercel' && p === '/v2/user' && auth === 'Bearer bad')) return [401, { error: { message: 'bad token' }, message: 'bad token' }];
    if (svc === 'vercel') {
      if (p === '/v2/user') return auth === 'Bearer bad' ? [403, { error: { message: 'forbidden' } }] : [200, { user: { username: 'pat' } }];
      let m;
      if (req.method === 'GET' && (m = p.match(/^\/v9\/projects\/([^/]+)$/))) return vercelProjects.has(m[1]) ? [200, vercelProjects.get(m[1])] : [404, { error: { code: 'not_found', message: 'Project not found' } }];
      if (req.method === 'POST' && p === '/v11/projects') { const pr = { id: `prj_${json.name}`, name: json.name, framework: json.framework }; vercelProjects.set(json.name, pr); vercelProjects.set(pr.id, pr); return [200, pr]; }
      if (req.method === 'POST' && /^\/v10\/projects\/[^/]+\/env$/.test(p)) return [201, { created: json }];
      if (req.method === 'POST' && p === '/v2/files') return [200, {}];
      if (req.method === 'POST' && p === '/v13/deployments') { deployCount++; return [200, { id: `dpl_${deployCount}`, url: `site-${deployCount}-hash.vercel.app`, readyState: 'QUEUED' }]; }
      if (req.method === 'GET' && /^\/v13\/deployments\//.test(p)) return [200, { id: p.split('/').pop(), readyState: deployStates.shift() || 'READY', alias: [] }];
      if (req.method === 'GET' && /^\/v3\/deployments\/.+\/events$/.test(p)) return [200, [{ type: 'stdout', payload: { text: 'Running "npm run build"' } }, { type: 'stderr', payload: { text: 'src/main.js:3:1: ERROR: Unexpected "}"' } }]];
      if (req.method === 'GET' && /^\/v9\/projects\/[^/]+\/domains$/.test(p)) { const id = p.split('/')[3]; const pr = vercelProjects.get(id); return [200, { domains: [{ name: `${pr ? pr.name : 'x'}.vercel.app`, verified: true }] }]; }
      if (req.method === 'POST' && /^\/v9\/projects\/[^/]+\/link$/.test(p)) return [200, { link: { type: 'github', repo: json.repo } }];
    }
    if (svc === 'supabase') {
      if (p === '/v1/projects' && req.method === 'GET') return [200, [{ ref: 'shopref000001', name: 'shop', status: 'ACTIVE_HEALTHY' }]];
      if (p === '/v1/projects' && req.method === 'POST') return [201, { ref: 'newref000002', name: json.name, status: 'COMING_UP' }];
      if (p === '/v1/projects/newref000002') return [200, { ref: 'newref000002', name: 'notes-app', status: 'ACTIVE_HEALTHY' }];
      if (p === '/v1/organizations') return [200, [{ id: 'org1', slug: 'org-one', name: 'My Org' }]];
      if (p === '/v1/organizations/org-one') return [200, { id: 'org1', name: 'My Org', plan: 'free' }];
      if (/^\/v1\/projects\/[^/]+\/api-keys$/.test(p)) return [200, [{ name: 'service_role', type: 'legacy', api_key: 'service-role-secret-key' }, { name: 'anon', type: 'legacy', api_key: 'anon-public-key-abc' }]];
      if (/^\/v1\/projects\/[^/]+\/database\/query$/.test(p)) return [201, []];
    }
    if (svc === 'github') {
      if (p === '/user') return [200, { login: 'pat' }];
      if (p === '/user/repos' && req.method === 'POST') return [201, { name: json.name, full_name: `pat/${json.name}`, html_url: `https://github.com/pat/${json.name}`, clone_url: bare, private: json.private }];
    }
    return [404, { message: 'no fake route', error: { message: 'no fake route' } }];
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const [status, body] = handle(req, Buffer.concat(chunks));
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const savedEnv = { ...process.env };
  process.env.CODEPLY_VERCEL_API = `${base}/vercel`;
  process.env.CODEPLY_SUPABASE_API = `${base}/supabase`;
  process.env.CODEPLY_GITHUB_API = `${base}/github`;
  process.env.CODEPLY_PUBLISH_POLL_MS = '5';

  // In-memory connections instead of ~/.codeply/config.json.
  const realGet = config.getIntegration;
  const realSave = config.saveIntegration;
  const conns = { vercel: {}, supabase: {}, github: {} };
  config.getIntegration = (n) => (conns[n] ? { clientId: '', clientSecret: '', accessToken: '', ...conns[n] } : realGet(n));
  config.saveIntegration = (n, patch) => (conns[n] ? (conns[n] = { ...conns[n], ...patch }) : realSave(n, patch));

  const asked = [];
  const approvals = [];
  const makeCtx = (cwd, { answers = [], userMessage = 'publish my website', approve = 'once' } = {}) => ({
    cwd, mode: 'Build', userMessage, signal: new AbortController().signal,
    approve: async (req) => { approvals.push(req); return approve; },
    ask: async (q) => { asked.push(q); const a = answers.shift(); return typeof a === 'function' ? a(q) : a ?? null; },
  });
  const reset = () => { calls.length = 0; asked.length = 0; approvals.length = 0; deployStates = []; };
  const project = (name, files) => {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
    return dir;
  };
  const noTokens = (text) => !Object.values(TOK).some((t) => String(text).includes(t));

  try {
    // 1. No database: a plain static site, user says no to GitHub.
    {
      reset();
      conns.vercel = { accessToken: TOK.vercel, userName: 'pat' };
      const dir = project('pub-static', { 'index.html': '<html><head><title>Tea</title></head><body><h1>Tea shop</h1><script src="app.js"></script></body></html>', 'app.js': 'console.log(1)', '.env': 'SECRET=1', 'node_modules/x/index.js': 'x' });
      const ctx = makeCtx(dir, { answers: ['No, just deploy'] });
      const chk = await executeTool('publish_check', {}, ctx);
      check('publish: static site needs no database', chk.ok && /no sign of one/.test(chk.output) && chk.meta.publish.steps.database.status === 'skipped', chk.output);
      deployStates = ['BUILDING', 'BUILDING', 'READY'];
      const r = await executeTool('publish_deploy', {}, ctx);
      const files = calls.filter((c) => c.path === '/v2/files');
      const dep = calls.find((c) => c.path === '/v13/deployments');
      const polls = calls.filter((c) => c.method === 'GET' && /^\/v13\/deployments\//.test(c.path));
      check('publish: asks about GitHub before the first deploy', asked[0] && asked[0].question === 'Connect GitHub so pushes deploy automatically?', JSON.stringify(asked));
      check('publish: creates the Vercel project, uploads files by sha, never .env or node_modules', calls.some((c) => c.path === '/v11/projects' && c.body.name === 'pub-static') &&
        files.length === 2 && files.every((f) => /^[0-9a-f]{40}$/.test(f.headers['x-vercel-digest'])) && dep && dep.body.files.map((f) => f.file).join() === 'app.js,index.html' && dep.body.target === 'production' && dep.body.projectSettings.framework === null, JSON.stringify(dep && dep.body));
      check('publish: polls the deployment until READY', polls.length === 3, String(polls.length));
      check('publish: returns the live URL and a finished card', r.ok && /live at https:\/\/pub-static\.vercel\.app/.test(r.output) && r.meta.liveUrl === 'https://pub-static.vercel.app' && r.meta.publish.steps.live.status === 'done' && r.meta.publish.steps.github.status === 'skipped', r.output);
      check('publish: no env vars for a site without a database', !calls.some((c) => /\/env$/.test(c.path)));
      check('publish: the approval is marked dangerous and names the project', approvals.length === 1 && approvals[0].danger && /pub-static/.test(approvals[0].title));
      const st = publish.readState(dir);
      check('publish: state remembers project and GitHub choice, no tokens', st.vercel.projectName === 'pub-static' && st.github.choice === 'no' && noTokens(JSON.stringify(st)) && noTokens(r.output));
      reset();
      const again = await executeTool('publish_deploy', {}, makeCtx(dir));
      check('publish: a second publish reuses the project and does not ask about GitHub again', again.ok && asked.length === 0 && !calls.some((c) => c.path === '/v11/projects'), again.output);
    }

    // 2. Not asked to publish: nothing happens.
    {
      reset();
      const dir = path.join(tmp, 'pub-static');
      const r = await executeTool('publish_deploy', {}, makeCtx(dir, { userMessage: 'make the header blue' }));
      check('publish: refuses when the user did not ask to publish', !r.ok && /has not asked to publish/.test(r.output) && calls.length === 0 && approvals.length === 0, r.output);
    }

    // 3. Database: Vite app with sign-in; Supabase connected mid-flow; env injection; build error then fix.
    {
      reset();
      conns.supabase = {};
      const dir = project('pub-vite', {
        'package.json': JSON.stringify({ name: 'pub-vite', scripts: { build: 'vite build' }, dependencies: { '@supabase/supabase-js': '^2' }, devDependencies: { vite: '^6' } }),
        'index.html': '<form><input type="password"></form><script type="module" src="/src/main.js"></script>',
        'src/main.js': "import { createClient } from '@supabase/supabase-js';\nexport const sb = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY);\n",
        'dist/old.js': 'stale',
      });
      const chk = await executeTool('publish_check', {}, makeCtx(dir));
      check('publish: sign-in and supabase-js mean a database is likely needed', /likely needed/.test(chk.output) && /Vite/.test(chk.output) && /VITE_SUPABASE_URL/.test(chk.output), chk.output);
      const before = await executeTool('supabase_setup', {}, makeCtx(dir));
      check('publish: supabase_setup without a connection points to publish_connect', !before.ok && /publish_connect/.test(before.output) && before.meta.publish.steps.database.status === 'waiting');
      const ctx = makeCtx(dir, { answers: [(q) => { conns.supabase = { accessToken: TOK.supabase, email: 'My Org' }; return 'Connected'; }, 'shop (shopref000001)', 'No, just deploy'] });
      const conn = await executeTool('publish_connect', { service: 'supabase', reason: 'The app has sign-in.' }, ctx);
      check('publish: publish_connect pauses with a one-click Supabase connect, then resumes', conn.ok && asked[0].connect === 'supabase' && /Log in to your Supabase/.test(asked[0].question) && /connected now/.test(conn.output), conn.output);
      const setup = await executeTool('supabase_setup', {}, ctx);
      const env = fs.readFileSync(path.join(dir, '.env'), 'utf8');
      check('publish: user picks an existing project; URL and anon key land in .env with VITE_ names', setup.ok && /Which Supabase project/.test(asked[1].question) && asked[1].options.includes('Create a new project') &&
        /VITE_SUPABASE_URL=https:\/\/shopref000001\.supabase\.co/.test(env) && /VITE_SUPABASE_ANON_KEY=anon-public-key-abc/.test(env), setup.output + env);
      check('publish: the service role key is never written or shown', !env.includes('service-role-secret') && !setup.output.includes('service-role-secret') && !setup.output.includes('anon-public-key-abc'));
      check('publish: .env is git-ignored', /^\.env$/m.test(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')));
      approvals.length = 0;
      const schema = await executeTool('supabase_schema', { sql: 'create table notes (id bigint primary key, body text)' }, ctx);
      const q = calls.find((c) => /database\/query$/.test(c.path));
      check('publish: schema SQL is shown for approval, RLS added, missing policy warned', schema.ok && approvals[0].tool === 'supabase_schema' && /enable row level security/.test(approvals[0].detail) && /no policy on notes/.test(approvals[0].detail) &&
        q && /alter table notes enable row level security;/.test(q.body.query) && /no policy/.test(schema.output), JSON.stringify(approvals[0]));
      const declined = await executeTool('supabase_schema', { sql: 'drop table notes' }, { ...ctx, approve: async (req) => { approvals.push(req); return 'reject'; } });
      check('publish: declined SQL never runs, destructive SQL is flagged', !declined.ok && approvals[approvals.length - 1].danger && calls.filter((c) => /database\/query$/.test(c.path)).length === 1);

      calls.length = 0;
      deployStates = ['ERROR'];
      const bad = await executeTool('publish_deploy', {}, ctx);
      const envCall = calls.find((c) => /\/env$/.test(c.path));
      const dep = calls.find((c) => c.path === '/v13/deployments');
      check('publish: Supabase values go to Vercel env vars, .env and dist stay local', envCall && envCall.body.map((e) => e.key).join() === 'VITE_SUPABASE_URL,VITE_SUPABASE_ANON_KEY' && envCall.body[1].value === 'anon-public-key-abc' &&
        dep.body.projectSettings.framework === 'vite' && !dep.body.files.some((f) => /^\.env|^dist\//.test(f.file)), JSON.stringify(dep && dep.body.files));
      check('publish: a failed build comes back with its log and one retry', !bad.ok && /Unexpected "\}"/.test(bad.output) && /one retry/.test(bad.output) && bad.meta.publish.steps.vercel.status === 'error' && noTokens(bad.output), bad.output);
      const good = await executeTool('publish_deploy', {}, ctx);
      check('publish: the retry after a fix goes live', good.ok && /pub-vite\.vercel\.app/.test(good.output) && good.meta.publish.steps.database.status === 'done', good.output);
      deployStates = ['ERROR'];
      await executeTool('publish_deploy', {}, ctx);
      deployStates = ['ERROR'];
      const twice = await executeTool('publish_deploy', {}, ctx);
      check('publish: a second build failure says stop retrying', !twice.ok && /Stop retrying/.test(twice.output), twice.output);
    }

    // 4. New Supabase project for a static site: approval with plan, env.js and script tag.
    {
      reset();
      const dir = project('notes-app', { 'index.html': '<html><head></head><body><input type="password"><script src="app.js"></script></body></html>', 'app.js': 'const sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);' });
      const r = await executeTool('supabase_setup', { project: 'new' }, makeCtx(dir));
      const js = fs.readFileSync(path.join(dir, 'env.js'), 'utf8');
      const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
      check('publish: creating a project asks first and states the plan', r.ok && approvals[0].tool === 'supabase_setup' && /plan: free/.test(approvals[0].detail) && calls.some((c) => c.path === '/v1/projects' && c.method === 'POST' && c.body.organization_slug === 'org-one'), r.output);
      check('publish: a static site gets env.js loaded before its scripts', /window\.SUPABASE_URL = "https:\/\/newref000002\.supabase\.co"/.test(js) && /anon-public-key-abc/.test(js) && html.indexOf('<script src="env.js"></script>') < html.indexOf('<script src="app.js">'), html);
    }

    // 5. GitHub opt-in: connect, create repo, push, link Vercel, then deploy.
    {
      reset();
      conns.github = {};
      const dir = project('pub-gh', { 'index.html': '<h1>hi</h1>', '.env': 'X=1' });
      const ctx = makeCtx(dir, { answers: ['Yes, connect GitHub', (q) => { conns.github = { accessToken: TOK.github, userName: 'pat' }; return 'Connected'; }] });
      const first = await executeTool('publish_deploy', {}, ctx);
      check('publish: saying yes to GitHub sends the agent to publish_github first', first.ok && /publish_github/.test(first.output) && !calls.some((c) => c.path === '/v13/deployments'), first.output);
      const noGh = await executeTool('publish_github', {}, ctx);
      check('publish: publish_github without GitHub asks for publish_connect', !noGh.ok && /publish_connect/.test(noGh.output));
      const conn = await executeTool('publish_connect', { service: 'github' }, ctx);
      const gh = await executeTool('publish_github', {}, ctx);
      const link = calls.find((c) => /\/link$/.test(c.path));
      let pushed = '';
      try { pushed = execFileSync('git', ['--git-dir', bare, 'ls-tree', '-r', '--name-only', `refs/heads/${publish.readState(dir).github?.branch}`]).toString(); } catch {}
      check('publish: GitHub connected, repo created private, code pushed without .env', conn.ok && gh.ok && calls.some((c) => c.svc === 'github' && c.path === '/user/repos' && c.body.private === true) && /index\.html/.test(pushed) && /\.gitignore/.test(pushed) && !/^\.env$/m.test(pushed), gh.output + pushed);
      check('publish: the Vercel project is linked to the repo', link && link.body.repo === 'pat/pub-gh' && link.body.type === 'github' && publish.readState(dir).github.linked === true, JSON.stringify(link && link.body));
      const cfg = fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8');
      check('publish: no token left in .git/config or output', noTokens(cfg) && noTokens(gh.output));
      asked.length = 0;
      const live = await executeTool('publish_deploy', {}, ctx);
      check('publish: the deploy after linking goes live and mentions auto-deploy', live.ok && asked.length === 0 && /deploys on its own/.test(live.output) && /pub-gh\.vercel\.app/.test(live.output), live.output);
    }

    // 6. Helpers.
    check('publish: GitHub remote parsing', publish.githubRepoFromUrl('https://github.com/a/b.git') === 'a/b' && publish.githubRepoFromUrl('git@github.com:a/b') === 'a/b' && publish.githubRepoFromUrl('https://gitlab.com/a/b') === null);
    check('publish: Next.js reads NEXT_PUBLIC_ names from .env.local', (() => { const d = project('pub-next', { 'package.json': '{"dependencies":{"next":"15"}}' }); const s = publish.detectStack(d); return s.framework === 'nextjs' && s.envFile === '.env.local' && publish.envNames(s).key === 'NEXT_PUBLIC_SUPABASE_ANON_KEY'; })());
    const tokOk = await oauth.checkAccessToken('vercel', TOK.vercel);
    let tokBad = '';
    try { await oauth.checkAccessToken('vercel', 'bad'); } catch (e) { tokBad = e.message; }
    check('publish: token sign-in checks the token and never echoes it', tokOk.userName === 'pat' && tokOk.accessToken === TOK.vercel && /did not accept/.test(tokBad) && !tokBad.includes('bad '), tokBad);
  } finally {
    config.getIntegration = realGet;
    config.saveIntegration = realSave;
    for (const k of ['CODEPLY_VERCEL_API', 'CODEPLY_SUPABASE_API', 'CODEPLY_GITHUB_API', 'CODEPLY_PUBLISH_POLL_MS']) {
      if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
    }
    server.close();
  }
}
