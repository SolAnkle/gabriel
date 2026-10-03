// Deterministic text analysis: KOL stylometrics, similarity checks, and "sounds like AI" filters.
// No model calls here, so these numbers are reproducible and cheap to run on thousands of posts.

const EMOJI_RE = /\p{Extended_Pictographic}/gu;
const WORD_RE = /[\p{L}\p{N}$'@#]+/gu;

export function words(text) {
  return (text.toLowerCase().match(WORD_RE) || []).filter(Boolean);
}

export function ngrams(tokens, n) {
  const out = [];
  for (let i = 0; i + n <= tokens.length; i++) out.push(tokens.slice(i, i + n).join(' '));
  return out;
}

/** Jaccard similarity of word trigrams (falls back to words for very short texts). */
export function similarity(a, b) {
  const wa = words(a);
  const wb = words(b);
  const n = Math.min(wa.length, wb.length) >= 6 ? 3 : 1;
  const sa = new Set(ngrams(wa, n));
  const sb = new Set(ngrams(wb, n));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const g of sa) if (sb.has(g)) inter++;
  return inter / (sa.size + sb.size - inter);
}

export function maxSimilarity(text, others) {
  return others.reduce((m, o) => Math.max(m, similarity(text, o)), 0);
}

/** Per-account writing statistics. */
export function stylometrics(posts) {
  const texts = posts.map((p) => (typeof p === 'string' ? p : p.text || '')).filter((t) => t.trim());
  const n = texts.length || 1;
  let wordsTotal = 0, chars = 0, emojis = 0, lowerStart = 0, capsWords = 0, excl = 0, quest = 0,
    ellipsis = 0, urls = 0, mentions = 0, tickers = 0, replies = 0, lineBreaks = 0, noFinalPunct = 0;
  const vocab = new Map();
  for (const t of texts) {
    const w = words(t);
    wordsTotal += w.length;
    chars += t.length;
    emojis += (t.match(EMOJI_RE) || []).length;
    if (/^[a-z]/.test(t.trim())) lowerStart++;
    capsWords += (t.match(/\b[A-Z]{3,}\b/g) || []).length;
    excl += (t.match(/!/g) || []).length;
    quest += (t.match(/\?/g) || []).length;
    ellipsis += (t.match(/\.\.\.|…/g) || []).length;
    urls += (t.match(/https?:\/\//g) || []).length;
    mentions += (t.match(/@\w+/g) || []).length;
    tickers += (t.match(/\$[A-Za-z][A-Za-z0-9]{1,9}\b/g) || []).length;
    if (/^@\w+/.test(t.trim())) replies++;
    lineBreaks += (t.match(/\n/g) || []).length;
    if (!/[.!?]$/.test(t.trim())) noFinalPunct++;
    for (const word of new Set(w)) vocab.set(word, (vocab.get(word) || 0) + 1);
  }
  const r = (x) => Math.round((x / n) * 1000) / 1000;
  return {
    posts: texts.length,
    avgWords: r(wordsTotal),
    avgChars: r(chars),
    emojiPerPost: r(emojis),
    lowercaseStartRate: r(lowerStart),
    capsWordsPerPost: r(capsWords),
    exclamationPerPost: r(excl),
    questionPerPost: r(quest),
    ellipsisPerPost: r(ellipsis),
    urlPerPost: r(urls),
    mentionPerPost: r(mentions),
    tickerPerPost: r(tickers),
    replyRate: r(replies),
    lineBreaksPerPost: r(lineBreaks),
    noFinalPunctuationRate: r(noFinalPunct),
    topWords: [...vocab.entries()]
      .filter(([w]) => w.length > 2 && !STOPWORDS.has(w))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .map(([w, c]) => ({ w, docFreq: Math.round((c / n) * 1000) / 1000 })),
  };
}

/** Phrases (4-grams) an account repeats: its signatures. The agent must never reuse these. */
export function signaturePhrases(posts, minCount = 3, limit = 50) {
  const counts = new Map();
  for (const p of posts) {
    const t = typeof p === 'string' ? p : p.text || '';
    for (const g of new Set(ngrams(words(t.replace(/https?:\/\/\S+/g, '')), 4))) counts.set(g, (counts.get(g) || 0) + 1);
  }
  return [...counts.entries()].filter(([, c]) => c >= minCount).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([g]) => g);
}

/** Averages stylometrics across accounts so no single KOL dominates the blend. */
export function blendStylometrics(perKol) {
  const keys = Object.keys(perKol[0] || {}).filter((k) => typeof perKol[0][k] === 'number' && k !== 'posts');
  const out = {};
  for (const k of keys) {
    const vals = perKol.map((s) => s[k]).sort((a, b) => a - b);
    out[k] = { min: vals[0], median: vals[Math.floor(vals.length / 2)], max: vals[vals.length - 1] };
  }
  return out;
}

// Tells that read as assistant-written rather than as a person typing on CT.
export const GENERIC_AI_TELLS = [
  /\bdelve\b/i, /\bin the (ever[- ])?evolving\b/i, /\blet'?s dive in\b/i, /\bbuckle up\b/i, /\bgame[- ]changer\b/i,
  /\bnavigat(e|ing) the\b/i, /\btapestry\b/i, /\bunleash\b/i, /\bit'?s (important|worth) (to note|noting)\b/i,
  /\bin conclusion\b/i, /\bembark\b/i, /\brealm of\b/i, /\bharness(ing)? the power\b/i, /\bexciting times\b/i,
  /\bstay tuned\b/i, /\bas an ai\b/i, /\blanguage model\b/i, /—/, /#\w+.*#\w+.*#\w+/,
];

export function genericAiTells(text) {
  return GENERIC_AI_TELLS.filter((re) => re.test(text)).map((re) => re.source);
}

/** Signature phrases from KOLs that appear verbatim in the text (cloning check). */
export function borrowedSignatures(text, signatures) {
  const grams = new Set(ngrams(words(text), 4));
  return signatures.filter((s) => grams.has(s));
}

const STOPWORDS = new Set(
  'the and for that this with you are but not have was just all its it\'s your from they what will can out get about one like more when there been has into than them their then some our who why how would could should him his her she him been i\'m don\'t dont im'.split(' '),
);
