// Execution layer. Paper mode simulates fills at live prices with a price-impact estimate.
// Live mode swaps through Jupiter and signs locally. Policy checks always run BEFORE this is called;
// live mode re-checks the actual quote (price impact) before signing.
import { Keypair, VersionedTransaction, Connection } from '@solana/web3.js';
import bs58 from 'bs58';
import { config, assertLiveTradingAllowed } from '../config.js';
import { checkQuote } from './policy.js';
import { tokenBalanceRaw, solBalance } from '../market/solana.js';
import { fetchJson } from '../market/dexscreener.js';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUP = 'https://lite-api.jup.ag';
const PAPER_FEE_PCT = 0.003; // DEX fee + priority fee, roughly

let kp = null;
function keypair() {
  if (!kp) kp = Keypair.fromSecretKey(bs58.decode(config.walletSecretKey));
  return kp;
}

export function walletAddress() {
  if (config.tradingMode === 'live' && config.walletSecretKey) return keypair().publicKey.toBase58();
  return config.publicWalletAddress || 'paper-wallet';
}

/** Constant-product estimate: trading `usd` into a pool with `liquidityUsd` total moves price about this much. */
export function estimateImpact(usd, liquidityUsd) {
  const side = Math.max(1, liquidityUsd / 2);
  return usd / (side + usd);
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

// ---------------- live (Jupiter) ----------------
async function jupiterSwap(inputMint, outputMint, amountRaw) {
  const q = new URLSearchParams({ inputMint, outputMint, amount: String(amountRaw), slippageBps: String(config.policy.maxSlippageBps) });
  const quote = await fetchJson(`${JUP}/swap/v1/quote?${q}`);
  const check = checkQuote(quote, config.policy);
  if (!check.ok) throw new Error(`quote rejected: ${check.reason}`);
  const swap = await fetchJson(`${JUP}/swap/v1/swap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ quoteResponse: quote, userPublicKey: walletAddress(), dynamicComputeUnitLimit: true, prioritizationFeeLamports: 'auto' }),
    timeoutMs: 20_000,
  });
  const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, 'base64'));
  tx.sign([keypair()]);
  const conn = new Connection(config.solanaRpcUrl, 'confirmed');
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  if (res.value.err) throw new Error(`swap ${sig} failed on chain: ${JSON.stringify(res.value.err)}`);
  return { sig, quote };
}

async function liveBuy(snapshot, usd, decimals) {
  const solUsd = await solPriceUsd();
  const before = await tokenBalanceRaw(walletAddress(), snapshot.address);
  const { sig } = await jupiterSwap(SOL_MINT, snapshot.address, Math.floor((usd / solUsd) * 1e9));
  const after = await tokenBalanceRaw(walletAddress(), snapshot.address);
  const amount = Number(after - before) / 10 ** decimals;
  if (!(amount > 0)) throw new Error(`swap ${sig} confirmed but no tokens arrived`);
  return { amount, priceUsd: usd / amount, costUsd: usd, txid: sig, simulated: false };
}

async function liveSell(snapshot, fraction, decimals) {
  const balance = await tokenBalanceRaw(walletAddress(), snapshot.address);
  const raw = fraction >= 1 ? balance : (balance * BigInt(Math.floor(fraction * 1e6))) / 1_000_000n;
  if (raw <= 0n) throw new Error('nothing to sell');
  const solBefore = await solBalance(walletAddress());
  const { sig } = await jupiterSwap(snapshot.address, SOL_MINT, raw);
  const solAfter = await solBalance(walletAddress());
  const proceedsUsd = (solAfter - solBefore) * (await solPriceUsd());
  const amount = Number(raw) / 10 ** decimals;
  return { amount, priceUsd: proceedsUsd / amount, proceedsUsd, txid: sig, simulated: false };
}

export async function executeBuy(snapshot, usd, safety) {
  if (assertLiveTradingAllowed()) return liveBuy(snapshot, usd, safety?.decimals ?? 6);
  return paperBuy(snapshot, usd);
}

export async function executeSell(snapshot, position, fraction) {
  if (assertLiveTradingAllowed()) return liveSell(snapshot, fraction, position.decimals ?? 6);
  return paperSell(snapshot, position.amount * fraction);
}
