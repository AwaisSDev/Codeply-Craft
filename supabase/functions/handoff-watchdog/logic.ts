// The watchdog's decisions, with no network and no Deno APIs, so the Node tests
// (codeply-cli/test/cloud-resilience-test) can import this file and check them.
// index.ts does the I/O around it.

export const STALE_SECONDS = 60;          // a PC lease with no renewal for this long is taken over
export const CLOUD_STALE_SECONDS = 180;   // a cloud lease with no renewal (the runner beats every 15 s, and needs a minute or two to start)
export const MAX_RECLAIMS = 2;            // a dead cloud runner is replaced at most this many times
export const MAX_DISPATCH_TRIES = 5;      // GitHub refusing to start the run: tries before giving up
const BACKOFF = [30, 60, 120, 240];       // seconds to wait after the 1st, 2nd, 3rd, 4th failed try

export type Lease = {
  session_id: string;
  repo: string;
  base?: string | null;
  mode?: string | null;
  prompt?: string | null;
  wip_sha?: string | null;
  cloud_task_id: string;
  epoch: number;
  attempt?: number | null;
  dispatch_attempts?: number | null;
};

export type Outcome = { kind: "ok" } | { kind: "no_credentials" } | { kind: "http"; status: number; message?: string } | { kind: "network"; message?: string };

/** The WIP branch of a handoff run (same rule as wipBranch in handoff.mjs). */
export const wipBranch = (sid: string) => `craft/wip-${String(sid).replace(/[^A-Za-z0-9_-]/g, "")}`;
/** The WIP branch of a cloud run that is not a handoff (see pushRunnerWip in handoff.mjs). */
export const taskWipBranch = (taskId: string) => wipBranch(`task-${taskId}`);

/** Seconds to wait before try number `tries + 1`, or null when `tries` failed tries is the limit. */
export function backoffSeconds(tries: number): number | null {
  if (tries >= MAX_DISPATCH_TRIES) return null;
  return BACKOFF[Math.min(Math.max(tries, 1), BACKOFF.length) - 1];
}

const waitWords = (s: number) => (s < 60 ? `${s} seconds` : s === 60 ? "a minute" : `${Math.round(s / 60)} minutes`);

/** What went wrong, in plain words for the person (no status codes first). */
export function plainReason(o: Outcome, repo: string): string {
  if (o.kind === "no_credentials") return "Codeply has no GitHub access to start the cloud run. Connect GitHub in Codeply or install the Codeply GitHub app.";
  if (o.kind === "network") return "Codeply could not reach GitHub to start the cloud run.";
  if (o.kind === "http") {
    if (o.status === 401) return "GitHub no longer accepts the sign-in Codeply saved for the cloud. Reconnect GitHub in Codeply.";
    if (o.status === 403) return "GitHub would not let Codeply start the cloud run (permissions or a rate limit).";
    if (o.status === 404) return `Codeply could not find its cloud workflow in ${repo}. Set up Cloud again for this project in Codeply.`;
    if (o.status === 422) return "GitHub rejected the request to start the cloud run. Set up Cloud again in Codeply to update the workflow file.";
    if (o.status >= 500) return "GitHub is having trouble right now.";
    return `GitHub refused to start the cloud run (${o.status}${o.message ? `: ${o.message}` : ""}).`;
  }
  return "";
}

/**
 * After a failed try: wait and try again, or give up. `row.dispatch_attempts`
 * is the number of tries made before this one.
 */
export function planDispatchFailure(row: Pick<Lease, "repo" | "dispatch_attempts">, o: Outcome): { state: string; note: string; delaySeconds: number | null } {
  const tries = (row.dispatch_attempts || 0) + 1;
  const delay = backoffSeconds(tries);
  const why = plainReason(o, row.repo);
  const finalState = o.kind === "no_credentials" ? "no_credentials" : "cloud_failed";
  if (delay == null) {
    return { state: finalState, delaySeconds: null, note: `${why} Codeply tried ${tries} times and gave up, so the task carries on on your PC when it is back online.` };
  }
  return { state: "dispatch_retry", delaySeconds: delay, note: `${why} Trying again in ${waitWords(delay)} (try ${tries} of ${MAX_DISPATCH_TRIES}).` };
}

/** The final note when a cloud runner died and there are no replacements left. */
export function deadRunnerNote(attempt: number): string {
  return `The cloud run stopped responding${attempt ? ` and was restarted ${attempt} time${attempt === 1 ? "" : "s"}` : ""}, but it did not finish. Your work up to the last save is on a craft/wip-* branch of your repo, and the task carries on on your PC when it is back online.`;
}

/** A hex HMAC-SHA256 over the lease, given to the runner so it may renew it (and nothing else). */
export async function leaseToken(secret: string, sessionId: string, taskId: string, epoch: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`lease:${sessionId}:${taskId}:${epoch}`)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export const FALLBACK_PROMPT = "Carry on the task that was running on the PC.";

/**
 * The workflow inputs for this lease. With a WIP commit from the PC (or from a
 * runner that died) the run resumes from craft/wip-<chat>; without one, from
 * the base branch with the run's own prompt (or from the dead runner's
 * craft/wip-task-<id> when it left one).
 */
export function dispatchInputs(row: Lease, o: { wipExists: boolean; taskWipExists: boolean; lease: string }): Record<string, string> {
  const common = { mode: row.mode || "Build", task_id: row.cloud_task_id, session_id: row.session_id, attempt: String((row.attempt || 0) + 1), lease: o.lease };
  if (row.wip_sha || o.wipExists) return { ...common, prompt: row.prompt || FALLBACK_PROMPT, handoff: "resume" };
  return { ...common, prompt: row.prompt || FALLBACK_PROMPT, handoff: "", ...(o.taskWipExists ? { wip: taskWipBranch(row.cloud_task_id) } : {}) };
}

/** A lease whose prompt is unknown and that has nothing saved cannot be resumed: say so instead of running a blank task. */
export function nothingToResume(row: Lease, o: { wipExists: boolean; taskWipExists: boolean }): boolean {
  return !row.wip_sha && !o.wipExists && !o.taskWipExists && !row.prompt;
}
