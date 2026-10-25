/**
 * Codeply add-on: `browser_check`, Classic Craft's look at a page in a real
 * browser. The page opens in Craft's own browser panel (where the person can
 * watch), and the tool reports what actually happened: console errors and
 * warnings, failed requests, broken images, sideways scroll at the chosen
 * size, and the visible text.
 *
 * Only Craft has that browser, so the tool is registered only when Craft
 * started this engine with its loopback bridge (`CODEPLY_HAZE_BRIDGE_URL`
 * and the per-launch secret). The report is built on Craft's side by the
 * same code Classic uses (codeply-cli/lib/tools.mjs browser_check).
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'

export const name = 'codeply-browser-check'
export const inject = ['tools']

/** Craft's answer: the report text and whether the page loaded. */
interface BridgeReply { ok?: boolean; output?: string; error?: string }

const DESCRIPTION = [
  'Open a page in a real browser (Craft\'s browser panel, which the user can see) and report what actually happened:',
  'console errors and warnings, failed network requests, broken images, whether the page scrolls sideways at the chosen size,',
  'and its visible text. Use it after changing a web page or app to check it really works, before saying it does.',
  'url: http://localhost:<port>/... for a running dev server, or file:///<absolute path> for a static file.',
  'viewport: desktop (default), tablet, mobile, or WIDTHxHEIGHT. wait: extra milliseconds after load (default 700, max 5000).',
].join(' ')

/**
 * Register browser_check when Craft's bridge is present.
 * @param ctx - the engine context.
 */
export function apply(ctx: Context): void {
  const env = launchEnvironmentOf(ctx)
  const haze = env.get('CODEPLY_HAZE_BRIDGE_URL')?.value
  const token = env.get('CODEPLY_HAZE_BRIDGE_TOKEN')?.value
  if (haze === undefined || haze.length === 0 || token === undefined || token.length === 0) return
  const endpoint = new URL('/browser-check', haze).href

  ctx.tools.register(defineTool({
    name: 'browser_check',
    description: DESCRIPTION,
    parameters: {
      url: { type: 'string', required: true, description: 'The page to open: http(s):// or file:///.' },
      viewport: { type: 'string', description: 'desktop (default), tablet, mobile, or WIDTHxHEIGHT such as 1280x800.' },
      wait: { type: 'integer', description: 'Extra milliseconds to wait after load, up to 5000.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          report: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    timeoutMs: 90_000,
    async execute(args, exec) {
      let reply: BridgeReply
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          signal: exec.signal,
          redirect: 'error',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ url: args.url, viewport: args.viewport, wait: args.wait }),
        })
        reply = await response.json() as BridgeReply
      } catch (error) {
        if (exec.signal.aborted) throw error
        return { ok: false, report: 'Could not reach Craft\'s browser. Is Craft still open? Continue by reasoning from the source; do not retry this.' }
      }
      const report = reply.output ?? reply.error ?? 'browser_check returned nothing.'
      return { ok: reply.ok === true, report }
    },
    presentCall: args => ({ card: 'generic', title: `Check ${args.url}`, kind: 'fetch', rawInput: args }),
  }))
}
