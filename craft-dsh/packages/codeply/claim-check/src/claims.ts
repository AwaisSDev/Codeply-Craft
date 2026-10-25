/**
 * Patterns for answers that claim work no tool did. Ported from Classic
 * Craft's claim audit (codeply-cli/lib/agent.mjs): only completion language
 * counts ("I've updated", "has been fixed", "tests pass"), never plans or
 * advice ("I will update", "you should run the tests").
 */

const HC_VERB = '(?:applied|updated|written|wrote|edited|fixed|changed|added|created|modified|implemented|built|removed|deleted|replaced|refactored|renamed|rewritten|rewrote|moved|made)'
// A closed set between "have" and the verb: "I have TO update" is necessity, not a claim.
const HC_ADVERB = '(?:now|already|actually|just|finally)'

export const CLAIM_CHANGED = new RegExp(
  String.raw`\bi(?:'ve|\s+have)\s+(?:${HC_ADVERB}\s+){0,2}${HC_VERB}\b`
  + String.raw`|\bsuccessfully\s+${HC_VERB}\b`
  + String.raw`|\b${HC_VERB}\b[^.!?\n]{0,20}\bsuccessfully\b`
  + String.raw`|\b(?:has|have)\s+been\s+${HC_VERB}\b`
  + String.raw`|\bi\s+(?:${HC_ADVERB}\s+)?(?:updated|edited|fixed|changed|added|created|modified|implemented|removed|replaced|refactored|rewrote|wrote)\s+(?:the|your|a|an|it|this|that|all|each|every)\b`,
  'i',
)

export const CLAIM_VERIFIED = new RegExp(
  String.raw`\bi(?:'ve|\s+have)\s+(?:${HC_ADVERB}\s+|also\s+|successfully\s+){0,2}(?:run|ran|tested|verified|executed|confirmed|checked)\b`
  + String.raw`|\ball\s+(?:the\s+)?tests\s+(?:now\s+)?pass`
  + String.raw`|\btests?\s+(?:now\s+)?(?:pass(?:ed|es)?|succeed(?:ed|s)?)\b`
  + String.raw`|\bbuild\s+(?:now\s+)?(?:passes|succeeded|is\s+successful)\b`
  + String.raw`|\bverified\s+(?:that\s+)?(?:it|the\s+(?:page|app|site|fix|change))\s+works`,
  'i',
)

export const CLAIM_SHIPPED = new RegExp(
  String.raw`\bi(?:'ve|\s+have)\s+(?:${HC_ADVERB}\s+|also\s+|successfully\s+){0,2}(?:deployed|pushed|committed|published)\b`
  + String.raw`|\bsuccessfully\s+(?:deployed|pushed|committed|published)\b`
  + String.raw`|\b(?:is|are)\s+now\s+live\s+(?:at|on)\b`,
  'i',
)

const FILENAME_TOKEN = /\b[\w-]+\.(?:html|htm|css|js|jsx|ts|tsx|mjs|cjs|py|json|md|yml|yaml|txt|svg|vue|svelte)\b/gi
const CHANGE_VERB = /\b(?:updated|changed|edited|created|added|modified|wrote|written|fixed|rewrote|rewritten|replaced|removed|refactored|implemented|applied|saved|generated|renamed|moved|deleted)\b/i
const COMMAND_BEFORE = /\b(?:run|running|node|nodemon|python3?|py|deno|bun|npx|npm|yarn|pnpm|tsx|ts-node|open|opening|execute|launch|start|serve|visit|load)\s+(?:(?:--?[\w-]+|start|run|exec)\s+)*$/i

/**
 * File names a reply says it changed. Code blocks and command-shaped code
 * spans are dropped first, and a name right after a command word ("run
 * index.js") is how to use a file, not a claim that it changed.
 * @param prose - the reply text.
 * @returns lower-cased base names.
 */
export function claimedFiles(prose: string): string[] {
  const text = prose
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`\n]*)`/g, (_m, inner: string) => (/\s/.test(inner.trim()) ? ' ' : inner))
  const out = new Set<string>()
  for (const sentence of text.split(/[.!?;:](?=\s|$)|\n/)) {
    if (!CHANGE_VERB.test(sentence)) continue
    for (const m of sentence.matchAll(FILENAME_TOKEN)) {
      if (COMMAND_BEFORE.test(sentence.slice(0, m.index))) continue
      out.add(m[0].toLowerCase())
    }
  }
  return [...out]
}
