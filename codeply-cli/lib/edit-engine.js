/**
 * Codeply CLI - surgical SEARCH/REPLACE edit engine
 *
 * Adapted from Codeply-App/main.js's computeInstructionEdits/
 * applySearchReplace/applyEditsToContent - same approach (small verified
 * diffs instead of a full-file rewrite), trimmed for a stateless single-shot
 * CLI: no local usage-history file, no .codeply/ response cache, no
 * multi-turn conversation context (each CLI invocation is its own process).
 */
const fs = require('fs');
const path = require('path');
const ai = require('./ai');

// Apply ONE search/replace edit to a string. Exact match first, then
// whitespace-tolerant (ignore leading/trailing space, then collapse internal
// runs), skipping blank lines on both sides. Re-indents the replacement to fit.
// Returns { ok, content } or { ok:false, error:'notfound'|'multiple'|'empty' }.
function applySearchReplace(fileContent, searchBlock, replaceBlock) {
  // Matching works on LF text; a CRLF file is written back as CRLF so an edit
  // never rewrites every line ending in the file (a whole-file diff, and a
  // mixed-ending file once a later write adds LF lines).
  const res = applySearchReplaceLF(fileContent, searchBlock, replaceBlock);
  if (res.ok && /\r\n/.test(fileContent || '')) res.content = res.content.replace(/\r?\n/g, '\r\n');
  return res;
}

function applySearchReplaceLF(fileContent, searchBlock, replaceBlock) {
  const nl = (s) => (s || '').replace(/\r\n/g, '\n');
  fileContent = nl(fileContent); searchBlock = nl(searchBlock); replaceBlock = nl(replaceBlock);
  if (!searchBlock.trim()) return { ok: false, error: 'empty' };

  const fileLines = fileContent.split('\n');
  const searchLines = searchBlock.split('\n');

  const lineStartOffset = (idx) => { let o = 0; for (let k = 0; k < idx; k++) o += fileLines[k].length + 1; return o; };

  const reindentBlock = (block, indent) => {
    const ls = block.split('\n');
    const firstNonEmpty = ls.find(l => l.trim() !== '') || '';
    const base = (firstNonEmpty.match(/^[ \t]*/) || [''])[0];
    return ls.map(l => {
      if (l.trim() === '') return '';
      const stripped = l.startsWith(base) ? l.slice(base.length) : l.replace(/^[ \t]*/, '');
      return indent + stripped;
    }).join('\n');
  };

  const locate = (normalize) => {
    const s = searchLines.map(normalize).filter(x => x !== '');
    if (!s.length) return [];
    const found = [];
    for (let start = 0; start < fileLines.length; start++) {
      if (normalize(fileLines[start]) !== s[0]) continue;
      let fi = start, si = 0, end = start;
      while (si < s.length && fi < fileLines.length) {
        const nf = normalize(fileLines[fi]);
        if (nf === '') { fi++; continue; }       // skip blank lines in the file
        if (nf !== s[si]) break;
        end = fi; fi++; si++;
      }
      if (si === s.length) found.push([start, end]);
    }
    return found;
  };

  const exact = fileContent.indexOf(searchBlock);
  if (exact !== -1) {
    if (exact !== fileContent.lastIndexOf(searchBlock)) return { ok: false, error: 'multiple' };
    return { ok: true, content: fileContent.slice(0, exact) + replaceBlock + fileContent.slice(exact + searchBlock.length) };
  }

  let matches = locate(l => l.trim());
  if (matches.length === 0) matches = locate(l => l.trim().replace(/\s+/g, ' '));

  if (matches.length === 0) {
    // Last resort: anchor on the first AND last non-blank lines of the search
    // block (recovers when the AI dropped/added a line in the middle). Kept
    // conservative - both anchors must be unique and the span must be modest.
    const sNon = searchLines.map(l => l.trim()).filter(x => x !== '');
    if (sNon.length >= 2) {
      const firstHits = [], lastHits = [];
      fileLines.forEach((l, i) => {
        const t = l.trim();
        if (t === sNon[0]) firstHits.push(i);
        if (t === sNon[sNon.length - 1]) lastHits.push(i);
      });
      if (firstHits.length === 1 && lastHits.length === 1 && lastHits[0] >= firstHits[0]) {
        const sL = firstHits[0], eL = lastHits[0];
        if (eL - sL + 1 <= sNon.length * 3 + 5) {   // don't grab a huge region
          const indent = (fileLines[sL].match(/^[ \t]*/) || [''])[0];
          const reindented = reindentBlock(replaceBlock, indent);
          return { ok: true, content: fileContent.slice(0, lineStartOffset(sL)) + reindented + fileContent.slice(lineStartOffset(eL) + fileLines[eL].length) };
        }
      }
    }
    const fuzzy = fuzzyLocate(fileContent, searchBlock);
    if (fuzzy.ok) {
      const at = fileContent.indexOf(fuzzy.span);
      // The model's replacement carries the indentation it wrongly assumed;
      // move it to where the block really sits.
      const text = fuzzy.reindent
        ? reindentBlock(replaceBlock, (fuzzy.span.split('\n').find((l) => l.trim()) || '').match(/^[ \t]*/)[0])
        : replaceBlock;
      return { ok: true, content: fileContent.slice(0, at) + text + fileContent.slice(at + fuzzy.span.length), fuzzy: true };
    }
    return { ok: false, error: fuzzy.error === 'multiple' ? 'multiple' : 'notfound' };
  }
  if (matches.length > 1) return { ok: false, error: 'multiple' };

  const [startLine, endLine] = matches[0];
  const indent = (fileLines[startLine].match(/^[ \t]*/) || [''])[0];
  const reindented = reindentBlock(replaceBlock, indent);
  const startChar = lineStartOffset(startLine);
  const endChar = lineStartOffset(endLine) + fileLines[endLine].length;
  return { ok: true, content: fileContent.slice(0, startChar) + reindented + fileContent.slice(endChar) };
}

// ─── Fallback matchers ──────────────────────────────────────────────────────
//
// Adapted from opencode (packages/opencode/src/tool/edit.ts), MIT License,
// Copyright (c) 2025 opencode - https://github.com/sst/opencode
//
// Each matcher yields candidate spans that exist VERBATIM in the file for a
// search block the model copied imperfectly (escaped quotes, shifted
// indentation, a middle line reworded). They only run after the matcher above
// has found nothing, and a candidate is used only when it occurs exactly once
// and is not far larger than what the model asked for.

function levenshtein(a, b) {
  if (a === '' || b === '') return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function spanOfLines(lines, start, end) {
  return lines.slice(start, end + 1).join('\n');
}

const ANCHOR_SIMILARITY = 0.65;

// First and last lines match exactly (trimmed); the middle only has to be
// similar. Recovers a search block with one line misremembered.
function* blockAnchorMatches(content, find) {
  const lines = content.split('\n');
  const want = find.split('\n');
  if (want[want.length - 1] === '') want.pop();
  if (want.length < 3) return;
  const first = want[0].trim(), last = want[want.length - 1].trim();
  const maxDelta = Math.max(1, Math.floor(want.length * 0.25));

  const candidates = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== first) continue;
    for (let j = i + 2; j < lines.length; j++) {
      if (lines[j].trim() !== last) continue;
      if (Math.abs(j - i + 1 - want.length) <= maxDelta) candidates.push([i, j]);
      break;
    }
  }

  let best = null, bestScore = -1;
  for (const [s, e] of candidates) {
    const size = e - s + 1;
    const middle = Math.min(want.length - 2, size - 2);
    let score = 1;
    if (middle > 0) {
      score = 0;
      for (let k = 1; k < want.length - 1 && k < size - 1; k++) {
        const a = lines[s + k].trim(), b = want[k].trim();
        const len = Math.max(a.length, b.length);
        score += len ? 1 - levenshtein(a, b) / len : 1;
      }
      score /= middle;
    }
    if (score > bestScore) { bestScore = score; best = [s, e]; }
  }
  if (best && bestScore >= ANCHOR_SIMILARITY) yield spanOfLines(lines, best[0], best[1]);
}

// Same block with its indentation shifted as a whole.
function* indentationFlexibleMatches(content, find) {
  const dedent = (text) => {
    const ls = text.split('\n');
    const indents = ls.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length);
    if (!indents.length) return text;
    const min = Math.min(...indents);
    return ls.map((l) => (l.trim() ? l.slice(min) : l)).join('\n');
  };
  const target = dedent(find);
  const lines = content.split('\n');
  const n = find.split('\n').length;
  for (let i = 0; i + n <= lines.length; i++) {
    const block = lines.slice(i, i + n).join('\n');
    if (dedent(block) === target) yield block;
  }
}

// The model wrote \n, \" or \` escapes where the file has the real characters.
function* escapeNormalizedMatches(content, find) {
  const unescape = (s) => s.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (m, c) =>
    ({ n: '\n', t: '\t', r: '\r', "'": "'", '"': '"', '`': '`', '\\': '\\', '\n': '\n', $: '$' }[c] ?? m));
  const target = unescape(find);
  if (target !== find && content.includes(target)) yield target;
  const lines = content.split('\n');
  const n = target.split('\n').length;
  for (let i = 0; i + n <= lines.length; i++) {
    const block = lines.slice(i, i + n).join('\n');
    if (block !== target && unescape(block) === target) yield block;
  }
}

// Stray blank lines or spaces around the block.
function* trimmedBoundaryMatches(content, find) {
  const t = find.trim();
  if (t === find) return;
  if (content.includes(t)) yield t;
}

const FALLBACK_MATCHERS = [indentationFlexibleMatches, escapeNormalizedMatches, trimmedBoundaryMatches, blockAnchorMatches];

// A "match" many times bigger than the search block means an anchor latched
// onto the wrong closing line; replacing it would silently delete code.
function isDisproportionate(span, find) {
  const spanLines = span.split('\n').length, findLines = find.split('\n').length;
  if (spanLines >= Math.max(findLines + 3, findLines * 2)) return true;
  if (findLines === 1) return false;
  return span.trim().length > Math.max(find.trim().length + 500, find.trim().length * 4);
}

/**
 * Find the one verbatim span in `content` that an imperfect search block most
 * likely meant. @returns {{ok:true, span:string} | {ok:false, error:'notfound'|'multiple'|'disproportionate'}}
 */
function fuzzyLocate(content, find) {
  let sawMultiple = false;
  for (const matcher of FALLBACK_MATCHERS) {
    for (const span of matcher(content, find)) {
      if (!span.trim()) continue;
      const at = content.indexOf(span);
      if (at === -1) continue;
      if (at !== content.lastIndexOf(span)) { sawMultiple = true; continue; }
      if (isDisproportionate(span, find)) return { ok: false, error: 'disproportionate' };
      return { ok: true, span, reindent: matcher === indentationFlexibleMatches || matcher === blockAnchorMatches };
    }
  }
  return { ok: false, error: sawMultiple ? 'multiple' : 'notfound' };
}

// Apply an ordered list of verified {search, replace} hunks to file content,
// all-or-nothing (pure - no disk write).
function applyEditsToContent(fileContent, edits) {
  let working = (fileContent || '').replace(/\r\n/g, '\n');
  for (let i = 0; i < edits.length; i++) {
    const { search, replace } = edits[i];
    const res = applySearchReplace(working, search, replace);
    if (!res.ok) return { ok: false, error: res.error, index: i };
    working = res.content;
  }
  return { ok: true, content: working };
}

const SYSTEM_PROMPT = `You are a precise code editor. You receive an INSTRUCTION describing a small change, and the FULL current file. Make ONLY the specific change requested, as surgical SEARCH/REPLACE edits - do NOT reproduce the whole file.

STRICT RULES:
1. Return an "edits" array. Use the FEWEST edits that cleanly express the change.
2. "search" must be copied VERBATIM from the file below - exact existing text being changed, with just enough surrounding lines to be unique.
3. "replace" is that same block with ONLY the requested change applied - preserve everything else in it exactly (formatting, unrelated properties, comments, whitespace style).
4. If the SAME property/selector/value appears more than once in the file (e.g. "top" set in both a "from" and a "to" block), do NOT pick the first or most obvious match - use every clue in the instruction to find the ONE correct occurrence: the CURRENT value it mentions, nearby selectors, rule/keyframe names, or ordering (first/last, start/end). If more than one occurrence still fits equally well after that, return an EMPTY "edits" array with a "reason" naming the ambiguity instead of guessing.
5. If the instruction genuinely requires large new content that can't be expressed as a small edit (e.g. "build a whole new page/game/module from scratch"), return an EMPTY "edits" array - do not guess badly at a huge diff.
6. Return ONLY valid JSON, no markdown, no commentary.

Response format:
{
  "edits": [ { "search": "<exact verbatim block from the file>", "replace": "<that block with the change applied>" } ],
  "reason": "<one short sentence>",
  "confidence": <0-100>
}`;

/**
 * Asks the AI for surgical edits, self-corrects up to twice against bad
 * "search" matches, and returns only the edits that verify cleanly against
 * the real file content.
 * @returns {Promise<{success:boolean, edits?:Array, badCount?:number, reason?:string, confidence?:number, tokensUsed?:number, modelUsed?:string, error?:string}>}
 */
async function computeInstructionEdits(instruction, filePath) {
  if (!fs.existsSync(filePath)) return { success: false, error: `File not found: ${filePath}` };
  const content = fs.readFileSync(filePath, 'utf8');

  const probe = (search) => {
    const res = applySearchReplace(content, search, search);
    return res.ok ? 'ok' : res.error;
  };

  let totalTokens = 0;
  let lastModelUsed = null;

  const askModel = async (feedback) => {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      // Large/stable content (the file) first, small/always-different content
      // (the instruction) last - the ai-proxy's underlying model caches a
      // repeated PREFIX, so this ordering matters for repeated calls against
      // the same file even when the instruction text differs each time.
      { role: 'user', content: `FULL FILE (${path.basename(filePath)}):\n${content}\n\nINSTRUCTION:\n${instruction}` },
    ];
    if (feedback) messages.push({ role: 'user', content: feedback });

    const aiResult = await ai.chat(messages, { json: true, meta: { promptText: instruction, filePath } });
    if (!aiResult.success) throw new Error(aiResult.error);
    if (aiResult.modelUsed) lastModelUsed = aiResult.modelUsed;
    const data = aiResult.data;
    totalTokens += (data.usage || {}).total_tokens || 0;

    let parsed;
    try { parsed = JSON.parse(data.choices[0].message.content); }
    catch { return { edits: [], confidence: 0, reason: '' }; }

    const edits = Array.isArray(parsed.edits)
      ? parsed.edits.filter(e => e && e.search && e.replace != null).map(e => ({ search: e.search, replace: e.replace }))
      : [];
    return { edits, confidence: parsed.confidence == null ? 75 : parsed.confidence, reason: parsed.reason || '' };
  };

  let edits, confidence, reason;
  try {
    ({ edits, confidence, reason } = await askModel());
  } catch (e) {
    return { success: false, error: e.message };
  }

  const verify = (list) => list.map((e) => ({ e, status: probe(e.search) }));
  let checked = verify(edits);
  let bad = checked.filter(c => c.status !== 'ok');

  let pass = 0;
  while (bad.length && pass < 2) {
    pass++;
    const feedback =
      `Some "search" blocks from your last answer are wrong. Return the COMPLETE corrected edits array again, fixing these:\n` +
      bad.map(c => c.status === 'multiple'
        ? `- Matched MULTIPLE places - include more surrounding lines so it is unique:\n${c.e.search}`
        : `- NOT found in the file - copy it EXACTLY from the FULL FILE above, character for character:\n${c.e.search}`
      ).join('\n') +
      `\nEvery "search" must be copied verbatim from the file shown above.`;
    let retry;
    try { retry = await askModel(feedback); }
    catch (e) { break; }
    if (retry.edits.length) { edits = retry.edits; confidence = retry.confidence; reason = retry.reason || reason; }
    checked = verify(edits);
    bad = checked.filter(c => c.status !== 'ok');
  }

  const good = checked.filter(c => c.status === 'ok').map(c => c.e);
  return { success: true, edits: good, badCount: bad.length, confidence, reason, tokensUsed: totalTokens, modelUsed: lastModelUsed };
}

module.exports = { applySearchReplace, applyEditsToContent, computeInstructionEdits, fuzzyLocate };
