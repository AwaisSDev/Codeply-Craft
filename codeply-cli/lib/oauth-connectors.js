/**
 * Codeply — Gmail and Slack OAuth + the real API calls the agent's tools use.
 *
 * Desktop-app OAuth (RFC 8252): the consent screen opens in the user's real
 * system browser, not an embedded webview, and the redirect is caught by a
 * short-lived local HTTP server on a fixed loopback port — Real App/main.js
 * owns spinning that server up/down; this file only builds URLs and talks to
 * the providers' token/API endpoints. No secrets are ever logged.
 */
const GMAIL_SCOPES = 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send';
// channels:join is what lets slackPostMessage auto-join a public channel
// before posting to it — without it, chat:write alone only covers channels
// the app has already been manually invited into.
const SLACK_SCOPES = 'chat:write,channels:read,channels:history,channels:join';
// Separate from the bot scopes above — Slack issues bot and user tokens
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
  const body = await res.json();
  if (!res.ok) throw new Error(body.error_description || body.error || `Gmail token refresh failed (HTTP ${res.status})`);
  return body; // { access_token, expires_in, ... } — no new refresh_token on refresh
}

async function getGmailProfile(accessToken) {
  const res = await fetch('https://www.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error?.message || `Gmail profile lookup failed (HTTP ${res.status})`);
  return body.emailAddress;
}

function base64UrlEncode(str) {
  return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function gmailSend(accessToken, { to, subject, body }) {
  const raw = base64UrlEncode(`To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n${body}`);
  const res = await fetch('https://www.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Gmail send failed (HTTP ${res.status})`);
  return data; // { id, threadId, ... }
}

async function gmailSearch(accessToken, query, maxResults = 10) {
  const params = new URLSearchParams({ q: query, maxResults: String(maxResults) });
  const res = await fetch(`https://www.googleapis.com/gmail/v1/users/me/messages?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const list = await res.json();
  if (!res.ok) throw new Error(list.error?.message || `Gmail search failed (HTTP ${res.status})`);
  if (!list.messages?.length) return [];
  // The list endpoint only returns bare ids — each result needs its own
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
  // Slack's OAuth endpoint returns HTTP 200 even on failure — ok:false in the body is the real signal.
  if (!body.ok) throw new Error(body.error || 'Slack token exchange failed');
  return body; // { access_token, team: { id, name }, ... }
}

/** Public-channel-only equivalent of clicking "Join channel" in Slack. Idempotent — already_in_channel is fine. */
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
  // joined — not "any public channel" the way a human member can post to.
  // Auto-joining first (public channels only; that's all resolveSlackChannel
  // in tools.mjs ever resolves to) means the agent can post to a channel the
  // very first time it's asked to, instead of failing with not_in_channel
  // until someone manually runs /invite in Slack. Joining a channel it's
  // already in is a harmless no-op (already_in_channel), so this doesn't
  // need to track membership itself — just always try.
  //
  // A user token is different: it posts as an actual workspace member, who
  // either already belongs to the channel or doesn't — conversations.join
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
  // public_channel only — private_channel requires the separate groups:read
  // scope, which isn't part of the bot scope set this app asks for
  // (chat:write, channels:read, channels:history). Slack rejects the WHOLE
  // conversations.list call with missing_scope if any requested type isn't
  // covered, not just the private-channel portion — so asking for a type we
  // don't have scope for breaks lookup even for public channels the bot can
  // see fine, which is exactly what was happening here.
  const res = await fetch('https://slack.com/api/conversations.list?types=public_channel&limit=100', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await res.json();
  if (!body.ok) throw new Error(body.error || 'Slack channel list failed');
  return (body.channels || []).map((c) => ({ id: c.id, name: c.name, isPrivate: c.is_private, isMember: c.is_member }));
}

module.exports = {
  buildGmailAuthUrl, exchangeGmailCode, refreshGmailToken, getGmailProfile, gmailSend, gmailSearch,
  buildSlackAuthUrl, exchangeSlackCode, slackPostMessage, slackListChannels, slackJoinChannel,
};
