# Memecoin Character Agent

A memecoin trader character that runs itself. He has his own identity, voice and memory, his own coin and wallet. He claims his coin's creator fees, researches memecoins, buys and sells them, and posts on X about his life and his trades.

No website: it's a long-running process with a terminal status command and alerts to Telegram or Discord.

**Safe by default:** it paper-trades at live prices and logs posts instead of sending them. Real money and real posting each need explicit switches.

```
claim creator fees ─► wallet (SOL)
                         │
     scan new coins ─► brain: thesis, conviction, size ─► risk limits (code) ─► buy
                         │
  watch positions ─► exit rules + brain thesis review ─► sell ─► SOL
                         │
        X: post / reply / quote / ignore ─► guard (code) ─► X
                         │
           memory · reflection · activity log · alerts
```

## Quick start

```bash
npm install
cp .env.example .env        # add ANTHROPIC_API_KEY for the real brain
npm run ingest-kols         # optional: personality influences from data/kols/
npm run genesis             # he creates himself: name, story, voice, look, coin
npm start                   # the loop: trading + X
npm run status              # in another terminal: port, positions, recent activity
```

| Command (`node src/cli.js …`) | What it does |
|---|---|
| `genesis [--force] [--seed "..."]` | Character creation: identity, origin story, voice, trading style, look (for Higgsfield), coin, bio |
| `ingest-kols` | Analyse `data/kols/*` into an original personality blend (see `data/kols/README.md`) |
| `run` | The loop: market every 10 min, X every 15 min, exit review every 6 h, reflection daily |
| `status` | Wallet, port, cash, fees, W/L record, positions with theses, recent trades and errors |
| `tick [market\|exits\|social\|reflection]` | Run one tick and exit |
| `claim` | Show pending creator fees and claim now (live) |
| `sweep` | Move SOL above `SWEEP_ABOVE_SOL` to the cold wallet now (live) |
| `pause [reason]` / `resume` | Kill switch for new buys. Exits and stop losses keep running |
| `fees <usd> [note]` | Record fee income by hand (paper mode adds it as cash) |
| `reflect` | Self-review now |

## The brain

- **Genesis** (`src/brain/genesis.js`). He chooses his name, handle, backstory, origin story (how he got into memecoins), what he does off the charts, his voice with example posts, his trading philosophy, a visual description for Higgsfield, his coin and his bio.
- **Personality from KOLs** (`src/brain/kols.js`, `style.js`). Writing statistics and behaviour patterns from real accounts are blended into an original voice. Each account's signature phrases are blocked from reuse.
- **Layers** (`src/brain/persona.js`). Identity, voice, risk limits, per-person memory, portfolio and recent posts are separate prompt layers, and the stable ones are cached. He stays in character. He never claims to be a real human, and says he's virtual if someone sincerely asks.
- **Memory** (`src/brain/memory.js`). People (sentiment, tags, notes, interactions), running jokes, predictions, lessons.
- **Reflection** (`src/brain/reflection.js`). A daily check for repetition and AI-sounding posts, plus a review of trades. It writes up to 3 style notes.

## Money

**Creator fees** (`src/trading/treasury.js`)
- Reads unclaimed fees from pump.fun's creator vaults: the bonding-curve vault, plus the PumpSwap vault after graduation, which needs `AGENT_COIN_ADDRESS`.
- Claims through PumpPortal only when at least `MIN_CLAIM_SOL` is waiting. If the vaults can't be read, it claims every `CLAIM_INTERVAL_HOURS` instead.
- Every claim is simulated before it's sent. Only SOL that actually arrives gets credited.

**Buying** (`src/trading/research.js` → `policy.js` → `wallet.js`)
- Discovery and scoring, then the brain's thesis, then the risk limits size or reject it.
- Execution goes through Jupiter, with PumpPortal as the fallback for coins still on the bonding curve.
- Each attempt:
  - checks the price impact on the quote
  - caps the priority fee
  - simulates before sending
  - rebroadcasts until confirmed
  - re-quotes and retries
- Balances are checked before every retry, so a late-landing transaction is never repeated.
- `MIN_SOL_RESERVE` is never spent, so there's always gas.

**Selling**
- Exit rules:
  - stop loss
  - take profit on part of the position
  - an exit for positions that sit too long without working
- Every 6 hours the brain re-reads each thesis and can sell half or all of a position.
- The brain can always cut a loser. It can't sell in profit within 24 hours of posting about that coin (no shill-and-dump).
- If no route exists on Jupiter or PumpPortal, the position is flagged **UNSELLABLE** and alerted. It's retried every tick rather than ignored.

**The wallet is the source of truth.** Each market tick reconciles the books with on-chain balances, so partial fills and outside transfers fix themselves.

**Profit sweep.** SOL above `SWEEP_ABOVE_SOL` is moved to `SWEEP_TO_ADDRESS` (your cold wallet), so the hot wallet only ever holds what it trades with.

**One lock.** Buys, sells, claims and sweeps never run at the same time.

## X

`src/social/` decides whether to post, reply, quote or ignore for each of these:
- his own trades and exits
- mentions
- posts from accounts he watches
- quiet periods

A code guard checks every post before it goes out:
- length and rate limits
- per-person reply cooldowns
- near-duplicates
- AI-sounding phrases
- reused KOL phrases
- "buy now" or guaranteed-returns wording

Any post naming a coin he holds, or his own coin, gets `[holding $X]` added.

## Going live

1. **Brain.** Set `ANTHROPIC_API_KEY`, optionally run `ingest-kols`, then `genesis --force`. Read what he chose.
2. **Coin.** Launch the coin he designed on pump.fun **from his wallet**, so the creator fees go to it. Then set `AGENT_COIN_ADDRESS`.
3. **X.** Create the account. Add the four OAuth 1.0a keys from an app with Read and Write access, and set `X_MODE=live`. Reading mentions and watched accounts needs `X_BEARER_TOKEN` (paid tier) and `X_USER_ID`. Turn on X's automated-account label.
4. **Paper week.** Leave `TRADING_MODE=paper` for a week with the real brain and check his decisions.
5. **Tiny live.** Use a fresh hot wallet, a paid `SOLANA_RPC_URL`, `TRADING_MODE=live` and `I_UNDERSTAND_THIS_SPENDS_REAL_MONEY=true`. Start with `MAX_TRADE_USD=10` and `MAX_TRADES_PER_DAY=3`.
   - Set up alerts and run `node src/cli.js claim` by hand once.
   - Run it like this for one to two weeks. Watch claims, buys, sells and `status`.
6. **Scale.** Raise the limits slowly, and set up the sweep to your cold wallet.
7. **Deploy.** `docker compose up -d --build`. It restarts on crash, and state lives in a volume.

## What's verified and what isn't

- **Verified:**
  - 24 unit tests: risk limits, exit rules, posting guard and disclosure, reserve and sell maths, style analysis, and the OAuth signature against X's published example.
  - An offline end-to-end run against live market data: genesis, paper buys, exit review, pause and resume, a disclosed post, duplicate posts blocked, and status.
- **Written but never run against mainnet:**
  - Live Jupiter and PumpPortal swaps
  - The PumpPortal fee claim, and the creator-vault addresses it reads pending fees from
  - The SOL sweep
  - Posting to X
  - Real Claude calls

  Prove these with tiny amounts in step 5 before trusting them.

## Notes

- State is plain JSON in `state/` (or `STATE_DIR`), and `state/ledger.jsonl` is the full activity log.
- The `[holding $X]` disclosure and X's automated label are deliberate. He promotes his own coin and posts about coins he holds, so they keep the account clear of misleading the people buying.
