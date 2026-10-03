// The heartbeat. Each tick is independent and logs its own failures, so one broken API
// never stops the rest of the agent. Everything that moves money shares one lock, so a buy,
// a sell, a claim and a sweep can never run at the same time.
import { config } from './config.js';
import { load, record } from './store.js';
import { scan } from './trading/research.js';
import { refreshPositions, runExits, considerBuy, reconcile, reviewExits } from './trading/trader.js';
import { refreshLiveCash, claimCreatorFees, sweepProfits, snapshotTreasury } from './trading/treasury.js';
import { socialTick } from './social/engine.js';
import { reflect } from './brain/reflection.js';

const running = new Set();

async function guarded(lock, fn) {
  if (running.has(lock)) return; // previous tick still going
  running.add(lock);
  try {
    await fn();
  } catch (err) {
    record('error', `${lock} tick failed: ${err.message}`);
    console.error(err);
  } finally {
    running.delete(lock);
  }
}

const step = (name, fn) => fn().catch((err) => record('error', `${name} failed: ${err.message}`));

export async function marketTick() {
  await step('Wallet reconcile', reconcile);
  await step('Cash refresh', refreshLiveCash);
  await step('Creator fee claim', claimCreatorFees);
  const snaps = await refreshPositions();
  await runExits(snaps);
  const reports = await scan();
  for (const r of reports) await considerBuy(r);
  await step('Profit sweep', sweepProfits);
  snapshotTreasury();
}

export async function exitReviewTick() {
  const snaps = await refreshPositions();
  await reviewExits(snaps);
}

export const ticks = {
  market: () => guarded('money', marketTick),
  exitReview: () => guarded('money', exitReviewTick),
  social: () => guarded('social', socialTick),
  reflection: () => guarded('reflection', reflect),
};

export function startLoop() {
  if (load('agent').status !== 'online') throw new Error('Run genesis first: npm run genesis');
  record('system', `Agent started (${config.tradingMode} trading, X ${config.xMode})`);
  const timers = [];
  for (const [name, minutes] of Object.entries(config.cadence)) {
    timers.push(setInterval(ticks[name], minutes * 60_000));
  }
  // Stagger the first run so startup isn't one burst of API calls.
  setTimeout(ticks.market, 2_000);
  setTimeout(ticks.social, 60_000);
  return () => timers.forEach(clearInterval);
}
