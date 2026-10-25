import { useState } from 'react'
import type { CSSProperties } from 'react'

/** One accent choice: a name and its base colour (`null` keeps the built-in blue). */
interface Accent { id: string; label: string; color: string | null }

/** Craft's palette. The base colour becomes the whole accent ramp, light and dark. */
export const ACCENTS: readonly Accent[] = [
  { id: 'craft', label: 'Craft blue', color: null },
  { id: 'violet', label: 'Violet', color: '#7c5cff' },
  { id: 'iris', label: 'Iris', color: '#5b6cff' },
  { id: 'teal', label: 'Teal', color: '#14b8a6' },
  { id: 'green', label: 'Green', color: '#22c55e' },
  { id: 'amber', label: 'Amber', color: '#f59e0b' },
  { id: 'coral', label: 'Coral', color: '#ff6b4a' },
  { id: 'rose', label: 'Rose', color: '#f43f73' },
  { id: 'graphite', label: 'Graphite', color: '#8b919c' },
]

const STORAGE_KEY = 'craft.accent'
/** The accent ramp steps DSH's tokens read (links, selection, info buttons, the active nav row, bubbles). */
const RAMP_STEPS = ['50', '100', '200', '300', '400', '450', '500', '600', '800', '900'] as const

/** Each step as a mix of the base colour with white (light steps) or a near-black (dark steps). */
function ramp(color: string): Record<(typeof RAMP_STEPS)[number], string> {
  const mix = (with_: string, pct: number): string => `color-mix(in srgb, ${color} ${pct}%, ${with_})`
  return {
    50: mix('white', 8),
    100: mix('white', 14),
    200: mix('white', 24),
    300: mix('white', 42),
    400: mix('white', 78),
    450: mix('white', 90),
    500: color,
    600: mix('black', 80),
    800: mix('rgb(28, 30, 36)', 36),
    900: mix('rgb(28, 30, 36)', 22),
  }
}

/** Read the saved accent id; storage can be unavailable. */
function savedAccent(): string {
  try { return localStorage.getItem(STORAGE_KEY) ?? 'craft' } catch { return 'craft' }
}

/**
 * Put an accent on the page. The theme tokens live on `body`, so the overrides
 * go on body's inline style, which wins over both the light and dark sheets.
 * @param id - accent id from {@link ACCENTS}.
 */
export function applyAccent(id: string): void {
  const style = document.body?.style
  if (style === undefined) return
  const color = ACCENTS.find(accent => accent.id === id)?.color ?? null
  const steps = color === null ? null : ramp(color)
  for (const step of RAMP_STEPS) {
    const name = `--dsw-static-deepseek-${step}`
    if (steps === null) style.removeProperty(name)
    else style.setProperty(name, steps[step])
  }
  if (color === null) style.removeProperty('--dsw-static-blue-500')
  else style.setProperty('--dsw-static-blue-500', color)
}

/** Apply the saved accent as soon as the page has a body. */
export function applySavedAccent(): void {
  if (document.body !== null) applyAccent(savedAccent())
  else document.addEventListener('DOMContentLoaded', () => { applyAccent(savedAccent()) }, { once: true })
}

const swatch = (color: string, selected: boolean): CSSProperties => ({
  width: 28, height: 28, borderRadius: '50%', padding: 0, cursor: 'pointer', background: color,
  border: 0, flex: 'none',
  boxShadow: selected
    ? '0 0 0 2px var(--dsw-alias-bg-base, var(--dsw-alias-bg-module-platform)), 0 0 0 4px var(--dsw-alias-label-primary)'
    : 'inset 0 0 0 0.5px rgba(0, 0, 0, 0.18)',
})

/**
 * Settings > General: the accent colour swatches. The choice is per device,
 * kept in this page's storage and applied at once.
 * @returns the settings row.
 */
export function AccentRow() {
  const [current, setCurrent] = useState(savedAccent)
  const pick = (id: string): void => {
    setCurrent(id)
    try { localStorage.setItem(STORAGE_KEY, id) } catch { /* the accent still applies for this run */ }
    applyAccent(id)
  }
  const name = ACCENTS.find(accent => accent.id === current)?.label ?? 'Craft blue'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '16px 0', borderBottom: '0.5px solid var(--dsw-alias-border-l2)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' }}>Accent color</span>
        <span style={{ fontSize: 13, color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary-dimmed))' }}>{name}</span>
      </div>
      <div role="radiogroup" aria-label="Accent color" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, padding: '4px 4px 0' }}>
        {ACCENTS.map(accent => (
          <button
            key={accent.id}
            type="button"
            role="radio"
            aria-checked={current === accent.id}
            aria-label={accent.label}
            title={accent.label}
            style={swatch(accent.color ?? 'rgb(65, 118, 230)', current === accent.id)}
            onClick={() => { pick(accent.id) }}
          />
        ))}
      </div>
    </div>
  )
}
