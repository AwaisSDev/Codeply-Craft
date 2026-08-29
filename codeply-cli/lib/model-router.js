/**
 * Codeply — task-based model routing.
 *
 * Gemma 4 31B (Ollama cloud) is the Auto model: it is ALWAYS the writer and
 * drives the whole turn — every tool call, every file edit, the final reply
 * — for every kind of task, including plain coding work. It is multimodal,
 * so an attached image goes straight to it: there is no separate
 * describe-the-image helper hop any more (that only existed because the old
 * writer was text-only, and re-describing an image to the very model that
 * can already see it costs an extra call and loses detail).
 *
 * Ollama's two account keys (apiKey / apiKeyFallback in ~/.codeply/config.json)
 * both back this one route — if the first key errors out or is over its
 * quota, ai.js's chatViaOllama moves the same request to the second key on
 * its own, so the Auto model stays up without anything here knowing.
 *
 * One narrow HELPER still runs before the writer's turn, and only for a
 * substantial design/architecture decision: a single-shot planning call whose
 * short output is handed to the writer as extra context. It never talks to
 * the user and never drives the agent loop. It lives on a different provider
 * (OpenRouter) on purpose — it is the one part of a turn that keeps working
 * when Ollama is having a bad day, and its failure is never fatal either way.
 *
 * planTurn() decides WHICH helpers should run, from the message text and
 * whether an image is attached — it does no I/O and makes no API calls.
 * runHelpers() actually calls them and returns the augmented message the
 * writer should see, plus the writer route and human-readable notes for the UI.
 *
 * Nothing here ever writes to ~/.codeply/config.json — routes are applied as
 * a per-request override (see applyRoute in ai.js), so the CLI's own stored
 * config is untouched and two chats can be on different models without
 * racing each other.
 */
const ai = require('./ai.js');

// Model IDs verified against the providers' live model lists.
// Note the "a4b" in the 26B id — plain "google/gemma-4-26b-it" does not exist.
// The writer's provider is 'ollama' against the cloud host (https://ollama.com),
// which is where both of the configured keys live.
const WRITER = { id: 'writer', label: 'Gemma 4 31B', provider: 'ollama', model: 'gemma4:31b' };
// Kept as a named export because it IS still the model that reads images —
// it is just the writer itself now, reached directly rather than through a
// separate helper call.
const VISION_HELPER = WRITER;
const DESIGN_HELPER = { id: 'design', label: 'Codeply Design', provider: 'openrouter', model: 'google/gemma-4-26b-a4b-it:free' };

// A whole new page/site/app from scratch is a real design decision (layout,
// sections, structure) worth Gemma 4's better design judgment. A one-line
// style tweak to something that already exists is not — "make the button
// yellow" doesn't need an architecture opinion, it needs an edit, so it's
// deliberately left OUT of this pattern (and doesn't match it: no
// site/page/app noun) rather than added to some separate "trivial" exclusion
// list. Keeping the match narrow does the exclusion for free.
const BIG_DESIGN_RE =
  /\b(?:build|create|make|design)\b[^.!?\n]{0,40}\b(?:website|web\s?site|landing\s?page|webpage|home\s?page|mockup|dashboard|app|application|ui|interface|portfolio|prototype)\b/i;

// Genuine advice-seeking / planning language — "how should I structure the
// auth flow", "what's the best approach here". The apostrophe is optional
// throughout ("whats" / "what's" / "what’s") since people type it either way.
const DESIGN_ADVICE_RE =
  /\b(?:plan|plans|planning|suggest|suggests|suggestion|suggestions|architecture|architect|recommend|recommends|approach|strategy|tradeoff|trade-off|compare|options)\b|how\s+should|how\s+do\s+i|what(?:['’]?s|\s+is)\s+the\s+best|which\s+(?:is|would)\s+better|should\s+i/i;

/**
 * Decide which helper(s) a turn needs. Pure classification — no I/O.
 * `needsVision` is gone: the writer reads images itself now.
 * @returns {{needsDesign:boolean, writer:object}}
 */
function planTurn(message, hasImage) {
  const text = String(message || '');
  return {
    needsDesign: BIG_DESIGN_RE.test(text) || DESIGN_ADVICE_RE.test(text),
    writer: WRITER,
  };
}

const DESIGN_PROMPT_PREFIX =
  'You are a design/architecture advisor. Give a concise, concrete, actionable plan for the request below — ' +
  'key sections or components, structure, layout decisions, or the architectural approach — that another ' +
  'engineer will implement directly from your plan. Be specific, not generic advice. Keep it under 200 words, ' +
  'plain prose or a short list, no code.\n\nThe request: ';

/**
 * Run whichever helpers plan{} calls for, and build the message the writer
 * actually sees. Each helper call is a single, non-agentic ai.chat() — no
 * tool loop, no back-and-forth, just "think about this once, hand back a note."
 *
 * Images are passed straight back through untouched: the writer is
 * multimodal, so they belong in its own turn rather than being flattened
 * into someone else's description of them.
 *
 * @param {{needsDesign:boolean}} plan  from planTurn()
 * @param {string}   message   the user's original message text
 * @param {string[]} [images]  data: URLs the user attached, if any
 * @returns {Promise<{message:string, images:string[]|null, notes:Array<{label:string, why:string}>}>}
 */
async function runHelpers(plan, message, images) {
  const sections = [];
  const notes = [];

  if (plan.needsDesign) {
    const r = await ai.chat(
      [{ role: 'user', content: DESIGN_PROMPT_PREFIX + message }],
      { route: DESIGN_HELPER, maxTokens: 500 },
    );
    if (r.success) {
      sections.push(`[Design plan from ${DESIGN_HELPER.label}]\n${r.data.choices[0].message.content}`);
      notes.push({ label: DESIGN_HELPER.label, why: 'planned the design' });
    } else {
      notes.push({ label: DESIGN_HELPER.label, why: `couldn't produce a plan (${r.error})`, failed: true });
    }
  }

  return {
    message: sections.length ? `${sections.join('\n\n')}\n\n${message}` : message,
    // The writer sees the images itself — hand them back exactly as they
    // came in rather than dropping them for a text stand-in.
    images: images && images.length ? images : null,
    notes,
  };
}

module.exports = { planTurn, runHelpers, WRITER, VISION_HELPER, DESIGN_HELPER };
