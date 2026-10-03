// What the character page shows: which Higgsfield render to put centre stage, and his mood.
// Both are derived from state in code, so the page always matches the wallet.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const MEDIA_RE = /\.(png|webp|jpe?g|gif|mp4|webm)$/i;
export const isVideo = (url) => /\.(mp4|webm)(\?|$)/i.test(url || '');

/**
 * Hero media, best match first:
 *  1. data/character/hero-<tier>.*   (a render per life tier: hero-broke.png, hero-winning.mp4, ...)
 *  2. data/character/hero.*
 *  3. CHARACTER_HERO_URL
 *  4. the newest finished Higgsfield scene
 * Transparent PNG/WebP cut-outs look best: the name sits behind him.
 */
export function heroMedia(tier, scenes = []) {
  const dir = config.characterDir;
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => MEDIA_RE.test(f));
  } catch {}
  const pick = (base) => files.find((f) => path.parse(f).name.toLowerCase() === base);
  const local = pick(`hero-${tier}`) || pick('hero');
  if (local) return { url: `/character/${encodeURIComponent(local)}`, video: isVideo(local), source: 'local' };
  if (config.characterHeroUrl) return { url: config.characterHeroUrl, video: isVideo(config.characterHeroUrl), source: 'url' };
  const scene = scenes.find((s) => s.mediaUrl);
  if (scene) return { url: scene.mediaUrl, video: isVideo(scene.mediaUrl), source: 'scene' };
  return null;
}

/** Extra renders (data/character/*, anything not named hero*) for the gallery strip. */
export function galleryMedia() {
  try {
    return fs.readdirSync(config.characterDir)
      .filter((f) => MEDIA_RE.test(f) && !/^hero/i.test(f))
      .sort()
      .map((f) => ({ url: `/character/${encodeURIComponent(f)}`, video: isVideo(f) }));
  } catch {
    return [];
  }
}

const TIER_MOOD = {
  broke: { word: 'eating noodles', line: 'one monitor, zero excuses' },
  surviving: { word: 'grinding', line: 'still here, which is the whole strategy' },
  comfortable: { word: 'calm', line: 'not up bad, not down bad. just up' },
  winning: { word: 'quietly winning', line: 'trying very hard not to post the PnL' },
  rich: { word: 'insufferable', line: 'has started saying "my team" about two plants' },
};

/**
 * Mood from the last 24h: treasury swing, fresh Ls, what he's doing right now.
 * `snapshots` [{at, treasuryUsd}], `closed` [{closedAt, pnlPct, symbol}], `lastEvent` ledger event.
 */
export function mood({ status, tier, snapshots = [], closed = [], lastEvent, now = Date.now() }) {
  if (status !== 'online') return { word: 'not born yet', line: 'waiting for genesis', tone: 'neutral' };
  const dayAgo = now - 86_400_000;
  const recentL = closed.find((c) => Date.parse(c.closedAt) > dayAgo && c.pnlPct <= -0.4);
  if (recentL) return { word: 'in shambles', line: `still thinking about $${recentL.symbol}`, tone: 'down' };
  const recentW = closed.find((c) => Date.parse(c.closedAt) > dayAgo && c.pnlPct >= 1);
  if (recentW) return { word: 'acting normal', line: `$${recentW.symbol} did a ${(1 + recentW.pnlPct).toFixed(1)}x. he is fine. totally fine`, tone: 'up' };
  const base = snapshots.find((s) => Date.parse(s.at) >= dayAgo);
  const last = snapshots.at(-1);
  if (base && last && base.treasuryUsd > 0) {
    const change = last.treasuryUsd / base.treasuryUsd - 1;
    if (change >= 0.15) return { word: 'up bad', line: `treasury +${Math.round(change * 100)}% today`, tone: 'up' };
    if (change <= -0.15) return { word: 'down bad', line: `treasury ${Math.round(change * 100)}% today`, tone: 'down' };
  }
  if (lastEvent && now - Date.parse(lastEvent.at) < 15 * 60_000 && ['analysis', 'research', 'policy', 'trade'].includes(lastEvent.type)) {
    return { word: 'locked in', line: 'reading charts nobody asked him to read', tone: 'neutral' };
  }
  return { ...(TIER_MOOD[tier] || TIER_MOOD.surviving), tone: 'neutral' };
}

/** Turns a ledger event into a short third-person "right now" line. */
export function nowLine(e) {
  if (!e) return null;
  const d = e.data || {};
  switch (e.type) {
    case 'analysis': return `looking at $${d.token}… ${String(e.summary).split(': ')[1]?.toLowerCase() || ''}`.trim();
    case 'research': return 'scrolling through new coins';
    case 'trade': return d.side === 'buy' ? `just bought $${d.token}` : `just sold $${d.token}`;
    case 'policy': return d.violations ? `decided to pass on $${d.token}` : `about to buy $${d.token}`;
    case 'social': return d.action === 'REPLY' ? `replying to @${d.target}` : d.action === 'QUOTE' ? `quoting @${d.target}` : 'posting';
    case 'ignore': return 'chose violence (silence)';
    case 'reflection': return 'rereading his old posts';
    case 'content': return 'getting his picture taken';
    case 'fees': return 'counting creator fees';
    case 'genesis': return null;
    case 'guard': return 'deleted a draft';
    default: return null;
  }
}
