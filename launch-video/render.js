// Renders the composition frame by frame with a virtual clock, so every frame is exact at 60 fps.
//   node render.js video  --from 0 --to 60 --out out/part.mp4     frames piped into ffmpeg
//   node render.js shots  --times 1,2.5,12 --out shots/          stills at given times
//   node render.js sheet  --from 10 --to 14 --every 4 --out x.jpg  a contact sheet of every Nth frame
//   node render.js cues   --out cues.json                         the sound cue list
// Frames before --from are still stepped (without screenshots) so the film's state is the same.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path');

const args = process.argv.slice(2), mode = args[0];
const opt = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const FPS = +opt('fps', 60), URL = opt('url', 'http://localhost:8830/comp/index.html');
const from = +opt('from', 0), to = +opt('to', 60), out = opt('out', 'out/film.mp4');
const scale = +opt('scale', 1);

(async () => {
  const browser = await chromium.launch({ args: ['--font-render-hinting=none', '--disable-lcd-text', '--force-color-profile=srgb'] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: scale });
  page.on('pageerror', (e) => console.error('PAGE ERROR', e.message));
  page.on('response', (r) => { if (r.status() >= 400) console.error('HTTP', r.status(), r.url()); });
  page.on('console', (m) => { if (m.type() === 'error') console.error('console:', m.text().slice(0, 200)); });
  await page.clock.install({ time: new Date('2026-11-10T09:41:00Z') });
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => window.__ready === true);
  // let every image decode, then freeze the clock
  await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))));
  await page.clock.pauseAt(new Date('2026-11-10T09:42:00Z'));

  if (mode === 'cues') {
    fs.writeFileSync(out, JSON.stringify(await page.evaluate(() => window.__cues()), null, 0));
    console.log('cues ->', out); await browser.close(); return;
  }

  const N = Math.round(to * FPS);
  let acc = 0; // fractional ms carried so the clock stays exactly on 1/60 s
  async function step(i) {
    if (i > 0) { acc += 1000 / FPS; const ms = Math.floor(acc); acc -= ms; await page.clock.runFor(ms); }
    await page.evaluate((t) => window.__frame(t), i / FPS);
  }
  const t0 = Date.now();
  if (mode === 'video') {
    const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-',
      '-c:v', 'libx264', '-preset', opt('preset', 'medium'), '-crf', opt('crf', '14'), '-pix_fmt', 'yuv420p', '-r', String(FPS), '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
    const startI = Math.round(from * FPS);
    for (let i = 0; i < N; i++) {
      await step(i);
      if (i < startI) continue;
      const buf = await page.screenshot({ type: 'png' });
      if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
      if (i % 120 === 0) console.log(`frame ${i}/${N}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
    ff.stdin.end(); await new Promise((r) => ff.on('close', r));
  } else if (mode === 'shots') {
    const times = opt('times', '').split(',').map(Number).sort((a, b) => a - b);
    fs.mkdirSync(out, { recursive: true });
    const want = new Map(times.map((x) => [Math.round(x * FPS), x]));
    const last = Math.max(...want.keys());
    for (let i = 0; i <= last; i++) {
      await step(i);
      if (want.has(i)) await page.screenshot({ path: path.join(out, 't' + want.get(i).toFixed(2).padStart(6, '0') + '.png') });
    }
  } else if (mode === 'sheet') {
    const every = +opt('every', 6), cols = +opt('cols', 8), w = +opt('w', 400);
    const dir = fs.mkdtempSync('/tmp/claude-0/sheet-');
    const startI = Math.round(from * FPS); let k = 0;
    for (let i = 0; i < N; i++) {
      await step(i);
      if (i < startI || (i - startI) % every) continue;
      await page.screenshot({ path: path.join(dir, String(k++).padStart(5, '0') + '.jpg'), type: 'jpeg', quality: 80 });
    }
    const F = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
    const rows = Math.ceil(k / cols);
    await new Promise((r) => spawn('ffmpeg', ['-v', 'error', '-y', '-framerate', '1', '-i', path.join(dir, '%05d.jpg'),
      '-vf', `scale=${w}:-1,drawtext=fontfile=${F}:text='%{eif\\:${from}*100+n*${every}*100/${FPS}\\:d}':x=4:y=4:fontsize=15:fontcolor=red:box=1:boxcolor=white,tile=${cols}x${rows}`,
      '-frames:v', '1', out], { stdio: 'inherit' }).on('close', r));
    fs.rmSync(dir, { recursive: true });
  }
  console.log(`done ${mode} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
