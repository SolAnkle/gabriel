// Public dashboard: static page + read-only JSON + a live event stream. Only public data leaves here:
// no prompts, no raw model reasoning, no keys.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { load, readLedger, onLedgerEvent } from '../store.js';
import { capital, positionValue } from '../trading/policy.js';
import { walletAddress } from '../trading/wallet.js';
import { lifeTier } from '../trading/treasury.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(here, 'index.html');

export function publicState() {
  const agent = load('agent');
  const pf = load('portfolio');
  const cap = capital(pf, config.policy);
  const memory = load('memory');
  const lastReflection = readLedger(500).find((e) => e.type === 'reflection') || null;
  return {
    status: agent.status,
    modes: { trading: config.tradingMode, x: config.xMode, llm: config.llmEnabled ? 'live' : 'offline' },
    identity: agent.identity && {
      name: agent.identity.name, username: agent.identity.username, bio: agent.identity.bio, backstory: agent.identity.backstory,
      traits: agent.identity.personalityTraits, worldview: agent.identity.worldview, trading: agent.identity.trading,
    },
    coin: agent.coin && { name: agent.coin.name, ticker: agent.coin.ticker, concept: agent.coin.concept, lore: agent.coin.lore, address: agent.coin.address },
    visual: agent.visual && { summary: agent.visual.summary },
    genesis: agent.genesis,
    wallet: walletAddress(),
    lifeTier: lifeTier(pf),
    treasury: {
      total: cap.treasury, cash: pf.cashUsd, portfolio: pf.positions.reduce((s, p) => s + positionValue(p), 0),
      available: cap.available, reserve: cap.reserve, operations: cap.operations, deployed: cap.deployed,
      feesEarned: pf.feesEarnedUsd, buckets: config.policy.buckets,
    },
    history: pf.snapshots.slice(-500),
    positions: pf.positions.map((p) => ({
      symbol: p.symbol, name: p.name, address: p.address, url: p.url, imageUrl: p.imageUrl, openedAt: p.openedAt,
      invested: p.originalCostUsd, costBasis: p.costUsd, value: positionValue(p), pnlPct: p.lastPrice / p.entryPrice - 1, thesis: p.thesis,
      tookProfit: Boolean(p.tookProfit),
    })),
    closed: pf.closed.slice(-30).reverse().map((c) => ({
      symbol: c.symbol, url: c.url, invested: c.originalCostUsd, returned: c.proceedsUsd, pnlPct: c.pnlPct, thesis: c.thesis,
      exitReason: c.exitReason, postMortem: c.postMortem, closedAt: c.closedAt,
    })),
    posts: load('social').posts.slice(-30).reverse(),
    scenes: load('content').briefs.slice(-12).reverse().map(({ id, at, tier, trigger, format, scene, caption, status, mediaUrl }) => ({ id, at, tier, trigger, format, scene, caption, status, mediaUrl })),
    relationships: Object.values(memory.people).sort((a, b) => b.interactions.length - a.interactions.length).slice(0, 12)
      .map((p) => ({ handle: p.handle, sentiment: p.sentiment, tags: p.tags, interactions: p.interactions.length, lastSeen: p.lastSeen })),
    lastReflection,
    policy: config.policy,
  };
}

export function startServer(port = config.port) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(fs.readFileSync(PAGE));
      }
      if (url.pathname === '/api/state') return json(res, publicState());
      if (url.pathname === '/api/ledger') return json(res, readLedger(Math.min(500, Number(url.searchParams.get('limit')) || 100)));
      if (url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': connected\n\n');
        const off = onLedgerEvent((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
        const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
        req.on('close', () => {
          off();
          clearInterval(ping);
        });
        return;
      }
      res.writeHead(404).end('not found');
    } catch (err) {
      console.error(err);
      res.writeHead(500).end('error');
    }
  });
  server.listen(port, () => console.log(`dashboard on http://localhost:${port}`));
  return server;
}

function json(res, body) {
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
}
