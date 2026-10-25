/** Craft host occupants: the Codeply account launcher, the Browser button, the accent colour row and the Models page. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/remote'
import { CodeplyAccountLauncher, CraftBrowserButton } from './Host.tsx'
import { CloudChip } from './CloudChip.tsx'
import type { CloudChipInjected } from './CloudChip.tsx'
import { AccentRow, applySavedAccent } from './AccentRow.tsx'
import { OwnModelsSection } from './OwnModelsSection.tsx'

/** Required service: the UI slot registry. */
export const inject = ['slots', 'remote', 'remote.session']

/**
 * Register the account launcher (DeepSeek's account plugin is not mounted in
 * Codeply Craft) and the Browser action at the sidebar foot.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  // Craft's accent colour: applied before Settings is ever opened, chosen in Settings > General.
  applySavedAccent()
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'craft-accent',
    order: 12,
  } as never, AccentRow as never))
  // Settings > Models is Craft's own: Haze 2 and your own models (Classic's Add a model), in place of DeepSeek's page.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'models',
    order: 10,
    label: () => 'Models',
  } as never, OwnModelsSection as never))
  ctx.slots.inject('settings.launcher', () => ctx.slots.register({ name: 'settings.launcher' }, CodeplyAccountLauncher))
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'craft-browser' }, CraftBrowserButton))
  // Craft Cloud in the composer row: switches this chat between Craft Cloud and Haze 2.
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'craft-cloud',
    inject: (sessionId: string): CloudChipInjected => ({
      setCloud: async (on) => {
        const result = await ctx.remote.session.selectModel({
          sessionId: sessionId as never,
          provider: on ? 'craft-cloud' : 'haze',
          model: on ? 'cloud' : 'haze-2',
        })
        return result.ok ? null : result.error.message
      },
    }),
  } as never, CloudChip as never))
}
