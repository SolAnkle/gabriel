// KOL dataset -> behavioural patterns -> one ORIGINAL personality influence spec.
// Input: data/kols/<handle>.json (array of strings or {text, likes, retweets, created_at, in_reply_to})
//    or data/kols/<handle>.txt (one post per line).
// We never ask the model to imitate a person. Each account is reduced to patterns, the patterns are
// blended, and every account's signature phrases are stored so the agent can be blocked from reusing them.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { update, record } from '../store.js';
import { think, obj, str, numb, arr } from './llm.js';
import { stylometrics, signaturePhrases, blendStylometrics } from './style.js';

const SAMPLE_PER_KOL = 80;

export function readKolFiles(dir = config.kolDir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(json|txt)$/.test(f) && !f.startsWith('_'))
    .map((f) => {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8');
      const posts = f.endsWith('.json')
        ? JSON.parse(raw).map((p) => (typeof p === 'string' ? { text: p } : p))
        : raw.split('\n').map((t) => t.trim()).filter(Boolean).map((text) => ({ text }));
      return { handle: path.basename(f).replace(/\.(json|txt)$/, ''), posts: posts.filter((p) => p.text) };
    })
    .filter((k) => k.posts.length);
}

/** Highest-engagement posts first (when we have engagement), plus a spread of the rest. */
function sample(posts, n) {
  const scored = posts.map((p) => ({ p, s: (p.likes || 0) + 2 * (p.retweets || 0) }));
  const top = [...scored].sort((a, b) => b.s - a.s).slice(0, Math.floor(n / 2)).map((x) => x.p);
  const rest = posts.filter((p) => !top.includes(p));
  const step = Math.max(1, Math.floor(rest.length / (n - top.length)));
  return [...top, ...rest.filter((_, i) => i % step === 0)].slice(0, n);
}

const PATTERN_SCHEMA = obj({
  humorStyle: str(), sarcasmLevel: numb('0-10'), aggressiveness: numb('0-10'), confidence: numb('0-10'),
  shitpostShare: numb('0-1 share of posts that are jokes/shitposts'), analysisShare: numb('0-1'),
  onWinning: str('how they act after wins'), onLosing: str(), onCriticism: str(),
  withFollowers: str(), withBiggerAccounts: str(),
  narrativeSpotting: str('how they find and frame narratives'),
  replyTriggers: arr(str(), 'what makes them reply'), ignoreTriggers: arr(str()),
  riskPhilosophy: str(), recurringStructures: arr(str(), 'sentence SHAPES they reuse, described abstractly, not quoted'),
});

export async function analyzeKols() {
  const kols = readKolFiles();
  if (!kols.length) throw new Error(`No KOL files in ${config.kolDir}. See data/kols/README.md`);
  record('kol', `Analyzing ${kols.length} accounts (${kols.reduce((s, k) => s + k.posts.length, 0)} posts)`);

  const accounts = [];
  for (const k of kols) {
    const stats = stylometrics(k.posts);
    const signatures = signaturePhrases(k.posts);
    const posts = sample(k.posts, SAMPLE_PER_KOL).map((p) => p.text.replace(/\s+/g, ' ').slice(0, 400));
    const patterns = await think({
      label: `kol:${k.handle}`,
      effort: 'medium',
      system: [
        'You analyse the posting BEHAVIOUR of a crypto Twitter account for a research dataset. Describe patterns abstractly. Never quote their catchphrases or copy their wording.',
      ],
      prompt: `Writing statistics:\n${JSON.stringify(stats)}\n\nSample posts:\n${posts.map((p, i) => `${i + 1}. ${p}`).join('\n')}`,
      schema: PATTERN_SCHEMA,
      offline: () => offlinePatterns(stats),
    });
    accounts.push({ handle: k.handle, posts: k.posts.length, stats, signatures, patterns });
    record('kol', `Extracted behaviour patterns from ${k.posts.length} posts`, { account: k.handle });
  }

  const blend = blendStylometrics(accounts.map((a) => a.stats));
  const synthesis = await think({
    label: 'kol:synthesis',
    effort: 'high',
    system: [
      'You design an ORIGINAL internet-native crypto personality. You are given behavioural patterns from several accounts. Find what the best-performing traits have in common, keep the contrasts that make a character interesting, and invent something new. The result must not read like any one source account.',
    ],
    prompt: `Blended statistics (min/median/max across accounts):\n${JSON.stringify(blend)}\n\nPer-account patterns:\n${JSON.stringify(accounts.map((a) => a.patterns), null, 1)}`,
    schema: obj({
      sharedTraits: arr(str()), productiveContrasts: arr(str()),
      voiceTargets: obj({
        avgWords: numb(), lowercaseStartRate: numb(), emojiPerPost: numb(), capsWordsPerPost: numb(),
        shitpostShare: numb(), analysisShare: numb(),
      }),
      onWinning: str(), onLosing: str(), onCriticism: str(), withBiggerAccounts: str(),
      replyTriggers: arr(str()), ignoreTriggers: arr(str()), riskPhilosophy: str(),
      avoid: arr(str(), 'patterns that would make the character feel derivative or generic'),
    }),
    offline: () => offlineSynthesis(blend),
  });

  const signatures = [...new Set(accounts.flatMap((a) => a.signatures))];
  update('kols', (s) => Object.assign(s, { analyzedAt: new Date().toISOString(), accounts, blend, signatures, synthesis }));
  record('kol', `Personality influences synthesised; ${signatures.length} signature phrases blocked from reuse`);
  return synthesis;
}

function offlinePatterns(stats) {
  return {
    humorStyle: 'deadpan self-deprecation', sarcasmLevel: 6, aggressiveness: 4, confidence: 7,
    shitpostShare: 0.55, analysisShare: 0.25, onWinning: 'understated flex then a joke at own expense',
    onLosing: 'owns it fast, turns it into a bit', onCriticism: 'one dry line or silence',
    withFollowers: 'warm to regulars, short replies', withBiggerAccounts: 'confident peer, never begging',
    narrativeSpotting: 'notices what people are tired of before they say it',
    replyTriggers: ['a genuinely new idea', 'someone being confidently wrong'], ignoreTriggers: ['engagement bait', 'shill requests'],
    riskPhilosophy: 'small size, many shots, cut losers', recurringStructures: [`~${Math.round(stats.avgWords)} word one-liners`],
  };
}

function offlineSynthesis(blend) {
  return {
    sharedTraits: ['short lowercase posts', 'self-aware about losses', 'narrative over charts'],
    productiveContrasts: ['analytical but unserious', 'confident but self-deprecating'],
    voiceTargets: { avgWords: blend?.avgWords?.median ?? 14, lowercaseStartRate: 0.8, emojiPerPost: 0.2, capsWordsPerPost: 0.2, shitpostShare: 0.5, analysisShare: 0.3 },
    onWinning: 'downplays it', onLosing: 'posts the L publicly with a joke', onCriticism: 'dry one-liner or ignore',
    withBiggerAccounts: 'peer energy', replyTriggers: ['new narrative', 'good joke to build on'], ignoreTriggers: ['bait', 'shill DMs'],
    riskPhilosophy: 'survive first', avoid: ['catchphrases', 'motivational tone', 'hashtags'],
  };
}
