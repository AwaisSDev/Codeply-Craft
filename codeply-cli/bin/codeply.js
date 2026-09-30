#!/usr/bin/env node
/**
 * Codeply CLI - apply an AI instruction to a file from the terminal.
 *
 * Single-shot by design (v1): one instruction, one file, one verified diff,
 * one write. No multi-file auto-detection, no conversation memory, no local
 * response cache - those are desktop-app features that can come later if
 * this is worth building out further.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const { Command } = require('commander');

const auth = require('../lib/auth');
const ai = require('../lib/ai');
const editEngine = require('../lib/edit-engine');
const applyLimit = require('../lib/apply-limit');
const config = require('../lib/config');

// Google brand palette
const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[38;2;234;67;53m${s}\x1b[0m`,     // #EA4335
  green: (s) => `\x1b[38;2;52;168;83m${s}\x1b[0m`,   // #34A853
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  blue: (s) => `\x1b[38;2;66;133;244m${s}\x1b[0m`,   // #4285F4
  yellow: (s) => `\x1b[38;2;251;188;5m${s}\x1b[0m`,  // #FBBC05
  accent: (s) => `\x1b[38;2;66;133;244m${s}\x1b[0m`, // primary = blue
  secondary: (s) => `\x1b[38;2;154;160;166m${s}\x1b[0m`,
  muted: (s) => `\x1b[38;2;95;99;104m${s}\x1b[0m`,
  text: (s) => `\x1b[38;2;232;234;237m${s}\x1b[0m`,
};

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} (y/N) `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

function printEditPreview(edits) {
  edits.forEach((e, i) => {
    console.log(c.muted(`\n── edit ${i + 1}/${edits.length} ──`));
    e.search.split('\n').forEach(l => console.log(c.red(`- ${l}`)));
    e.replace.split('\n').forEach(l => console.log(c.green(`+ ${l}`)));
  });
  console.log('');
}

async function runApply(instruction, opts) {
  const session = await auth.getSession();
  if (!session) {
    console.error('Not signed in. Run `codeply login` first.');
    process.exitCode = 1;
    return;
  }

  const filePath = path.resolve(process.cwd(), opts.file);
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exitCode = 1;
    return;
  }

  // The shared 100/day cap only applies when spending the Codeply proxy -
  // Ollama (local or the user's own cloud key) doesn't touch that account.
  const usingCodeply = config.getConfig().provider === 'codeply';
  if (usingCodeply) {
    const limit = await applyLimit.checkApplyLimit();
    if (!limit.allowed) {
      console.error(limit.error || `Daily apply limit reached (${limit.count}/${limit.limit}). This is shared with the Codeply desktop app and resets at midnight UTC.`);
      console.error(c.muted(config.byokHint()));
      process.exitCode = 1;
      return;
    }
  }

  console.log(c.secondary(`Asking Codeply about ${path.basename(filePath)}…`));
  const result = await editEngine.computeInstructionEdits(instruction, filePath);

  if (!result.success) {
    console.error(c.red(`Failed: ${result.error}`));
    process.exitCode = 1;
    return;
  }
  if (!result.edits.length) {
    console.log(result.reason || 'No edits produced - the instruction may be too ambiguous or too large for a targeted change.');
    return;
  }

  printEditPreview(result.edits);
  if (result.badCount) {
    console.log(c.muted(`Note: ${result.badCount} proposed change(s) couldn't be matched against the file and were skipped.`));
  }
  console.log(c.muted(`${result.reason || ''}${result.reason ? ' - ' : ''}confidence ${result.confidence ?? '?'}%, ${result.tokensUsed || 0} tokens, model ${result.modelUsed || 'unknown'}`));

  if (opts.dryRun) {
    console.log(c.muted('\n(dry run - nothing written)'));
    return;
  }

  if (!opts.yes) {
    const ok = await confirm(c.bold(c.accent(`Apply ${result.edits.length} edit(s) to ${path.basename(filePath)}?`)));
    if (!ok) { console.log(c.secondary('Cancelled.')); return; }
  }

  const fileContent = fs.readFileSync(filePath, 'utf8');
  const applied = editEngine.applyEditsToContent(fileContent, result.edits);
  if (!applied.ok) {
    console.error(`Could not apply edit ${applied.index + 1}: ${applied.error}`);
    process.exitCode = 1;
    return;
  }

  fs.writeFileSync(filePath, applied.content);
  if (usingCodeply) {
    const linesAdded = result.edits.reduce((n, e) => n + e.replace.split('\n').length, 0);
    const linesRemoved = result.edits.reduce((n, e) => n + e.search.split('\n').length, 0);
    await applyLimit.recordApplyEvent(filePath, linesAdded, linesRemoved);
  }
  console.log(c.green(`✓ Applied to ${filePath}`));
}

// TUI Mode - interactive when no command is provided
async function runTUI() {
  // Check if running in interactive terminal
  if (!process.stdin.isTTY) {
    const VERSION = require('../package.json').version;
    // C=blue O=red D=yellow E=green P=blue L=red Y=yellow
    // Fixed-width letters + trailing gap so CODEPLY reads cleanly
    const letterColors = [c.blue, c.red, c.yellow, c.green, c.blue, c.red, c.yellow];
    const logoLines = [
      [' ██████╗ ', ' ██████╗ ', '██████╗  ', '███████╗ ', '██████╗  ', '██╗      ', '██╗   ██╗'],
      ['██╔════╝ ', '██╔═══██╗', '██╔══██╗ ', '██╔════╝ ', '██╔══██╗ ', '██║      ', '╚██╗ ██╔╝'],
      ['██║      ', '██║   ██║', '██║  ██║ ', '█████╗   ', '██████╔╝ ', '██║      ', ' ╚████╔╝ '],
      ['██║      ', '██║   ██║', '██║  ██║ ', '██╔══╝   ', '██╔═══╝  ', '██║      ', '  ╚██╔╝  '],
      ['╚██████╗ ', '╚██████╔╝', '██████╔╝ ', '███████╗ ', '██║      ', '███████╗ ', '   ██║   '],
      [' ╚═════╝ ', ' ╚═════╝ ', '╚═════╝  ', '╚══════╝ ', '╚═╝      ', '╚══════╝ ', '   ╚═╝   '],
    ];

    console.log('');
    logoLines.forEach((line) => {
      console.log(line.map((seg, i) => letterColors[i](seg)).join(''));
    });
    console.log(`
${c.secondary('Apply AI instructions. Edit files. Ship faster.')}  ${c.muted('v' + VERSION)}

${c.bold(c.text('Usage'))}
  ${c.blue('codeply')}                          Launch interactive TUI
  ${c.blue('codeply apply')} ${c.dim('<instruction>')} ${c.blue('-f')} ${c.dim('<file>')}
  ${c.red('codeply login')}                     Sign in with your Codeply account
  ${c.yellow('codeply logout')}                    Sign out
  ${c.green('codeply whoami')}                    Show current account

${c.muted('Run in a terminal for the full interactive UI · codeply --help')}
`);
    return;
  }

  const React = await import('react');
  const { render } = await import('ink');
  const { default: App } = await import('../lib/tui.mjs');

  // Take the screen so the app doesn't look like output that happened to land
  // in a shell. Deliberately a plain clear rather than the alternate screen
  // buffer (\x1b[?1049h): alt-screen would discard scrollback on exit, and the
  // whole point of the <Static> transcript is that you can scroll back through
  // it afterwards.
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');

  render(React.default.createElement(App), {
    exitOnCtrlC: false, // handled inside the app (clear draft first, then quit)
  });
}

const program = new Command();
program
  .name('codeply')
  .description('Apply an AI instruction to a file from the terminal.')
  .version(require('../package.json').version);

program
  .command('login')
  .description('Sign in with your Codeply account (email + emailed code).')
  .action(async () => { await auth.login(); });

program
  .command('logout')
  .description('Sign out of the current Codeply session.')
  .action(async () => { await auth.logout(); });

program
  .command('whoami')
  .description('Show the currently signed-in account.')
  .action(async () => {
    const session = await auth.getSession();
    console.log(session ? session.user.email : 'Not signed in.');
  });

program
  .command('provider [name]')
  .description('Show or set the model backend (codeply | ollama | openrouter | groq | anthropic | openai | google | qwen).')
  .option('--key <key>', 'API key for ollama (cloud only), openrouter, groq, anthropic, openai, google, or qwen')
  .option('--model <model>', 'model name for the selected provider')
  .option('--host <url>', 'ollama host only (default https://ollama.com; local: http://localhost:11434)')
  .option('--base-url <url>', 'qwen only - Alibaba Model Studio compatible-mode endpoint (deployment-specific)')
  .action(async (name, opts) => {
    const config = require('../lib/config');

    if (!name && !opts.key && !opts.model && !opts.host && !opts.baseUrl) {
      const cfg = config.getConfig();
      console.log(`Provider  ${c.accent(config.describeProvider(cfg))}`);
      if (cfg.provider === 'ollama') {
        console.log(`Host      ${cfg.ollama.host}`);
        console.log(`Model     ${cfg.ollama.model}`);
        console.log(`Key       ${config.maskKey(cfg.ollama.apiKey)}`);
      } else if (config.BYOK_PROVIDERS.includes(cfg.provider)) {
        console.log(`Model     ${cfg[cfg.provider].model}`);
        console.log(`Key       ${config.maskKey(cfg[cfg.provider].apiKey)}`);
      }
      console.log(c.muted(`\nConfig      ${config.configPath}`));
      console.log(c.muted(`Providers   ${config.PROVIDERS.join(', ')}`));
      console.log(c.muted('Set with    codeply provider openrouter --key <key> [--model <model>]'));
      if (cfg.provider === 'codeply') {
        console.log(c.muted(`\n${config.byokHint()}`));
      }
      return;
    }

    if (name && !config.PROVIDERS.includes(name)) {
      console.error(`Unknown provider "${name}". Use one of: ${config.PROVIDERS.join(', ')}.`);
      process.exitCode = 1;
      return;
    }

    const patch = {};
    if (name) patch.provider = name;
    const target = name || config.getConfig().provider;

    if (target === 'ollama') {
      const ollama = {};
      if (opts.key) ollama.apiKey = opts.key;
      if (opts.model) ollama.model = opts.model;
      if (opts.host) ollama.host = opts.host;
      if (Object.keys(ollama).length) patch.ollama = ollama;
    } else if (config.BYOK_PROVIDERS.includes(target)) {
      const byok = {};
      if (opts.key) byok.apiKey = opts.key;
      if (opts.model) byok.model = opts.model;
      if (target === 'qwen' && opts.baseUrl) byok.baseUrl = opts.baseUrl;
      if (Object.keys(byok).length) patch[target] = byok;
    }

    const saved = config.saveConfig(patch);
    if (!saved.ok) {
      console.error(`Could not save config: ${saved.error}`);
      process.exitCode = 1;
      return;
    }
    console.log(c.green(`✓ Provider: ${config.describeProvider(config.getConfig())}`));
    console.log(c.muted(`  saved to ${saved.path}`));
    if (opts.key) console.log(c.muted('  the key is stored outside the repo and is never committed'));
  });

program
  .command('apply <instruction>')
  .description('Apply an instruction to a file.')
  .requiredOption('-f, --file <path>', 'file to edit')
  .option('-y, --yes', 'apply without confirmation prompt')
  .option('--dry-run', 'show the proposed edits without writing them')
  .action(runApply);

const skillCmd = program
  .command('skill')
  .description('List, install, or remove agent skills (SKILL.md playbooks the agent can load mid-task).');

skillCmd
  .command('list', { isDefault: true })
  .description('List every available skill.')
  .option('-a, --all', 'include full descriptions (default shows a compact table)')
  .action((opts) => {
    const skills = require('../lib/skills');
    const list = skills.listSkills();
    if (list.length === 0) {
      console.log('No skills installed.');
      return;
    }
    const daily = list.filter((s) => s.daily);
    const rest = list.filter((s) => !s.daily);
    console.log(c.bold(`${list.length} skills`) + c.muted(` (${daily.length} loaded by default, ${rest.length} available via list_skills or /skill install)`));
    console.log('');
    for (const s of list) {
      const tag = s.source === 'user' ? c.green('[user]') : s.daily ? c.blue('[daily]') : c.muted('[library]');
      console.log(`${s.name.padEnd(30)} ${tag}`);
      if (opts.all) console.log(c.muted(`  ${s.description}`));
    }
    console.log('');
    console.log(c.muted(`Bundled from affaan-m/ECC - see skills/SOURCE.md.  Add your own: codeply skill install <path-or-github-url>`));
  });

skillCmd
  .command('install <source>')
  .description('Install a skill from a local directory (containing SKILL.md) or a GitHub URL/owner-repo.')
  .option('-n, --name <name>', 'name to install under (single-skill sources only; ignored for a whole-repo install)')
  .action(async (source, opts) => {
    const skills = require('../lib/skills');
    const isLocal = fs.existsSync(source);

    if (isLocal) {
      const result = skills.installFromLocalDir(path.resolve(process.cwd(), source), opts.name);
      if (!result.ok) { console.error(c.red(result.error)); process.exitCode = 1; return; }
      console.log(c.green(`✓ Installed "${result.name}"`));
      console.log(c.muted(`  ${result.dest}`));
      return;
    }

    console.log(c.secondary(`Fetching from ${source}…`));
    let result;
    try {
      result = await skills.installFromGitHub(source, opts.name);
    } catch (e) {
      console.error(c.red(`Install failed: ${e.message}`));
      process.exitCode = 1;
      return;
    }
    if (!result.ok) {
      console.error(c.red(result.error || `No skills installed from ${source}.`));
      process.exitCode = 1;
      return;
    }
    console.log(c.green(`✓ Installed ${result.installed.length} skill(s) from ${result.source}`));
    for (const i of result.installed) console.log(c.muted(`  ${i.name}  (${i.fileCount} file(s)) → ${i.dest}`));
    if (result.failed.length) {
      console.log(c.yellow(`  ${result.failed.length} skipped (fetch failed):`));
      for (const f of result.failed) console.log(c.muted(`    ${f.dir}: ${f.error}`));
    }
  });

skillCmd
  .command('remove <name>')
  .description('Remove a user-installed skill. Bundled skills cannot be removed this way.')
  .action((name) => {
    const skills = require('../lib/skills');
    const result = skills.removeSkill(name);
    if (!result.ok) { console.error(c.red(result.error)); process.exitCode = 1; return; }
    console.log(c.green(`✓ Removed "${name}"`));
  });

skillCmd
  .command('show <name>')
  .description('Print a skill\'s full instructions.')
  .action((name) => {
    const skills = require('../lib/skills');
    const body = skills.loadSkillBody(name);
    if (body == null) {
      console.error(c.red(`No skill named "${name}". Run \`codeply skill list\` to see what's available.`));
      process.exitCode = 1;
      return;
    }
    console.log(body);
  });

const pluginCmd = program
  .command('plugin')
  .description('Install, share and manage plugins: bundles of commands, skills, MCP servers and instructions.');

function printPluginSummary(s) {
  console.log(c.bold(`${s.name}${s.version ? ' ' + s.version : ''}`) + (s.author ? c.muted(`  by ${s.author}`) : ''));
  if (s.description) console.log(`  ${s.description}`);
  const parts = [];
  if (s.commands) parts.push(`${s.commands} command${s.commands === 1 ? '' : 's'} (/${s.name}:...)`);
  if (s.skills) parts.push(`${s.skills} skill${s.skills === 1 ? '' : 's'}`);
  if (s.instructions) parts.push('agent instructions');
  if (parts.length) console.log(c.muted(`  Adds: ${parts.join(', ')}`));
  if (s.mcpServers.length) {
    console.log(c.yellow('  Starts MCP servers (these can run programs on this computer):'));
    for (const m of s.mcpServers) console.log(`    ${m.name}: ${m.runs || m.url}`);
  }
}

pluginCmd
  .command('list', { isDefault: true })
  .description('List installed plugins.')
  .action(() => {
    const list = require('../lib/plugins').listPlugins(process.cwd());
    if (!list.length) {
      console.log('No plugins installed. Try: codeply plugin install <owner/repo | git URL | folder>');
      return;
    }
    for (const p of list) {
      const tag = [p.scope, p.enabled ? '' : 'disabled'].filter(Boolean).join(', ');
      console.log(`${p.name.padEnd(24)} ${p.version.padEnd(8)} ${c.muted(`[${tag}]`)} ${p.description}`);
    }
  });

pluginCmd
  .command('install <source>')
  .description('Install from owner/repo, a git URL (add #branch or #tag), or a local folder.')
  .option('--project', 'install for this project only (default: every project)')
  .option('--force', 'replace an existing plugin of the same name')
  .option('-y, --yes', 'do not ask before installing')
  .action(async (source, opts) => {
    const plugins = require('../lib/plugins');
    console.log(c.secondary(`Fetching ${source}...`));
    const prepared = await plugins.prepareInstall(source);
    if (!prepared.ok) { console.error(c.red(prepared.error)); process.exitCode = 1; return; }
    console.log('');
    printPluginSummary(prepared.summary);
    console.log('');
    if (!opts.yes && !(await confirm(c.bold(c.accent(`Install ${prepared.name}?`))))) { plugins.discardInstall(prepared); console.log('Cancelled.'); return; }
    const done = plugins.finishInstall(prepared, { scope: opts.project ? 'project' : 'user', cwd: process.cwd(), force: !!opts.force });
    if (!done.ok) { console.error(c.red(done.error)); process.exitCode = 1; return; }
    console.log(c.green(`Installed ${done.name}`) + c.muted(`  ${done.dest}`));
  });

pluginCmd
  .command('update [name]')
  .description('Re-fetch a plugin (or all of them) from where it was installed.')
  .option('-y, --yes', 'do not ask before updating')
  .action(async (name, opts) => {
    const plugins = require('../lib/plugins');
    const names = name ? [name] : plugins.listPlugins(process.cwd()).filter((p) => p.source).map((p) => p.name);
    if (!names.length) { console.log('Nothing to update.'); return; }
    for (const n of names) {
      const prepared = await plugins.prepareUpdate(n, process.cwd());
      if (!prepared.ok) { console.error(c.red(`${n}: ${prepared.error}`)); process.exitCode = 1; continue; }
      const oldMcp = new Set(prepared.before.mcpServers.map((m) => `${m.name}|${m.runs}|${m.url}`));
      const added = prepared.summary.mcpServers.filter((m) => !oldMcp.has(`${m.name}|${m.runs}|${m.url}`));
      if (added.length && !opts.yes) {
        console.log(c.yellow(`${n} now starts new or changed MCP servers:`));
        for (const m of added) console.log(`    ${m.name}: ${m.runs || m.url}`);
        if (!(await confirm(c.bold(c.accent(`Update ${n}?`))))) { plugins.discardInstall(prepared); console.log(`Skipped ${n}.`); continue; }
      }
      const done = plugins.finishInstall(prepared, { scope: prepared.scope, cwd: process.cwd(), force: true });
      if (!done.ok) { console.error(c.red(`${n}: ${done.error}`)); process.exitCode = 1; continue; }
      console.log(c.green(`Updated ${n}`) + (done.summary.version ? c.muted(`  ${done.summary.version}`) : ''));
    }
  });

pluginCmd
  .command('remove <name>')
  .description('Uninstall a plugin.')
  .action((name) => {
    const r = require('../lib/plugins').removePlugin(name, process.cwd());
    if (!r.ok) { console.error(c.red(r.error)); process.exitCode = 1; return; }
    console.log(c.green(`Removed ${r.name}`));
  });

for (const [verb, on] of [['enable', true], ['disable', false]]) {
  pluginCmd
    .command(`${verb} <name>`)
    .description(`${on ? 'Turn a plugin back on' : 'Turn a plugin off without removing it'}.`)
    .action((name) => {
      const r = require('../lib/plugins').setEnabled(name, on, process.cwd());
      if (!r.ok) { console.error(c.red(r.error)); process.exitCode = 1; return; }
      console.log(c.green(`${on ? 'Enabled' : 'Disabled'} ${r.name}`));
    });
}

pluginCmd
  .command('init <name>')
  .description('Create a new plugin folder to fill in and push to GitHub.')
  .action((name) => {
    const r = require('../lib/plugins').scaffoldPlugin(name, process.cwd());
    if (!r.ok) { console.error(c.red(r.error)); process.exitCode = 1; return; }
    console.log(c.green(`Created ${r.dir}`));
    console.log(c.muted(`Try it locally: codeply plugin install ${r.dir}\nShare it: push the folder to GitHub, then others run: codeply plugin install <you>/${r.name}`));
  });

const githubCmd = program
  .command('github')
  .description('The GitHub agent: comment /codeply on an issue or pull request and Craft does the work in your own Actions runner.');

githubCmd
  .command('install')
  .description('Add the workflow file that lets /codeply comments start a run.')
  .action(async () => {
    const { installWorkflow } = await import('../lib/github-agent.mjs');
    const r = installWorkflow(process.cwd());
    if (!r.ok) { console.error(c.red(r.error)); process.exitCode = 1; return; }
    console.log(c.green(`Created ${r.file}`));
    console.log([
      '',
      'Finish in your repository settings:',
      '  1. Settings > Secrets and variables > Actions > New repository secret: CODEPLY_API_KEY (your own model key).',
      '  2. Optional variables: CODEPLY_PROVIDER (openai, anthropic, gemini, openrouter, groq, deepseek), CODEPLY_MODEL, CODEPLY_BASE_URL.',
      '  3. Settings > Actions > General > Workflow permissions: "Read and write" and allow Actions to create pull requests.',
      '  4. Commit the workflow, then comment "/codeply <what you want>" on an issue or pull request.',
      '',
      'Only the owner, members and collaborators can start a run. "/codeply ask ..." and "/codeply plan ..." never change files.',
    ].join('\n'));
  });

githubCmd
  .command('run')
  .description('Handle the current GitHub Actions event (used by the workflow).')
  .option('--max-steps <n>', 'step budget for the agent', '40')
  .action(async (opts) => {
    const g = await import('../lib/github-agent.mjs');
    const cfg = { ...process.env };
    const token = cfg.GITHUB_TOKEN || cfg.GH_TOKEN;
    // The agent runs commands and MCP servers; it must never see these.
    for (const k of ['GITHUB_TOKEN', 'GH_TOKEN', 'CODEPLY_API_KEY', 'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN']) delete process.env[k];
    if (!cfg.GITHUB_EVENT_NAME || !cfg.GITHUB_EVENT_PATH) { console.error(c.red('This runs inside GitHub Actions (GITHUB_EVENT_NAME and GITHUB_EVENT_PATH are not set).')); process.exitCode = 1; return; }
    let event;
    try { event = JSON.parse(fs.readFileSync(cfg.GITHUB_EVENT_PATH, 'utf8')); } catch (e) { console.error(c.red(`Could not read the event: ${e.message}`)); process.exitCode = 1; return; }
    const r = g.routeFromEnv(cfg);
    // A setup error is still reported on the issue, so the person who asked isn't left waiting.
    const out = await g.runGithubAgent({
      eventName: cfg.GITHUB_EVENT_NAME, event, token, route: r.route, setupError: r.error, env: cfg, cwd: process.cwd(),
      maxSteps: Math.max(1, Number(opts.maxSteps) || 40), log: (m) => console.log(m),
    });
    console.log(`${out.status}${out.url ? ` ${out.url}` : ''}`);
    if (out.status === 'failed') { console.error(c.red(out.message || 'Failed.')); process.exitCode = 1; }
  });

// ─── Craft Cloud ───────────────────────────────────────────────────────────

/** GITHUB_TOKEN, then the GitHub CLI's login, then Craft's own GitHub connection. */
function cloudToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  try {
    const t = require('child_process').execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
    if (t) return t;
  } catch {}
  const gh = config.getIntegration ? config.getIntegration('github') : {};
  if (gh && gh.accessToken) return gh.accessToken;
  throw new Error('No GitHub login. Connect GitHub in Craft, run "gh auth login", or set GITHUB_TOKEN.');
}

function cloudModel(id) {
  const m = id ? config.getModel(id) || config.getModels().find((x) => x.name === id || x.model === id) : config.getSelectedModel();
  if (!m) throw new Error(id ? `No model "${id}". Models: ${config.getModels().map((x) => x.name).join(', ') || 'none yet'}.` : 'Cloud runs use one of your own models. Pick one with "codeply model", or pass --model.');
  return m;
}

const cloudCmd = program
  .command('cloud')
  .description('Craft Cloud: run the agent on GitHub\'s machines (your account, your key) while this PC is off.');

cloudCmd
  .command('setup')
  .description('Create the private mirror repo for this folder, push a snapshot and store your model key as an encrypted secret.')
  .option('--model <id>', 'model to use (default: the selected one)')
  .action(async (opts) => {
    try {
      const cl = await import('../lib/cloud.mjs');
      const r = await cl.setupCloud({ cwd: process.cwd(), token: cloudToken(), model: cloudModel(opts.model) });
      console.log(c.green(`${r.created ? 'Created' : 'Using'} ${r.url} (private).`));
      for (const s of r.skipped) console.log(c.yellow(`  left out ${s.path}: ${s.reason}`));
      console.log('Start a run with: codeply cloud run "<what to do>"');
    } catch (e) { console.error(c.red(e.message)); process.exitCode = 1; }
  });

cloudCmd
  .command('run <prompt...>')
  .description('Push the latest snapshot and start a cloud run.')
  .option('--mode <mode>', 'Build, Plan or Ask', 'Build')
  .option('--session <id>', 'continue this cloud chat')
  .option('--model <id>', 'model to use (default: the selected one)')
  .option('--wait', 'wait for the run and print the answer')
  .action(async (words, opts) => {
    try {
      const cl = await import('../lib/cloud.mjs');
      const token = cloudToken();
      const cwd = process.cwd();
      const task = await cl.startCloudRun({ cwd, token, prompt: words.join(' '), mode: opts.mode, sessionId: opts.session || '', model: cloudModel(opts.model) });
      console.log(`Started cloud task ${task.id} on ${task.repo}.`);
      if (!opts.wait) { console.log(`Check it with: codeply cloud status ${task.id}`); return; }
      let t = task; let shown = '';
      while (!['done', 'failed', 'cancelled'].includes(t.status)) {
        await new Promise((r) => setTimeout(r, 5000));
        t = await cl.cloudRunStatus({ cwd, taskId: task.id, token });
        const line = `${t.status}${t.progress ? `: ${t.progress.split('\n')[0]}` : ''}`;
        if (line !== shown) { console.log(c.dim(line)); shown = line; }
      }
      printCloudTask(t);
    } catch (e) { console.error(c.red(e.message)); process.exitCode = 1; }
  });

function printCloudTask(t) {
  console.log(`${t.id}  ${t.status}  ${t.mode}  ${t.prompt.split('\n')[0].slice(0, 60)}`);
  if (t.runUrl) console.log(c.dim(`  ${t.runUrl}`));
  if (t.error) console.log(c.red(`  ${t.error}`));
  if (t.result && t.result.answer) console.log(`\n${t.result.answer}\n`);
  if (t.result && t.result.files && t.result.files.length) console.log(`Changed: ${t.result.files.join(', ')}\nApply with: codeply cloud pull ${t.id}`);
}

cloudCmd
  .command('status [task]')
  .description('Show one cloud task, or the recent ones for this folder.')
  .action(async (taskId) => {
    try {
      const cl = await import('../lib/cloud.mjs');
      const cwd = process.cwd();
      const p = cl.getProject(cwd);
      if (!p || !p.repo) { console.log('Cloud is not set up here. Run: codeply cloud setup'); return; }
      if (taskId) { printCloudTask(await cl.cloudRunStatus({ cwd, taskId, token: cloudToken() })); return; }
      console.log(`Mirror: ${p.repo}${p.lastPush ? `, last snapshot ${new Date(p.lastPush.at).toLocaleString()}` : ''}`);
      for (const t of (p.tasks || []).slice(0, 10)) console.log(`${t.id}  ${t.status}  ${t.mode}  ${t.prompt.split('\n')[0].slice(0, 60)}`);
    } catch (e) { console.error(c.red(e.message)); process.exitCode = 1; }
  });

cloudCmd
  .command('pull <task>')
  .description('Apply a finished cloud run\'s changes to this folder (3-way merge).')
  .action(async (taskId) => {
    try {
      const cl = await import('../lib/cloud.mjs');
      const cwd = process.cwd();
      const token = cloudToken();
      await cl.cloudRunStatus({ cwd, taskId, token });
      const r = await cl.pullCloudRun({ cwd, taskId, token });
      if (!r.applied) { console.log(r.message); return; }
      console.log(c.green(`Applied ${r.files.length} file${r.files.length === 1 ? '' : 's'}: ${r.files.join(', ')}`));
      if (r.conflicts.length) console.log(c.yellow(`Conflicts to resolve (look for <<<<<<< markers): ${r.conflicts.join(', ')}`));
    } catch (e) { console.error(c.red(e.message)); process.exitCode = 1; }
  });

cloudCmd
  .command('push')
  .description('Back up this folder to its mirror now.')
  .action(async () => {
    try {
      const cl = await import('../lib/cloud.mjs');
      const r = await cl.pushSnapshot({ cwd: process.cwd(), token: cloudToken() });
      console.log(r.pushed ? c.green(`Pushed snapshot ${r.sha.slice(0, 7)}.`) : 'Already up to date.');
      for (const s of r.skipped) console.log(c.yellow(`  left out ${s.path}: ${s.reason}`));
    } catch (e) { console.error(c.red(e.message)); process.exitCode = 1; }
  });

cloudCmd
  .command('runner')
  .description('Run one cloud task (used by the craft-cloud workflow inside GitHub Actions).')
  .option('--max-steps <n>', 'step budget for the agent', '80')
  .action(async (opts) => {
    const cl = await import('../lib/cloud.mjs');
    const s = cl.runnerSetup(process.env);
    const out = await cl.runCloudRunner({ env: s.cfg, token: s.token, route: s.route, setupError: s.setupError, cwd: process.cwd(), maxSteps: Math.max(1, Number(opts.maxSteps) || 80), log: (m) => console.log(m) });
    console.log(`${out.status}${out.result && out.result.branch ? ` ${out.result.branch}` : ''}`);
    if (out.status === 'failed') { console.error(c.red((out.result && out.result.error) || 'Failed.')); process.exitCode = 1; }
  });

program
  .command('serve')
  .description('Run the engine as a local HTTP API with a live event stream, for the desktop app, phone, editors and scripts.')
  .option('-p, --port <port>', 'port to listen on (0 picks a free one)', '4096')
  .option('--host <host>', 'address to bind; anything but 127.0.0.1 exposes the engine to the network', '127.0.0.1')
  .option('--password <password>', 'password clients must send (default: CODEPLY_SERVER_PASSWORD, else a random one is printed)')
  .option('--cwd <dir>', 'default project folder for new chats', process.cwd())
  .option('--data-dir <dir>', 'where chats are stored (default ~/.codeply/server)')
  .option('--cors <origin...>', 'browser origins allowed to call the API')
  .action(async (opts) => {
    const { startServer } = await import('../lib/server.mjs');
    const password = opts.password || process.env.CODEPLY_SERVER_PASSWORD || undefined;
    let srv;
    try {
      srv = await startServer({ port: Number(opts.port), host: opts.host, password, cwd: opts.cwd, dataDir: opts.dataDir, allowedOrigins: opts.cors });
    } catch (e) {
      console.error(c.red(`Could not start the server: ${e.message}`));
      process.exitCode = 1;
      return;
    }
    console.log(c.green(`✓ Codeply engine listening on ${srv.url}`));
    console.log(`  Password  ${srv.password}${password ? '' : c.muted('  (generated for this run)')}`);
    console.log(c.muted(`  Chats     ${srv.storage === 'json' ? 'JSON file (this Node has no SQLite)' : `SQLite (${srv.storage})`}`));
    console.log(c.muted(`  Try       curl -H "Authorization: Bearer ${srv.password}" ${srv.url}/doc`));
    if (!['127.0.0.1', 'localhost', '::1'].includes(opts.host)) {
      console.log(c.yellow('  Bound beyond this machine over plain HTTP. Put it behind a tunnel or TLS proxy before exposing it.'));
    }
    const stop = async () => { await srv.close(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });

// If no arguments provided, launch TUI
if (process.argv.length <= 2) {
  runTUI();
} else {
  program.parseAsync(process.argv);
}
