/**
 * Legacy CJS stub — the interactive TUI lives in tui.mjs (ESM + Ink).
 * Entry point: bin/codeply.js → dynamic import('./lib/tui.mjs')
 */
module.exports = function deprecatedTui() {
  throw new Error('Use lib/tui.mjs via the codeply entrypoint (node bin/codeply.js).');
};
