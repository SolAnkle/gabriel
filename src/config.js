// All settings come from the environment. Everything that can lose money or speak in public
// is OFF by default: the agent paper-trades and writes posts to the log instead of X.
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const num = (v, d) => (v == null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v, d = false) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

export const config = {
  stateDir: process.env.STATE_DIR || path.join(here, '..', 'state'),
  kolDir: process.env.KOL_DIR || path.join(here, '..', 'data', 'kols'),

  // --- LLM ---
  model: process.env.AGENT_MODEL || 'claude-opus-5-5',
  // Without a key the agent runs on a scripted offline brain so the whole loop can be demoed.
  llmEnabled: Boolean(process.env.ANTHROPIC_API_KEY),

  // --- Trading ---
  // paper: simulated fills at live DexScreener prices. live: real swaps through Jupiter.
  tradingMode: process.env.TRADING_MODE === 'live' ? 'live' : 'paper',
  // Live trading needs this second switch too, so a typo in TRADING_MODE can't spend money.
  liveTradingConfirmed: bool(process.env.I_UNDERSTAND_THIS_SPENDS_REAL_MONEY),
  solanaRpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  walletSecretKey: process.env.AGENT_WALLET_SECRET_KEY || '', // base58, live mode only
  publicWalletAddress: process.env.AGENT_WALLET_ADDRESS || '',
  paperStartingTreasuryUsd: num(process.env.PAPER_STARTING_TREASURY_USD, 10_000),

  // --- Live execution ---
  execution: {
    // SOL always left in the wallet for transaction fees; buys can never dip into it.
    minSolReserve: num(process.env.MIN_SOL_RESERVE, 0.05),
    // Jupiter priority fee: level + cap per transaction (lamports).
    priorityLevel: process.env.PRIORITY_LEVEL || 'high', // medium | high | veryHigh
    maxPriorityFeeLamports: num(process.env.MAX_PRIORITY_FEE_LAMPORTS, 2_000_000),
    // PumpPortal fallback priority fee (SOL) for coins still on the pump.fun bonding curve.
    pumpPortalPriorityFeeSol: num(process.env.PUMPPORTAL_PRIORITY_FEE_SOL, 0.0005),
    swapAttempts: num(process.env.SWAP_ATTEMPTS, 3),
    confirmTimeoutSec: num(process.env.CONFIRM_TIMEOUT_SEC, 60),
  },

  // --- Creator fees ---
  fees: {
    claim: bool(process.env.CLAIM_CREATOR_FEES),
    // Skip claims smaller than this, so transaction fees don't eat them.
    minClaimSol: num(process.env.MIN_CLAIM_SOL, 0.05),
    // Claim at most this often even when the pending balance can't be read.
    claimIntervalHours: num(process.env.CLAIM_INTERVAL_HOURS, 6),
  },

  // --- Profit sweep: SOL above the threshold goes to a cold wallet ---
  sweep: {
    toAddress: process.env.SWEEP_TO_ADDRESS || '',
    aboveSol: num(process.env.SWEEP_ABOVE_SOL, 0),
  },

  // --- Alerts (any or both) ---
  alerts: {
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
  },

  // --- Portfolio policy (deterministic; the LLM can never change these) ---
  policy: {
    buckets: {
      reserve: num(process.env.BUCKET_RESERVE, 0.4),
      trading: num(process.env.BUCKET_TRADING, 0.3),
      operations: num(process.env.BUCKET_OPERATIONS, 0.2),
      experimental: num(process.env.BUCKET_EXPERIMENTAL, 0.1),
    },
    maxTradeUsd: num(process.env.MAX_TRADE_USD, 500),
    maxTradePctOfTreasury: num(process.env.MAX_TRADE_PCT_OF_TREASURY, 0.05),
    maxPositionPctOfTreasury: num(process.env.MAX_POSITION_PCT_OF_TREASURY, 0.08),
    maxOpenPositions: num(process.env.MAX_OPEN_POSITIONS, 8),
    minLiquidityUsd: num(process.env.MIN_LIQUIDITY_USD, 25_000),
    minVolume24hUsd: num(process.env.MIN_VOLUME_24H_USD, 50_000),
    minTokenAgeMinutes: num(process.env.MIN_TOKEN_AGE_MINUTES, 30),
    maxTop10HolderPct: num(process.env.MAX_TOP10_HOLDER_PCT, 0.45),
    minOrganicScore: num(process.env.MIN_ORGANIC_SCORE, 20),
    maxSlippageBps: num(process.env.MAX_SLIPPAGE_BPS, 300),
    maxPriceImpactPct: num(process.env.MAX_PRICE_IMPACT_PCT, 2),
    stopLossPct: num(process.env.STOP_LOSS_PCT, -0.5),
    takeProfitPct: num(process.env.TAKE_PROFIT_PCT, 2),
    takeProfitSellFraction: num(process.env.TAKE_PROFIT_SELL_FRACTION, 0.5),
    maxHoldHours: num(process.env.MAX_HOLD_HOURS, 72),
    // After posting about a token it holds, the agent can't sell it in profit for this long.
    mentionLockHours: num(process.env.MENTION_LOCK_HOURS, 24),
    dailyLossLimitPct: num(process.env.DAILY_LOSS_LIMIT_PCT, 0.1),
    maxTradesPerDay: num(process.env.MAX_TRADES_PER_DAY, 6),
    cooldownMinutesPerToken: num(process.env.COOLDOWN_MINUTES_PER_TOKEN, 720),
    minConviction: num(process.env.MIN_CONVICTION, 7),
    allowedChains: (process.env.ALLOWED_CHAINS || 'solana').split(',').map((s) => s.trim()),
  },

  // --- X / Twitter ---
  // dry-run: posts are generated, checked and logged to the activity log but not sent.
  xMode: process.env.X_MODE === 'live' ? 'live' : 'dry-run',
  x: {
    apiKey: process.env.X_API_KEY || '',
    apiSecret: process.env.X_API_SECRET || '',
    accessToken: process.env.X_ACCESS_TOKEN || '',
    accessSecret: process.env.X_ACCESS_SECRET || '',
    bearerToken: process.env.X_BEARER_TOKEN || '',
    userId: process.env.X_USER_ID || '',
    watchHandles: (process.env.X_WATCH_HANDLES || '').split(',').map((s) => s.trim()).filter(Boolean),
  },
  social: {
    maxPostsPerDay: num(process.env.MAX_POSTS_PER_DAY, 12),
    maxRepliesPerDay: num(process.env.MAX_REPLIES_PER_DAY, 30),
    minMinutesBetweenPosts: num(process.env.MIN_MINUTES_BETWEEN_POSTS, 45),
    replyCooldownHoursPerUser: num(process.env.REPLY_COOLDOWN_HOURS_PER_USER, 6),
    maxSimilarityToRecent: num(process.env.MAX_SIMILARITY_TO_RECENT, 0.6),
  },

  // --- Loop cadence (minutes) ---
  cadence: {
    market: num(process.env.MARKET_TICK_MINUTES, 10),
    social: num(process.env.SOCIAL_TICK_MINUTES, 15),
    reflection: num(process.env.REFLECTION_TICK_MINUTES, 24 * 60),
    // How often the brain re-reads each open position's thesis and may sell early.
    exitReview: num(process.env.EXIT_REVIEW_MINUTES, 6 * 60),
  },
};

export function assertLiveTradingAllowed() {
  if (config.tradingMode !== 'live') return false;
  if (!config.liveTradingConfirmed) {
    throw new Error('TRADING_MODE=live also needs I_UNDERSTAND_THIS_SPENDS_REAL_MONEY=true');
  }
  if (!config.walletSecretKey) throw new Error('TRADING_MODE=live needs AGENT_WALLET_SECRET_KEY');
  return true;
}
