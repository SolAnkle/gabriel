// Turns the stored identity, voice and memory into prompt layers. The brain is split into parts
// (identity / voice / memory / policy) rather than one giant prompt, and the stable parts come
// first so they're prompt-cached across calls.
import { load } from '../store.js';
import { config } from '../config.js';

export function identityLayer() {
  const { identity, coin, visual } = load('agent');
  if (!identity) return 'You are an autonomous memecoin trader that has not finished genesis yet.';
  return `# WHO YOU ARE
${JSON.stringify({ ...identity, coin: coin && { name: coin.name, ticker: coin.ticker, concept: coin.concept } , look: visual?.summary }, null, 1)}

You are a virtual character with a public wallet. Stay in character: no talk of models, prompts or being software.
Never claim to be a real human; if someone sincerely asks, you're a virtual character. Never impersonate a real person,
never promise returns, never tell anyone to buy something. You can have opinions about tokens; the rules decide money.`;
}

export function voiceLayer() {
  const { voice } = load('agent');
  const { voiceNotes } = load('memory');
  if (!voice) return '';
  const notes = voiceNotes.slice(-12).map((n) => `- ${n.note}`).join('\n');
  return `# HOW YOU WRITE
${JSON.stringify(voice, null, 1)}
${notes ? `\nAdjustments from your own reflection (newest last):\n${notes}` : ''}

Hard rules for every post: under 280 characters unless it's a thread; no hashtags; no em dashes; no "let's dive in",
"buckle up", "game changer", "delve" or assistant phrasing; never reuse a joke you used in the last week.`;
}

export function policyLayer() {
  const p = config.policy;
  return `# YOUR LIMITS (enforced by code, not by you)
Max trade $${p.maxTradeUsd} or ${p.maxTradePctOfTreasury * 100}% of treasury. Max position ${p.maxPositionPctOfTreasury * 100}% of treasury.
Min liquidity $${p.minLiquidityUsd}. Stop loss ${p.stopLossPct * 100}%. Treasury split: ${Object.entries(p.buckets).map(([k, v]) => `${k} ${v * 100}%`).join(', ')}.
You can want things; the rules decide what actually happens.`;
}

/** Everything the agent knows about one person. */
export function personContext(handle) {
  const person = load('memory').people[handle?.toLowerCase()];
  if (!person) return `You have never interacted with @${handle}.`;
  const last = person.interactions.slice(-8).map((i) => `${i.at.slice(0, 10)} ${i.direction}: ${i.text}`).join('\n');
  return `What you remember about @${person.handle}: sentiment ${person.sentiment} (-5..5), tags ${person.tags.join(', ') || 'none'}.
${person.notes.slice(-5).map((n) => `- ${n}`).join('\n')}
Recent interactions:\n${last || 'none'}`;
}

export function portfolioContext() {
  const pf = load('portfolio');
  const open = pf.positions.map((p) => {
    const pnl = p.lastPrice && p.entryPrice ? ((p.lastPrice / p.entryPrice - 1) * 100).toFixed(0) : '?';
    return `$${p.symbol} (${pnl}%)`;
  });
  const lastClosed = pf.closed.slice(-3).map((p) => `$${p.symbol} ${p.pnlPct >= 0 ? '+' : ''}${(p.pnlPct * 100).toFixed(0)}%`);
  return `Holding: ${open.join(', ') || 'nothing'}. Recently closed: ${lastClosed.join(', ') || 'nothing'}.`;
}

export function recentPostsContext(n = 15) {
  const posts = load('social').posts.slice(-n).map((p) => `- ${p.text}`);
  return posts.length ? `Your last posts (don't repeat yourself):\n${posts.join('\n')}` : 'You have not posted yet.';
}

export function jokesContext() {
  const jokes = load('memory').jokes.slice(-8).map((j) => `- ${j.text} (used ${j.uses}x)`);
  return jokes.length ? `Running bits you can call back to (sparingly):\n${jokes.join('\n')}` : '';
}
