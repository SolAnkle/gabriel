import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spendableSol, sellAmountRaw, estimateImpact } from '../src/trading/wallet.js';
import { checkDiscretionarySell } from '../src/trading/policy.js';

test('buys never dip into the SOL fee reserve', () => {
  assert.equal(spendableSol(1, 0.05), 0.95);
  assert.equal(spendableSol(0.03, 0.05), 0);
});

test('sell amounts: full balance, half, and nothing', () => {
  assert.equal(sellAmountRaw(1_000_000n, 1), 1_000_000n);
  assert.equal(sellAmountRaw(1_000_001n, 0.5), 500_000n);
  assert.equal(sellAmountRaw(1_000_000n, 0), 0n);
  // Works past Number precision.
  assert.equal(sellAmountRaw(10n ** 24n, 0.5), 5n * 10n ** 23n);
});

test('price impact grows with size relative to liquidity', () => {
  assert.ok(estimateImpact(100, 100_000) < 0.01);
  assert.ok(estimateImpact(10_000, 20_000) > 0.4);
});

test('brain can cut losers any time but cannot sell in profit right after posting', () => {
  const policy = { mentionLockHours: 24 };
  const now = Date.parse('2026-10-03T12:00:00Z');
  const recent = new Date(now - 2 * 3_600_000).toISOString();
  assert.equal(checkDiscretionarySell({ entryPrice: 1, lastPrice: 0.7, lastMentionedAt: recent }, policy, now).ok, true);
  assert.equal(checkDiscretionarySell({ entryPrice: 1, lastPrice: 1.5, lastMentionedAt: recent }, policy, now).ok, false);
  assert.equal(checkDiscretionarySell({ entryPrice: 1, lastPrice: 1.5 }, policy, now).ok, true);
  assert.equal(checkDiscretionarySell({ entryPrice: 1, lastPrice: 0 }, policy, now).ok, false);
});
