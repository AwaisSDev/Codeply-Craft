/** Codeply Craft occupants for the brand slots: sidebar mark and name, and the new-chat hero mark. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { CraftMark, CraftName } from './Brand.tsx'

/** Required service: the UI slot registry. */
export const inject = ['slots']

/**
 * Fill the brand slots as one registration set, so the shell's fallbacks
 * (DeepSeek's whale and the local-build badge) never show.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', () =>
      ctx.slots.inject('conversation.hero.brand.mark', function* () {
        yield ctx.slots.register({ name: 'sidebar.brand.mark' }, CraftMark)
        yield ctx.slots.register({ name: 'sidebar.brand.name' }, CraftName)
        yield ctx.slots.register({ name: 'conversation.hero.brand.mark' }, CraftMark)
      })))
}
