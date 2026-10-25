import { FishLogo } from './FishLogo.tsx'
import type { IconProps } from './icons/props.ts'

/** Display options for the brand wordmark. */
export interface BrandWordmarkProps extends IconProps {
  /** Whether to include the leading Codeply mark; defaults to true. */
  includeMark?: boolean | undefined
}

/**
 * Render the full brand wordmark. Craft fork: "Craft" in the interface's own
 * sans font beside the Codeply mark, replacing DeepSeek's lettering.
 * @param props.size - height in px (default 24).
 * @param props.className - extra class for layout placement.
 * @param props.includeMark - whether to include the leading mark.
 * @returns the wordmark (aria-hidden decorative brand art).
 */
export function BrandWordmark({ size = 24, className, includeMark = true }: BrandWordmarkProps) {
  return (
    <span
      className={className}
      aria-hidden="true"
      style={{ display: 'inline-flex', alignItems: 'center', gap: size * 0.3, height: size, lineHeight: 1 }}
    >
      {includeMark ? <FishLogo size={size} /> : null}
      <span style={{ fontSize: size * 0.72, fontWeight: 600, letterSpacing: '-0.01em' }}>Codeply Craft</span>
    </span>
  )
}
