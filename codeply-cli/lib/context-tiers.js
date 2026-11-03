/**
 * Confidence and storage tiers for observations from a local model (release/memory-model/TIERS.md).
 *
 * The local backend asks llama-server for the log-probability of every token of its answer. From those,
 * each observation in the answer gets a confidence:
 *   exist  probability of the token that opens the observation (the model's decision to add it at all)
 *   mean   geometric-mean probability of the observation's own tokens
 *   min    the lowest token probability inside it
 * The confidences travel next to the answer (never inside it), so text the model reads cannot set them.
 *
 * With tiers configured ({ feature, tauA, tauP }), an observation is
 *   automatic  f >= tauA         stored as the model said (stated -> confirmed)
 *   pending    tauP <= f < tauA  stored as a tentative memory that expires unless seen again or confirmed
 *   discard    f < tauP          not stored
 * Without tiers, or without a confidence, everything is automatic (the behaviour before tiers).
 */

/** Character spans [start, end) of the objects in the top-level "observations" array of a JSON text. */
function observationSpans(text) {
  const key = String(text).search(/"observations"\s*:\s*\[/);
  if (key < 0) return [];
  let i = text.indexOf('[', key) + 1;
  const spans = []; let depth = 0; let start = -1; let inStr = false; let esc = false;
  for (; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth++; } else if (c === '}') { depth--; if (depth === 0 && start >= 0) { spans.push([start, i + 1]); start = -1; } } else if (c === ']' && depth === 0) break;
  }
  return spans;
}

/**
 * Per-observation confidences from an OpenAI-style logprobs.content list, aligned with the answer's
 * "observations" array. Null when the tokens do not reassemble the answer (then: no tiers for this batch).
 */
function confidences(content, tokens) {
  if (!Array.isArray(tokens) || !tokens.length) return null;
  const offs = []; let at = 0;
  for (const t of tokens) { const s = (t && t.token) || ''; offs.push([at, at + s.length]); at += s.length; }
  if (tokens.map((t) => (t && t.token) || '').join('') !== content) return null;
  return observationSpans(content).map(([a, b]) => {
    const inside = tokens.map((t, k) => ({ lp: Number(t.logprob), o: offs[k] })).filter((x) => x.o[1] > a && x.o[0] < b && Number.isFinite(x.lp));
    if (!inside.length) return null;
    const round = (v) => Math.round(v * 10000) / 10000;
    return {
      exist: round(Math.exp(inside[0].lp)),
      mean: round(Math.exp(inside.reduce((s, x) => s + x.lp, 0) / inside.length)),
      min: round(Math.exp(Math.min(...inside.map((x) => x.lp)))),
    };
  });
}

const FEATURES = ['exist', 'mean', 'min'];

/** A valid tiers config, or null (tiers off). */
function tiersConfig(c) {
  if (!c || typeof c !== 'object' || !FEATURES.includes(c.feature)) return null;
  const tauA = Number(c.tauA); const tauP = Number(c.tauP);
  if (!(tauA >= 0 && tauA <= 1) || !(tauP >= 0 && tauP <= tauA)) return null;
  return { feature: c.feature, tauA, tauP };
}

/** 'automatic' | 'pending' | 'discard' for one observation. */
function tierFor(obs, cfg) {
  const c = tiersConfig(cfg);
  const v = c && obs && obs.confidence ? Number(obs.confidence[c.feature]) : NaN;
  if (!c || !Number.isFinite(v)) return 'automatic';
  if (v >= c.tauA) return 'automatic';
  if (v >= c.tauP) return 'pending';
  return 'discard';
}

/**
 * Apply the tiers to a batch of guarded observations. Pending ones are marked { pending: true } and lose
 * "stated" (the brain stores them tentative, with an expiry); discarded ones are returned separately.
 */
function applyTiers(observations, cfg) {
  const keep = []; const discarded = [];
  for (const o of observations || []) {
    const tier = tierFor(o, cfg);
    if (tier === 'discard') { discarded.push({ ...o, tier }); continue; }
    keep.push(tier === 'pending' ? { ...o, tier, pending: true, certainty: o.certainty === 'stated' ? 'implied' : o.certainty } : { ...o, tier });
  }
  return { keep, discarded };
}

module.exports = { observationSpans, confidences, tiersConfig, tierFor, applyTiers, FEATURES };
