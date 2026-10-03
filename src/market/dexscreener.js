// Keyless market data from DexScreener: discovery feeds plus per-token pair snapshots.
const BASE = 'https://api.dexscreener.com';

export async function fetchJson(url, { timeoutMs = 10_000, ...init } = {}) {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json', 'user-agent': 'autonomous-memecoin-agent/0.1', ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

/** Newly profiled and boosted tokens: the "what's new / what's being pushed" feed. */
export async function discoverTokens(allowedChains) {
  const feeds = [
    ['profile', `${BASE}/token-profiles/latest/v1`],
    ['boost', `${BASE}/token-boosts/latest/v1`],
    ['top-boost', `${BASE}/token-boosts/top/v1`],
  ];
  const results = await Promise.allSettled(feeds.map(([, url]) => fetchJson(url)));
  const seen = new Map();
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') return console.warn(`DexScreener ${feeds[i][0]} feed failed:`, r.reason?.message);
    for (const t of Array.isArray(r.value) ? r.value : []) {
      if (!allowedChains.includes(t.chainId) || !t.tokenAddress) continue;
      const key = `${t.chainId}:${t.tokenAddress}`;
      const prev = seen.get(key) || { chainId: t.chainId, address: t.tokenAddress, sources: [], boosts: 0, description: null, links: [] };
      prev.sources.push(feeds[i][0]);
      prev.boosts = Math.max(prev.boosts, t.totalAmount || t.amount || 0);
      prev.description ||= t.description || null;
      prev.links = prev.links.length ? prev.links : t.links || [];
      seen.set(key, prev);
    }
  });
  return [...seen.values()];
}

/** Best (most liquid) pair per token, as a flat snapshot. Batches up to 30 addresses per call. */
export async function getSnapshots(chainId, addresses) {
  const out = new Map();
  for (let i = 0; i < addresses.length; i += 30) {
    const batch = addresses.slice(i, i + 30);
    const pairs = await fetchJson(`${BASE}/tokens/v1/${chainId}/${batch.join(',')}`);
    for (const p of Array.isArray(pairs) ? pairs : []) {
      const addr = p.baseToken?.address;
      if (!addr || !batch.includes(addr)) continue;
      const prev = out.get(addr);
      if (!prev || (p.liquidity?.usd || 0) > prev.liquidityUsd) out.set(addr, toSnapshot(p));
    }
  }
  return out;
}

export function toSnapshot(p) {
  const tx = p.txns || {};
  return {
    chainId: p.chainId,
    address: p.baseToken.address,
    name: p.baseToken.name,
    symbol: p.baseToken.symbol,
    pairAddress: p.pairAddress,
    dexId: p.dexId,
    url: p.url,
    priceUsd: p.priceUsd ? Number(p.priceUsd) : null,
    marketCap: p.marketCap ?? p.fdv ?? null,
    liquidityUsd: p.liquidity?.usd ?? 0,
    volume: { m5: p.volume?.m5 || 0, h1: p.volume?.h1 || 0, h6: p.volume?.h6 || 0, h24: p.volume?.h24 || 0 },
    txns: {
      m5: tx.m5 || { buys: 0, sells: 0 }, h1: tx.h1 || { buys: 0, sells: 0 },
      h6: tx.h6 || { buys: 0, sells: 0 }, h24: tx.h24 || { buys: 0, sells: 0 },
    },
    priceChange: { m5: p.priceChange?.m5 ?? 0, h1: p.priceChange?.h1 ?? 0, h6: p.priceChange?.h6 ?? 0, h24: p.priceChange?.h24 ?? 0 },
    pairCreatedAt: p.pairCreatedAt ?? null,
    imageUrl: p.info?.imageUrl || null,
    websites: (p.info?.websites || []).map((w) => w.url),
    socials: (p.info?.socials || []).map((s) => ({ type: s.type, url: s.url })),
    boosts: p.boosts?.active || 0,
    fetchedAt: new Date().toISOString(),
  };
}
