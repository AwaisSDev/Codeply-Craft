import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import type { SettingsLauncherOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SidebarFooterActionOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

/** What Craft's preload (dsh-preload.js) exposes to this page. */
interface CodeplyHost {
  account(): Promise<{ signedIn: boolean; email?: string; name?: string; avatarUrl?: string } | null>
  openBrowser(url?: string): Promise<boolean>
  toggleBrowser(): Promise<boolean>
}
const host = (): CodeplyHost | undefined => (globalThis as { codeplyHost?: CodeplyHost }).codeplyHost

type Account = Awaited<ReturnType<CodeplyHost['account']>>

const row = (wide: boolean): CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: 10, width: wide ? '100%' : 36, height: 36, padding: wide ? '0 8px' : 0,
  justifyContent: wide ? 'flex-start' : 'center', border: 0, borderRadius: 8, background: 'transparent',
  color: 'inherit', font: 'inherit', fontSize: 13, cursor: 'pointer', textAlign: 'left',
})

/**
 * The Codeply account at the sidebar foot: avatar and name, opening Settings.
 * Craft owns sign-in, so this only shows who is signed in.
 * @param props - launcher state from the settings shell.
 * @returns the launcher button.
 */
export function CodeplyAccountLauncher({ wide, openSettings }: SettingsLauncherOwnerProps) {
  const [account, setAccount] = useState<Account>(null)
  useEffect(() => {
    let live = true
    void host()?.account().then((a) => { if (live) setAccount(a) }).catch(() => {})
    return () => { live = false }
  }, [])
  const name = account?.signedIn === true ? (account.name || account.email || 'Codeply account') : 'Codeply account'
  const initial = (name.trim()[0] ?? 'C').toUpperCase()
  return (
    <button type="button" style={row(wide)} aria-label={`${name}, open Settings`} title={account?.email ?? name} onClick={openSettings}>
      {account?.avatarUrl
        ? <img src={account.avatarUrl} alt="" style={{ width: 24, height: 24, borderRadius: '50%', flex: 'none' }} />
        : <span aria-hidden="true" style={{ width: 24, height: 24, borderRadius: '50%', flex: 'none', display: 'grid', placeItems: 'center', background: '#1f6bff', color: '#fff', fontSize: 12, fontWeight: 600 }}>{initial}</span>}
      {wide ? <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span> : null}
    </button>
  )
}

/**
 * Opens Craft's own browser (tabs, address bar, point-at tool) on the right.
 * @param props - sidebar column state.
 * @returns the button.
 */
export function CraftBrowserButton({ wide }: SidebarFooterActionOwnerProps) {
  if (host() === undefined) return null
  return (
    <button type="button" style={row(wide)} aria-label="Browser" title="Browser" onClick={() => { void host()?.toggleBrowser() }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a14 14 0 0 1 0 18" /><path d="M12 3a14 14 0 0 0 0 18" />
      </svg>
      {wide ? <span>Browser</span> : null}
    </button>
  )
}
