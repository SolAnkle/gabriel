// Plain-text status for the terminal: wallet, port, positions, recent trades and alerts.
import { config } from './config.js';
import { load, readLedger } from './store.js';
import { capital, positionValue } from './trading/policy.js';
import { walletAddress } from './trading/wallet.js';
import { isPaused } from './trading/trader.js';

const usd = (n) => (n == null || !Number.isFinite(n) ? '—' : `$${n.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`);
const pct = (n) => (Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${(n * 100).toFixed(1)}%` : '—');

export function statusText() {
  const agent = load('agent');
  const pf = load('portfolio');
  const c = capital(pf, config.policy);
  const lines = [];
  const name = agent.identity ? `${agent.identity.name} (@${agent.identity.username})` : 'not born yet (run genesis)';
  lines.push(`${name}  ·  ${config.tradingMode.toUpperCase()} trading  ·  X ${config.xMode}${isPaused() ? '  ·  BUYING PAUSED' : ''}`);
  lines.push(`wallet  ${walletAddress()}`);
  if (agent.coin) lines.push(`coin    $${agent.coin.ticker}${agent.coin.address ? `  ${agent.coin.address}` : '  (not launched)'}`);
  lines.push('');
  lines.push(`port    ${usd(c.treasury)}   cash ${usd(pf.cashUsd)}   in coins ${usd(c.treasury - pf.cashUsd)}   free to trade ${usd(c.available)}`);
  lines.push(`fees    ${usd(pf.feesEarnedUsd)} earned${pf.lastFeeClaimAt ? `   last claim ${pf.lastFeeClaimAt}` : ''}`);
  const wins = pf.closed.filter((x) => x.pnlPct >= 0).length;
  lines.push(`record  ${wins}W ${pf.closed.length - wins}L   realized ${usd(pf.trades.filter((t) => t.side === 'sell').reduce((s, t) => s + (t.realizedPnlUsd || 0), 0))}`);
  lines.push('');
  lines.push(pf.positions.length ? 'POSITIONS' : 'POSITIONS  none');
  for (const p of pf.positions) {
    const pnl = p.lastPrice / p.entryPrice - 1;
    lines.push(`  $${String(p.symbol).padEnd(10)} in ${usd(p.originalCostUsd).padStart(10)}  now ${usd(positionValue(p)).padStart(10)}  ${pct(pnl).padStart(8)}${p.unsellableSince ? '  UNSELLABLE' : ''}`);
    lines.push(`    "${p.thesis}"`);
  }
  lines.push('');
  lines.push('RECENT');
  for (const e of readLedger(400).filter((x) => ['trade', 'fees', 'error', 'sweep', 'control', 'social'].includes(x.type)).slice(0, 12)) {
    lines.push(`  ${e.at.slice(5, 16).replace('T', ' ')}  ${e.type.padEnd(8)} ${e.summary.replace(/\s+/g, ' ').slice(0, 140)}`);
  }
  return lines.join('\n');
}
