// Social engine: for each thing that happened (a trade, a mention, a KOL post, a quiet hour) the agent
// decides POST / REPLY / QUOTE / IGNORE. The model writes; guard.js decides what actually ships.
import { config } from '../config.js';
import { load, update, record } from '../store.js';
import { think, obj, str, numb, arr, oneOf } from '../brain/llm.js';
import { identityLayer, voiceLayer, personContext, portfolioContext, recentPostsContext, jokesContext } from '../brain/persona.js';
import { rememberInteraction, rememberJoke, rememberPrediction } from '../brain/memory.js';
import { checkPost, applyDisclosure, fixable } from './guard.js';
import { postTweet, fetchMentions, fetchWatchedPosts } from './x.js';
import { lifeTier } from '../trading/treasury.js';

const DECISION_SCHEMA = obj({
  action: oneOf(['POST', 'REPLY', 'QUOTE', 'IGNORE']),
  text: str('the post, empty if IGNORE'),
  publicReason: str('one short line for the public activity feed about why you did this (or ignored it)'),
  personNote: str('what to remember about this person, empty if nothing'),
  sentimentDelta: numb('-2..2 how this changed your feelings about them'),
  personTags: arr(str(), 'e.g. supporter, hater, kol, funny, shill'),
  newRunningJoke: str('if this starts a bit you might call back to later, name it; else empty'),
  prediction: str('if you made a checkable prediction, restate it plainly; else empty'),
});

async function decide(situation, { handle, allowed }) {
  return think({
    label: 'social', effort: 'medium',
    system: [identityLayer(), voiceLayer()],
    prompt: `${portfolioContext()}
Your life right now: ${lifeTier()} tier.
${recentPostsContext()}
${jokesContext()}
${handle ? personContext(handle) : ''}

SITUATION:
${situation}

Allowed actions: ${allowed.join(', ')}. IGNORE is often the right call: only speak if you have something genuinely
funny, useful or true to add. Never tell anyone to buy anything. Write like you, not like an assistant.`,
    schema: DECISION_SCHEMA,
    offline: () => offlineDecision(situation, allowed),
  });
}

/** Runs the guard, gives the model one chance to fix fixable problems, then publishes. */
async function publish(decision, { replyTo, quoteOf, target, situation, handle, allowed, aboutAddresses = [] }) {
  const ctx = () => ({ posts: load('social').posts, signatures: load('kols').signatures, limits: config.social });
  let draft = { action: decision.action, text: decision.text.trim(), target };
  let verdict = checkPost(draft, ctx());
  if (!verdict.ok && fixable(verdict.problems).length === verdict.problems.length) {
    const retry = await decide(`${situation}\n\nYour draft was rejected: ${verdict.problems.join('; ')}. Draft: "${draft.text}". Rewrite it or IGNORE.`, { handle, allowed });
    if (retry.action === 'IGNORE') return logIgnore(retry, target);
    draft = { action: retry.action, text: retry.text.trim(), target };
    decision = retry;
    verdict = checkPost(draft, ctx());
  }
  if (!verdict.ok) {
    record('guard', `Blocked a ${draft.action.toLowerCase()}: ${verdict.problems.join('; ')}`, { action: draft.action, target });
    return null;
  }

  const { positions } = load('portfolio');
  const { coin } = load('agent');
  const disclosed = applyDisclosure(draft.text, positions, coin, aboutAddresses);
  if (disclosed.text.length > 280) {
    record('guard', `Blocked a ${draft.action.toLowerCase()}: no room for the holding disclosure`, { target });
    return null;
  }

  let sent;
  try {
    sent = await postTweet(disclosed.text, { replyTo: draft.action === 'REPLY' ? replyTo : undefined, quoteOf: draft.action === 'QUOTE' ? quoteOf : undefined });
  } catch (err) {
    record('error', `Posting failed: ${err.message}`);
    return null;
  }
  const post = { id: sent.id, url: sent.url, at: new Date().toISOString(), action: draft.action, text: disclosed.text, target: target || null, disclosed: disclosed.disclosed, dryRun: sent.dryRun };
  update('social', (s) => {
    s.posts.push(post);
    if (s.posts.length > 1000) s.posts.splice(0, s.posts.length - 1000);
  });
  // Anti pump-and-dump: once the agent talks about a token it holds, it can't take profit on it for a while.
  update('portfolio', (p) => {
    for (const pos of p.positions) if (disclosed.disclosed.includes(`$${String(pos.symbol).toUpperCase()}`)) pos.lastMentionedAt = post.at;
  });
  const verb = { POST: 'Posted', REPLY: `Replied to @${target}`, QUOTE: `Quoted @${target}` }[draft.action];
  record('social', `${verb}${sent.dryRun ? ' (dry-run)' : ''}: "${disclosed.text}"`, { ...post, why: decision.publicReason });
  if (decision.newRunningJoke) rememberJoke(decision.newRunningJoke);
  if (decision.prediction) rememberPrediction(decision.prediction);
  return post;
}

function logIgnore(decision, target) {
  update('social', (s) => {
    s.decisions.push({ at: new Date().toISOString(), action: 'IGNORE', target: target || null, why: decision.publicReason });
    if (s.decisions.length > 500) s.decisions.splice(0, s.decisions.length - 500);
  });
  record('ignore', `${target ? `Ignored @${target}` : 'Stayed quiet'}: ${decision.publicReason}`);
  return null;
}

async function handle(situation, opts) {
  const decision = await decide(situation, opts);
  if (opts.handle) {
    rememberInteraction(opts.handle, { direction: 'them', text: opts.theirText || '', tweetId: opts.replyTo, sentimentDelta: decision.sentimentDelta, note: decision.personNote || undefined, tags: decision.personTags });
  }
  if (decision.action === 'IGNORE' || !opts.allowed.includes(decision.action)) return logIgnore(decision, opts.target);
  const post = await publish(decision, { ...opts, situation });
  if (post && opts.handle) rememberInteraction(opts.handle, { direction: 'me', text: post.text, tweetId: post.id });
  return post;
}

const describeEvent = {
  trade: (d) => `You just bought $${d.usd.toFixed(0)} of $${d.token}. Your thesis: "${d.thesis}". Narrative: ${d.narrative}. You may post about it (the holding disclosure is added automatically).`,
  exit: (d) => `You just closed $${d.token} at ${(d.pnlPct * 100).toFixed(0)}% (${d.reason}). Your post-mortem: "${d.postMortem}". Posting your Ls matters as much as your Ws.`,
  fees: (d) => `Your coin earned $${d.usd.toFixed(2)} in creator fees.`,
  life: (d) => `Your life tier changed from ${d.from} to ${d.to}.`,
};

export async function socialTick() {
  // 1. Things the agent did.
  const queue = update('social', (s) => s.queue.splice(0));
  for (const item of queue) {
    const situation = describeEvent[item.kind]?.(item.data);
    if (situation) await handle(situation, { allowed: ['POST', 'IGNORE'], aboutAddresses: item.data.address ? [item.data.address] : [] });
  }

  // 2. Mentions and replies.
  const social = load('social');
  let mentions = [];
  try {
    mentions = await fetchMentions(social.lastMentionId);
  } catch (err) {
    record('error', `Reading mentions failed: ${err.message}`);
  }
  for (const t of mentions.reverse()) {
    if (social.seenTweetIds.includes(t.id)) continue;
    markSeen(t.id, 'mention');
    await handle(`@${t.author} (${t.authorFollowers ?? '?'} followers) said to you: "${t.text}"`, {
      allowed: ['REPLY', 'IGNORE'], handle: t.author, target: t.author, replyTo: t.id, theirText: t.text,
    });
  }

  // 3. KOLs the agent follows.
  let watched = [];
  try {
    watched = await fetchWatchedPosts(config.x.watchHandles, social.lastWatchedId);
  } catch (err) {
    record('error', `Reading watched accounts failed: ${err.message}`);
  }
  for (const t of watched.reverse().slice(-5)) {
    if (social.seenTweetIds.includes(t.id)) continue;
    markSeen(t.id, 'watched');
    await handle(`@${t.author} (${t.authorFollowers ?? '?'} followers) posted: "${t.text}". Do you have something interesting to add?`, {
      allowed: ['REPLY', 'QUOTE', 'IGNORE'], handle: t.author, target: t.author, replyTo: t.id, quoteOf: t.id, theirText: t.text,
    });
  }

  // 4. Nothing happened? Maybe say something, maybe not.
  const lastOriginal = load('social').posts.filter((p) => p.action !== 'REPLY').at(-1);
  const quietHours = lastOriginal ? (Date.now() - Date.parse(lastOriginal.at)) / 3_600_000 : Infinity;
  if (!queue.length && quietHours > 3) {
    await handle(`You haven't posted in ${Number.isFinite(quietHours) ? Math.round(quietHours) + ' hours' : 'ever'}. Post only if you actually have a thought (market take, narrative, joke, life update).`, { allowed: ['POST', 'IGNORE'] });
  }
}

function markSeen(id, kind) {
  update('social', (s) => {
    s.seenTweetIds.push(id);
    if (s.seenTweetIds.length > 2000) s.seenTweetIds.splice(0, s.seenTweetIds.length - 2000);
    // X ids are numeric strings; compare by length then lexically.
    const newer = (a, b) => !b || a.length > b.length || (a.length === b.length && a > b);
    if (kind === 'mention' && newer(id, s.lastMentionId)) s.lastMentionId = id;
    if (kind === 'watched' && newer(id, s.lastWatchedId)) s.lastWatchedId = id;
  });
}

function offlineDecision(situation, allowed) {
  const lines = {
    bought: 'everyone is farming the obvious dog meta. this one is stupid enough to work',
    closed: situation.includes('-') ? 'took the L. thesis was wrong, size was right' : 'closed it. not greedy, just tired',
    quiet: 'charts are doing the thing where nothing happens loudly',
  };
  if (/bought/.test(situation) && allowed.includes('POST')) return { action: 'POST', text: lines.bought, publicReason: 'explaining a new position', personNote: '', sentimentDelta: 0, personTags: [], newRunningJoke: '', prediction: '' };
  if (/closed/.test(situation) && allowed.includes('POST')) return { action: 'POST', text: lines.closed, publicReason: 'posting the result, win or lose', personNote: '', sentimentDelta: 0, personTags: [], newRunningJoke: '', prediction: '' };
  if (/haven't posted/.test(situation)) return { action: 'POST', text: lines.quiet, publicReason: 'quiet market, one thought', personNote: '', sentimentDelta: 0, personTags: [], newRunningJoke: '', prediction: '' };
  return { action: 'IGNORE', text: '', publicReason: 'nothing to add', personNote: '', sentimentDelta: 0, personTags: [], newRunningJoke: '', prediction: '' };
}
