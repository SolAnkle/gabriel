// On-chain checks via plain Solana JSON-RPC (no SDK needed for reads).
import { config } from '../config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The free public RPC rate-limits hard (especially getTokenLargestAccounts); use a paid RPC in production.
async function rpc(method, params, attempt = 0) {
  const res = await fetch(config.solanaRpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
  const limited = res.status === 429 || /too many requests/i.test(body.error?.message || '');
  if (limited && attempt < 3) {
    await sleep(1500 * 2 ** attempt);
    return rpc(method, params, attempt + 1);
  }
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/**
 * Holder concentration and mint safety. Jupiter's token API first (keyless, includes an organic-volume
 * score), raw RPC as the fallback.
 */
export async function tokenSafety(mint) {
  try {
    const list = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${mint}`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.json());
    const t = (Array.isArray(list) ? list : []).find((x) => x.id === mint);
    if (t?.audit && t.audit.topHoldersPercentage != null) {
      return {
        source: 'jupiter',
        decimals: t.decimals,
        top10ExLargestPct: t.audit.topHoldersPercentage / 100,
        mintAuthority: t.audit.mintAuthorityDisabled === false ? 'enabled' : null,
        freezeAuthority: t.audit.freezeAuthorityDisabled === false ? 'enabled' : null,
        holderCount: t.holderCount ?? null,
        organicScore: t.organicScore ?? null,
        organicScoreLabel: t.organicScoreLabel ?? null,
        devMints: t.audit.devMints ?? null,
        tags: t.tags || [],
      };
    }
  } catch (err) {
    console.warn(`Jupiter audit failed for ${mint}:`, err.message);
  }
  return rpcTokenSafety(mint);
}

/**
 * Holder concentration and mint safety for an SPL token, straight from RPC.
 * top10Pct includes pool and bonding-curve accounts, so it overstates whale risk a little;
 * the largest single account is reported separately so it can be excluded as the probable pool.
 */
async function rpcTokenSafety(mint) {
  const largest = await rpc('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }]);
  const supply = await rpc('getTokenSupply', [mint, { commitment: 'confirmed' }]);
  const info = await rpc('getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  const total = Number(supply.value.uiAmount) || 0;
  const amounts = (largest.value || []).map((a) => Number(a.uiAmount) || 0).sort((a, b) => b - a);
  const pct = (xs) => (total ? xs.reduce((s, x) => s + x, 0) / total : null);
  const parsed = info?.value?.data?.parsed?.info || {};
  return {
    source: 'rpc',
    decimals: supply.value.decimals,
    top1Pct: pct(amounts.slice(0, 1)),
    top10Pct: pct(amounts.slice(0, 10)),
    top10ExLargestPct: pct(amounts.slice(1, 11)),
    mintAuthority: parsed.mintAuthority ?? null,
    freezeAuthority: parsed.freezeAuthority ?? null,
  };
}

export async function solBalance(address) {
  const r = await rpc('getBalance', [address, { commitment: 'confirmed' }]);
  return r.value / 1e9;
}

/** Raw (base-unit) balance of one token in a wallet. */
export async function tokenBalanceRaw(owner, mint) {
  const r = await rpc('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  return (r.value || []).reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
}

export { rpc };
