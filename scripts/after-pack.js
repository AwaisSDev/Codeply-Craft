// electron-builder afterPack hook.
//
// codeply-cli/node_modules is a separate package's dependencies (ws,
// @supabase/supabase-js, commander, ...) unrelated to this app's own
// dependency tree. Both `files` (with asarUnpack) and `extraResources`
// route through the SAME file-matcher electron-builder uses to prune
// node_modules against ITS OWN package.json — so either way, this nested
// node_modules quietly came out empty in the packaged app, with no warning.
// A raw fs.cpSync here is the standard workaround: it runs after packaging,
// completely outside electron-builder's file-matching, so nothing prunes it.
const fs = require('fs');
const path = require('path');

module.exports = async function afterPack(context) {
  const resourcesDir = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');

  const src = path.join(context.packager.projectDir, 'codeply-cli', 'node_modules');
  const dest = path.join(resourcesDir, 'codeply-cli', 'node_modules');

  if (!fs.existsSync(src)) {
    throw new Error(`codeply-cli/node_modules not found at ${src} — run "npm install" inside codeply-cli first.`);
  }
  fs.cpSync(src, dest, { recursive: true });
  console.log(`[after-pack] copied codeply-cli/node_modules -> ${dest}`);
};
