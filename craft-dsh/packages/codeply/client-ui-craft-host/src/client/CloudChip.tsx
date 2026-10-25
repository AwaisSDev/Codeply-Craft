import { useState } from 'react'
import type { CSSProperties } from 'react'

/** What the chip needs from its host: the chat's model and a way to switch it. */
export interface CloudChipInjected {
  /** Turn Craft Cloud on (its model) or off (back to Haze 2) for this chat. */
  setCloud(on: boolean): Promise<string | null>
}

interface Selection { readonly provider: string; readonly model: string }
interface CloudChipProps extends CloudChipInjected {
  useProjection(key: 'modelSelection'): { readonly lastUsed: Selection | null; readonly next: Selection | null } | undefined
  locked?: boolean
}

const chip = (on: boolean): CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 10px', border: 0, borderRadius: 8,
  background: on ? 'color-mix(in srgb, #1f6bff 18%, transparent)' : 'transparent',
  color: on ? '#5b9bff' : 'inherit', font: 'inherit', fontSize: 13, cursor: 'pointer', opacity: 0.95,
})

/**
 * Craft Cloud in the composer row, like Classic's Cloud chip: on, this chat's
 * messages run on Craft Cloud (your PC can be off); off, back to Haze 2.
 * @param props - the chat's model projection and the switch.
 * @returns the chip.
 */
export function CloudChip({ useProjection, setCloud, locked }: CloudChipProps) {
  const selection = useProjection('modelSelection')
  const current = selection?.next ?? selection?.lastUsed ?? null
  const on = current?.provider === 'craft-cloud'
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <button
      type="button"
      style={chip(on)}
      disabled={busy || locked === true}
      aria-pressed={on}
      title={error ?? (on ? 'Craft Cloud is on: messages run in the cloud. Click to run here again.' : 'Run this chat on Craft Cloud, so your PC can be off')}
      onClick={() => {
        setBusy(true)
        void setCloud(!on).then((failure) => { setError(failure); setBusy(false) })
      }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M7 18h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.1 9.2 4.5 4.5 0 0 0 7 18Z" />
      </svg>
      <span>Cloud</span>
    </button>
  )
}
