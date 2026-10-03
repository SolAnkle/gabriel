// Deterministic portfolio policy. The model can say "I like this token"; only these functions decide
// whether money moves and how much. Pure functions: no I/O, fully unit tested.

const DAY_MS = 24 * 60 * 60 * 1000;

export function positionValue(p) {
  return p.amount * (p.lastPrice ?? p.entryPrice);
}

export function treasuryValue(portfolio) {
  return portfolio.cashUsd + portfolio.positions.reduce((s, p) => s + positionValue(p), 0);
}

/** How the treasury splits into buckets, and how much trading capital is free right now. */
export function capital(portfolio, policy) {
  const treasury = treasuryValue(portfolio);
  const b = policy.buckets;
  const tradingCapital = treasury * (b.trading + b.experimental);
  const deployed = portfolio.positions.reduce((s, p) => s + p.costUsd, 0);
  // Cash that must stay untouched: the reserve and the operations budget.
  const protectedCash = treasury * (b.reserve + b.operations);
  const available = Math.max(0, Math.min(tradingCapital - deployed, portfolio.cashUsd - protectedCash));
  const cents = (x) => Math.round(x * 100) / 100;
  return {
    treasury: cents(treasury),
    reserve: cents(treasury * b.reserve),
    operations: cents(treasury * b.operations),
    tradingCapital: cents(tradingCapital),
    experimental: cents(treasury * b.experimental),
    deployed: cents(deployed),
    available: cents(available),
  };
}

function realizedToday(portfolio, now) {
  return portfolio.trades
    .filter((t) => t.side === 'sell' && now - Date.parse(t.at) < DAY_MS)
    .reduce((s, t) => s + (t.realizedPnlUsd || 0), 0);
}

/**
 * Validates and sizes a buy. Returns { ok, sizeUsd, violations, notes }.
 * `request` = { snapshot, safety, conviction, requestedUsd, flags }
 */
export function checkBuy(request, portfolio, policy, now = Date.now()) {
  const { snapshot: s, safety, conviction, requestedUsd } = request;
  const v = [];
  const notes = [];

  if (!policy.allowedChains.includes(s.chainId)) v.push(`chain ${s.chainId} not allowed`);
  if (!(s.priceUsd > 0)) v.push('no price');
  if ((s.liquidityUsd || 0) < policy.minLiquidityUsd) v.push(`liquidity $${Math.round(s.liquidityUsd || 0)} < $${policy.minLiquidityUsd}`);
  if ((s.volume?.h24 || 0) < policy.minVolume24hUsd) v.push(`24h volume $${Math.round(s.volume?.h24 || 0)} < $${policy.minVolume24hUsd}`);
  if (s.pairCreatedAt && (now - s.pairCreatedAt) / 60000 < policy.minTokenAgeMinutes) v.push(`pair younger than ${policy.minTokenAgeMinutes}m`);
  if (!s.pairCreatedAt) v.push('unknown token age');

  if (s.chainId === 'solana') {
    if (!safety) v.push('holder data unavailable');
    else {
      if (safety.mintAuthority) v.push('mint authority not renounced');
      if (safety.freezeAuthority) v.push('freeze authority set');
      // Largest account is usually the pool/bonding curve, so judge the next ten.
      // Jupiter's organic score: low means the volume is mostly bots / wash trading.
      if (safety.organicScore != null && safety.organicScore < (policy.minOrganicScore ?? 0))
        v.push(`organic score ${Math.round(safety.organicScore)} < ${policy.minOrganicScore} (likely wash-traded)`);
      if (safety.top10ExLargestPct != null && safety.top10ExLargestPct > policy.maxTop10HolderPct)
        v.push(`top holders own ${(safety.top10ExLargestPct * 100).toFixed(0)}% (max ${policy.maxTop10HolderPct * 100}%)`);
    }
  }

  if ((conviction ?? 0) < policy.minConviction) v.push(`conviction ${conviction} < ${policy.minConviction}`);
  if (request.flags?.length) v.push(...request.flags.map((f) => `flagged: ${f}`));

  const openSame = portfolio.positions.find((p) => p.address === s.address);
  const lastTrade = [...portfolio.trades].reverse().find((t) => t.address === s.address);
  if (lastTrade && (now - Date.parse(lastTrade.at)) / 60000 < policy.cooldownMinutesPerToken) v.push('token cooldown active');
  if (!openSame && portfolio.positions.length >= policy.maxOpenPositions) v.push(`already ${portfolio.positions.length} open positions`);

  const tradesToday = portfolio.trades.filter((t) => now - Date.parse(t.at) < DAY_MS && t.side === 'buy').length;
  if (tradesToday >= policy.maxTradesPerDay) v.push(`daily trade limit (${policy.maxTradesPerDay}) reached`);

  const cap = capital(portfolio, policy);
  if (realizedToday(portfolio, now) < -policy.dailyLossLimitPct * cap.treasury) v.push('daily loss limit hit');

  // Sizing: the smallest of every cap wins.
  const existing = openSame ? openSame.costUsd : 0;
  const limits = {
    requested: requestedUsd ?? Infinity,
    maxTrade: policy.maxTradeUsd,
    pctOfTreasury: policy.maxTradePctOfTreasury * cap.treasury,
    positionCap: policy.maxPositionPctOfTreasury * cap.treasury - existing,
    available: cap.available,
    // Don't be more than ~2% of the pool: keeps price impact and exit risk sane.
    liquidity: (s.liquidityUsd || 0) * 0.02,
  };
  const [binding, size] = Object.entries(limits).sort((a, b) => a[1] - b[1])[0];
  const sizeUsd = Math.floor(Math.max(0, size) * 100) / 100;
  if (binding !== 'requested') notes.push(`size capped by ${binding}`);
  if (sizeUsd < 10) v.push(`size $${sizeUsd} below $10 minimum (bound by ${binding})`);

  return { ok: v.length === 0, sizeUsd, violations: v, notes, capital: cap };
}

/** Exit rules applied to every open position each tick. Returns null or { fraction, reason }. */
export function checkExit(position, policy, now = Date.now()) {
  const price = position.lastPrice;
  if (!(price > 0)) return null;
  const pnl = price / position.entryPrice - 1;
  if (pnl <= policy.stopLossPct) return { fraction: 1, reason: `stop loss (${(pnl * 100).toFixed(0)}%)` };
  // Anti pump-and-dump: no profit-taking soon after the agent publicly talked about the token.
  const mentionedH = position.lastMentionedAt ? (now - Date.parse(position.lastMentionedAt)) / 3_600_000 : Infinity;
  const profitLocked = mentionedH < (policy.mentionLockHours ?? 24);
  if (pnl >= policy.takeProfitPct && !position.tookProfit && !profitLocked)
    return { fraction: policy.takeProfitSellFraction, reason: `take profit (+${(pnl * 100).toFixed(0)}%)` };
  // After taking profit, protect the rest: exit if it gives back to breakeven.
  if (position.tookProfit && pnl <= 0) return { fraction: 1, reason: 'remaining position back to entry' };
  const ageH = (now - Date.parse(position.openedAt)) / 3_600_000;
  if (ageH >= policy.maxHoldHours && pnl < 0.25) return { fraction: 1, reason: `held ${Math.round(ageH)}h without working` };
  return null;
}

/** Live-mode quote check: refuse fills that would move the price too much. */
export function checkQuote(quote, policy) {
  const impactPct = Number(quote.priceImpactPct || 0) * 100;
  if (impactPct > policy.maxPriceImpactPct) return { ok: false, reason: `price impact ${impactPct.toFixed(2)}% > ${policy.maxPriceImpactPct}%` };
  return { ok: true };
}
