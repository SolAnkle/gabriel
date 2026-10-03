// Execution layer. Paper mode simulates fills at live prices with a price-impact estimate.
// Live mode swaps through Jupiter (PumpPortal as the fallback for coins still on the pump.fun bonding
// curve) and signs locally. Policy checks run BEFORE this is called; live mode re-checks the actual
// quote (price impact) and simulates every transaction before sending it.
import { VersionedTransaction } from '@solana/web3.js';
import { config, assertLiveTradingAllowed } from '../config.js';
import { checkQuote } from './policy.js';
import { tokenBalanceRaw, solBalance } from '../market/solana.js';
import { fetchJson } from '../market/dexscreener.js';
import { keypair, sendTransaction, SimulationError, UnconfirmedError } from './tx.js';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUP = 'https://lite-api.jup.ag';
const PAPER_FEE_PCT = 0.003; // DEX fee + priority fee, roughly

/** No route to sell this token anywhere: the bot keeps the position and alerts instead of retrying blindly. */
export class UnsellableError extends Error {}

export function walletAddress() {
  if (config.tradingMode === 'live' && config.walletSecretKey) return keypair().publicKey.toBase58();
  return config.publicWalletAddress || 'paper-wallet';
}

/** Constant-product estimate: trading `usd` into a pool with `liquidityUsd` total moves price about this much. */
export function estimateImpact(usd, liquidityUsd) {
  const side = Math.max(1, liquidityUsd / 2);
  return usd / (side + usd);
}

/** SOL a buy may spend: everything above the fee reserve. */
export function spendableSol(balanceSol, reserveSol) {
  return Math.max(0, balanceSol - reserveSol);
}

/** Raw token amount for selling `fraction` of a balance (fraction >= 1 sells everything). */
export function sellAmountRaw(balanceRaw, fraction) {
  if (fraction >= 1) return balanceRaw;
  return (balanceRaw * BigInt(Math.floor(Math.max(0, fraction) * 1e6))) / 1_000_000n;
}

export async function solPriceUsd() {
  const data = await fetchJson(`${JUP}/price/v3?ids=${SOL_MINT}`);
  const p = Number(data?.[SOL_MINT]?.usdPrice);
  if (!(p > 0)) throw new Error('could not price SOL');
  return p;
}

// ---------------- paper ----------------
function paperBuy(snapshot, usd) {
  const impact = estimateImpact(usd, snapshot.liquidityUsd);
  const priceUsd = snapshot.priceUsd * (1 + impact);
  const net = usd * (1 - PAPER_FEE_PCT);
  return { amount: net / priceUsd, priceUsd, costUsd: usd, txid: null, simulated: true };
}

function paperSell(snapshot, amount) {
  const gross = amount * snapshot.priceUsd;
  const impact = estimateImpact(gross, snapshot.liquidityUsd);
  const priceUsd = snapshot.priceUsd * (1 - impact);
  return { amount, priceUsd, proceedsUsd: amount * priceUsd * (1 - PAPER_FEE_PCT), txid: null, simulated: true };
}

// ---------------- live routes ----------------
const NO_ROUTE = /COULD_NOT_FIND_ANY_ROUTE|NO_ROUTES_FOUND|TOKEN_NOT_TRADABLE|not tradable|HTTP 400/i;

async function jupiterSwap(inputMint, outputMint, amountRaw) {
  const q = new URLSearchParams({ inputMint, outputMint, amount: String(amountRaw), slippageBps: String(config.policy.maxSlippageBps) });
  const quote = await fetchJson(`${JUP}/swap/v1/quote?${q}`);
  const check = checkQuote(quote, config.policy);
  if (!check.ok) throw new Error(`quote rejected: ${check.reason}`);
  const swap = await fetchJson(`${JUP}/swap/v1/swap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: walletAddress(),
      dynamicComputeUnitLimit: true,
      dynamicSlippage: false,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: { maxLamports: config.execution.maxPriorityFeeLamports, priorityLevel: config.execution.priorityLevel },
      },
    }),
    timeoutMs: 20_000,
  });
  const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, 'base64'));
  return sendTransaction(tx, 'jupiter swap', { lastValidBlockHeight: swap.lastValidBlockHeight });
}

/** PumpPortal local transaction: works for coins still on the pump.fun bonding curve. */
async function pumpPortalTrade({ action, mint, amount, denominatedInSol }) {
  const res = await fetch('https://pumpportal.fun/api/trade-local', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      publicKey: walletAddress(), action, mint, amount, denominatedInSol: String(denominatedInSol),
      slippage: config.policy.maxSlippageBps / 100, priorityFee: config.execution.pumpPortalPriorityFeeSol, pool: 'auto',
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`PumpPortal ${action} -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const tx = VersionedTransaction.deserialize(new Uint8Array(await res.arrayBuffer()));
  return sendTransaction(tx, `pumpportal ${action}`);
}

/**
 * Runs `attempt` up to N times with a fresh quote each time. Before each retry, `landed()` checks
 * balances, so a transaction that confirmed late is never repeated (no double buys or sells).
 */
async function withRetries(label, attempt, landed) {
  let lastErr;
  for (let i = 0; i < config.execution.swapAttempts; i++) {
    try {
      return await attempt(i);
    } catch (err) {
      lastErr = err;
      if (err instanceof UnconfirmedError || !(err instanceof SimulationError)) {
        // It may have landed anyway; never resend blindly.
        if (await landed()) return null;
      }
      if (err instanceof UnsellableError) throw err;
      console.warn(`${label} attempt ${i + 1} failed: ${err.message}`);
    }
  }
  throw lastErr;
}

async function liveBuy(snapshot, usd, decimals) {
  const owner = walletAddress();
  const [solUsd, solBal] = await Promise.all([solPriceUsd(), solBalance(owner)]);
  const sol = Math.min(usd / solUsd, spendableSol(solBal, config.execution.minSolReserve));
  if (sol < 0.001) throw new Error(`not enough SOL above the ${config.execution.minSolReserve} SOL fee reserve`);
  const lamports = Math.floor(sol * 1e9);
  const before = await tokenBalanceRaw(owner, snapshot.address);
  const landed = async () => (await tokenBalanceRaw(owner, snapshot.address)) > before;

  let route = 'jupiter';
  const sig = await withRetries(`buy $${snapshot.symbol}`, async () => {
    if (route === 'jupiter') {
      try {
        return await jupiterSwap(SOL_MINT, snapshot.address, lamports);
      } catch (err) {
        if (!NO_ROUTE.test(err.message)) throw err;
        route = 'pumpportal'; // likely still on the bonding curve
      }
    }
    return pumpPortalTrade({ action: 'buy', mint: snapshot.address, amount: sol, denominatedInSol: true });
  }, landed);

  const after = await tokenBalanceRaw(owner, snapshot.address);
  const amount = Number(after - before) / 10 ** decimals;
  if (!(amount > 0)) throw new Error(`buy ${sig || '(landed late)'} confirmed but no tokens arrived`);
  const costUsd = sol * solUsd;
  return { amount, priceUsd: costUsd / amount, costUsd, txid: sig, route, simulated: false };
}

async function liveSell(snapshot, fraction, decimals) {
  const owner = walletAddress();
  const balance = await tokenBalanceRaw(owner, snapshot.address);
  const raw = sellAmountRaw(balance, fraction);
  if (raw <= 0n) throw new Error('nothing to sell');
  const solBefore = await solBalance(owner);
  const landed = async () => (await tokenBalanceRaw(owner, snapshot.address)) < balance;

  let route = 'jupiter';
  const sig = await withRetries(`sell $${snapshot.symbol}`, async () => {
    if (route === 'jupiter') {
      try {
        return await jupiterSwap(snapshot.address, SOL_MINT, raw);
      } catch (err) {
        if (!NO_ROUTE.test(err.message)) throw err;
        route = 'pumpportal';
      }
    }
    try {
      return await pumpPortalTrade({ action: 'sell', mint: snapshot.address, amount: Number(raw) / 10 ** decimals, denominatedInSol: false });
    } catch (err) {
      // A failed simulation or slow confirm is retryable; only "no route anywhere" means unsellable.
      if (err instanceof SimulationError || err instanceof UnconfirmedError) throw err;
      throw new UnsellableError(`no route to sell $${snapshot.symbol} (Jupiter and PumpPortal both failed: ${err.message})`);
    }
  }, landed);

  const after = await tokenBalanceRaw(owner, snapshot.address);
  const soldRaw = balance - after;
  const proceedsUsd = Math.max(0, (await solBalance(owner)) - solBefore) * (await solPriceUsd());
  const amount = Number(soldRaw) / 10 ** decimals;
  if (!(amount > 0)) throw new Error(`sell ${sig || '(landed late)'} confirmed but balance did not drop`);
  return { amount, priceUsd: proceedsUsd / amount, proceedsUsd, txid: sig, route, simulated: false };
}

export async function executeBuy(snapshot, usd, safety) {
  if (assertLiveTradingAllowed()) return liveBuy(snapshot, usd, safety?.decimals ?? 6);
  return paperBuy(snapshot, usd);
}

export async function executeSell(snapshot, position, fraction) {
  if (assertLiveTradingAllowed()) return liveSell(snapshot, fraction, position.decimals ?? 6);
  return paperSell(snapshot, position.amount * fraction);
}
