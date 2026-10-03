import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPost, applyDisclosure, mentionedTokens, fixable } from '../src/social/guard.js';

const limits = { maxPostsPerDay: 2, maxRepliesPerDay: 2, minMinutesBetweenPosts: 45, replyCooldownHoursPerUser: 6, maxSimilarityToRecent: 0.6 };
const now = Date.parse('2026-10-03T12:00:00Z');
const ago = (min) => new Date(now - min * 60_000).toISOString();

test('finds tickers and contract addresses', () => {
  const m = mentionedTokens('aping $xyz and $ABC at 7EYnhQoR9YM3N7UoaKRoA44Uy8JeaZV3qyouov87awMs');
  assert.deepEqual(m.tickers, ['XYZ', 'ABC']);
  assert.equal(m.addresses.length, 1);
});

test('discloses held tokens and own coin, leaves others alone', () => {
  const positions = [{ symbol: 'XYZ', address: 'Mint1' }];
  const d = applyDisclosure('$xyz is stupid enough to work. $WITNESS holders know', positions, { ticker: 'WITNESS' });
  assert.match(d.text, /\[holding \$XYZ, \$WITNESS \(my coin\)\]$/);
  assert.deepEqual(applyDisclosure('$ABC looks cooked', positions, null).disclosed, []);
  assert.deepEqual(applyDisclosure('stupid enough to work', positions, null, ['Mint1']).disclosed, ['$XYZ']);
});

test('blocks generic AI tone, solicitation, borrowed phrases and near-duplicates', () => {
  const posts = [{ at: ago(600), action: 'POST', text: 'everyone is farming the obvious dog meta this one is stupid enough to work' }];
  const sig = ['i am so back'];
  const check = (text) => checkPost({ action: 'POST', text }, { posts, signatures: sig, limits, now }).problems.join(' | ');
  assert.match(check("Let's dive in to this game-changer"), /generic AI/);
  assert.match(check('buy now, guaranteed 10x'), /telling people to buy/);
  assert.match(check('ok i am so back fellas'), /signature phrase/);
  assert.match(check('everyone is farming the obvious dog meta this one is stupid enough to work lol'), /too similar/);
  assert.equal(check('chart looks like my sleep schedule'), '');
});

test('rate limits and per-user reply cooldown are not "fixable" by rewriting', () => {
  const posts = [
    { at: ago(10), action: 'POST', text: 'one' },
    { at: ago(100), action: 'POST', text: 'two two two' },
    { at: ago(60), action: 'REPLY', target: 'kol', text: 'hey' },
  ];
  const p = checkPost({ action: 'POST', text: 'fresh thought here' }, { posts, limits, now }).problems;
  assert.ok(p.some((x) => /daily post limit/.test(x)));
  assert.ok(p.some((x) => /too recently/.test(x)));
  assert.deepEqual(fixable(p), []);
  const r = checkPost({ action: 'REPLY', text: 'again', target: 'kol' }, { posts, limits, now }).problems;
  assert.ok(r.some((x) => /replied to @kol/.test(x)));
});
