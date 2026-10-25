// Preload for the new Craft's view (dsh-engine.js). The page is the engine's
// own web UI, so it gets only what the Codeply plugins in it need from Craft:
// who is signed in, and Craft's own browser. Nothing else crosses over.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codeplyHost', {
  /** The signed-in Codeply account: { signedIn, email, name, avatarUrl }. */
  account: () => ipcRenderer.invoke('dsh:host:account'),
  /** Open Craft's browser on the right, with a page when given one. */
  openBrowser: (url) => ipcRenderer.invoke('dsh:host:openBrowser', typeof url === 'string' ? url : ''),
  /** Show or hide Craft's browser. */
  toggleBrowser: () => ipcRenderer.invoke('dsh:host:toggleBrowser'),
  /** Your own models, the same list as Classic's (keys never come back, only a masked preview). */
  models: {
    list: () => ipcRenderer.invoke('dsh:host:models', 'list'),
    save: (input) => ipcRenderer.invoke('dsh:host:models', 'save', input),
    remove: (id) => ipcRenderer.invoke('dsh:host:models', 'remove', String(id || '')),
    detectOllama: (host) => ipcRenderer.invoke('dsh:host:models', 'detectOllama', typeof host === 'string' ? host : ''),
  },
});

// A browser point-at pick from Craft's window lands in the composer, like it
// does in Classic: the text at the caret, the picked element's picture as a
// pasted image. The composer is the page's editable field, so this goes
// through the same insert and paste paths typing and pasting use.
function composerField() {
  const fields = [...document.querySelectorAll('[contenteditable="true"]')].filter((el) => el.offsetParent !== null);
  return fields[fields.length - 1] || null;
}

async function pasteImage(field, dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  const file = new File([blob], 'picked-element.png', { type: blob.type || 'image/png' });
  const data = new DataTransfer();
  data.items.add(file);
  field.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
}

ipcRenderer.on('dsh:host:insert', async (e, payload) => {
  const field = composerField();
  if (!field) return;
  field.focus();
  const sel = window.getSelection();
  if (sel && !field.contains(sel.anchorNode)) {
    const range = document.createRange();
    range.selectNodeContents(field);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  if (payload && payload.image) { try { await pasteImage(field, payload.image); } catch {} }
  if (payload && payload.text) document.execCommand('insertText', false, payload.text);
});
