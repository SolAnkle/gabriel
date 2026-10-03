import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBuy, checkExit, capital, treasuryValue } from '../src/trading/policy.js';

const policy = {
  buckets: { reserve: 0.4, trading: 0.3, operations: 0.2, experimental: 0.1 },
  maxTradeUsd: 500, maxTradePctOfTreasury: 0.05, maxPositionPctOfTreasury: 0.08, maxOpenPositions: 3,
  minLiquidityUsd: 25_000, minVolume24hUsd: 50_000, minTokenAgeMinutes: 30, maxTop10HolderPct: 0.45,
  stopLossPct: -0.5, takeProfitPct: 2, takeProfitSellFraction: 0.5, maxHoldHours: 72, mentionLockHours: 24,
  dailyLossLimitPct: 0.1, maxTradesPerDay: 6, cooldownMinutesPerToken: 720, minConviction: 7, allowedChains: ['solana'], minOrganicScore: 20,
};
const now = Date.parse('2026-10-03T12:00:00Z');
const empty = () => ({ cashUsd: 10_000, positions: [], trades: [], closed: [] });
const snap = (o = {}) => ({
  chainId: 'solana', address: 'Mint111', symbol: 'XYZ', priceUsd: 0.01, liquidityUsd: 200_000,
  volume: { h24: 500_000 }, pairCreatedAt: now - 5 * 3_600_000, ...o,
});
const safety = { top10ExLargestPct: 0.2, mintAuthority: null, freezeAuthority: null, decimals: 6 };

test('capital splits treasury into buckets and protects reserve + operations', () => {
  const c = capital(empty(), policy);
  assert.equal(c.treasury, 10_000);
  assert.equal(c.reserve, 4_000);
  assert.equal(c.tradingCapital, 4_000);
  assert.equal(c.available, 4_000);
});

test('approves a clean buy and caps it at the per-trade limit', () => {
  const v = checkBuy({ snapshot: snap(), safety, conviction: 8, requestedUsd: 2_000 }, empty(), policy, now);
  assert.equal(v.ok, true, v.violations.join());
  assert.equal(v.sizeUsd, 500);
});

test('pct-of-treasury cap binds on a small treasury', () => {
  const pf = { ...empty(), cashUsd: 2_000 };
  const v = checkBuy({ snapshot: snap(), safety, conviction: 9, requestedUsd: 420 }, pf, policy, now);
  assert.equal(v.sizeUsd, 100);
});

test('rejects thin liquidity, young pairs, concentrated holders and low conviction', () => {
  const v = checkBuy({
    snapshot: snap({ liquidityUsd: 5_000, pairCreatedAt: now - 60_000 }),
    safety: { ...safety, top10ExLargestPct: 0.7, mintAuthority: 'abc' }, conviction: 3, requestedUsd: 100,
  }, empty(), policy, now);
  assert.equal(v.ok, false);
  const all = v.violations.join(' | ');
  for (const s of ['liquidity', 'younger', 'top holders', 'mint authority', 'conviction']) assert.match(all, new RegExp(s));
});

test('missing holder data on solana is a hard no', () => {
  const v = checkBuy({ snapshot: snap(), safety: null, conviction: 9, requestedUsd: 100 }, empty(), policy, now);
  assert.match(v.violations.join(), /holder data unavailable/);
});

test('enforces cooldown, open-position count and daily loss limit', () => {
  const pf = empty();
  pf.trades.push({ at: new Date(now - 60_000).toISOString(), side: 'buy', address: 'Mint111' });
  pf.trades.push({ at: new Date(now - 60_000).toISOString(), side: 'sell', address: 'Other', realizedPnlUsd: -2_000 });
  pf.positions = ['a', 'b', 'c'].map((a) => ({ address: a, amount: 1, entryPrice: 100, lastPrice: 100, costUsd: 100 }));
  const v = checkBuy({ snapshot: snap(), safety, conviction: 9, requestedUsd: 100 }, pf, policy, now);
  const all = v.violations.join(' | ');
  assert.match(all, /cooldown/);
  assert.match(all, /open positions/);
  assert.match(all, /daily loss limit/);
});

test('never dips into reserve: available is zero when cash is mostly deployed', () => {
  const pf = { cashUsd: 5_000, positions: [{ address: 'a', amount: 1, entryPrice: 5_000, lastPrice: 5_000, costUsd: 5_000 }], trades: [], closed: [] };
  assert.equal(treasuryValue(pf), 10_000);
  assert.equal(capital(pf, policy).available, 0);
  const v = checkBuy({ snapshot: snap(), safety, conviction: 9, requestedUsd: 100 }, pf, policy, now);
  assert.equal(v.ok, false);
});

test('exit rules: stop loss, take profit, mention lock, stale hold', () => {
  const base = { entryPrice: 1, openedAt: new Date(now - 3_600_000).toISOString() };
  assert.equal(checkExit({ ...base, lastPrice: 0.4 }, policy, now).fraction, 1);
  assert.equal(checkExit({ ...base, lastPrice: 3.5 }, policy, now).fraction, 0.5);
  // Talked about it an hour ago: can't take profit, but stop loss still works.
  const mentioned = { ...base, lastMentionedAt: new Date(now - 3_600_000).toISOString() };
  assert.equal(checkExit({ ...mentioned, lastPrice: 3.5 }, policy, now), null);
  assert.equal(checkExit({ ...mentioned, lastPrice: 0.3 }, policy, now).fraction, 1);
  assert.match(checkExit({ ...base, openedAt: new Date(now - 80 * 3_600_000).toISOString(), lastPrice: 1.05 }, policy, now).reason, /without working/);
  assert.equal(checkExit({ ...base, lastPrice: 1.2 }, policy, now), null);
});

test('rejects wash-traded tokens by organic score', () => {
  const v = checkBuy({ snapshot: snap(), safety: { ...safety, organicScore: 4 }, conviction: 9, requestedUsd: 100 }, empty(), policy, now);
  assert.match(v.violations.join(), /wash-traded/);
});
