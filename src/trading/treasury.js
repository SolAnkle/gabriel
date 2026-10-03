// Port bookkeeping and the money coming in and out of the wallet:
// creator-fee income (claims), cash, profit sweeps to cold storage, and periodic snapshots.
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { config, assertLiveTradingAllowed } from '../config.js';
import { load, update, record } from '../store.js';
import { treasuryValue, capital } from './policy.js';
import { walletAddress, solPriceUsd, SOL_MINT } from './wallet.js';
import { solBalance, tokenBalanceRaw } from '../market/solana.js';
import { connection, sendTransaction, transferSol } from './tx.js';

const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_AMM_PROGRAM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const RENT_EXEMPT_EMPTY = 890_880; // lamports an empty system account must keep

export function creditCreatorFees(usd, note = 'creator fees') {
  if (!(usd > 0)) return;
  update('portfolio', (p) => {
    p.feesEarnedUsd += usd;
    if (config.tradingMode === 'paper') p.cashUsd += usd;
  });
  const c = capital(load('portfolio'), config.policy);
  record('fees', `+$${usd.toFixed(2)} ${note}`, { usd, port: c.treasury });
}

/** Live mode: cash is whatever SOL the wallet holds. */
export async function refreshLiveCash() {
  if (config.tradingMode !== 'live') return;
  const [sol, price] = await Promise.all([solBalance(walletAddress()), solPriceUsd()]);
  update('portfolio', (p) => (p.cashUsd = sol * price));
}

/**
 * Unclaimed creator fees, in SOL, per pump.fun venue:
 *  - bonding curve: the creator-vault PDA of the pump program (native SOL above rent)
 *  - PumpSwap (after graduation): WSOL held by the creator-vault authority of the AMM program
 * Returns null for a venue whose balance couldn't be read.
 */
export async function pendingCreatorFees(creator = walletAddress()) {
  const c = connection();
  const owner = new PublicKey(creator);
  const [curveVault] = PublicKey.findProgramAddressSync([Buffer.from('creator-vault'), owner.toBuffer()], PUMP_PROGRAM);
  const [ammAuthority] = PublicKey.findProgramAddressSync([Buffer.from('creator_vault'), owner.toBuffer()], PUMP_AMM_PROGRAM);
  const [curve, amm] = await Promise.allSettled([
    c.getBalance(curveVault, 'confirmed').then((l) => Math.max(0, l - RENT_EXEMPT_EMPTY) / 1e9),
    tokenBalanceRaw(ammAuthority.toBase58(), SOL_MINT).then((raw) => Number(raw) / 1e9),
  ]);
  return {
    curve: curve.status === 'fulfilled' ? curve.value : null,
    amm: amm.status === 'fulfilled' ? amm.value : null,
  };
}

async function claimVia(pool) {
  const body = { publicKey: walletAddress(), action: 'collectCreatorFee', priorityFee: config.execution.pumpPortalPriorityFeeSol, pool };
  if (pool === 'pump-amm') body.mint = load('agent').coin?.address || process.env.AGENT_COIN_ADDRESS;
  const res = await fetch('https://pumpportal.fun/api/trade-local', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`PumpPortal claim (${pool}) -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const tx = VersionedTransaction.deserialize(new Uint8Array(await res.arrayBuffer()));
  return sendTransaction(tx, `claim ${pool}`);
}

/**
 * Claims pump.fun creator fees when there's enough waiting to be worth the transaction fee.
 * If the vault balances can't be read, claims at most every CLAIM_INTERVAL_HOURS instead.
 * The SOL that actually arrives is what gets credited. Live mode + CLAIM_CREATOR_FEES=true only.
 * VERIFY ON MAINNET with a small balance first: PumpPortal's claim API and pump.fun's vault layout
 * can change.
 */
export async function claimCreatorFees() {
  if (!config.fees.claim || !assertLiveTradingAllowed()) return null;
  const owner = walletAddress();
  const pending = await pendingCreatorFees(owner);
  const lastClaim = load('portfolio').lastFeeClaimAt;
  const intervalDue = !lastClaim || Date.now() - Date.parse(lastClaim) > config.fees.claimIntervalHours * 3_600_000;

  const pools = [];
  if (pending.curve == null ? intervalDue : pending.curve >= config.fees.minClaimSol) pools.push('pump');
  const hasCoin = Boolean(load('agent').coin?.address || process.env.AGENT_COIN_ADDRESS);
  if (hasCoin && (pending.amm == null ? intervalDue : pending.amm >= config.fees.minClaimSol)) pools.push('pump-amm');
  if (!pools.length) return 0;

  let gained = 0;
  for (const pool of pools) {
    const before = await solBalance(owner);
    try {
      const sig = await claimVia(pool);
      const got = (await solBalance(owner)) - before;
      if (got > 0) {
        gained += got;
        const usd = got * (await solPriceUsd());
        update('portfolio', (p) => (p.feesEarnedUsd += usd));
        record('fees', `Claimed ${got.toFixed(4)} SOL ($${usd.toFixed(2)}) in creator fees (${pool})`, { txid: sig, sol: got, usd, pool });
      }
    } catch (err) {
      record('error', `Creator fee claim (${pool}) failed: ${err.message}`);
    }
  }
  update('portfolio', (p) => (p.lastFeeClaimAt = new Date().toISOString()));
  return gained;
}

/** Moves SOL above SWEEP_ABOVE_SOL to SWEEP_TO_ADDRESS (cold wallet). Live mode only. */
export async function sweepProfits() {
  const { toAddress, aboveSol } = config.sweep;
  if (!toAddress || !(aboveSol > 0) || !assertLiveTradingAllowed()) return null;
  const bal = await solBalance(walletAddress());
  const excess = bal - aboveSol;
  if (excess < 0.01) return 0;
  const lamports = Math.floor(excess * 1e9);
  const sig = await transferSol(toAddress, lamports, 'profit sweep');
  const usd = excess * (await solPriceUsd());
  record('sweep', `Swept ${excess.toFixed(4)} SOL ($${usd.toFixed(2)}) to cold wallet`, { txid: sig, to: toAddress, sol: excess });
  return excess;
}

export function snapshotTreasury() {
  update('portfolio', (p) => {
    p.snapshots.push({ at: new Date().toISOString(), treasuryUsd: Math.round(treasuryValue(p) * 100) / 100 });
    if (p.snapshots.length > 5000) p.snapshots.splice(0, p.snapshots.length - 5000);
  });
}

/** Where the character's life is, based on port value vs. lifetime fees. Colours how he talks. */
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
