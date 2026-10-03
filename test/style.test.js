import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stylometrics, signaturePhrases, similarity, blendStylometrics } from '../src/brain/style.js';
import { repetitionReport } from '../src/brain/reflection.js';
import { metrics } from '../src/trading/research.js';
import { oauthHeader } from '../src/social/x.js';

test('stylometrics counts the basics', () => {
  const s = stylometrics(['gm frens 🚀', 'THIS is the one', 'ngl kinda cooked...']);
  assert.equal(s.posts, 3);
  assert.ok(s.emojiPerPost > 0.3 && s.emojiPerPost < 0.34);
  assert.ok(s.lowercaseStartRate > 0.6);
  assert.ok(s.ellipsisPerPost > 0);
});

test('signature phrases are repeated 4-grams', () => {
  const posts = ['we are so back today', 'honestly we are so back', 'lol we are so back again', 'something else entirely here'];
  assert.deepEqual(signaturePhrases(posts, 3), ['we are so back']);
});

test('similarity is 1 for identical text and low for unrelated', () => {
  assert.equal(similarity('the chart is cooked again today ok', 'the chart is cooked again today ok'), 1);
  assert.ok(similarity('the chart is cooked again today ok', 'bought a new monitor because why not') < 0.1);
});

test('blend reports min/median/max per metric', () => {
  const b = blendStylometrics([stylometrics(['a b c']), stylometrics(['a b c d e f'])]);
  assert.equal(b.avgWords.min, 3);
  assert.equal(b.avgWords.max, 6);
});

test('repetition report spots repeated openers and duplicates', () => {
  const r = repetitionReport(['ngl this is cooked', 'ngl another one', 'ngl again', 'ngl this is cooked']);
  assert.ok(r.repeatedOpeners.length >= 1);
  assert.equal(r.nearDuplicatePairs, 1);
});


test('research metrics detect acceleration', () => {
  const s = {
    priceUsd: 1, liquidityUsd: 100_000, socials: [{}], boosts: 0, pairCreatedAt: Date.now() - 3_600_000,
    volume: { h1: 60_000, h6: 90_000, h24: 100_000 }, priceChange: { h1: 20 },
    txns: { h1: { buys: 300, sells: 100 }, h6: { buys: 400, sells: 200 } },
  };
  const m = metrics(s, null);
  assert.equal(m.socialAcceleration, 'HIGH');
  assert.equal(m.buyPressure, 0.75);
});

test('OAuth 1.0a signature matches the X documentation example', () => {
  // Example from https://developer.x.com/en/docs/authentication/oauth-1-0a/creating-a-signature
  // (query-param variant: status/include_entities moved into the URL).
  const h = oauthHeader(
    'POST',
    'https://api.twitter.com/1.1/statuses/update.json?include_entities=true&status=Hello%20Ladies%20%2B%20Gentlemen%2C%20a%20signed%20OAuth%20request%21',
    { apiKey: 'xvz1evFS4wEEPTGEFPHBog', apiSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw', accessToken: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb', accessSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE' },
    'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg', '1318622958',
  );
  assert.match(h, /oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"/);
});
