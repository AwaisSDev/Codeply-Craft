// The sources hook on a fake engine context: what a turn searched and opened lands on its reply.
// node sidecar/ext-sources.test.mjs
import assert from 'node:assert';
import { start } from './ext-sources.mjs';
const emitted = []; let saved = 0;
const ctx = { hooks: { runStart: [], runEvent: [], runEnd: [] }, api: { save: () => saved++, meta: (s) => ({ id: s.id }) }, emit: (id, e) => emitted.push([id, e]) };
start(ctx);
const session = { id: 'c1', messages: [{ kind: 'user', text: 'q' }] };
ctx.hooks.runStart[0](session);
session.messages.push({ kind: 'assistant', text: 'a' });
ctx.hooks.runEvent[0](session, { type: 'tool_end', name: 'web_fetch', ok: true, args: { url: 'https://example.com/page' } });
ctx.hooks.runEvent[0](session, { type: 'tool_end', name: 'dsh:web_search', ok: true, output: '1. Foo - https://foo.dev/a\n2. Again https://example.com/page' });
ctx.hooks.runEvent[0](session, { type: 'tool_end', name: 'read', ok: true, output: 'https://ignored.dev' });
await ctx.hooks.runEnd[0](session, { aborted: false });
assert.deepEqual(session.messages[1].sources.map((s) => s.host), ['example.com', 'foo.dev']);
assert.equal(session.messages[1].sources[1].title, 'Foo');
assert.equal(saved, 1); assert.equal(emitted[0][1].type, 'session_sync');
// A run stopped before it answered leaves the earlier reply alone.
const s3 = { id: 'c3', messages: [{ kind: 'assistant', text: 'old' }] };
ctx.hooks.runStart[0](s3);
ctx.hooks.runEvent[0](s3, { type: 'tool_end', name: 'web_fetch', ok: true, args: { url: 'https://example.org/' } });
await ctx.hooks.runEnd[0](s3, { aborted: true });
assert.equal(s3.messages[0].sources, undefined);
// A fetched page's own links are not sources; private addresses never are.
const { sourcesOf } = await import('./ext-sources.mjs');
assert.equal(sourcesOf({ name: 'web_fetch', ok: true, args: { url: 'https://a.dev/' }, output: 'see https://b.dev/x' }).length, 1);
ctx.hooks.runStart[0](s3);
ctx.hooks.runEvent[0](s3, { type: 'tool_end', name: 'web_fetch', ok: true, args: { url: 'http://192.168.1.4/admin' } });
s3.messages.push({ kind: 'assistant', text: 'new' });
await ctx.hooks.runEnd[0](s3, {});
assert.equal(s3.messages[1].sources, undefined);
// A run with no searches leaves the reply alone.
const s2 = { id: 'c2', messages: [{ kind: 'assistant', text: 'b' }] };
await ctx.hooks.runEnd[0](s2, {});
assert.equal(s2.messages[0].sources, undefined);
console.log('ext-sources ok');
