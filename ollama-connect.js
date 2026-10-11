// Connect Ollama: a full page (model menu → Connect Ollama) that walks people
// through ollama.com's own flow with drawn illustrations of each step.
//
//   Online           1. open ollama.com/dashboard (its "Get API key")
//                    2. name the key "Codeply" and Create API key
//                    3. paste it here; it's checked, then pick models
//   On this computer the Ollama app: models it has installed, and its own
//                    ollama.com sign-in for cloud models with no key
//
// Everything goes through main.js (ollamaCloud:*, models:*); the key is sent
// to main once to be checked and saved with the model, never kept here.
(function () {
  const api = window.craft;
  if (!api) return;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const LOCAL_HOST = 'http://localhost:11434';
  // Ollama's free accounts can run these families (checked against ollama.com,
  // 2026-10-11: the rest answer 402 "not included in your free usage").
  const FREE_FAMILIES = /^(gpt-oss|gemma4|nemotron-3-(nano|super|ultra))(:|$)/;
  const isFreeModel = (name) => FREE_FAMILIES.test(String(name || ''));
  // the Ollama app calls a cloud model "<name>-cloud" when it has a size tag, else "<name>:cloud"
  const localCloudName = (n) => (n.includes(':') ? `${n}-cloud` : `${n}:cloud`);

  // ─── Illustrations (drawn, theme aware: colors come from CSS) ──────────────
  const cursor = (x, y) => `<g class="ocx-cursor" transform="translate(${x} ${y})"><path d="M0 0l0 15 4-3.6 2.6 6 2.4-1-2.6-6 5.4-.2z"/></g>`;
  const browser = (url, inner) => `
    <svg class="ocx-art" viewBox="0 0 340 210" role="img" aria-hidden="true">
      <rect class="ocx-win" x="6" y="6" width="328" height="198" rx="12"/>
      <path class="ocx-bar" d="M6 18a12 12 0 0 1 12-12h304a12 12 0 0 1 12 12v12H6z"/>
      <circle class="ocx-dot" cx="20" cy="18" r="3"/><circle class="ocx-dot" cx="30" cy="18" r="3"/><circle class="ocx-dot" cx="40" cy="18" r="3"/>
      <rect class="ocx-url" x="110" y="11" width="120" height="14" rx="7"/><text class="ocx-url-t" x="170" y="21" text-anchor="middle">${url}</text>
      ${inner}
    </svg>`;
  const ART = {
    dashboard: browser('ollama.com/dashboard', `
      <rect class="ocx-line strong" x="20" y="48" width="44" height="6" rx="3"/>
      <rect class="ocx-line" x="20" y="64" width="30" height="5" rx="2.5"/>
      <rect class="ocx-line" x="20" y="77" width="24" height="5" rx="2.5"/>
      <rect class="ocx-line" x="20" y="90" width="32" height="5" rx="2.5"/>
      <rect class="ocx-line" x="20" y="103" width="28" height="5" rx="2.5"/>
      <rect class="ocx-line strong" x="96" y="46" width="110" height="8" rx="4"/>
      <rect class="ocx-pill-o" x="206" y="40" width="54" height="20" rx="10"/><rect class="ocx-line" x="216" y="48" width="34" height="4" rx="2"/>
      <g class="ocx-hot"><rect class="ocx-ring" x="263" y="37" width="66" height="26" rx="13"/><rect class="ocx-pill" x="266" y="40" width="60" height="20" rx="10"/><text class="ocx-pill-t" x="296" y="53.5" text-anchor="middle">Get API key</text></g>
      <rect class="ocx-card" x="96" y="72" width="232" height="54" rx="10"/>
      <rect class="ocx-line" x="108" y="84" width="60" height="5" rx="2.5"/><rect class="ocx-line strong" x="108" y="98" width="26" height="10" rx="3"/>
      <rect class="ocx-line" x="226" y="84" width="50" height="5" rx="2.5"/><rect class="ocx-line strong" x="226" y="98" width="40" height="10" rx="3"/>
      <rect class="ocx-line strong" x="96" y="140" width="56" height="7" rx="3.5"/>
      <rect class="ocx-card" x="96" y="156" width="72" height="34" rx="8"/><rect class="ocx-card" x="176" y="156" width="72" height="34" rx="8"/><rect class="ocx-card" x="256" y="156" width="72" height="34" rx="8"/>
      ${cursor(306, 56)}`),
    create: browser('ollama.com/dashboard', `
      <rect class="ocx-shade" x="6" y="30" width="328" height="174"/>
      <rect class="ocx-modal" x="50" y="44" width="240" height="146" rx="12"/>
      <text class="ocx-h" x="64" y="66">Use open models in my app</text>
      <text class="ocx-s" x="64" y="84">1. Get an API key</text>
      <rect class="ocx-input" x="64" y="94" width="128" height="24" rx="7"/><text class="ocx-typed" x="74" y="110">Codeply</text><rect class="ocx-caret" x="114" y="100" width="1.4" height="12"/>
      <g class="ocx-hot"><rect class="ocx-ring" x="196" y="91" width="88" height="30" rx="15"/><rect class="ocx-pill" x="199" y="94" width="82" height="24" rx="12"/><text class="ocx-pill-t" x="240" y="109.5" text-anchor="middle">Create API key</text></g>
      <text class="ocx-s" x="64" y="138">2. Paste this prompt into your coding agent</text>
      <rect class="ocx-input" x="64" y="146" width="212" height="22" rx="7"/>
      ${cursor(256, 114)}`),
    paste: `
    <svg class="ocx-art" viewBox="0 0 340 210" role="img" aria-hidden="true">
      <rect class="ocx-win" x="18" y="20" width="200" height="88" rx="12"/>
      <text class="ocx-s" x="34" y="44">Your new key</text>
      <rect class="ocx-input" x="34" y="54" width="140" height="26" rx="7"/><text class="ocx-dots" x="44" y="72">••••••••••••••••</text>
      <g class="ocx-hot"><rect class="ocx-ring" x="176" y="51" width="32" height="32" rx="9"/><rect class="ocx-copy" x="179" y="54" width="26" height="26" rx="7"/>
        <rect class="ocx-copy-i" x="187" y="61" width="9" height="11" rx="2"/><rect class="ocx-copy-i" x="190" y="64" width="9" height="11" rx="2"/></g>
      <path class="ocx-arrow" d="M206 86c34 6 56 20 64 40"/><path class="ocx-arrow-h" d="M263 121l7 7 6-8"/>
      <rect class="ocx-win" x="122" y="132" width="200" height="66" rx="12"/>
      <circle class="ocx-brand" cx="140" cy="150" r="6"/><text class="ocx-s" x="152" y="154">Codeply</text>
      <rect class="ocx-input on" x="136" y="164" width="120" height="22" rx="7"/><text class="ocx-dots" x="144" y="179">••••••••••</text>
      <rect class="ocx-pill" x="262" y="164" width="48" height="22" rx="7"/><text class="ocx-pill-t" x="286" y="178.5" text-anchor="middle">Connect</text>
    </svg>`,
    local: `
    <svg class="ocx-art" viewBox="0 0 340 210" role="img" aria-hidden="true">
      <rect class="ocx-win" x="60" y="24" width="220" height="140" rx="10"/>
      <rect class="ocx-term" x="70" y="34" width="200" height="120" rx="6"/>
      <text class="ocx-code" x="82" y="56">$ ollama list</text>
      <text class="ocx-code dim" x="82" y="76">qwen2.5-coder:7b</text>
      <text class="ocx-code dim" x="82" y="94">llama3.2:3b</text>
      <text class="ocx-code dim" x="82" y="112">gpt-oss:120b-cloud</text>
      <text class="ocx-code" x="82" y="136">$ ollama signin</text><rect class="ocx-caret" x="170" y="127" width="7" height="12"/>
      <path class="ocx-base" d="M40 168h260l-14 16H54z"/>
    </svg>`,
  };

  // ─── The page ──────────────────────────────────────────────────────────────
  let root = null; let tab = 'online'; let step = 1; let key = ''; let busy = false;
  let connected = null; // { via: 'key' } or { via: 'app' }
  let poll = null;

  function close() {
    if (!root) return;
    clearInterval(poll);
    root.classList.remove('open');
    const r = root; root = null;
    setTimeout(() => r.remove(), 180);
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  const $ = (sel) => root && root.querySelector(sel);

  const STEPS = [
    { n: 1, title: 'Open ollama.com', text: 'Sign in (it\'s free), then click <b>Get API key</b> at the top right.', art: 'dashboard' },
    { n: 2, title: 'Create a key', text: 'Name it <b>Codeply</b> and click <b>Create API key</b>.', art: 'create' },
    { n: 3, title: 'Paste it here', text: 'Copy the key, paste it below and click <b>Connect</b>. It stays on this computer.', art: 'paste' },
  ];

  function onlineHtml() {
    if (connected) return modelsShell();
    return `
      <div class="ocx-steps">
        <ol class="ocx-list">${STEPS.map((s) => `
          <li class="ocx-step${step === s.n ? ' on' : ''}${step > s.n ? ' done' : ''}" data-step="${s.n}">
            <span class="ocx-num">${step > s.n ? '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>' : s.n}</span>
            <span class="ocx-step-text"><strong>${s.title}</strong><span>${s.text}</span></span>
          </li>`).join('')}
        </ol>
        <div class="ocx-stage" id="ocxStage">${ART[STEPS[step - 1].art]}</div>
      </div>
      <div class="ocx-actions">
        ${step === 1 ? '<button class="ocx-btn primary" data-act="open-site">Open ollama.com</button><button class="ocx-btn ghost" data-act="next">I have a key</button>' : ''}
        ${step === 2 ? '<button class="ocx-btn ghost" data-act="open-site">Open ollama.com again</button><button class="ocx-btn primary" data-act="next">I copied it</button>' : ''}
        ${step === 3 ? `<div class="ocx-key">
            <input id="ocxKey" type="password" placeholder="Paste your ollama.com key" autocomplete="off" spellcheck="false" value="${esc(key)}">
            <button class="ocx-btn primary" data-act="connect"${busy ? ' disabled' : ''}>${busy ? '<span class="ocx-spin"></span>Checking…' : 'Connect'}</button>
          </div>` : ''}
      </div>
      <div class="ocx-msg" id="ocxMsg"></div>`;
  }

  function localHtml() {
    if (connected && connected.via === 'app') return modelsShell();
    return `
      <div class="ocx-steps">
        <div class="ocx-local-text">
          <h3>Ollama on this computer</h3>
          <p>Models you've installed run right here: free, private, no internet needed. Signed in to ollama.com, the app also runs its cloud models with no key.</p>
          <div class="ocx-local-status" id="ocxLocal"><span class="ocx-spin"></span>Looking for Ollama…</div>
        </div>
        <div class="ocx-stage">${ART.local}</div>
      </div>
      <div class="ocx-local-models" id="ocxLocalModels"></div>`;
  }

  function modelsShell() {
    return `<div class="ocx-done"><span class="ocx-badge"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>Connected${connected.via === 'app' ? ' through the Ollama app' : ' with your key'}</span>
      <p>Pick a model to add. It shows up in your model menu right away.</p></div>
      <div class="ocx-grid" id="ocxGrid"><div class="ocx-loading"><span class="ocx-spin"></span>Loading Ollama's models…</div></div>`;
  }

  function render() {
    if (!root) return;
    $('.ocx-tabs').innerHTML = ['online', 'local'].map((t) => `<button class="${tab === t ? 'on' : ''}" data-tab="${t}">${t === 'online' ? 'Online' : 'On this computer'}</button>`).join('');
    $('.ocx-body').innerHTML = tab === 'online' ? onlineHtml() : localHtml();
    $('.ocx-tabs').querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab; render(); }));
    root.querySelectorAll('[data-step]').forEach((li) => li.addEventListener('click', () => { if (!busy) { step = Number(li.dataset.step); render(); } }));
    const act = (name, fn) => root.querySelectorAll(`[data-act="${name}"]`).forEach((b) => b.addEventListener('click', fn));
    act('open-site', () => { api.ollamaCloudOpenKeys(); if (step === 1) { step = 2; render(); } });
    act('next', () => { step = Math.min(3, step + 1); render(); if (step === 3) setTimeout(() => $('#ocxKey') && $('#ocxKey').focus(), 40); });
    act('connect', connectKey);
    const input = $('#ocxKey');
    if (input) {
      input.addEventListener('input', () => { key = input.value; });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') connectKey(); });
    }
    if ($('#ocxGrid')) loadModels();
    if (tab === 'local' && $('#ocxLocal')) checkLocal();
  }

  function msg(text, kind) { const m = $('#ocxMsg'); if (m) { m.className = `ocx-msg ${kind || ''}`; m.textContent = text || ''; } }

  async function connectKey() {
    const input = $('#ocxKey');
    key = (input ? input.value : key).trim();
    if (!key) { msg('Paste your key first.', 'err'); return; }
    busy = true; render();
    const r = await api.ollamaCloudCheckKey(key);
    busy = false;
    if (!r.ok) { render(); msg(r.error, 'err'); return; }
    connected = { via: 'key' };
    render();
  }

  async function loadModels() {
    const grid = $('#ocxGrid');
    const r = await api.ollamaCloudModels();
    if (!root || !grid.isConnected) return;
    if (!r.ok) { grid.innerHTML = `<div class="ocx-loading err">${esc(r.error)}</div>`; return; }
    const viaApp = connected && connected.via === 'app';
    const saved = new Set(((typeof state !== 'undefined' && state.models && state.models.models) || []).map((m) => m.model));
    // free accounts first: those work right away, the rest need Ollama usage credits
    const models = r.models.slice().sort((a, b) => Number(isFreeModel(b.name)) - Number(isFreeModel(a.name)));
    grid.innerHTML = models.map((m) => {
      const id = viaApp ? localCloudName(m.name) : m.name;
      const [fam, tag] = m.name.split(':');
      const free = isFreeModel(m.name);
      return `<button class="ocx-model" data-id="${esc(id)}" data-name="${esc(m.name)}">
        <span class="ocx-model-name">${esc(fam)}</span>
        <span class="ocx-model-tag">${esc(tag || 'latest')}</span>
        <span class="ocx-price ${free ? 'free' : 'paid'}" title="${free ? 'Included in a free Ollama account' : 'Needs Ollama usage credits or a paid plan'}">${free ? 'Free' : 'Paid'}</span>
        <span class="ocx-model-add">${saved.has(id) ? 'Use' : 'Add'}</span>
      </button>`;
    }).join('');
    grid.querySelectorAll('.ocx-model').forEach((b) => b.addEventListener('click', () => addModel(b)));
  }

  /** An already-saved model with this id (and the same kind of address): pick it instead of adding a copy. */
  async function useExisting(model, local) {
    const list = (typeof state !== 'undefined' && state.models && state.models.models) || [];
    const m = list.find((x) => x.model === model && (local ? x.kind === 'ollama' : /ollama\.com/.test(x.baseUrl || '')));
    if (!m) return false;
    const r = await api.selectModel(m.id);
    if (r && r.ok && typeof applyModelsState === 'function') applyModelsState(r.state);
    close();
    return true;
  }

  async function addModel(btn) {
    if (btn.disabled) return;
    const viaApp = connected && connected.via === 'app';
    const model = btn.dataset.id; const name = btn.dataset.name;
    if (await useExisting(model, viaApp)) return;
    btn.disabled = true;
    btn.querySelector('.ocx-model-add').innerHTML = '<span class="ocx-spin"></span>';
    const r = await api.saveModel(viaApp
      ? { kind: 'ollama', name: `${name} (Ollama)`, baseUrl: LOCAL_HOST, model, apiKey: '' }
      : { kind: 'openai', name: `${name} (Ollama)`, baseUrl: 'https://ollama.com/v1', model, apiKey: key });
    if (!r.ok) {
      btn.disabled = false;
      btn.querySelector('.ocx-model-add').textContent = 'Retry';
      btn.title = r.error || 'Could not add it.';
      btn.classList.add('err');
      return;
    }
    if (typeof applyModelsState === 'function') applyModelsState(r.state);
    close();
  }

  async function checkLocal() {
    const box = $('#ocxLocal');
    const list = $('#ocxLocalModels');
    const [cloud, installed] = await Promise.all([api.ollamaCloudLocal(), api.detectOllama(LOCAL_HOST)]);
    if (!root || !box.isConnected) return;
    if (!cloud.running) {
      box.innerHTML = '<span class="ocx-dotst off"></span>Ollama isn\'t running on this computer.';
      list.innerHTML = '<div class="ocx-actions left"><button class="ocx-btn primary" data-act="download">Download Ollama</button><span class="ocx-hint">Install it, open it, then come back here.</span></div>';
      list.querySelector('[data-act="download"]').addEventListener('click', () => api.ollamaCloudOpenDownload());
      return;
    }
    box.innerHTML = `<span class="ocx-dotst on"></span>Ollama is running${cloud.signedIn ? ' and signed in to ollama.com' : ''}.`;
    const rows = installed && installed.ok ? installed.models : [];
    list.innerHTML = `
      ${cloud.signedIn ? '<div class="ocx-actions left"><button class="ocx-btn primary" data-act="app-cloud">Use its cloud models</button><span class="ocx-hint">No key needed: the app is signed in.</span></div>'
        : `<div class="ocx-actions left"><button class="ocx-btn ghost" data-act="app-signin">Sign the app in to ollama.com</button><span class="ocx-hint">Then its cloud models work with no key.</span></div>`}
      ${rows.length ? `<div class="ocx-sub">Installed on this computer</div><div class="ocx-grid">${rows.map((m) => `
        <button class="ocx-model" data-local="${esc(m.name)}"><span class="ocx-model-name">${esc(m.name.split(':')[0])}</span><span class="ocx-model-tag">${esc(m.name.split(':')[1] || 'latest')}${m.params ? ` · ${esc(m.params)}` : ''}</span><span class="ocx-model-add">Add</span></button>`).join('')}</div>`
        : '<div class="ocx-hint block">No models installed yet. In a terminal, run <code>ollama pull qwen2.5-coder</code>, then come back.</div>'}`;
    const appCloud = list.querySelector('[data-act="app-cloud"]');
    if (appCloud) appCloud.addEventListener('click', () => { connected = { via: 'app' }; render(); });
    const signin = list.querySelector('[data-act="app-signin"]');
    if (signin) signin.addEventListener('click', async () => {
      signin.disabled = true; signin.innerHTML = '<span class="ocx-spin"></span>Waiting for you in the browser…';
      const s = await api.ollamaCloudSignin(cloud.signinUrl || '');
      if (!s.ok) { signin.disabled = false; signin.textContent = 'Try again'; return; }
      const until = Date.now() + 3 * 60_000;
      clearInterval(poll);
      poll = setInterval(async () => {
        if (!root || Date.now() > until) { clearInterval(poll); return; }
        const again = await api.ollamaCloudLocal();
        if (again.signedIn) { clearInterval(poll); connected = { via: 'app' }; render(); }
      }, 4000);
    });
    list.querySelectorAll('[data-local]').forEach((b) => b.addEventListener('click', async () => {
      if (await useExisting(b.dataset.local, true)) return;
      b.disabled = true; b.querySelector('.ocx-model-add').innerHTML = '<span class="ocx-spin"></span>';
      const r = await api.saveModel({ kind: 'ollama', name: `${b.dataset.local} (local)`, baseUrl: LOCAL_HOST, model: b.dataset.local, apiKey: '' });
      if (!r.ok) { b.disabled = false; b.querySelector('.ocx-model-add').textContent = 'Retry'; b.title = r.error || ''; return; }
      if (typeof applyModelsState === 'function') applyModelsState(r.state);
      close();
    }));
  }

  function open(opts = {}) {
    if (root) return;
    tab = opts.tab || 'online'; step = 1; key = ''; busy = false; connected = null;
    root = document.createElement('div');
    root.className = 'ocx-backdrop';
    root.innerHTML = `
      <div class="ocx-page" role="dialog" aria-label="Connect Ollama">
        <button class="ocx-close" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
        <div class="ocx-head">
          <h2>Connect Ollama</h2>
          <p>Big open models like Kimi, GLM, DeepSeek and gpt-oss, on your own Ollama account.</p>
          <div class="ocx-tabs" role="tablist"></div>
        </div>
        <div class="ocx-body"></div>
      </div>`;
    document.body.appendChild(root);
    root.addEventListener('mousedown', (e) => { if (e.target === root) close(); });
    root.querySelector('.ocx-close').addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    render();
    requestAnimationFrame(() => root && root.classList.add('open'));
  }

  window.OllamaConnect = { open, close };
})();
