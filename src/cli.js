#!/usr/bin/env node
// Usage: node src/cli.js <command> [options]
//   genesis [--force] [--seed "extra direction"]   the agent creates itself
//   ingest-kols                                    analyse data/kols/* into personality influences
//   tick [market|social|reflection|content]        run one tick (all if omitted) and exit
//   fees <usd> [note]                              record creator-fee income (paper mode adds cash)
//   reflect                                        run a reflection now
//   serve                                          dashboard only
//   run                                            dashboard + autonomous loop
import { config } from './config.js';
import { runGenesis } from './brain/genesis.js';
import { analyzeKols } from './brain/kols.js';
import { startLoop, marketTick } from './loop.js';
import { socialTick } from './social/engine.js';
import { reflect } from './brain/reflection.js';
import { contentTick } from './content/engine.js';
import { creditCreatorFees } from './trading/treasury.js';
import { startServer } from './web/server.js';

const [cmd, ...args] = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

console.log(`mode: trading=${config.tradingMode} x=${config.xMode} llm=${config.llmEnabled ? config.model : 'offline'}`);

const commands = {
  genesis: () => runGenesis({ force: flag('force'), seed: opt('seed') || process.env.GENESIS_SEED || '' }),
  'ingest-kols': analyzeKols,
  tick: async () => {
    const which = args[0];
    const direct = { market: marketTick, social: socialTick, reflection: reflect, content: contentTick };
    if (which) return direct[which]();
    for (const fn of Object.values(direct)) await fn();
  },
  fees: () => creditCreatorFees(Number(args[0]), args.slice(1).join(' ') || 'creator fees'),
  reflect,
  serve: () => startServer(),
  run: () => {
    startServer();
    startLoop();
  },
};

if (!commands[cmd]) {
  console.log('commands: genesis | ingest-kols | tick [market|social|reflection|content] | fees <usd> | reflect | serve | run');
  process.exit(cmd ? 1 : 0);
}
const result = await commands[cmd]();
if (!['serve', 'run'].includes(cmd)) {
  if (cmd === 'genesis') console.log(`\n${result.identity.name} (@${result.identity.username}) is online. Coin: $${result.coin.ticker}`);
  process.exit(0);
}
