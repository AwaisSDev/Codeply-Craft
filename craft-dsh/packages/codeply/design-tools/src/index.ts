/**
 * Codeply add-on: the codeply-taste design layer's two tools, so the skill
 * works on this harness as it does in Classic Craft.
 *
 * - `design_direction` deals an art direction from the research library.
 * - `design_lint` checks a design against the measured rules and, in Craft,
 *   a real render in Craft's browser.
 *
 * Both run on Craft's side (or the terminal app's) with Classic's own code
 * (codeply-cli/lib/design-tools.mjs), reached through the loopback bridge
 * that started this engine (`CODEPLY_HAZE_BRIDGE_URL` and its secret). With
 * no bridge the tools are not registered. The skill itself comes from
 * Classic's skills folder (`DSH_BUNDLED_SKILL_DIR`).
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'

export const name = 'codeply-design-tools'
export const inject = ['tools']

/** Craft's answer: the tool's text and whether it worked. */
interface BridgeReply { ok?: boolean; output?: string; error?: string }

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      report: { type: 'string', required: true },
    },
  },
  render: (_args: unknown, value: { report: string }) => [{ type: 'text' as const, text: value.report }],
} as const

/**
 * Register the two tools when Craft's bridge is present.
 * @param ctx - the engine context.
 */
export function apply(ctx: Context): void {
  const env = launchEnvironmentOf(ctx)
  const haze = env.get('CODEPLY_HAZE_BRIDGE_URL')?.value
  const token = env.get('CODEPLY_HAZE_BRIDGE_TOKEN')?.value
  if (haze === undefined || haze.length === 0 || token === undefined || token.length === 0) return

  const call = async (tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ ok: boolean; report: string }> => {
    let reply: BridgeReply
    try {
      const response = await fetch(new URL(`/design/${tool}`, haze).href, {
        method: 'POST',
        signal,
        redirect: 'error',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        // The engine runs in the project folder, so its cwd is the design's folder.
        body: JSON.stringify({ args, cwd: process.cwd() }),
      })
      reply = await response.json() as BridgeReply
    } catch (error) {
      if (signal.aborted) throw error
      return { ok: false, report: `Could not reach Craft for ${tool}. Is it still open? Carry on without it; do not retry.` }
    }
    return { ok: reply.ok === true, report: reply.output ?? reply.error ?? `${tool} returned nothing.` }
  }

  ctx.tools.register(defineTool({
    name: 'design_direction',
    description: 'Deal an art direction for a page or app from the codeply-taste research library (type, palette, layout, imagery, motion), saved to .taste-skill/. Use it before designing anything a person will look at. list=sectors (or directions, roles, tones) lists the choices.',
    parameters: {
      brief: { type: 'string', description: 'One line: what it is and for whom.' },
      sector: { type: 'string', description: 'e.g. saas, restaurant, consumer-app, personal-portfolio (list=sectors lists them).' },
      tone: { type: 'string', description: 'quiet, bold, warm, technical, playful, luxury or editorial.' },
      sections: { type: 'string', description: 'Comma-separated section roles to plan.' },
      options: { type: 'string', description: '3 to see three directions first.' },
      direction: { type: 'string', description: 'The id of the direction to deal in full.' },
      redraw: { type: 'string', description: 'Re-deal one part: type, palette, hero, photos, section:<role> or direction.' },
      have: { type: 'string', description: 'Assets that really exist: photography, product-photo, product-ui, illustration, video.' },
      keep: { type: 'string', description: 'Parts the brand already fixes: palette, type.' },
      avoid: { type: 'string', description: 'Direction ids to skip.' },
      show: { type: 'string', description: 'true to reprint the saved sheet.' },
      list: { type: 'string', description: 'sectors, directions, roles or tones.' },
      site: { type: 'string', description: 'Print one studied reference site in full.' },
    },
    output: OUTPUT,
    timeoutMs: 120_000,
    execute: (args, exec) => call('design_direction', args as Record<string, unknown>, exec.signal),
    presentCall: args => ({ card: 'generic', title: 'Design direction', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'design_lint',
    description: 'Check a design against the codeply-taste rules and a real render (in Craft); returns findings to fix. Run it once or twice after building, not more.',
    parameters: {
      path: { type: 'string', required: true, description: 'The design file, usually index.html.' },
      kind: { type: 'string', description: 'website, app, slides, doc, poster, social or logo.' },
      widths: { type: 'string', description: 'Optional comma-separated widths to render.' },
      allow: { type: 'string', description: 'Rule ids to allow, each with a reason you can state.' },
    },
    output: OUTPUT,
    timeoutMs: 180_000,
    execute: (args, exec) => call('design_lint', args as Record<string, unknown>, exec.signal),
    presentCall: args => ({ card: 'generic', title: `Check ${args.path}`, kind: 'other', rawInput: args }),
  }))
}
