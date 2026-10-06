'use strict';

/**
 * Research Mode preprocessor hook.
 *
 * This is a plain pass-through: the messages come back exactly as given. The
 * only thing it adds is the optional "Research context" the user typed in
 * Settings (for example "I am testing my own app in an authorized setting"),
 * handed back as `system` so the caller can send it as an ordinary system
 * message. The hook exists for scoped, user-written context only.
 */
function preprocess({ messages, mode, model, researchContext } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const text = typeof researchContext === 'string' ? researchContext.trim() : '';
  return { messages: list, system: text };
}

/** Messages with the context (if any) as a leading system message. */
function withSystem({ messages, system }) {
  return system ? [{ role: 'system', content: system }, ...messages] : messages;
}

module.exports = { preprocess, withSystem };
