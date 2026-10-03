// Periodic self-review. Code measures repetition and "AI-ness"; the model reads the numbers plus its
// own posts and results, and writes a few bounded style notes. Notes adjust the voice; they can't
// rewrite the identity.
import { load, update, record } from '../store.js';
import { think, obj, str, arr } from './llm.js';
import { identityLayer, voiceLayer } from './persona.js';
import { similarity, stylometrics, genericAiTells, words } from './style.js';
import { fetchMetrics } from '../social/x.js';

const MAX_VOICE_NOTES = 12;
const COMMON_FIRST_WORDS = new Set(['i', 'the', 'a', 'my', 'this', 'it', 'is', 'just', 'so', 'when']);

export function repetitionReport(texts) {
  let pairs = 0, simSum = 0, nearDupes = 0;
  for (let i = 0; i < texts.length; i++)
    for (let j = i + 1; j < texts.length; j++) {
      const s = similarity(texts[i], texts[j]);
      simSum += s;
      pairs++;
      if (s > 0.5) nearDupes++;
    }
  // Verbal tics: the same first word or first two words over and over.
  const openers = new Map();
  const bump = (o) => o && openers.set(o, (openers.get(o) || 0) + 1);
  for (const t of texts) {
    const w = words(t);
    if (w[0] && !COMMON_FIRST_WORDS.has(w[0])) bump(w[0]);
    if (w.length > 1) bump(w.slice(0, 2).join(' '));
  }
  return {
    avgPairwiseSimilarity: pairs ? Math.round((simSum / pairs) * 1000) / 1000 : 0,
    nearDuplicatePairs: nearDupes,
    repeatedOpeners: [...openers.entries()].filter(([, c]) => c >= 3).map(([o, c]) => `${o} (${c}x)`),
    genericAiPosts: texts.filter((t) => genericAiTells(t).length).length,
  };
}

export async function reflect() {
  const posts = load('social').posts.slice(-50);
  if (posts.length < 5) {
    record('reflection', 'Not enough posts to reflect on yet');
    return null;
  }
  const texts = posts.map((p) => p.text.replace(/\n\n\[holding.*\]$/s, ''));
  const repetition = repetitionReport(texts);
  const stats = stylometrics(texts);
  const targets = load('kols').synthesis?.voiceTargets || null;
  let metrics = {};
  try {
    metrics = await fetchMetrics(posts.map((p) => p.id));
  } catch (err) {
    console.warn('engagement fetch failed:', err.message);
  }
  const withEngagement = posts.map((p) => ({ text: p.text.slice(0, 200), action: p.action, likes: metrics[p.id]?.like_count ?? null, replies: metrics[p.id]?.reply_count ?? null }));
  const { closed } = load('portfolio');
  const { jokes, predictions } = load('memory');

  const out = await think({
    label: 'reflection', effort: 'high',
    system: [identityLayer(), voiceLayer()],
    prompt: `Time to look at yourself honestly.

Repetition metrics (code-measured): ${JSON.stringify(repetition)}
Your writing stats: ${JSON.stringify({ ...stats, topWords: stats.topWords.slice(0, 15) })}
Targets from your influences: ${JSON.stringify(targets)}
Your last ${posts.length} posts with engagement (null = unknown):
${withEngagement.map((p, i) => `${i + 1}. [${p.action}] ${p.text} (likes ${p.likes}, replies ${p.replies})`).join('\n')}
Closed trades: ${JSON.stringify(closed.slice(-15).map((c) => ({ token: c.symbol, pnlPct: Math.round(c.pnlPct * 100), thesis: c.thesis, why: c.exitReason })))}
Running jokes: ${JSON.stringify(jokes.slice(-10))}
Open predictions: ${JSON.stringify(predictions.filter((p) => !p.resolved).slice(-10))}

Answer: Am I repetitive? Which posts sounded like generic AI? Which jokes worked? Which predictions or trades were wrong and why?
Then give at most 3 concrete style adjustments (how to write, not who to be), and any jokes to retire.`,
    schema: obj({
      publicSummary: str('2-3 sentences in your voice for the public feed'),
      repetitive: str(), soundedGeneric: arr(str()), jokesThatWorked: arr(str()), jokesToRetire: arr(str()),
      wrongCalls: arr(str()), tradingLessons: arr(str()), styleAdjustments: arr(str(), 'max 3'),
    }),
    offline: () => ({
      publicSummary: `read my last ${posts.length} posts. ${repetition.nearDuplicatePairs ? 'i repeat myself. fixing it' : 'not repeating myself yet. suspicious'}`,
      repetitive: repetition.nearDuplicatePairs ? 'yes' : 'no', soundedGeneric: [], jokesThatWorked: [], jokesToRetire: [],
      wrongCalls: closed.filter((c) => c.pnlPct < 0).map((c) => `$${c.symbol}`), tradingLessons: [], styleAdjustments: repetition.repeatedOpeners.length ? [`stop opening with "${repetition.repeatedOpeners[0].split(' (')[0]}"`] : [],
    }),
  });

  const at = new Date().toISOString();
  update('memory', (m) => {
    for (const note of out.styleAdjustments.slice(0, 3)) m.voiceNotes.push({ at, note });
    if (m.voiceNotes.length > MAX_VOICE_NOTES) m.voiceNotes.splice(0, m.voiceNotes.length - MAX_VOICE_NOTES);
    m.lessons.push({ at, wrongCalls: out.wrongCalls, tradingLessons: out.tradingLessons });
    const retire = new Set(out.jokesToRetire.map((j) => j.toLowerCase()));
    m.jokes = m.jokes.filter((j) => !retire.has(j.text.toLowerCase()));
  });
  record('reflection', out.publicSummary, { repetition, styleAdjustments: out.styleAdjustments, wrongCalls: out.wrongCalls, lessons: out.tradingLessons });
  return out;
}
