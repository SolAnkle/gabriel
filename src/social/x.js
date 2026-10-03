// Minimal X API v2 client. Writes use OAuth 1.0a user context; reads use the app bearer token.
// In dry-run mode nothing is sent: posts get a fake id and live only on the public ledger.
import crypto from 'node:crypto';
import { config } from '../config.js';

const API = 'https://api.x.com/2';

const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** OAuth 1.0a header. JSON bodies are not part of the signature, only URL query params are. */
export function oauthHeader(method, url, { apiKey, apiSecret, accessToken, accessSecret }, nonce = crypto.randomBytes(16).toString('hex'), timestamp = Math.floor(Date.now() / 1000).toString()) {
  const u = new URL(url);
  const oauth = {
    oauth_consumer_key: apiKey, oauth_nonce: nonce, oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp, oauth_token: accessToken, oauth_version: '1.0',
  };
  const params = [...Object.entries(oauth), ...u.searchParams.entries()].map(([k, v]) => [enc(k), enc(v)]).sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1));
  const base = [method.toUpperCase(), enc(`${u.origin}${u.pathname}`), enc(params.map(([k, v]) => `${k}=${v}`).join('&'))].join('&');
  const signature = crypto.createHmac('sha1', `${enc(apiSecret)}&${enc(accessSecret)}`).update(base).digest('base64');
  return 'OAuth ' + Object.entries({ ...oauth, oauth_signature: signature }).map(([k, v]) => `${enc(k)}="${enc(v)}"`).join(', ');
}

async function xFetch(method, path, { body, auth = 'user' } = {}) {
  const url = `${API}${path}`;
  const headers = { 'content-type': 'application/json' };
  headers.authorization = auth === 'bearer' ? `Bearer ${config.x.bearerToken}` : oauthHeader(method, url, config.x);
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`X ${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

export const canRead = () => Boolean(config.x.bearerToken && config.x.userId);
export const canWrite = () => config.xMode === 'live' && Boolean(config.x.apiKey && config.x.apiSecret && config.x.accessToken && config.x.accessSecret);

/** Posts a tweet, reply (replyTo) or quote (quoteOf). Returns { id, url, dryRun }. */
export async function postTweet(text, { replyTo, quoteOf } = {}) {
  if (!canWrite()) {
    const id = `dry-${Date.now().toString(36)}`;
    return { id, url: null, dryRun: true };
  }
  const body = { text };
  if (replyTo) body.reply = { in_reply_to_tweet_id: replyTo };
  if (quoteOf) body.quote_tweet_id = quoteOf;
  const res = await xFetch('POST', '/tweets', { body });
  return { id: res.data.id, url: `https://x.com/i/status/${res.data.id}`, dryRun: false };
}

const TWEET_FIELDS = 'tweet.fields=created_at,author_id,conversation_id,public_metrics,referenced_tweets&expansions=author_id&user.fields=username,public_metrics';

function normalize(res) {
  const users = Object.fromEntries((res.includes?.users || []).map((u) => [u.id, u]));
  return (res.data || []).map((t) => ({
    id: t.id, text: t.text, createdAt: t.created_at, conversationId: t.conversation_id,
    authorId: t.author_id, author: users[t.author_id]?.username || t.author_id,
    authorFollowers: users[t.author_id]?.public_metrics?.followers_count ?? null,
    metrics: t.public_metrics || {},
  }));
}

export async function fetchMentions(sinceId) {
  if (!canRead()) return [];
  const q = `${TWEET_FIELDS}&max_results=50${sinceId ? `&since_id=${sinceId}` : ''}`;
  return normalize(await xFetch('GET', `/users/${config.x.userId}/mentions?${q}`, { auth: 'bearer' }));
}

/** Recent original posts from the KOLs the agent follows. */
export async function fetchWatchedPosts(handles, sinceId) {
  if (!canRead() || !handles.length) return [];
  const query = encodeURIComponent(`(${handles.map((h) => `from:${h}`).join(' OR ')}) -is:retweet -is:reply`);
  const q = `query=${query}&${TWEET_FIELDS}&max_results=25${sinceId ? `&since_id=${sinceId}` : ''}`;
  return normalize(await xFetch('GET', `/tweets/search/recent?${q}`, { auth: 'bearer' }));
}

/** Engagement on our own recent posts, for reflection. */
export async function fetchMetrics(ids) {
  const real = ids.filter((id) => !id.startsWith('dry-'));
  if (!canRead() || !real.length) return {};
  const res = await xFetch('GET', `/tweets?ids=${real.slice(0, 100).join(',')}&tweet.fields=public_metrics`, { auth: 'bearer' });
  return Object.fromEntries((res.data || []).map((t) => [t.id, t.public_metrics]));
}
