import glyph from './assets/craft-glyph.png'

/**
 * The Craft atomic mark in the current text colour: the same white-on-clear
 * glyph Craft's own title bar uses, applied as a mask.
 * @param props.size - square edge in pixels.
 * @param props.className - host class preserving the surrounding geometry.
 * @returns the mark (decorative; the name beside it carries the label).
 */
export function CraftMark({ size, className }: { size: number; className?: string | undefined }) {
  const mask = `url("${glyph}") center / contain no-repeat`
  return (
    <span
      className={className}
      aria-hidden="true"
      style={{ display: 'inline-block', width: size, height: size, flex: 'none', backgroundColor: 'currentColor', WebkitMask: mask, mask }}
    />
  )
}

/**
 * The product name, with no build or version badge.
 * @returns the name.
 */
export function CraftName() {
  return <span style={{ fontWeight: 600, fontSize: 14, whiteSpace: 'nowrap' }}>Codeply Craft</span>
}
