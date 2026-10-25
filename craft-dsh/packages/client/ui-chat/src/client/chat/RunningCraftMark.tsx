/**
 * Craft fork: the running indicator is the atomic Craft mark turning slowly
 * (replaces DeepSeek's whale tail). Reduced motion keeps it still.
 */
import css from './ChatView.module.css'

export function RunningCraftMark() {
  return (
    <span className={css.runningIcon} aria-hidden="true">
      <span className={css.runningCraft} />
    </span>
  )
}
