/**
 * Codeply - Gmail and Slack OAuth + the real API calls the agent's tools use.
 *
 * Desktop-app OAuth (RFC 8252): the consent screen opens in the user's real
 * system browser, not an embedded webview, and the redirect is caught by a
 * short-lived local HTTP server on a fixed loopback port - Real App/main.js
 * owns spinning that server up/down; this file only builds URLs and talks to
 * the providers' token/API endpoints. No secrets are ever logged.
 */
// One Google connection covers Gmail (read, send, drafts) and Google
// Calendar events. A connection made before compose/calendar were added lacks
// them; the tools say "reconnect Gmail in Connect Apps" when Google refuses.
const GOOGLE_SCOPE = {
  compose: 'https://www.googleapis.com/auth/gmail.compose',
  calendar: 'https://www.googleapis.com/auth/calendar.events',
};
const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send', GOOGLE_SCOPE.compose, GOOGLE_SCOPE.calendar].join(' ');
// channels:join is what lets slackPostMessage auto-join a public channel
// before posting to it - without it, chat:write alone only covers channels
// the app has already been manually invited into.
const SLACK_SCOPES = 'chat:write,channels:read,channels:history,channels:join';
// Separate from the bot scopes above - Slack issues bot and user tokens
// through entirely different mechanisms in the same OAuth exchange. `scope`
// requests the bot token (posts as "Codeply Craft APP"); `user_scope`
// requests a second, independent token that posts as the actual signed-in
// user. Both come back in one authorize round-trip, but they're genuinely
// two different tokens with two different scope sets.
const SLACK_USER_SCOPES = 'chat:write';

function buildGmailAuthUrl(clientId, redirectUri) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GMAIL_SCOPES,
    access_type: 'offline', // required to get a refresh_token back
    prompt: 'consent', // forces the refresh_token every time, not just first connect
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function exchangeGmailCode(clientId, clientSecret, code, redirectUri) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId, client_secret: clientSecret, code,
      redirect_uri: redirectUri, grant_type: 'authorization_code',
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error_description || body.error || `Gmail token exchange failed (HTTP ${res.status})`);
  return body; // { access_token, refresh_token, expires_in, ... }
}

async function refreshGmailToken(clientId, clientSecret, refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId, client_secret: clientSecret,
      refresh_token: refreshToken, grant_type: 'refresh_token',
    }),
  });
  const body = await readJson(res);
  if (!res.ok) {
    // invalid_grant (Google's description is just "Bad Request") means the
    // refresh token is dead: revoked, or expired because the OAuth app is
    // still in Testing mode, where Google drops refresh tokens after 7 days.
    // Only a fresh sign-in fixes it, so say that instead of "Bad Request".
    if (body.error === 'invalid_grant') {
      const e = new Error('The Gmail sign-in has expired or was revoked, so Craft disconnected it. Reconnect Gmail in Connect Apps (account menu → Connect Apps), then try again.');
      e.code = 'invalid_grant';
      throw e;
    }
    throw new Error(`Gmail token refresh failed (HTTP ${res.status}, ${body.error || 'error'}): ${body.error_description || 'no details from Google'}`);
  }
  return body; // { access_token, expires_in, ... } - no new refresh_token on refresh
}

async function getGmailProfile(accessToken) {
  const res = await fetch('https://www.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await readJson(res);
  if (!res.ok) throw gmailError(body, res.status, 'Gmail profile lookup');
  return body.emailAddress;
}

/**
 * Google's bare error.message is often just "Bad Request", which tells the
 * agent (and the user) nothing. Pull the status, the machine reason and the
 * per-error message so the real cause shows, with a plain-words hint for the
 * ones that need the user to act.
 */
function gmailError(data, status, what, scopeHint) {
  const err = (data && data.error) || {};
  const first = Array.isArray(err.errors) && err.errors[0] ? err.errors[0] : {};
  const reason = first.reason || err.status || '';
  const detail = [err.message, first.message].filter((m, i, a) => m && a.indexOf(m) === i).join(': ');
  let hint = '';
  if (status === 401) hint = ' The Gmail sign-in expired or was revoked. Reconnect Gmail in Connect Apps.';
  else if (status === 403 && /scope|insufficient/i.test(detail + reason)) hint = scopeHint || ' Gmail was connected without read access. Reconnect Gmail in Connect Apps and allow all requested permissions.';
  else if (status === 403 && /accessNotConfigured|SERVICE_DISABLED|has not been used/i.test(detail + reason)) hint = ' The Gmail API is not enabled on the Google Cloud project behind this app.';
  else if (/failedPrecondition|FAILED_PRECONDITION/i.test(reason)) hint = ' Google says this account has no usable Gmail mailbox for this app (Gmail turned off, or the account is not a test user of the app). Reconnect Gmail in Connect Apps with the right account.';
  else if (status === 400) hint = ' Reconnecting Gmail in Connect Apps usually fixes this.';
  const e = new Error(`${what} failed (HTTP ${status}${reason ? `, ${reason}` : ''}): ${detail || 'no details from Google'}.${hint}`);
  e.status = status;
  return e;
}

async function readJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { error: { message: text.slice(0, 200) } }; }
}

function base64UrlEncode(str) {
  return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** RFC 2822 message, base64url as Gmail wants it. A non-ASCII subject is RFC 2047 encoded. */
function rawEmail({ to, subject, body }) {
  const s = String(subject || '');
  const subj = /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
  const head = [to ? `To: ${to}` : '', `Subject: ${subj}`, 'Content-Type: text/plain; charset="UTF-8"'].filter(Boolean).join('\r\n');
  return base64UrlEncode(`${head}\r\n\r\n${body || ''}`);
}

async function gmailSend(accessToken, { to, subject, body }) {
  const raw = rawEmail({ to, subject, body });
  const res = await fetch('https://www.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  const data = await readJson(res);
  if (!res.ok) throw gmailError(data, res.status, 'Gmail send');
  return data; // { id, threadId, ... }
}

/** Saves a draft in the user's Gmail (needs gmail.compose). */
async function gmailCreateDraft(accessToken, { to, subject, body }) {
  const res = await fetch('https://www.googleapis.com/gmail/v1/users/me/drafts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { raw: rawEmail({ to, subject, body }) } }),
  });
  const data = await readJson(res);
  if (!res.ok) {
    const e = gmailError(data, res.status, 'Gmail draft', ' Gmail was connected before drafts were allowed. Reconnect Gmail in Connect Apps to allow drafts.');
    e.scopeMissing = res.status === 403 && /scope|insufficient/i.test(JSON.stringify(data));
    throw e;
  }
  return data; // { id, message: { id, threadId } }
}

// ─── Google Calendar (same Google connection as Gmail) ──────────────────────
const CALENDAR_EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

function calendarError(data, status, what) {
  const err = (data && data.error) || {};
  const first = Array.isArray(err.errors) && err.errors[0] ? err.errors[0] : {};
  const reason = first.reason || err.status || '';
  const detail = [err.message, first.message].filter((m, i, a) => m && a.indexOf(m) === i).join(': ');
  const text = `${detail} ${reason} ${JSON.stringify(err.details || '')}`;
  let hint = '';
  if (status === 401) hint = ' The Google sign-in expired or was revoked. Reconnect Gmail in Connect Apps.';
  else if (status === 403 && /accessNotConfigured|SERVICE_DISABLED|has not been used|is disabled/i.test(text)) hint = ' The Google Calendar API is not enabled on the Google Cloud project behind this app. Enable "Google Calendar API" in that project (Google Cloud console, APIs & Services, Library), wait a minute, then try again.';
  else if (status === 403 && /scope|insufficient/i.test(text)) hint = ' Google was connected before Calendar access was added. Reconnect Gmail in Connect Apps (it covers Calendar too) and allow calendar access.';
  else if (status === 400) hint = ' Check the start and end times.';
  const e = new Error(`${what} failed (HTTP ${status}${reason ? `, ${reason}` : ''}): ${detail || 'no details from Google'}.${hint}`);
  e.status = status;
  return e;
}

/** Events on the primary calendar between timeMin and timeMax (RFC 3339), soonest first. */
async function calendarListEvents(accessToken, { timeMin, timeMax, maxResults = 20 }) {
  const params = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', maxResults: String(maxResults) });
  if (timeMin) params.set('timeMin', timeMin);
  if (timeMax) params.set('timeMax', timeMax);
  const res = await fetch(`${CALENDAR_EVENTS_URL}?${params}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await readJson(res);
  if (!res.ok) throw calendarError(data, res.status, 'Calendar list');
  return data.items || [];
}

/** Creates an event on the primary calendar. `event` is a Calendar API event resource. */
async function calendarInsertEvent(accessToken, event) {
  const res = await fetch(CALENDAR_EVENTS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
  const data = await readJson(res);
  if (!res.ok) throw calendarError(data, res.status, 'Calendar add');
  return data; // { id, htmlLink, ... }
}

async function gmailSearch(accessToken, query, maxResults = 10) {
  // "*" and "" mean "everything" to a person but are not Gmail syntax; an
  // empty q simply lists the newest mail, which is what they meant.
  const q = String(query || '').trim();
  const params = new URLSearchParams({ maxResults: String(maxResults) });
  if (q && q !== '*' && q !== '""' && q !== "''") params.set('q', q);
  const res = await fetch(`https://www.googleapis.com/gmail/v1/users/me/messages?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const list = await readJson(res);
  if (!res.ok) throw gmailError(list, res.status, 'Gmail search');
  if (!list.messages?.length) return [];
  // The list endpoint only returns bare ids - each result needs its own
  // fetch for subject/from/snippet, capped by maxResults so a broad query
  // can't fan out into dozens of requests.
  const details = await Promise.all(list.messages.map(async (m) => {
    const r = await fetch(
      `https://www.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const msg = await r.json();
    const header = (name) => msg.payload?.headers?.find((h) => h.name === name)?.value || '';
    return { id: m.id, subject: header('Subject'), from: header('From'), date: header('Date'), snippet: msg.snippet || '' };
  }));
  return details;
}

function buildSlackAuthUrl(clientId, redirectUri) {
  const params = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri,
    scope: SLACK_SCOPES, user_scope: SLACK_USER_SCOPES,
  });
  return `https://slack.com/oauth/v2/authorize?${params}`;
}

async function exchangeSlackCode(clientId, clientSecret, code, redirectUri) {
  const res = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
  });
  const body = await res.json();
  // Slack's OAuth endpoint returns HTTP 200 even on failure - ok:false in the body is the real signal.
  if (!body.ok) throw new Error(body.error || 'Slack token exchange failed');
  return body; // { access_token, team: { id, name }, ... }
}

/** Public-channel-only equivalent of clicking "Join channel" in Slack. Idempotent - already_in_channel is fine. */
async function slackJoinChannel(accessToken, channelId) {
  const res = await fetch('https://slack.com/api/conversations.join', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: channelId }),
  });
  const body = await res.json();
  if (!body.ok && body.error !== 'already_in_channel') throw new Error(body.error || 'Could not join the channel');
}

async function slackPostMessage(accessToken, { channel, text }, { isUserToken = false } = {}) {
  // A bot token's chat:write only covers channels the app has actually
  // joined - not "any public channel" the way a human member can post to.
  // Auto-joining first (public channels only; that's all resolveSlackChannel
  // in tools.mjs ever resolves to) means the agent can post to a channel the
  // very first time it's asked to, instead of failing with not_in_channel
  // until someone manually runs /invite in Slack. Joining a channel it's
  // already in is a harmless no-op (already_in_channel), so this doesn't
  // need to track membership itself - just always try.
  //
  // A user token is different: it posts as an actual workspace member, who
  // either already belongs to the channel or doesn't - conversations.join
  // isn't the right operation for a user identity the way it is for a bot,
  // so this is skipped entirely on that path.
  if (!isUserToken) await slackJoinChannel(accessToken, channel);

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, text }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(body.error || 'Slack message failed to send');
  return body;
}

async function slackListChannels(accessToken) {
  // public_channel only - private_channel requires the separate groups:read
  // scope, which isn't part of the bot scope set this app asks for
  // (chat:write, channels:read, channels:history). Slack rejects the WHOLE
  // conversations.list call with missing_scope if any requested type isn't
  // covered, not just the private-channel portion - so asking for a type we
  // don't have scope for breaks lookup even for public channels the bot can
  // see fine, which is exactly what was happening here.
  const res = await fetch('https://slack.com/api/conversations.list?types=public_channel&limit=100', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await res.json();
  if (!body.ok) throw new Error(body.error || 'Slack channel list failed');
  return (body.channels || []).map((c) => ({ id: c.id, name: c.name, isPrivate: c.is_private, isMember: c.is_member }));
}

// Vercel Integrations Console apps do NOT use a plain /oauth/authorize?
// client_id=... URL - that endpoint belongs to a different, older Vercel
// OAuth app system and rejects Integrations Console client IDs outright
// ("App configuration error: The app ID is invalid"). An integration created
// in the Integrations Console starts its install at this slug-based URL
// instead (found on the integration's own Console settings page, not
// derived from client_id), and Vercel redirects back to whichever Redirect
// URL is configured in the Console (already this app's loopback callback)
// with ?code=... (and &teamId=... when installed to a team). The code
// exchange step below is unchanged - that part of the flow really is the
// same as the old system.
function buildVercelAuthUrl(slug, state) {
  const params = new URLSearchParams();
  if (state) params.set('state', state);
  const qs = params.toString();
  return `https://vercel.com/integrations/${encodeURIComponent(slug)}/new${qs ? `?${qs}` : ''}`;
}

async function exchangeVercelCode(clientId, clientSecret, code, redirectUri) {
  const res = await fetch('https://api.vercel.com/v2/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error?.message || body.error || `Vercel token exchange failed (HTTP ${res.status})`);
  return body; // { access_token, team_id, user_id, ... }
}

async function getVercelProfile(accessToken) {
  const res = await fetch('https://api.vercel.com/v2/user', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error?.message || `Vercel profile lookup failed (HTTP ${res.status})`);
  return body.user?.username || body.user?.email || '';
}

// Supabase's Management API OAuth2 flow (supabase.com/docs/guides/platform/oauth-apps):
// authorize/token both live under api.supabase.com, token exchange uses HTTP
// Basic auth (client_id:client_secret) rather than form-body credentials.
const SUPABASE_SCOPES = 'all';

function buildSupabaseAuthUrl(clientId, redirectUri) {
  const params = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri,
    response_type: 'code', scope: SUPABASE_SCOPES,
  });
  return `https://api.supabase.com/v1/oauth/authorize?${params}`;
}

async function exchangeSupabaseCode(clientId, clientSecret, code, redirectUri) {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch('https://api.supabase.com/v1/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` },
    body: new URLSearchParams({ code, grant_type: 'authorization_code', redirect_uri: redirectUri }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error_description || body.error || `Supabase token exchange failed (HTTP ${res.status})`);
  return body; // { access_token, refresh_token, expires_in, ... }
}

// Non-git deployment: upload isn't needed for small projects - files are
// inlined as base64 directly in the create-deployment body (Vercel's REST API
// supports both an inline `data`+`encoding` file or a reference to one
// pre-uploaded via /v2/files; inlining avoids a second round-trip per file
// and this app only ever deploys folders small enough for that to be fine).
async function vercelDeploy(accessToken, teamId, projectName, files) {
  // A brand-new project (no projectSettings passed - framework is left to
  // Vercel's own auto-detection) otherwise gets rejected with "projectSettings
  // is required... or use skipAutoDetectionConfirmation=1" on its first-ever
  // deploy, since Vercel wants an explicit confirmation step before it'll
  // guess the framework unattended.
  const params = new URLSearchParams({ skipAutoDetectionConfirmation: '1' });
  if (teamId) params.set('teamId', teamId);
  const res = await fetch(`https://api.vercel.com/v13/deployments${params.toString() ? `?${params}` : ''}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: projectName, target: 'production', files }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error?.message || body.error_description || `Vercel deploy failed (HTTP ${res.status})`);
  return body; // { id, url, readyState, ... }
}

/** Bulk-create/update project env vars - `vars` is [{ key, value }]. `type: 'encrypted'` hides values in the dashboard by default, same as a normal manual entry. */
async function vercelSetEnvVars(accessToken, teamId, projectIdOrName, vars) {
  const params = new URLSearchParams({ upsert: 'true' });
  if (teamId) params.set('teamId', teamId);
  const res = await fetch(`https://api.vercel.com/v10/projects/${encodeURIComponent(projectIdOrName)}/env?${params}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(vars.map((v) => ({
      key: v.key, value: v.value, type: 'encrypted', target: ['production', 'preview', 'development'],
    }))),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error?.message || `Vercel env var update failed (HTTP ${res.status})`);
  return body; // { created, failed: [...] }
}

async function supabaseListOrganizations(accessToken) {
  const res = await fetch('https://api.supabase.com/v1/organizations', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.message || `Supabase organization lookup failed (HTTP ${res.status})`);
  return body; // [{ id, slug, name }]
}

const SUPABASE_PROVISION_POLL_MS = 5000;
const SUPABASE_PROVISION_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Project creation is asynchronous - the initial response comes back
 * `status: "INACTIVE"` while Supabase provisions the database, so this polls
 * until it flips to `ACTIVE_HEALTHY` (or gives up after the timeout; the
 * project still exists at that point, it's just not confirmed ready yet).
 */
async function supabaseCreateProject(accessToken, { name, organizationSlug, dbPass, region = 'us-east-1' }) {
  const res = await fetch('https://api.supabase.com/v1/projects', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    // Despite older docs listing it as optional, the API now rejects project
    // creation without exactly one of region/region_selection set.
    body: JSON.stringify({ name, organization_slug: organizationSlug, db_pass: dbPass, region }),
  });
  let project = await res.json();
  if (!res.ok) throw new Error(project.message || `Supabase project creation failed (HTTP ${res.status})`);

  const ref = project.ref;
  const deadline = Date.now() + SUPABASE_PROVISION_TIMEOUT_MS;
  while (project.status !== 'ACTIVE_HEALTHY' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, SUPABASE_PROVISION_POLL_MS));
    const pr = await fetch(`https://api.supabase.com/v1/projects/${ref}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    project = await pr.json();
    if (!pr.ok) throw new Error(project.message || `Supabase project status check failed (HTTP ${pr.status})`);
  }
  if (project.status !== 'ACTIVE_HEALTHY') {
    throw new Error(`Project ${ref} is still provisioning (status: ${project.status}) after ${SUPABASE_PROVISION_TIMEOUT_MS / 1000}s - it will likely finish shortly; check the Supabase dashboard.`);
  }
  return project; // { ref, name, status, ... }
}

async function supabaseListProjects(accessToken) {
  const res = await fetch('https://api.supabase.com/v1/projects', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.message || `Supabase project list failed (HTTP ${res.status})`);
  return body; // [{ id, organization_id, name, ref, status, region, ... }]
}

/** Permanent, irreversible - Supabase does not soft-delete or restore a removed project. */
async function supabaseDeleteProject(accessToken, ref) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 204 || res.status === 200) return true;
  const body = await res.json().catch(() => ({}));
  throw new Error(body.message || `Supabase project deletion failed (HTTP ${res.status})`);
}

/** anon/public key + project URL + DB connection string. The connection string is built locally (not fetched) since dbPass was chosen by the caller, not returned by the API. */
async function supabaseGetProjectKeys(accessToken, ref, dbPass) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/api-keys?reveal=true`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const keys = await res.json();
  if (!res.ok) throw new Error(keys.message || `Supabase API key lookup failed (HTTP ${res.status})`);
  const anon = keys.find((k) => /^anon$/i.test(k.name || '') || /anon|publishable/i.test(k.name || k.type || ''));
  if (!anon?.api_key) throw new Error(`Project ${ref} has no anon/public key yet - it may still be finishing setup.`);
  return {
    url: `https://${ref}.supabase.co`,
    anonKey: anon.api_key,
    databaseUrl: `postgresql://postgres:${dbPass}@db.${ref}.supabase.co:5432/postgres`,
  };
}

/** Supabase OAuth access tokens expire; the refresh token doesn't (until revoked). */
async function refreshSupabaseToken(clientId, clientSecret, refreshToken) {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch('https://api.supabase.com/v1/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error_description || body.error || `Supabase token refresh failed (HTTP ${res.status})`);
  return body; // { access_token, refresh_token, expires_in }
}

const API_TIMEOUT_MS = 60_000;

/**
 * Generic authenticated JSON call used by the agent's full-access tools
 * (supabase_api / vercel_api). Returns { ok, status, body } and never throws
 * for an HTTP error - the status and the provider's own error body are
 * exactly what the agent needs to see to fix its request.
 */
async function apiCall(base, accessToken, method, apiPath, body, query) {
  const cleanPath = '/' + String(apiPath || '').replace(/^\/+/, '');
  const url = new URL(base + cleanPath);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '' && !url.searchParams.has(k)) url.searchParams.set(k, v);
  }
  const init = {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  };
  if (body !== undefined && body !== null && body !== '' && method !== 'GET' && method !== 'HEAD') {
    init.headers['Content-Type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let parsed = text;
  try { parsed = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, body: parsed, url: url.toString() };
}

function supabaseApi(accessToken, method, apiPath, body) {
  return apiCall('https://api.supabase.com', accessToken, method, apiPath, body);
}

/** Runs SQL against a project's Postgres through the Management API. */
function supabaseQuery(accessToken, ref, query) {
  return apiCall('https://api.supabase.com', accessToken, 'POST', `/v1/projects/${encodeURIComponent(ref)}/database/query`, { query });
}

/** teamId is appended automatically when the connection was installed to a team. */
function vercelApi(accessToken, teamId, method, apiPath, body) {
  return apiCall('https://api.vercel.com', accessToken, method, apiPath, body, { teamId });
}

// GitHub's standard OAuth Apps flow (docs.github.com/apps/oauth-apps) - much
// simpler registration than Vercel/Supabase: no scopes picker or store
// listing, just a name + callback URL. `repo` scope is what lets
// githubCreateRepo actually create repositories under the connected account.
// `workflow` lets Craft Cloud write craft-cloud.yml into the user's private mirror repo.
const GITHUB_SCOPES = 'repo gist workflow';

function buildGithubAuthUrl(clientId, redirectUri, state) {
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, scope: GITHUB_SCOPES });
  if (state) params.set('state', state);
  return `https://github.com/login/oauth/authorize?${params}`;
}

async function exchangeGithubCode(clientId, clientSecret, code, redirectUri) {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
  });
  const body = await res.json();
  if (!res.ok || body.error) throw new Error(body.error_description || body.error || `GitHub token exchange failed (HTTP ${res.status})`);
  return body; // { access_token, scope, token_type }
}

async function getGithubProfile(accessToken) {
  const res = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json' },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.message || `GitHub profile lookup failed (HTTP ${res.status})`);
  return body.login || '';
}

/** Creates a new repo under the connected user's account. Defaults to private - safer for an arbitrary local folder than defaulting public. */
async function githubCreateRepo(accessToken, name, { private: isPrivate = true } = {}) {
  const res = await fetch('https://api.github.com/user/repos', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ name, private: isPrivate }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.message || `GitHub repo creation failed (HTTP ${res.status})`);
  return body; // { name, full_name, html_url, clone_url, default_branch, ... }
}

module.exports = {
  buildGmailAuthUrl, exchangeGmailCode, refreshGmailToken, getGmailProfile, gmailSend, gmailSearch, gmailCreateDraft, gmailError,
  calendarListEvents, calendarInsertEvent, calendarError, GOOGLE_SCOPE,
  buildSlackAuthUrl, exchangeSlackCode, slackPostMessage, slackListChannels, slackJoinChannel,
  buildVercelAuthUrl, exchangeVercelCode, getVercelProfile, vercelDeploy, vercelSetEnvVars,
  buildSupabaseAuthUrl, exchangeSupabaseCode, refreshSupabaseToken, supabaseListOrganizations, supabaseCreateProject, supabaseGetProjectKeys,
  supabaseListProjects, supabaseDeleteProject, supabaseApi, supabaseQuery, vercelApi,
  buildGithubAuthUrl, exchangeGithubCode, getGithubProfile, githubCreateRepo,
};
