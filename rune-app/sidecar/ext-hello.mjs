// The smallest sidecar extension, and the pattern for the others: GET /ext/hello answers which
// extensions loaded. See the extensions block in engine.mjs.
export function route(ctx, req, res, url, p, reply) {
  if (req.method === 'GET' && p === '/ext/hello') {
    reply(200, { ok: true, missing: ctx.missing });
    return true;
  }
  return false;
}
