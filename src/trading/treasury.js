// Treasury bookkeeping: creator-fee income, cash, and periodic snapshots for the dashboard chart.
import { config, assertLiveTradingAllowed } from '../config.js';
import { load, update, record } from '../store.js';
import { treasuryValue, capital } from './policy.js';
import { walletAddress, solPriceUsd } from './wallet.js';
import { solBalance } from '../market/solana.js';
import { VersionedTransaction, Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

export function creditCreatorFees(usd, note = 'creator fees') {
  if (!(usd > 0)) return;
  update('portfolio', (p) => {
    p.feesEarnedUsd += usd;
    if (config.tradingMode === 'paper') p.cashUsd += usd;
  });
  const c = capital(load('portfolio'), config.policy);
  record('fees', `+$${usd.toFixed(2)} ${note}`, { usd, split: { reserve: c.reserve, trading: c.tradingCapital, operations: c.operations } });
}

/** Live mode: cash is whatever SOL the wallet holds. */
export async function refreshLiveCash() {
  if (config.tradingMode !== 'live') return;
  const [sol, price] = await Promise.all([solBalance(walletAddress()), solPriceUsd()]);
  update('portfolio', (p) => (p.cashUsd = sol * price));
}

/**
 * Claims pump.fun creator fees through PumpPortal's local-transaction API, then credits the SOL
 * that arrived. Only in live mode with CLAIM_CREATOR_FEES=true. UNTESTED against mainnet: try it
 * manually with a small balance before leaving it on.
 */
export async function claimCreatorFees() {
  if (process.env.CLAIM_CREATOR_FEES !== 'true' || !assertLiveTradingAllowed()) return null;
  const owner = walletAddress();
  const before = await solBalance(owner);
  const res = await fetch('https://pumpportal.fun/api/trade-local', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ publicKey: owner, action: 'collectCreatorFee', priorityFee: 0.000001 }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`PumpPortal claim -> HTTP ${res.status}: ${await res.text()}`);
  const tx = VersionedTransaction.deserialize(new Uint8Array(await res.arrayBuffer()));
  tx.sign([Keypair.fromSecretKey(bs58.decode(config.walletSecretKey))]);
  const conn = new Connection(config.solanaRpcUrl, 'confirmed');
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, 'confirmed');
  const gained = (await solBalance(owner)) - before;
  if (gained > 0) {
    const usd = gained * (await solPriceUsd());
    update('portfolio', (p) => (p.feesEarnedUsd += usd));
    record('fees', `Claimed ${gained.toFixed(4)} SOL ($${usd.toFixed(2)}) in creator fees`, { txid: sig });
  }
  return gained;
}

export function snapshotTreasury() {
  update('portfolio', (p) => {
    p.snapshots.push({ at: new Date().toISOString(), treasuryUsd: Math.round(treasuryValue(p) * 100) / 100 });
    if (p.snapshots.length > 5000) p.snapshots.splice(0, p.snapshots.length - 5000);
  });
}

/** Where the character's life is, based on treasury vs. lifetime fees. Drives the content engine. */
export function lifeTier(portfolio = load('portfolio')) {
  const t = treasuryValue(portfolio);
  const basis = Math.max(1, portfolio.feesEarnedUsd);
  const ratio = t / basis;
  if (t < 500 || ratio < 0.4) return 'broke';
  if (ratio < 0.9) return 'surviving';
  if (ratio < 1.5) return 'comfortable';
  if (ratio < 4) return 'winning';
  return 'rich';
}
