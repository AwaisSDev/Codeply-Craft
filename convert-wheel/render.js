// The converter's hidden page: draws PDF pages with pdf.js (vendor/pdfjs) and
// lays out DOCX files with docx-preview (vendor/docx) for printing to PDF.
// Jobs run one at a time.

let pdfjs = null;
async function lib() {
  if (!pdfjs) {
    pdfjs = await import('../vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', location.href).href;
  }
  return pdfjs;
}

const MAX_SIDE = 6000;  // a picture's longest side, in pixels

async function pdfJob({ id, data, all, scale }) {
  const doc = await (await lib()).getDocument({ data, isEvalSupported: false }).promise;
  try {
    const total = all ? doc.numPages : 1;
    for (let i = 0; i < total; i++) {
      const page = await doc.getPage(i + 1);
      let vp = page.getViewport({ scale });
      const fit = Math.min(1, MAX_SIDE / Math.max(vp.width, vp.height));
      if (fit < 1) vp = page.getViewport({ scale: scale * fit });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      const png = new Uint8Array(await blob.arrayBuffer());
      window.render.reply({ id, page: { png, index: i, total } });
      page.cleanup();
      canvas.width = canvas.height = 0;
    }
  } finally { doc.destroy(); }
}

// Lays the document out as pages; main.js prints this page to PDF afterwards.
async function docxJob({ data }) {
  const box = document.getElementById('doc');
  box.innerHTML = '';
  await window.docx.renderAsync(data, box, null, {
    inWrapper: true, ignoreWidth: false, ignoreHeight: false, breakPages: true,
    experimental: true, useBase64URL: true, renderHeaders: true, renderFooters: true, renderFootnotes: true,
  });
  // The first page's size becomes the printed page size.
  const first = box.querySelector('section.docx');
  const r = first ? first.getBoundingClientRect() : null;
  const width = r && r.width ? r.width : 816;
  const height = r && r.height ? r.height : 1056;
  document.getElementById('pageStyle').textContent = `@page { size: ${width}px ${height}px; margin: 0; }`;
  await document.fonts.ready;
  await Promise.all([...box.querySelectorAll('img')].map((img) => (img.complete ? null : new Promise((ok) => { img.onload = img.onerror = ok; }))));
  return { width, height };
}

let queue = Promise.resolve();
window.render.onJob((job) => {
  queue = queue.then(async () => {
    try {
      const result = job.type === 'pdf' ? await pdfJob(job) : await docxJob(job);
      window.render.reply({ id: job.id, done: true, result: result || null });
    } catch (e) {
      const msg = String((e && e.message) || e);
      window.render.reply({ id: job.id, error: /password/i.test(msg) ? 'this PDF has a password' : /Invalid PDF|corrupt/i.test(msg) ? "this PDF couldn't be read" : msg });
    }
  });
});
