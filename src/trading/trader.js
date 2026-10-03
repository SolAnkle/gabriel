// Ties research to money: reconcile with the wallet, refresh prices, enforce exits, let the brain
// review its holdings, and turn BUY theses into policy-checked trades. Every outcome goes in the ledger.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { load, update, record } from '../store.js';
import { getSnapshots } from '../market/dexscreener.js';
import { tokenBalanceRaw } from '../market/solana.js';
import { checkBuy, checkExit, checkDiscretionarySell, capital } from './policy.js';
import { executeBuy, executeSell, walletAddress, UnsellableError } from './wallet.js';
import { think, obj, str, oneOf } from '../brain/llm.js';
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
    await trySell(pos, snap, exit.fraction, exit.reason);
  }
}

async function trySell(pos, snap, fraction, reason) {
  try {
    await sell(pos, snap, fraction, reason);
  } catch (err) {
    if (err instanceof UnsellableError) {
      update('portfolio', (p) => {
        const live = p.positions.find((x) => x.address === pos.address);
        if (live) live.unsellableSince ||= new Date().toISOString();
      });
      record('error', `UNSELLABLE $${pos.symbol}: ${err.message}. Holding it and retrying next tick.`, { token: pos.symbol, address: pos.address });
    } else {
      record('error', `Sell of $${pos.symbol} failed: ${err.message}`);
    }
  }
}

// ---------- pause switch ----------
const pauseFile = () => path.join(config.stateDir, 'PAUSED');
export const isPaused = () => process.env.PAUSE_TRADING === 'true' || fs.existsSync(pauseFile());
export function setPaused(paused, why = '') {
  fs.mkdirSync(config.stateDir, { recursive: true });
  if (paused) fs.writeFileSync(pauseFile(), `${new Date().toISOString()} ${why}\n`);
  else fs.rmSync(pauseFile(), { force: true });
  record('control', paused ? `New buys PAUSED${why ? `: ${why}` : ''}. Exits and stop losses keep running.` : 'Buying RESUMED');
}

/**
 * Live mode: the wallet is the source of truth. Positions whose tokens left the wallet are closed;
 * amounts that drifted (partial fills, a late-landing transaction) are corrected.
 */
export async function reconcile() {
  if (config.tradingMode !== 'live') return;
  const owner = walletAddress();
  for (const pos of [...load('portfolio').positions]) {
    let raw;
    try {
      raw = await tokenBalanceRaw(owner, pos.address);
    } catch (err) {
      record('error', `Couldn't read $${pos.symbol} balance: ${err.message}`);
      continue;
    }
    const actual = Number(raw) / 10 ** (pos.decimals ?? 6);
    if (actual <= 0) {
      update('portfolio', (p) => {
        const live = p.positions.find((x) => x.address === pos.address);
        p.positions = p.positions.filter((x) => x.address !== pos.address);
        p.closed.push({ ...live, closedAt: new Date().toISOString(), exitReason: 'tokens left the wallet outside the bot', proceedsUsd: live.proceedsSoFarUsd || 0, pnlPct: (live.proceedsSoFarUsd || 0) / live.originalCostUsd - 1 });
      });
      record('error', `$${pos.symbol} balance is zero on chain; closed the position in the books`);
    } else if (Math.abs(actual - pos.amount) / pos.amount > 0.01) {
      update('portfolio', (p) => {
        const live = p.positions.find((x) => x.address === pos.address);
        if (live) live.amount = actual;
      });
      record('system', `Corrected $${pos.symbol} amount from ${pos.amount} to ${actual} to match the wallet`);
    }
  }
}

/**
 * The brain re-reads each holding: is the thesis still alive? It can sell half or all early.
 * Its choice still has to pass checkDiscretionarySell.
 */
export async function reviewExits(snapshots) {
  for (const pos of [...load('portfolio').positions]) {
    const snap = snapshots.get(pos.address);
    if (!snap?.priceUsd) continue;
    const pnl = snap.priceUsd / pos.entryPrice - 1;
    const verdict = await think({
      label: `review:${pos.symbol}`, effort: 'medium', system: [identityLayer(), voiceLayer()],
      prompt: `You hold $${pos.symbol}. You bought ${Math.round((Date.now() - Date.parse(pos.openedAt)) / 3_600_000)}h ago because: "${pos.thesis}" (narrative: ${pos.narrative || 'n/a'}).
Now: ${(pnl * 100).toFixed(0)}% from entry. Price change % ${JSON.stringify(snap.priceChange)}. Volume ${JSON.stringify(snap.volume)}. Txns ${JSON.stringify(snap.txns)}. Liquidity $${Math.round(snap.liquidityUsd)}.
Is your thesis still alive? HOLD unless something actually changed. SELL_HALF to de-risk, SELL_ALL if the reason you bought is gone.`,
      schema: obj({ decision: oneOf(['HOLD', 'SELL_HALF', 'SELL_ALL']), reason: str('one line, your voice') }),
      offline: () => ({ decision: snap.volume.h1 < snap.volume.h6 / 12 && pnl < 0 ? 'SELL_ALL' : 'HOLD', reason: 'volume left the building' }),
    }).catch((err) => {
      record('error', `Exit review of $${pos.symbol} failed: ${err.message}`);
      return null;
    });
    if (!verdict || verdict.decision === 'HOLD') continue;
    const allowed = checkDiscretionarySell(pos, config.policy);
    if (!allowed.ok) {
      record('policy', `Wanted to sell $${pos.symbol} early; blocked: ${allowed.reason}`, { token: pos.symbol });
      continue;
    }
    await trySell(pos, snap, verdict.decision === 'SELL_ALL' ? 1 : 0.5, `thesis review: ${verdict.reason}`);
  }
}

export async function sell(pos, snap, fraction, reason) {
  const fill = await executeSell(snap, pos, fraction);
  // Book by what actually sold (live fills can differ slightly from the requested fraction).
  const soldShare = Math.min(1, fill.amount / pos.amount);
  fraction = fraction >= 1 || soldShare > 0.995 ? 1 : soldShare;
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
  if (isPaused()) {
    record('policy', `Wanted $${s.symbol}, but buying is paused`, { token: s.symbol });
    return null;
  }
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
