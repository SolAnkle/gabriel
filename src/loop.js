// The heartbeat. Each tick is independent and logs its own failures, so one broken API
// never stops the rest of the agent.
import { config } from './config.js';
import { load, record } from './store.js';
import { scan } from './trading/research.js';
import { refreshPositions, runExits, considerBuy } from './trading/trader.js';
import { refreshLiveCash, claimCreatorFees, snapshotTreasury } from './trading/treasury.js';
import { socialTick } from './social/engine.js';
import { reflect } from './brain/reflection.js';
import { contentTick } from './content/engine.js';

const running = new Set();

async function guarded(name, fn) {
  if (running.has(name)) return; // previous tick still going
  running.add(name);
  try {
    await fn();
  } catch (err) {
    record('error', `${name} tick failed: ${err.message}`);
    console.error(err);
  } finally {
    running.delete(name);
  }
}

export async function marketTick() {
  await refreshLiveCash();
  await claimCreatorFees().catch((err) => record('error', `Fee claim failed: ${err.message}`));
  const snaps = await refreshPositions();
  await runExits(snaps);
  const reports = await scan();
  for (const r of reports) await considerBuy(r);
  snapshotTreasury();
}

export const ticks = {
  market: () => guarded('market', marketTick),
  social: () => guarded('social', socialTick),
  reflection: () => guarded('reflection', reflect),
  content: () => guarded('content', contentTick),
};

export function startLoop() {
  if (load('agent').status !== 'online') throw new Error('Run genesis first: npm run genesis');
  record('system', `Agent loop started (${config.tradingMode} trading, X ${config.xMode})`);
  const timers = [];
  for (const [name, minutes] of Object.entries(config.cadence)) {
    timers.push(setInterval(ticks[name], minutes * 60_000));
  }
  // Stagger the first run so startup isn't one burst of API calls.
  setTimeout(ticks.market, 2_000);
  setTimeout(ticks.social, 60_000);
  setTimeout(ticks.content, 120_000);
  return () => timers.forEach(clearInterval);
}
