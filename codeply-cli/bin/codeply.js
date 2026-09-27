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

// If no arguments provided, launch TUI
if (process.argv.length <= 2) {
  runTUI();
} else {
  program.parseAsync(process.argv);
}
