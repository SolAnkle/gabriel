// Signing, simulating, sending and confirming transactions. Every live money path goes through here:
// swaps, creator-fee claims and profit sweeps.
import { Keypair, VersionedTransaction, Connection, PublicKey, SystemProgram, TransactionMessage } from '@solana/web3.js';
import bs58 from 'bs58';
import { config } from '../config.js';

let kp = null;
let conn = null;

export function keypair() {
  if (!kp) kp = Keypair.fromSecretKey(bs58.decode(config.walletSecretKey));
  return kp;
}

export function connection() {
  if (!conn) conn = new Connection(config.solanaRpcUrl, 'confirmed');
  return conn;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Thrown when simulation rejects a transaction: nothing was sent, safe to retry with a fresh quote. */
export class SimulationError extends Error {
  constructor(label, err, logs = []) {
    super(`${label}: simulation failed ${JSON.stringify(err)}${logs.length ? ` | ${logs.slice(-3).join(' | ')}` : ''}`);
    this.simErr = err;
    this.logs = logs;
  }
}

/** Thrown when a sent transaction was not seen as confirmed in time. It MAY still land; check balances. */
export class UnconfirmedError extends Error {}

/**
 * Signs (if needed), simulates, sends and confirms a versioned transaction.
 * Rebroadcasts every few seconds until confirmed, failed, expired or timed out.
 * Returns the signature.
 */
export async function sendTransaction(tx, label, { lastValidBlockHeight } = {}) {
  const c = connection();
  tx.sign([keypair()]);

  const sim = await c.simulateTransaction(tx, { sigVerify: false, commitment: 'processed' });
  if (sim.value.err) throw new SimulationError(label, sim.value.err, sim.value.logs || []);

  const raw = tx.serialize();
  const sig = await c.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
  const deadline = Date.now() + config.execution.confirmTimeoutSec * 1000;
  let lastSend = Date.now();
  while (Date.now() < deadline) {
    await sleep(2000);
    const { value } = await c.getSignatureStatuses([sig]);
    const st = value[0];
    if (st?.err) throw new Error(`${label}: ${sig} failed on chain: ${JSON.stringify(st.err)}`);
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return sig;
    if (lastValidBlockHeight && (await c.getBlockHeight('confirmed')) > lastValidBlockHeight) {
      throw new UnconfirmedError(`${label}: ${sig} expired before confirming`);
    }
    if (Date.now() - lastSend > 4000) {
      await c.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
      lastSend = Date.now();
    }
  }
  throw new UnconfirmedError(`${label}: ${sig} not confirmed after ${config.execution.confirmTimeoutSec}s`);
}

/** Plain SOL transfer (used by the profit sweep). */
export async function transferSol(to, lamports, label = 'transfer') {
  const c = connection();
  const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({
    payerKey: keypair().publicKey,
    recentBlockhash: blockhash,
    instructions: [SystemProgram.transfer({ fromPubkey: keypair().publicKey, toPubkey: new PublicKey(to), lamports })],
  }).compileToV0Message();
  return sendTransaction(new VersionedTransaction(msg), label, { lastValidBlockHeight });
}
