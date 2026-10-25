import { useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'

/** A saved model as Craft shows it: the key never comes back, only a masked preview. */
interface OwnModel { id: string; name: string; kind: string; baseUrl: string; model: string; hasKey: boolean; keyPreview: string }
interface SaveResult { ok: boolean; error?: string; testFailed?: boolean; state?: { models: OwnModel[] } }
interface OwnModelsHost {
  list(): Promise<{ ok: boolean; state?: { models: OwnModel[] }; error?: string }>
  save(input: Record<string, unknown>): Promise<SaveResult>
  remove(id: string): Promise<SaveResult>
  detectOllama(host?: string): Promise<OllamaResult>
}
interface OllamaResult { ok: boolean; models?: { name: string }[]; error?: string }
const host = (): OwnModelsHost | undefined => (globalThis as { codeplyHost?: { models?: OwnModelsHost } }).codeplyHost?.models

/** Quick fill, the same as Classic's Add a model. */
const PRESETS = [
  { label: 'OpenAI', name: 'GPT-4o mini', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { label: 'Claude', name: 'Claude Sonnet', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5' },
  { label: 'Gemini', name: 'Gemini Flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.7-flash' },
  { label: 'OpenRouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/auto' },
  { label: 'Groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b' },
] as const

const OLLAMA = 'http://localhost:11434'

const text = (size: number, color = 'var(--dsw-alias-label-primary)'): CSSProperties => ({ fontSize: size, lineHeight: 1.5, color, margin: 0 })
const muted = 'var(--dsw-alias-label-secondary)'
const card: CSSProperties = { border: '0.5px solid var(--dsw-alias-border-l4)', borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }
const input: CSSProperties = {
  boxSizing: 'border-box', width: '100%', height: 34, padding: '0 10px', borderRadius: 8, font: 'inherit', fontSize: 13,
  border: '0.5px solid var(--dsw-alias-border-l4)', background: 'transparent', color: 'var(--dsw-alias-label-primary)', outline: 'none',
}
const button = (primary: boolean): CSSProperties => ({
  height: 32, padding: '0 14px', borderRadius: 8, font: 'inherit', fontSize: 13, cursor: 'pointer', border: primary ? 0 : '0.5px solid var(--dsw-alias-border-l4)',
  background: primary ? 'var(--dsw-alias-button-primary-fill)' : 'transparent',
  color: primary ? 'var(--dsw-alias-label-primary-inverted)' : 'var(--dsw-alias-label-primary)',
})
const chip: CSSProperties = { ...button(false), height: 26, padding: '0 10px', borderRadius: 999, fontSize: 12 }

/** One labelled field. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={text(12, muted)}>{label}</span>
      {children}
    </label>
  )
}

/**
 * Settings > Models in the new Craft: Haze 2, plus your own models with your
 * own keys. Same list as Classic (adding one here adds it there), tested with
 * a tiny real request before it is saved. Craft keeps the keys; this page
 * never sees one back.
 * @returns the section.
 */
export function OwnModelsSection() {
  const api = host()
  const [models, setModels] = useState<OwnModel[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ name: '', baseUrl: '', model: '', apiKey: '' })
  const [busy, setBusy] = useState<'' | 'test' | 'save'>('')
  const [error, setError] = useState('')
  const [canSkip, setCanSkip] = useState(false)
  const [ollama, setOllama] = useState<string[] | null>(null)
  const [ollamaNote, setOllamaNote] = useState('')

  useEffect(() => {
    if (api === undefined) return
    let live = true
    api.list().then((r) => {
      if (!live) return
      if (r.ok) setModels(r.state?.models ?? [])
      else setLoadError(r.error ?? 'Could not read your models.')
    }).catch(() => { if (live) setLoadError('Could not read your models.') })
    return () => { live = false }
  }, [api])

  if (api === undefined) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 720 }}>
        <h2 style={{ ...text(16), fontWeight: 500 }}>Models</h2>
        <p style={text(13, muted)}>Open this from Craft to add your own models.</p>
      </div>
    )
  }

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => { setForm(f => ({ ...f, [key]: e.target.value })) }
  const reset = (): void => {
    setAdding(false); setForm({ name: '', baseUrl: '', model: '', apiKey: '' }); setError(''); setCanSkip(false); setOllama(null); setOllamaNote('')
  }
  const save = async (skipTest: boolean, extra?: Partial<typeof form> & { kind?: string }): Promise<void> => {
    const values = { ...form, ...extra }
    if (!values.baseUrl.trim() || !values.model.trim()) { setError('Enter a base URL and a model ID.'); return }
    setBusy(skipTest ? 'save' : 'test'); setError(''); setCanSkip(false)
    const r = await api.save({ kind: extra?.kind ?? 'openai', ...values, skipTest }).catch((e: unknown) => ({ ok: false, error: String(e) } as SaveResult))
    setBusy('')
    if (!r.ok) {
      setError(r.testFailed === true ? `The test request failed: ${r.error ?? ''}` : (r.error ?? 'Could not save it.'))
      setCanSkip(r.testFailed === true)
      return
    }
    if (r.state !== undefined) setModels(r.state.models)
    reset()
  }
  const remove = async (id: string): Promise<void> => {
    const r = await api.remove(id).catch(() => ({ ok: false } as SaveResult))
    if (r.ok && r.state !== undefined) setModels(r.state.models)
  }
  const findOllama = async (): Promise<void> => {
    setOllamaNote('Looking for Ollama on this PC...')
    const r = await api.detectOllama(OLLAMA).catch((): OllamaResult => ({ ok: false, error: 'Ollama is not running.' }))
    if (!r.ok || (r.models ?? []).length === 0) { setOllama(null); setOllamaNote(r.ok ? 'Ollama is running, but has no models yet.' : (r.error ?? 'Ollama is not running.')); return }
    setOllama((r.models ?? []).map(m => m.name)); setOllamaNote('')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 720, color: 'var(--dsw-alias-label-primary)' }}>
      <h2 style={{ ...text(16), fontWeight: 500 }}>Models</h2>
      <p style={text(13, muted)}>Haze 2 picks the right model for each turn. Add your own models with your own keys and pick them from the model menu under Your models. Classic and the new Craft share this list.</p>

      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div>
            <p style={{ ...text(14), fontWeight: 500 }}>Haze 2</p>
            <p style={text(12, muted)}>Codeply's routing brain. Included with your Codeply account.</p>
          </div>
          <span style={text(12, muted)}>Default</span>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <p style={{ ...text(14), fontWeight: 500 }}>Your models</p>
        {!adding && <button type="button" style={button(true)} onClick={() => { setAdding(true) }}>Add a model</button>}
      </div>

      {loadError !== '' && <p style={text(13, 'var(--dsw-alias-state-error-primary)')}>{loadError}</p>}
      {models !== null && models.length === 0 && !adding && (
        <p style={text(13, muted)}>None yet. Any OpenAI-compatible API works, and so does Ollama on this PC.</p>
      )}
      {(models ?? []).map(m => (
        <div key={m.id} style={{ ...card, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ minWidth: 0 }}>
            <p style={{ ...text(14), fontWeight: 500 }}>{m.name || m.model}</p>
            <p style={{ ...text(12, muted), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {m.model} · {m.baseUrl}{m.hasKey ? ` · key ${m.keyPreview}` : ''}
            </p>
          </div>
          <button type="button" style={button(false)} aria-label={`Remove ${m.name || m.model}`} onClick={() => { void remove(m.id) }}>Remove</button>
        </div>
      ))}

      {adding && (
        <div style={card}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
            <span style={text(12, muted)}>Quick fill</span>
            {PRESETS.map(p => (
              <button key={p.label} type="button" style={chip} onClick={() => { setForm(f => ({ ...f, name: p.name, baseUrl: p.baseUrl, model: p.model })) }}>{p.label}</button>
            ))}
            <button type="button" style={chip} onClick={() => { void findOllama() }}>Ollama on this PC</button>
          </div>
          {ollamaNote !== '' && <p style={text(12, muted)}>{ollamaNote}</p>}
          {ollama !== null && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {ollama.map(name => (
                <button key={name} type="button" style={chip} disabled={busy !== ''}
                  onClick={() => { void save(true, { kind: 'ollama', name: `${name} (local)`, baseUrl: OLLAMA, model: name, apiKey: '' }) }}>
                  Add {name}
                </button>
              ))}
            </div>
          )}
          <Field label="Name"><input style={input} value={form.name} onChange={set('name')} placeholder="My model" /></Field>
          <Field label="Base URL"><input style={input} value={form.baseUrl} onChange={set('baseUrl')} placeholder="https://api.openai.com/v1" /></Field>
          <Field label="Model ID"><input style={input} value={form.model} onChange={set('model')} placeholder="gpt-4o-mini" /></Field>
          <Field label="API key"><input style={input} type="password" value={form.apiKey} onChange={set('apiKey')} placeholder="Stays on this PC" autoComplete="off" /></Field>
          {error !== '' && <p style={text(13, 'var(--dsw-alias-state-error-primary)')}>{error}</p>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" style={button(false)} onClick={reset}>Cancel</button>
            {canSkip && <button type="button" style={button(false)} disabled={busy !== ''} onClick={() => { void save(true) }}>{busy === 'save' ? 'Saving...' : 'Save anyway'}</button>}
            <button type="button" style={button(true)} disabled={busy !== ''} onClick={() => { void save(false) }}>{busy === 'test' ? 'Testing...' : 'Test & save'}</button>
          </div>
        </div>
      )}
    </div>
  )
}
