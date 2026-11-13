// Screenshots every view of the HTML prototype at 1440 x 900 into screenshots/prototype/.
// Run `node design/serve.js 5197` from the repo root first, then: node tools/prototype-shots.js screenshots/prototype
// Apps is captured by visiting Office first: the prototype only defines the Docs agent there.
const { chromium } = require('playwright');
(async () => {
  const out = process.argv[2];
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const base = 'http://localhost:5197/workspace/';
  const shot = async (name) => { await p.waitForTimeout(900); await p.screenshot({ path: `${out}/${name}.png` }); };
  const go = async (v) => { await p.evaluate((v) => localStorage.setItem('cw-view', v), v); await p.goto(base); };
  await p.goto(base);
  for (const v of ['office', 'board', 'chat', 'code', 'prs']) { await go(v); await shot(v); }
  await go('chat'); await p.click('[data-chat="Casual chat"]'); await shot('chat-thread');
  await go('office'); await p.waitForTimeout(300); await p.click('.agent[data-agent="frontend"]', { force: true }); await shot('office-drawer');
  await go('office'); await p.waitForTimeout(300); await p.click('.rail .tab[data-view="apps"]'); await p.waitForTimeout(1600); await shot('apps');
  await b.close();
})();
