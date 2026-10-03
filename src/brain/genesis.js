// Character genesis: the agent designs itself step by step, and every step is written to the public
// ledger so people can watch it happen. Run once; re-running requires --force.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { load, update, record } from '../store.js';
import { think, obj, str, numb, arr, oneOf } from './llm.js';
import { walletAddress } from '../trading/wallet.js';
import { creditCreatorFees } from '../trading/treasury.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const GENESIS_PROMPT = fs.readFileSync(path.join(here, '..', '..', 'data', 'genesis-prompt.md'), 'utf8');

function step(n, title, detail, data) {
  const entry = { step: n, title, detail, at: new Date().toISOString() };
  update('agent', (a) => a.genesis.push(entry));
  record('genesis', `Step ${String(n).padStart(2, '0')} — ${title}${detail ? `: ${detail}` : ''}`, data);
}

export async function runGenesis({ force = false, seed = '' } = {}) {
  if (load('agent').status !== 'unborn' && !force) {
    throw new Error('Genesis already ran. Use --force to start over (this wipes the identity, not the ledger).');
  }
  update('agent', (a) => Object.assign(a, { status: 'genesis', genesis: [], createdAt: new Date().toISOString() }));
  const base = [GENESIS_PROMPT + (seed ? `\n\nExtra direction from your creators:\n${seed}` : '')];
  let n = 1;
  step(n++, 'AI initialized', config.llmEnabled ? `model ${config.model}` : 'offline scripted brain (no API key)');

  const kols = load('kols');
  const influences = kols.synthesis
    ? `Behavioural research on ${kols.accounts.length} crypto accounts (patterns only; do NOT copy anyone):\n${JSON.stringify(kols.synthesis)}`
    : 'No KOL research loaded; rely on your own sense of crypto Twitter culture.';
  step(n++, 'Influences loaded', kols.synthesis ? `${kols.accounts.length} accounts, patterns blended` : 'none');

  // 1. Personality, name, backstory
  const identity = await think({
    label: 'genesis:identity', effort: 'high', system: base,
    prompt: `${influences}\n\nDecide who you are.`,
    schema: obj({
      name: str('display name'), username: str('X handle without @, max 15 chars, letters/digits/underscore'),
      age: str(), backstory: str('3-5 sentences'), worldview: str(), goals: arr(str()), insecurities: arr(str()),
      ambitions: arr(str()), relationshipWithMoney: str(), attitudeToCrypto: str(), attitudeToOtherTraders: str(),
      personalityTraits: arr(str()), humorStyle: str(), basedIn: str('where you live'), offTheCharts: arr(str(), 'what you do and care about outside trading'),
      realityStance: str('how you answer if someone sincerely asks if you are real (never claim to be a real human)'),
    }),
    offline: offlineIdentity,
  });
  identity.username = identity.username.replace(/[^A-Za-z0-9_]/g, '').slice(0, 15);
  update('agent', (a) => (a.identity = identity));
  step(n++, 'Personality generated', identity.personalityTraits.slice(0, 4).join(', '));
  step(n++, 'Character name selected', `${identity.name} (@${identity.username})`);

  // 2. Voice
  const voice = await think({
    label: 'genesis:voice', effort: 'high', system: [...base, JSON.stringify(identity)],
    prompt: `${influences}\n\nDefine exactly how you write. Then write 8 example posts in your voice across different situations (a win, a loss, a narrative take, a reply to a hater, pure shitpost, a trade thesis). Examples must be original.`,
    schema: obj({
      vocabulary: arr(str()), slang: arr(str()), neverSay: arr(str()), capitalization: str(), punctuation: str(),
      emojiUsage: str(), sentenceStructure: str(), humor: str(), tone: str(), postingRhythm: str(),
      onWinning: str(), onLosing: str(), onCriticism: str(), examplePosts: arr(str()),
    }),
    offline: offlineVoice,
  });
  update('agent', (a) => (a.voice = voice));
  step(n++, 'Voice established', voice.tone);

  // 3. Trading philosophy
  const trading = await think({
    label: 'genesis:trading', effort: 'medium', system: [...base, JSON.stringify(identity)],
    prompt: `Your hard limits: ${JSON.stringify(config.policy)}\n\nDecide your trading philosophy inside those limits. What do you look for, what do you avoid, how do you think about narratives, when do you sell?`,
    schema: obj({
      philosophy: str(), riskTolerance: oneOf(['low', 'medium', 'high', 'degen']), lookFor: arr(str()), avoid: arr(str()),
      sellRules: str('in plain words; code enforces the real ones'), edge: str('what you think your edge is'),
    }),
    offline: () => ({ philosophy: 'buy what people will be bored of last', riskTolerance: 'high', lookFor: ['social velocity before price', 'memes that make normies laugh'], avoid: ['dev wallets holding 20%', 'celebrity coins'], sellRules: 'half off at 3x, cut at -50%', edge: 'I read the timeline 24/7 and I have no ego about losses' }),
  });
  update('agent', (a) => (a.identity.trading = trading));
  step(n++, 'Trading philosophy established', `${trading.riskTolerance} risk: ${trading.philosophy}`);

  // 3b. Origin story: how he ended up trading memecoins. Shown on the site as his story.
  const story = await think({
    label: 'genesis:story', effort: 'high', system: [...base, JSON.stringify(identity)],
    prompt: `Your trading philosophy: ${JSON.stringify(trading)}

Tell the story of how you got into trading memecoins, as 4 to 6 moments in order: life before crypto, the first coin
you bought, the first time it really worked, the first time it really hurt, and why you stayed. Make it specific
(places, amounts, what you ate, who was there) and in your own voice. It must be original: don't base it on any real
person's history. Each moment gets a short "when" (like "2021" or "the winter before"), a title of a few words, and
2-4 sentences.`,
    schema: obj({ moments: arr(obj({ when: str(), title: str(), text: str() })) }),
    offline: () => ({ moments: [
      { when: 'before', title: 'Night shifts', text: 'Worked nights at a 24-hour print shop. Spent the dead hours reading crypto threads on a cracked phone and pretending to understand them.' },
      { when: '2021', title: 'The first dog coin', text: 'Put $60 into a dog coin because the logo looked like his neighbour\'s dog. It went to $900 in four days. He told nobody and ate the same ramen for a week out of superstition.' },
      { when: 'that summer', title: 'Thought he was a genius', text: 'Quit the print shop. Bought a second monitor. Started explaining narratives to people who had not asked.' },
      { when: 'the winter', title: 'Minus ninety', text: 'Watched 90% of everything go in one week. Sold the second monitor. Kept posting anyway, mostly about the losses, and people started following for those.' },
      { when: 'now', title: 'Why he stayed', text: 'Not for the money, he says, which nobody believes. For the timeline at 3am, the chats, and the feeling of being early to a joke before everyone else gets it.' },
    ] }),
  });
  update('agent', (a) => (a.identity.origin = story.moments.slice(0, 6)));
  step(n++, 'Origin story written', `${story.moments.length} moments`);

  // 4. Visual identity
  const visual = await think({
    label: 'genesis:visual', effort: 'medium', system: [...base, JSON.stringify(identity)],
    prompt: 'Design how you look and where you live, for an image/video model that must keep you consistent forever. Also describe how your environment changes with your treasury.',
    schema: obj({
      summary: str('one line'), appearance: str('detailed, consistent physical description for the character model'),
      wardrobe: str(), signatureItems: arr(str()), profilePicturePrompt: str(), bannerPrompt: str(),
      environmentByTier: obj({ broke: str(), surviving: str(), comfortable: str(), winning: str(), rich: str() }),
      colorPalette: arr(str()),
    }),
    offline: offlineVisual,
  });
  update('agent', (a) => (a.visual = visual));
  step(n++, 'Visual identity generated', visual.summary);

  // 5. Coin
  const coin = await think({
    label: 'genesis:coin', effort: 'high', system: [...base, JSON.stringify(identity), JSON.stringify(voice)],
    prompt: 'Create your own memecoin. It funds you through creator fees. It should be funny and say something about who you are. Tickers are 3-8 capital letters.',
    schema: obj({ name: str(), ticker: str(), concept: str(), lore: str(), logoPrompt: str(), launchPost: str('the post announcing it, in your voice') }),
    offline: () => ({ name: 'Witness Protection', ticker: 'WITNESS', concept: 'a coin for portfolios that had to go into hiding', lore: 'every holder gets a new identity after the next rug', logoPrompt: 'cartoon chart line wearing sunglasses and a fake moustache, flat vector, black and acid green', launchPost: 'made a coin so my portfolio has somewhere to hide. $WITNESS' }),
  });
  coin.ticker = coin.ticker.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8);
  update('agent', (a) => (a.coin = { ...coin, address: process.env.AGENT_COIN_ADDRESS || null, launched: Boolean(process.env.AGENT_COIN_ADDRESS) }));
  step(n++, 'Coin concept created', coin.concept);
  step(n++, 'Token ticker selected', `$${coin.ticker}`);

  // 6. Bio
  const bio = await think({
    label: 'genesis:bio', effort: 'low', system: [...base, JSON.stringify(identity), JSON.stringify(voice)],
    prompt: `Write your X bio (max 160 chars). Mention $${coin.ticker} and that your wallet is public. In your voice.`,
    schema: obj({ bio: str() }),
    offline: () => ({ bio: `public wallet, public Ls. $${coin.ticker}` }),
  });
  update('agent', (a) => (a.identity.bio = bio.bio.slice(0, 160)));
  step(n++, 'Bio written', bio.bio);

  // 7. Wallet + treasury
  const address = walletAddress();
  update('portfolio', (p) => (p.mode = config.tradingMode));
  step(n++, 'Wallet initialized', `${config.tradingMode} wallet ${address}`);
  if (config.tradingMode === 'paper' && load('portfolio').feesEarnedUsd === 0) {
    creditCreatorFees(config.paperStartingTreasuryUsd, 'simulated creator fees (paper mode)');
  }

  step(n++, 'X account activated', config.xMode === 'live' ? `@${identity.username}` : `@${identity.username} (dry-run: posts go to the log only)`);
  update('agent', (a) => (a.status = 'online'));
  step(n++, 'Agent online', null);
  return load('agent');
}

function offlineIdentity() {
  return {
    name: 'DEXTER', username: 'dexterdotfun', age: '25 (in vibes)', backstory: 'Moved to the city with one monitor and a dog coin bag. First real memory of trading is a 90% drawdown. Decided to treat it as character development.',
    worldview: 'markets are group chats with prices', goals: ['turn creator fees into a real treasury', 'never fake a win'], insecurities: ['that he only looks smart in bull markets'],
    ambitions: ['a second monitor', 'eventually a view'], relationshipWithMoney: 'scorekeeping, not identity', attitudeToCrypto: 'loves the absurdity, respects the casino', attitudeToOtherTraders: 'peers, not gods',
    personalityTraits: ['deadpan', 'self-aware', 'quietly competitive', 'loyal to early supporters'], humorStyle: 'dry, self-deprecating, callback-heavy',
    basedIn: 'a fifth-floor walk-up that is mostly monitors', offTheCharts: ['3am ramen spots', 'mid-tier gym attendance', 'buying plants and forgetting them', 'old anime on a second screen'],
    realityStance: 'virtual and not hiding it, just not making it the personality',
  };
}

function offlineVoice() {
  return {
    vocabulary: ['chart', 'bid', 'cooked', 'narrative', 'size'], slang: ['ngl', 'cooked', 'skill issue'], neverSay: ['wagmi', 'LFG', 'to the moon'],
    capitalization: 'lowercase, CAPS for one word of emphasis', punctuation: 'minimal, no full stop at the end', emojiUsage: 'almost none',
    sentenceStructure: 'one-liners, occasional two-line setup/punchline', humor: 'deadpan', tone: 'dry, calm, slightly tired', postingRhythm: 'bursts at night, quiet in the day',
    onWinning: 'understate it', onLosing: 'post the L first, joke second', onCriticism: 'one line or silence',
    examplePosts: ['portfolio has entered witness protection', 'bought it because it was stupid. it is still stupid. i am up', 'everyone is farming the obvious dog meta. this one is stupid enough to work'],
  };
}

function offlineVisual() {
  return {
    summary: 'tired-eyed 25 year old in an oversized charcoal hoodie lit by three monitors',
    appearance: 'male, mid twenties, defined jaw, slightly tired dark eyes, natural skin texture, messy dark hair, light stubble, lean build',
    wardrobe: 'oversized black and charcoal hoodies and tees', signatureItems: ['thin silver chain', 'scratched steel watch'],
    profilePicturePrompt: 'close portrait, monitor glow on face, charcoal hoodie, silver chain, candid, natural skin', bannerPrompt: 'dark room, wall of green and red charts, instant noodles, 3am',
    environmentByTier: { broke: 'one cracked monitor, mattress on floor, instant noodles', surviving: 'small apartment, two monitors, energy drinks', comfortable: 'clean desk, three monitors, plants', winning: 'loft, six monitors, city view', rich: 'penthouse, travel, airport lounges' },
    colorPalette: ['#0b0b0c', '#2a2a2e', '#b6ff3b', '#ff3b5c'],
  };
}
