import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mood, nowLine, isVideo } from '../src/web/character.js';

const now = Date.parse('2026-10-03T12:00:00Z');
const iso = (hoursAgo) => new Date(now - hoursAgo * 3_600_000).toISOString();

test('mood follows the wallet', () => {
  assert.equal(mood({ status: 'unborn', now }).word, 'not born yet');
  assert.equal(mood({ status: 'online', tier: 'surviving', closed: [{ closedAt: iso(2), pnlPct: -0.6, symbol: 'ABC' }], now }).word, 'in shambles');
  assert.equal(mood({ status: 'online', tier: 'surviving', snapshots: [{ at: iso(20), treasuryUsd: 100 }, { at: iso(0), treasuryUsd: 130 }], now }).word, 'up bad');
  assert.equal(mood({ status: 'online', tier: 'surviving', snapshots: [{ at: iso(20), treasuryUsd: 100 }, { at: iso(0), treasuryUsd: 70 }], now }).tone, 'down');
  assert.equal(mood({ status: 'online', tier: 'broke', now }).word, 'eating noodles');
  // A loss from last week no longer sets the mood.
  assert.equal(mood({ status: 'online', tier: 'rich', closed: [{ closedAt: iso(100), pnlPct: -0.9, symbol: 'X' }], now }).word, 'insufferable');
});

test('now line describes what he is doing', () => {
  assert.equal(nowLine({ type: 'trade', data: { side: 'buy', token: 'XYZ' } }), 'just bought $XYZ');
  assert.equal(nowLine({ type: 'policy', data: { token: 'XYZ', violations: ['x'] } }), 'decided to pass on $XYZ');
  assert.equal(nowLine({ type: 'system', data: {} }), null);
});

test('detects video renders', () => {
  assert.equal(isVideo('/character/hero.mp4'), true);
  assert.equal(isVideo('https://cdn.x/clip.webm?sig=1'), true);
  assert.equal(isVideo('hero.png'), false);
});
