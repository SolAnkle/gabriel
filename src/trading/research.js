// Research engine: discover -> deterministic metrics -> shortlist -> on-chain safety -> model thesis.
// Metrics are computed in code so they're comparable across runs; the model adds the judgement
// about narrative and meme quality that code can't score.
import { config } from '../config.js';
import { load, update, record } from '../store.js';
import { discoverTokens, getSnapshots } from '../market/dexscreener.js';
import { tokenSafety } from '../market/solana.js';
import { think, obj, str, numb, arr, oneOf } from '../brain/llm.js';
import { identityLayer, voiceLayer, policyLayer, portfolioContext } from '../brain/persona.js';

const SHORTLIST = Number(process.env.RESEARCH_SHORTLIST || 4);
const HISTORY_KEEP = 24;

export function metrics(s, prev) {
  const h1 = s.txns.h1;
  const buyPressure = h1.buys + h1.sells ? h1.buys / (h1.buys + h1.sells) : 0.5;
  // Volume in the last hour vs. the hourly average of the last 6h. >1 = accelerating.
  const volumeAcceleration = s.volume.h6 ? s.volume.h1 / (s.volume.h6 / 6) : s.volume.h1 > 0 ? 3 : 0;
  const txAcceleration = s.txns.h6.buys + s.txns.h6.sells ? (h1.buys + h1.sells) / ((s.txns.h6.buys + s.txns.h6.sells) / 6) : 0;
  const ageHours = s.pairCreatedAt ? (Date.now() - s.pairCreatedAt) / 3_600_000 : null;
  const volToLiq = s.liquidityUsd ? s.volume.h24 / s.liquidityUsd : 0;
  // Change since we last looked (our own "social velocity" proxy across ticks).
  const sinceLast = prev?.priceUsd ? s.priceUsd / prev.priceUsd - 1 : null;
  const txGrowthSinceLast = prev ? (h1.buys + h1.sells) - (prev.txns.h1.buys + prev.txns.h1.sells) : null;
  const quant =
    Math.min(volumeAcceleration, 4) * 1.5 + Math.min(txAcceleration, 4) + (buyPressure - 0.5) * 6 +
    Math.min(volToLiq, 10) * 0.3 + (s.socials.length ? 1 : 0) + (s.boosts ? 0.5 : 0) - (s.priceChange.h1 > 150 ? 2 : 0);
  return {
    buyPressure: round(buyPressure), volumeAcceleration: round(volumeAcceleration), txAcceleration: round(txAcceleration),
    ageHours: ageHours == null ? null : round(ageHours), volToLiq: round(volToLiq), sinceLast: sinceLast == null ? null : round(sinceLast),
    txGrowthSinceLast, quant: round(quant),
    socialAcceleration: volumeAcceleration > 2 && txAcceleration > 1.5 ? 'HIGH' : volumeAcceleration > 1.1 ? 'MEDIUM' : 'LOW',
  };
}

const round = (x) => Math.round(x * 100) / 100;

const THESIS_SCHEMA = obj({
  narrative: str('the narrative in a few words'), narrativeScore: numb('0-10'), memeScore: numb('0-10'),
  risk: oneOf(['LOW', 'MEDIUM', 'HIGH', 'EXTREME']), conviction: numb('0-10, how much you want it'),
  decision: oneOf(['BUY', 'WATCH', 'PASS']), requestedUsd: numb('what you would like to put in; rules may cut it'),
  publicThesis: str('one or two lines in your own voice, max 200 chars, for the public "why I bought/passed" card'),
  flags: arr(str(), 'serious red flags only: impersonates a real person/brand, copy of another coin, obvious honeypot signs, hate content'),
});

export async function scan() {
  const policy = config.policy;
  const discovered = await discoverTokens(policy.allowedChains);
  const held = new Set(load('portfolio').positions.map((p) => p.address));
  record('research', `Scanning ${discovered.length} new or boosted tokens`);

  const byChain = Object.groupBy(discovered, (d) => d.chainId);
  const snapshots = [];
  for (const [chainId, items] of Object.entries(byChain)) {
    const snaps = await getSnapshots(chainId, items.map((i) => i.address));
    for (const item of items) {
      const s = snaps.get(item.address);
      if (s) snapshots.push({ ...s, description: item.description, discoveredVia: item.sources });
    }
  }

  const history = load('research').history;
  const scored = snapshots
    .filter((s) => !held.has(s.address))
    // Cheap pre-filter with the same floors the policy enforces, so we don't spend model calls on no-gos.
    .filter((s) => s.liquidityUsd >= policy.minLiquidityUsd && s.volume.h24 >= policy.minVolume24hUsd)
    .map((s) => ({ s, m: metrics(s, history[s.address]?.at(-1)) }))
    .sort((a, b) => b.m.quant - a.m.quant);

  update('research', (r) => {
    for (const { s } of scored.slice(0, 40)) {
      const h = (r.history[s.address] ||= []);
      h.push({ at: s.fetchedAt, priceUsd: s.priceUsd, txns: s.txns, volume: s.volume, liquidityUsd: s.liquidityUsd });
      if (h.length > HISTORY_KEEP) h.splice(0, h.length - HISTORY_KEEP);
    }
    // Forget tokens we haven't seen in two days.
    for (const [addr, h] of Object.entries(r.history)) if (Date.now() - Date.parse(h.at(-1).at) > 48 * 3_600_000) delete r.history[addr];
  });

  record('research', `${scored.length} passed liquidity/volume floors; analysing top ${Math.min(SHORTLIST, scored.length)}`);
  const reports = [];
  for (const { s, m } of scored.slice(0, SHORTLIST)) {
    reports.push(await analyse(s, m));
  }
  return reports;
}

export async function analyse(s, m) {
  let safety = null;
  if (s.chainId === 'solana') {
    try {
      safety = await tokenSafety(s.address);
    } catch (err) {
      console.warn(`safety check failed for ${s.symbol}:`, err.message);
    }
  }
  const { identity } = load('agent');
  const thesis = await think({
    label: `research:${s.symbol}`, effort: 'medium',
    system: [identityLayer(), voiceLayer(), policyLayer()],
    prompt: `Your trading philosophy: ${JSON.stringify(identity?.trading ?? {})}
${portfolioContext()}

Token $${s.symbol} (${s.name}) on ${s.chainId}
Description: ${s.description || 'none'}
Links: ${[...s.websites, ...s.socials.map((x) => `${x.type}: ${x.url}`)].join(', ') || 'none'}
Market: price $${s.priceUsd}, mcap $${Math.round(s.marketCap || 0)}, liquidity $${Math.round(s.liquidityUsd)}, volume ${JSON.stringify(s.volume)}
Transactions: ${JSON.stringify(s.txns)}; price change % ${JSON.stringify(s.priceChange)}
Computed metrics: ${JSON.stringify(m)}
Holder data: ${safety ? JSON.stringify(safety) : 'unavailable'}

Decide if you want it. Be honest: most tokens are PASS. Your public thesis is shown next to the trade forever.`,
    schema: THESIS_SCHEMA,
    offline: () => offlineThesis(s, m),
  });

  const report = {
    id: `${s.address}-${Date.now()}`, at: new Date().toISOString(), snapshot: s, metrics: m, safety,
    ...thesis, publicThesis: thesis.publicThesis.slice(0, 240),
  };
  update('research', (r) => {
    r.reports.push(report);
    if (r.reports.length > 300) r.reports.splice(0, r.reports.length - 300);
  });
  record('analysis', `$${s.symbol}: ${thesis.decision} (conviction ${thesis.conviction}/10)`, {
    token: s.symbol, address: s.address, url: s.url,
    scores: {
      narrative: thesis.narrativeScore, meme: thesis.memeScore, socialAcceleration: m.socialAcceleration,
      liquidity: s.liquidityUsd >= config.policy.minLiquidityUsd * 2 ? 'GOOD' : 'ACCEPTABLE',
      holderConcentration: safety?.top10ExLargestPct == null ? 'UNKNOWN' : safety.top10ExLargestPct > 0.3 ? 'HIGH' : safety.top10ExLargestPct > 0.15 ? 'MEDIUM' : 'LOW',
      risk: thesis.risk,
    },
    narrative: thesis.narrative, thesis: report.publicThesis,
  });
  return report;
}

function offlineThesis(s, m) {
  const conviction = Math.max(0, Math.min(10, Math.round(4 + m.quant / 2)));
  const decision = conviction >= 7 ? 'BUY' : conviction >= 5 ? 'WATCH' : 'PASS';
  const theses = {
    BUY: m.socialAcceleration === 'HIGH' ? 'volume showed up before the price did. small bid' : 'stupid enough to work. sized like it might not',
    WATCH: 'interesting, not yet. watching who else notices',
    PASS: 'nothing here i would explain to my mum. pass',
  };
  return {
    narrative: s.description?.split(/[.!\n]/)[0]?.slice(0, 60) || 'unclear', narrativeScore: Math.min(10, conviction), memeScore: s.imageUrl ? 7 : 4,
    risk: 'HIGH', conviction, decision, requestedUsd: 400, publicThesis: theses[decision],
    flags: [],
  };
}
