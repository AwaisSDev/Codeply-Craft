// handoff-watchdog: starts Craft Cloud for runs whose PC went quiet, and keeps it going.
//
// pg_cron calls this every 30 s while some lease needs attention
// (supabase/handoff.sql, handoff_v2.sql). Each call claims, in one SQL
// statement (so a row is never claimed twice):
//   - PC leases with no renewal for 60 s: dispatches craft-cloud.yml with
//     handoff=resume on the chat's repo. The runner checks out craft/wip-<chat>,
//     reads the saved state and carries on. With no WIP yet it starts from the
//     base branch with the run's own prompt.
//   - cloud leases with no renewal for 3 minutes (the runner died): dispatches a
//     replacement, up to twice, then fails the lease with a notice.
//   - dispatches that failed earlier and are due again (backoff 30 s, 1, 2, 4
//     minutes, then a final failure in plain words).
// The runner renews its lease through { action: "cloud_beat" }, signed with a
// token only this function can make (see leaseToken in logic.ts).
//
// GitHub access, per repo: the Codeply GitHub App when it is installed there
// (a token that lasts an hour and only covers the repos the user picked),
// otherwise the user's own GitHub connection, if they keep it in Vault.
//
// A signed-in user can also ask { action: "app", repo } to learn whether the
// App is installed on a repo (the Cloud sheet shows it).
//
// Secrets (supabase secrets set ...): HANDOFF_CRON_SECRET, and for the App
// GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY (the .pem GitHub gives you).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  CLOUD_STALE_SECONDS, MAX_RECLAIMS, STALE_SECONDS, dispatchInputs, leaseToken, nothingToResume, planDispatchFailure, sameToken, taskWipBranch, wipBranch,
  type Lease, type Outcome,
} from "./logic.ts";

const WORKFLOW = "craft-cloud.yml";
const GH = "https://api.github.com";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function gh(token: string, method: string, path: string, body?: unknown, scheme = "token") {
  const r = await fetch(`${GH}${path}`, {
    method,
    headers: { Authorization: `${scheme} ${token}`, Accept: "application/vnd.github+json", "User-Agent": "codeply-handoff", "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: r.status, data };
}

// ─── GitHub App token ───────────────────────────────────────────────────

const b64url = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf as ArrayBuffer))).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const b64urlText = (s: string) => b64url(new TextEncoder().encode(s));

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  while (n > 0) { out.unshift(n & 0xff); n >>= 8; }
  return [0x80 | out.length, ...out];
}

/** GitHub hands out PKCS#1 keys; Web Crypto wants PKCS#8. Wrap it. */
function pkcs8FromPem(pem: string): Uint8Array {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  if (pem.includes("BEGIN PRIVATE KEY")) return der;
  const algo = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octet = [0x04, ...derLength(der.length), ...der];
  const inner = [0x02, 0x01, 0x00, ...algo, ...octet];
  return new Uint8Array([0x30, ...derLength(inner.length), ...inner]);
}

let appKey: CryptoKey | null = null;
async function appJwt(): Promise<string | null> {
  const id = Deno.env.get("GITHUB_APP_ID");
  const pem = Deno.env.get("GITHUB_APP_PRIVATE_KEY");
  if (!id || !pem) return null;
  if (!appKey) appKey = await crypto.subtle.importKey("pkcs8", pkcs8FromPem(pem.replace(/\\n/g, "\n")), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64urlText(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64urlText(JSON.stringify({ iat: now - 60, exp: now + 540, iss: id }))}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", appKey, new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64url(sig)}`;
}

/** An installation token for the repo, or null when the App is not installed there. */
async function appToken(repo: string): Promise<string | null> {
  const jwt = await appJwt();
  if (!jwt) return null;
  const inst = await gh(jwt, "GET", `/repos/${repo}/installation`, undefined, "Bearer");
  if (inst.status !== 200) return null;
  const tok = await gh(jwt, "POST", `/app/installations/${inst.data.id}/access_tokens`, { repositories: [repo.split("/")[1]] }, "Bearer");
  return tok.status === 201 ? tok.data.token : null;
}

async function tokenFor(row: any): Promise<{ token: string; via: string } | null> {
  const app = await appToken(row.repo).catch(() => null);
  if (app) return { token: app, via: "app" };
  const { data } = await admin.rpc("handoff_token_for", { p_user_id: row.user_id });
  return data ? { token: data as string, via: "user" } : null;
}

// ─── The watchdog ───────────────────────────────────────────────────────

async function branchExists(token: string, repo: string, branch: string): Promise<boolean> {
  const r = await gh(token, "GET", `/repos/${repo}/branches/${encodeURIComponent(branch)}`).catch(() => null);
  return !!r && r.status === 200;
}

/** Record a failed try: wait and try again, or give up with a notice in plain words. */
async function failed(row: any, o: Outcome, why: string) {
  const plan = planDispatchFailure(row as Lease, o);
  await admin.rpc("handoff_dispatch_failed", { p_session_id: row.session_id, p_epoch: row.epoch, p_note: plan.note, p_final_state: plan.state, p_delay_seconds: plan.delaySeconds });
  return { session: row.session_id, ok: false, retryInSeconds: plan.delaySeconds, why };
}

async function dispatch(row: any, secret: string) {
  const access = await tokenFor(row);
  if (!access) return failed(row, { kind: "no_credentials" }, "no credentials");
  const wipExists = row.wip_sha ? true : await branchExists(access.token, row.repo, wipBranch(row.session_id));
  const taskWipExists = wipExists ? false : await branchExists(access.token, row.repo, taskWipBranch(row.cloud_task_id));
  if (nothingToResume(row as Lease, { wipExists, taskWipExists })) {
    // The PC went quiet before it saved anything and never said what it was doing: no point trying again.
    const note = "The PC went offline before it saved any work, so there was nothing for the cloud to carry on from. The task carries on on your PC when it is back online.";
    await admin.rpc("handoff_dispatch_failed", { p_session_id: row.session_id, p_epoch: row.epoch, p_note: note, p_final_state: "cloud_failed", p_delay_seconds: null });
    return { session: row.session_id, ok: false, why: "nothing to resume" };
  }
  const lease = await leaseToken(secret, row.session_id, row.cloud_task_id, row.epoch);
  const r = await gh(access.token, "POST", `/repos/${row.repo}/actions/workflows/${WORKFLOW}/dispatches`, {
    ref: row.base || "main",
    inputs: dispatchInputs(row as Lease, { wipExists, taskWipExists, lease }),
  });
  if (r.status !== 204) return failed(row, { kind: "http", status: r.status, message: r.data && r.data.message ? String(r.data.message) : undefined }, `GitHub answered ${r.status}`);
  return { session: row.session_id, ok: true, via: access.via, task: row.cloud_task_id, attempt: (row.attempt || 0) + 1 };
}

/** The runner renews (or finishes) its lease. Only a runner holding the token made at dispatch may. */
async function cloudBeat(body: any, secret: string) {
  const { session_id, task_id, token, finish } = body || {};
  if (!session_id || !task_id || !token) return json(400, { error: "missing fields" });
  const { data: row } = await admin.from("run_leases").select("session_id, holder, cloud_task_id, epoch, state").eq("session_id", String(session_id)).maybeSingle();
  if (!row || row.holder !== "cloud" || row.cloud_task_id !== String(task_id)) return json(200, { ok: false, lost: true });
  const want = await leaseToken(secret, row.session_id, row.cloud_task_id, row.epoch);
  if (!sameToken(want, String(token))) return json(200, { ok: false, lost: true }); // an older runner (a replacement was dispatched), or a forged call
  const { data, error } = await admin.rpc("handoff_cloud_beat", { p_session_id: row.session_id, p_task_id: row.cloud_task_id, p_epoch: row.epoch, p_finish: !!finish });
  if (error) return json(500, { error: error.message });
  return json(200, { ok: data !== "lost", lost: data === "lost", state: data });
}

Deno.serve(async (req) => {
  const auth = req.headers.get("Authorization") || "";
  const body = await req.json().catch(() => ({}));

  // A signed-in user asking whether the App covers a repo.
  if (body && body.action === "app") {
    const { data } = await admin.auth.getUser(auth.replace(/^Bearer\s+/i, ""));
    if (!data || !data.user) return json(401, { error: "Sign in first." });
    if (!/^[\w.-]+\/[\w.-]+$/.test(String(body.repo || ""))) return json(400, { error: "Which repo?" });
    const jwt = await appJwt().catch(() => null);
    if (!jwt) return json(200, { configured: false, installed: false });
    const inst = await gh(jwt, "GET", `/repos/${body.repo}/installation`, undefined, "Bearer");
    return json(200, { configured: true, installed: inst.status === 200 });
  }

  const secret = Deno.env.get("HANDOFF_CRON_SECRET");
  if (!secret) return json(401, { error: "unauthorized" });
  // The runner's renewal: authenticated by its own token, not the cron secret.
  if (body && body.action === "cloud_beat") return cloudBeat(body, secret);
  if (auth !== `Bearer ${secret}`) return json(401, { error: "unauthorized" });
  let claim = await admin.rpc("handoff_claim_v2", { p_stale_seconds: STALE_SECONDS, p_cloud_stale_seconds: CLOUD_STALE_SECONDS, p_max_reclaims: MAX_RECLAIMS });
  // handoff_v2.sql not run yet: the old claim still works (PC leases only).
  if (claim.error && /could not find the function|does not exist/i.test(claim.error.message)) claim = await admin.rpc("handoff_claim_stale", { p_stale_seconds: STALE_SECONDS });
  if (claim.error) return json(500, { error: claim.error.message });
  const results = [];
  for (const row of claim.data || []) {
    // A thrown error (network down) is a failed try like any other: it is recorded and retried later.
    results.push(await dispatch(row, secret).catch((e) => failed(row, { kind: "network", message: String(e) }, String(e)).catch((e2) => ({ session: row.session_id, ok: false, why: String(e2) }))));
  }
  return json(200, { claimed: results.length, results });
});
