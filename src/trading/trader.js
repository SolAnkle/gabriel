// Ties research to money: refresh prices, enforce exits, and turn BUY theses into policy-checked trades.
// Every outcome (including "the rules said no") goes on the public ledger.
import { config } from '../config.js';
import { load, update, record } from '../store.js';
import { getSnapshots } from '../market/dexscreener.js';
import { checkBuy, checkExit, capital } from './policy.js';
import { executeBuy, executeSell } from './wallet.js';
import { think, obj, str } from '../brain/llm.js';
import { identityLayer, voiceLayer } from '../brain/persona.js';
import { enqueueSocial } from '../social/queue.js';

export async function refreshPositions() {
  const pf = load('portfolio');
  if (!pf.positions.length) return new Map();
  const byChain = Object.groupBy(pf.positions, (p) => p.chainId);
  const all = new Map();
  for (const [chainId, ps] of Object.entries(byChain)) {
    for (const [addr, snap] of await getSnapshots(chainId, ps.map((p) => p.address))) all.set(addr, snap);
  }
  update('portfolio', (p) => {
    for (const pos of p.positions) {
      const s = all.get(pos.address);
      if (s?.priceUsd) Object.assign(pos, { lastPrice: s.priceUsd, lastLiquidityUsd: s.liquidityUsd, lastCheckedAt: s.fetchedAt });
    }
  });
  return all;
}

export async function runExits(snapshots) {
  for (const pos of [...load('portfolio').positions]) {
    const exit = checkExit(pos, config.policy);
    if (!exit) continue;
    const snap = snapshots.get(pos.address);
    if (!snap) continue;
    try {
      await sell(pos, snap, exit.fraction, exit.reason);
    } catch (err) {
      record('error', `Sell of $${pos.symbol} failed: ${err.message}`);
    }
  }
}

export async function sell(pos, snap, fraction, reason) {
  const fill = await executeSell(snap, pos, fraction);
  const costPart = pos.costUsd * fraction;
  const realized = fill.proceedsUsd - costPart;
  const pnlPct = fill.proceedsUsd / costPart - 1;
  update('portfolio', (p) => {
    p.cashUsd += config.tradingMode === 'paper' ? fill.proceedsUsd : 0;
    p.trades.push({ at: new Date().toISOString(), side: 'sell', address: pos.address, symbol: pos.symbol, amount: fill.amount, priceUsd: fill.priceUsd, usd: fill.proceedsUsd, realizedPnlUsd: realized, reason, txid: fill.txid, simulated: fill.simulated });
    const live = p.positions.find((x) => x.address === pos.address);
    if (fraction >= 1) {
      p.positions = p.positions.filter((x) => x.address !== pos.address);
      p.closed.push({ ...live, closedAt: new Date().toISOString(), exitReason: reason, proceedsUsd: (live.proceedsSoFarUsd || 0) + fill.proceedsUsd, pnlPct: ((live.proceedsSoFarUsd || 0) + fill.proceedsUsd) / live.originalCostUsd - 1 });
    } else {
      live.amount -= fill.amount;
      live.costUsd -= costPart;
      live.proceedsSoFarUsd = (live.proceedsSoFarUsd || 0) + fill.proceedsUsd;
      live.tookProfit = true;
    }
  });
  const ev = record('trade', `SOLD ${fraction >= 1 ? 'all' : `${Math.round(fraction * 100)}%`} of $${pos.symbol} for $${fill.proceedsUsd.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${(pnlPct * 100).toFixed(0)}%): ${reason}`, {
    side: 'sell', token: pos.symbol, address: pos.address, usd: fill.proceedsUsd, pnlPct, reason, txid: fill.txid, simulated: fill.simulated,
  });
  if (fraction >= 1) {
    const post = await think({
      label: `exit:${pos.symbol}`, effort: 'low', system: [identityLayer(), voiceLayer()],
      prompt: `You just closed $${pos.symbol}. Entry thesis: "${pos.thesis}". Result: ${(pnlPct * 100).toFixed(0)}% (${reason}). Write the one-line public post-mortem shown on your portfolio card. Losses: own it, no excuses.`,
      schema: obj({ postMortem: str() }),
      offline: () => ({ postMortem: pnlPct >= 0 ? 'thesis played out. left some on the table on purpose' : 'i thought the meme would escape CT. it didn\'t. skill issue' }),
    });
    update('portfolio', (p) => {
      const c = p.closed.findLast((x) => x.address === pos.address);
      if (c) c.postMortem = post.postMortem;
    });
    enqueueSocial('exit', { token: pos.symbol, address: pos.address, pnlPct, reason, postMortem: post.postMortem, ledgerId: ev.id });
  }
}

/** Takes a research report; buys only if the policy agrees. */
export async function considerBuy(report) {
  if (report.decision !== 'BUY') return null;
  const s = report.snapshot;
  const pf = load('portfolio');
  const verdict = checkBuy({ snapshot: s, safety: report.safety, conviction: report.conviction, requestedUsd: report.requestedUsd, flags: report.flags }, pf, config.policy);

  if (!verdict.ok) {
    record('policy', `Wanted $${s.symbol}; rules said no: ${verdict.violations.join('; ')}`, { token: s.symbol, violations: verdict.violations, thesis: report.publicThesis });
    return null;
  }
  record('policy', `$${s.symbol} approved: $${verdict.sizeUsd.toFixed(2)} (${verdict.notes.join(', ') || 'as requested'})`, { token: s.symbol, sizeUsd: verdict.sizeUsd, available: verdict.capital.available });

  let fill;
  try {
    fill = await executeBuy(s, verdict.sizeUsd, report.safety);
  } catch (err) {
    record('error', `Buy of $${s.symbol} failed: ${err.message}`);
    return null;
  }
  update('portfolio', (p) => {
    if (config.tradingMode === 'paper') p.cashUsd -= fill.costUsd;
    const existing = p.positions.find((x) => x.address === s.address);
    if (existing) {
      const amount = existing.amount + fill.amount;
      existing.entryPrice = (existing.entryPrice * existing.amount + fill.priceUsd * fill.amount) / amount;
      existing.amount = amount;
      existing.costUsd += fill.costUsd;
      existing.originalCostUsd += fill.costUsd;
    } else {
      p.positions.push({
        address: s.address, symbol: s.symbol, name: s.name, chainId: s.chainId, url: s.url, imageUrl: s.imageUrl,
        amount: fill.amount, decimals: report.safety?.decimals, entryPrice: fill.priceUsd, lastPrice: s.priceUsd,
        costUsd: fill.costUsd, originalCostUsd: fill.costUsd, openedAt: new Date().toISOString(),
        thesis: report.publicThesis, narrative: report.narrative, reportId: report.id,
      });
    }
    p.trades.push({ at: new Date().toISOString(), side: 'buy', address: s.address, symbol: s.symbol, amount: fill.amount, priceUsd: fill.priceUsd, usd: fill.costUsd, txid: fill.txid, simulated: fill.simulated });
  });
  const ev = record('trade', `BOUGHT $${fill.costUsd.toFixed(2)} of $${s.symbol}`, {
    side: 'buy', token: s.symbol, address: s.address, usd: fill.costUsd, priceUsd: fill.priceUsd, thesis: report.publicThesis, txid: fill.txid, simulated: fill.simulated, url: s.url,
  });
  enqueueSocial('trade', { token: s.symbol, address: s.address, usd: fill.costUsd, thesis: report.publicThesis, narrative: report.narrative, ledgerId: ev.id });
  return fill;
}

export function capitalSummary() {
  return capital(load('portfolio'), config.policy);
}
