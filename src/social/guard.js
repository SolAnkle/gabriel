// Deterministic checks every outgoing post must pass. The model writes; this decides if it ships.
// Pure functions taking explicit state, so they're unit tested.
import { genericAiTells, borrowedSignatures, maxSimilarity } from '../brain/style.js';

const DAY_MS = 86_400_000;

// Wording that turns commentary into a solicitation or a promise.
const SOLICITATION = [
  /\b(you should|everyone should|go) (buy|ape|aping)\b/i, /\bbuy (now|this|it now)\b/i, /\bguarantee[ds]?\b/i,
  /\bcan'?t lose\b/i, /\brisk[- ]free\b/i, /\b(\d+)x (guaranteed|easy|incoming)\b/i, /\bnot a rug\b/i, /\bfree money\b/i,
];

/** Tickers ($ABC) and contract addresses in a post. */
export function mentionedTokens(text) {
  const tickers = [...text.matchAll(/\$([A-Za-z][A-Za-z0-9]{1,9})\b/g)].map((m) => m[1].toUpperCase());
  const addresses = [...text.matchAll(/(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])|0x[a-fA-F0-9]{40}/g)].map((m) => m[0]);
  return { tickers, addresses };
}

/**
 * Adds a holding disclosure when the post names a token the agent holds (or its own coin).
 * Returns { text, disclosed: [symbols] }.
 */
export function applyDisclosure(text, positions, ownCoin, aboutAddresses = []) {
  const { tickers, addresses } = mentionedTokens(text);
  // `aboutAddresses`: tokens the post is about even if it doesn't name them (e.g. a post triggered by a buy).
  const held = positions.filter((p) => tickers.includes(String(p.symbol).toUpperCase()) || addresses.includes(p.address) || aboutAddresses.includes(p.address));
  const syms = held.map((p) => `$${String(p.symbol).toUpperCase()}`);
  if (ownCoin?.ticker && tickers.includes(ownCoin.ticker.toUpperCase())) syms.push(`$${ownCoin.ticker.toUpperCase()} (my coin)`);
  if (!syms.length) return { text, disclosed: [] };
  const unique = [...new Set(syms)];
  return { text: `${text}\n\n[holding ${unique.join(', ')}]`, disclosed: unique };
}

/**
 * @param {object} draft  { action: 'POST'|'REPLY'|'QUOTE', text, target? (handle) }
 * @param {object} state  { posts: [{at, text, action, target}], signatures: [], limits, now }
 * Returns { ok, problems: [] }
 */
export function checkPost(draft, { posts, signatures = [], limits, now = Date.now() }) {
  const problems = [];
  const text = draft.text || '';
  if (!text.trim()) problems.push('empty');
  if (text.length > 280) problems.push(`too long (${text.length} chars)`);
  const tells = genericAiTells(text);
  if (tells.length) problems.push(`sounds like generic AI: ${tells.join(', ')}`);
  const borrowed = borrowedSignatures(text, signatures);
  if (borrowed.length) problems.push(`reuses a real account's signature phrase: "${borrowed[0]}"`);
  if (SOLICITATION.some((re) => re.test(text))) problems.push('reads as telling people to buy or promising returns');

  const recent = posts.filter((p) => now - Date.parse(p.at) < 7 * DAY_MS).map((p) => p.text);
  const sim = maxSimilarity(text, recent);
  if (sim > limits.maxSimilarityToRecent) problems.push(`too similar to a post from this week (${Math.round(sim * 100)}%)`);

  const today = posts.filter((p) => now - Date.parse(p.at) < DAY_MS);
  if (draft.action === 'REPLY') {
    if (today.filter((p) => p.action === 'REPLY').length >= limits.maxRepliesPerDay) problems.push('daily reply limit reached');
    const lastToSame = Math.max(-Infinity, ...posts.filter((p) => p.action === 'REPLY' && p.target && p.target === draft.target).map((p) => Date.parse(p.at)));
    if ((now - lastToSame) / 3_600_000 < limits.replyCooldownHoursPerUser) problems.push(`replied to @${draft.target} recently`);
  } else {
    const originals = today.filter((p) => p.action !== 'REPLY');
    if (originals.length >= limits.maxPostsPerDay) problems.push('daily post limit reached');
    const lastAt = Math.max(-Infinity, ...posts.filter((p) => p.action !== 'REPLY').map((p) => Date.parse(p.at)));
    if ((now - lastAt) / 60_000 < limits.minMinutesBetweenPosts) problems.push('posted too recently');
  }
  return { ok: problems.length === 0, problems };
}

/** Problems a rewrite can fix (as opposed to rate limits, which it can't). */
export const fixable = (problems) => problems.filter((p) => !/limit reached|too recently|replied to @/.test(p));
