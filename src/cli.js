#!/usr/bin/env node
// Usage: node src/cli.js <command> [options]
//   genesis [--force] [--seed "extra direction"]   the character creates itself
//   ingest-kols                                    analyse data/kols/* into personality influences
//   run                                            start the autonomous loop (trading + X)
//   status                                         wallet, port, positions, recent activity
//   tick [market|exits|social|reflection]          run one tick (all if omitted) and exit
//   claim                                          claim creator fees now (live mode)
//   sweep                                          sweep SOL above SWEEP_ABOVE_SOL to the cold wallet now
//   pause [reason] / resume                        stop / restart new buys (exits keep running)
//   fees <usd> [note]                              record creator-fee income by hand (paper mode adds cash)
//   reflect                                        run a reflection now
import { config } from './config.js';
import { runGenesis } from './brain/genesis.js';
import { analyzeKols } from './brain/kols.js';
import { startLoop, marketTick, exitReviewTick } from './loop.js';
import { socialTick } from './social/engine.js';
import { reflect } from './brain/reflection.js';
import { creditCreatorFees, claimCreatorFees, sweepProfits, pendingCreatorFees } from './trading/treasury.js';
import { setPaused } from './trading/trader.js';
import { statusText } from './status.js';

const [cmd, ...args] = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

console.log(`mode: trading=${config.tradingMode} x=${config.xMode} llm=${config.llmEnabled ? config.model : 'offline'}\n`);

const commands = {
  genesis: async () => {
    const a = await runGenesis({ force: flag('force'), seed: opt('seed') || process.env.GENESIS_SEED || '' });
    console.log(`\n${a.identity.name} (@${a.identity.username}) is online. Coin: $${a.coin.ticker}`);
  },
  'ingest-kols': analyzeKols,
  run: () => startLoop(),
  status: () => console.log(statusText()),
  tick: async () => {
    const direct = { market: marketTick, exits: exitReviewTick, social: socialTick, reflection: reflect };
    if (args[0]) {
      if (!direct[args[0]]) throw new Error(`unknown tick "${args[0]}"`);
      return direct[args[0]]();
    }
    for (const fn of Object.values(direct)) await fn();
  },
  claim: async () => {
    if (config.tradingMode === 'live') console.log('pending:', await pendingCreatorFees());
    console.log('claimed SOL:', await claimCreatorFees());
  },
  sweep: async () => console.log('swept SOL:', await sweepProfits()),
  pause: () => setPaused(true, args.join(' ')),
  resume: () => setPaused(false),
  fees: () => creditCreatorFees(Number(args[0]), args.slice(1).join(' ') || 'creator fees'),
  reflect,
};

if (!commands[cmd]) {
  console.log('commands: genesis | ingest-kols | run | status | tick [market|exits|social|reflection] | claim | sweep | pause [reason] | resume | fees <usd> | reflect');
  process.exit(cmd ? 1 : 0);
}
await commands[cmd]();
if (cmd !== 'run') process.exit(0);
