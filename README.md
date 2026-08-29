# Codeply Craft

The Codeply AI coding agent as a real desktop app. Same engine, auth, providers,
and daily caps as the Codeply CLI — this app loads the agent loop directly from
the sibling `codeply-cli` folder (override with `CODEPLY_CLI_PATH`).

## Run

```
npm install
npm start
```

## What it does

- **Real agent runs** — the CLI's `runAgent()` loop (read/write/edit/search/run/
  skills/fetch_image) streams into the chat as it works: tool rows, prose,
  and code blocks live.
- **Approvals** — every write, edit, run, and download shows an approval card
  (Accept / Always allow this tool / Reject) with a red/green diff for edits.
  The **Bypass mode** toggle in the composer skips the prompts for that run.
- **Modes** — Build / Plan / Ask chip (Plan and Ask are read-only, enforced by
  the engine).
- **Model: Auto** — the engine picks via your provider config
  (`~/.codeply/config.json`): the Codeply proxy by default, or Ollama /
  OpenRouter / Groq / Anthropic / OpenAI BYOK. No picker in the UI by design.
- **Sign-in** — email + 6-digit code against the same Supabase project as the
  desktop app and CLI; the session is shared via `~/.codeply/auth.json`.
  BYOK providers skip the login gate.
- **Sessions** — chats persist (userData/craft-store.json) and reload from the
  Recents list. Projects are real folders picked with a native dialog; the
  side panel shows the files each chat actually read and wrote.

- **Phone companion** - click **Use from phone** in Craft, open the displayed
  local address on the same Wi-Fi network, and enter the pairing code. The
  phone can dispatch, stream, stop, and approve work while every actual action
  continues to execute on the desktop PC.

## Files

- `main.js` — Electron main: window chrome, engine hosting, session store,
  auth IPC, approval bridge
- `preload.js` — the `window.craft` bridge
- `index.html` / `styles.css` / `app.js` — the renderer (login, home, chat)
