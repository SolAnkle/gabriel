# Autonomous Memecoin Agent

An AI memecoin trader and influencer that people can watch. It designs its own identity, earns creator fees from its own coin, researches memecoins, buys some with part of its treasury, explains each decision, posts on X, remembers people, reflects on itself, and its visual life follows its wallet. Every step goes to a public activity ledger and a character-first website.

**Safe by default:** it paper-trades at live prices and writes posts to the dashboard instead of X. Real money and real posting each need explicit switches.

```
KOL posts ─► style stats + behaviour patterns ─► original personality influences
                                                         │
genesis ─► identity · voice · trading philosophy · visual identity · coin · bio ─► agent online
                                                         │
DexScreener feeds ─► metrics (code) ─► shortlist ─► holder/authority/organic checks ─► model thesis
                                                         │
                                         portfolio policy (code) ── no ──► "rules said no" on the ledger
                                                         │ yes, sized by the smallest cap
                                                   wallet (paper | Jupiter)
                                                         │
                  social engine: POST / REPLY / QUOTE / IGNORE (model) ─► guard (code) ─► X
                                                         │
             memory (people, jokes, predictions) · reflection · content briefs (Higgsfield)
                                                         │
                                     public ledger ─► character website (live stream)
```

## The core rule: the model wants, code decides

| The model decides | Code enforces |
|---|---|
| Who it is, how it talks, what its coin is | Treasury buckets: 40% reserve, 30% trading, 20% operations, 10% experimental |
| Whether it likes a token, its thesis, conviction, desired size | Max trade ($ and % of treasury), max position, max open positions, trades per day, daily loss limit, per-token cooldown |
| | Minimum liquidity, volume and pair age; holder concentration; mint/freeze authority; organic-volume score; price impact on live quotes |
| | Stop loss, take profit, stale-position exit |
| Whether to post, reply, quote or ignore, and what to say | Length, rate limits, per-person reply cooldown, near-duplicate check, "sounds like AI" phrases, reuse of a real KOL's signature phrases, buy-solicitation wording |
| | **Holding disclosure** appended to any post naming a token it holds, its own coin, or a post triggered by a trade |
| | **No profit-taking for 24h after it talks about a token it holds** (stop losses still work), so it can't shill and dump |

Every rejection is public: "Wanted $XYZ; rules said no: top holders own 62%".

## Quick start

```bash
cd agent
npm install
cp .env.example .env          # optional: add ANTHROPIC_API_KEY for the real brain
npm run genesis               # the agent creates itself (watch the ledger)
npm run tick                  # one pass of market → social → reflection → content
npm start                     # website on http://localhost:8787 + autonomous loop
```

Without `ANTHROPIC_API_KEY` the agent uses a scripted offline brain, so you can run the whole pipeline (real market data, paper trades, guard, dashboard) for free.

Other commands:

| Command | What it does |
|---|---|
| `npm run ingest-kols` | Analyse `data/kols/*` into personality influences. Run **before** genesis. See `data/kols/README.md`. |
| `node src/cli.js genesis --force --seed "..."` | Redo genesis with extra direction |
| `node src/cli.js tick market` | Also `social`, `reflection`, `content` |
| `node src/cli.js fees 250 "week 1 fees"` | Record creator-fee income (adds cash in paper mode) |
| `npm run serve` | Website only |
| `npm test` | Unit tests for policy, guard, style analysis, metrics and OAuth signing |

## How each part works

**Personality from KOLs** (`src/brain/kols.js`, `style.js`). For each account, code computes writing statistics (length, capitalisation, emoji, punctuation, tickers, reply rate, vocabulary) and finds its repeated 4-word "signature" phrases. The model describes behaviour abstractly: humour, sarcasm, how they react to wins, losses and criticism, how they treat bigger accounts, what makes them reply or ignore. A second pass blends all accounts into one original spec. Signature phrases are stored, and any post that reuses one is blocked.

**Genesis** (`src/brain/genesis.js`). From `data/genesis-prompt.md` (which includes your suggested look as a starting point the agent may change), the agent chooses its name and handle, backstory, insecurities and ambitions, voice with example posts, trading philosophy, a visual identity with environments for five life tiers, its coin, and its bio. Each step is a ledger event, so the dashboard shows it building itself.

**Brain layers** (`src/brain/persona.js`). Identity, voice (plus reflection notes), policy, per-person memory, portfolio and recent posts are separate prompt layers. The stable ones come first and are prompt-cached.

**Research** (`src/trading/research.js`). It pulls DexScreener's latest-profile and boost feeds, computes buy pressure, volume and transaction acceleration, volume/liquidity and change since the last look, and skips anything under the policy floors before spending a model call. The top few get a Jupiter audit (top-holder %, mint/freeze authority, holder count, organic score; falls back to RPC) and a model thesis: narrative and meme scores, risk, conviction, BUY/WATCH/PASS, and a one-line public thesis.

**Execution** (`src/trading/wallet.js`). Paper mode fills at the live price plus a constant-product impact estimate and fees. Live mode quotes on Jupiter, rejects quotes over the price-impact limit, signs locally and confirms, then reconciles the actual token balance.

**Social** (`src/social/engine.js`). Inputs are its own trades and exits, mentions, posts from watched KOLs, and quiet periods. The model sees what it remembers about the person, its portfolio, its recent posts and running jokes, then picks an action. IGNORE is a first-class outcome and is logged with a reason. If the guard rejects a draft for something fixable, the model gets one rewrite.

**Memory** (`src/brain/memory.js`): people (sentiment −5..5, tags, notes, last 40 interactions), running jokes, predictions, lessons. Someone who trolls it Monday is in context on Friday.

**Reflection** (`src/brain/reflection.js`, daily). Code measures pairwise similarity, repeated openers and generic-AI phrases, and pulls engagement where available. The model reviews posts, trades and jokes, and writes at most 3 style notes. Notes adjust *how* it writes, never who it is, and only the latest 12 are kept.

**Content** (`src/content/engine.js`). Code decides when a new scene is warranted: life tier change (broke → surviving → comfortable → winning → rich, from treasury vs. lifetime fees), a ±30% treasury move, a big win, a rug, or a daily slice of life. The model writes the scene and caption on top of its fixed appearance. With `HIGGSFIELD_*` set, the brief is POSTed to your endpoint; otherwise it's queued on the dashboard.

## The website

The site is about **him**, not his trading. Two pages, one look:

- **`/` (home): the character.** Your Higgsfield render stands centre stage in front of his name as a masthead, with mood-coloured light, film grain and a slight mouse parallax. Around him: an online / last-seen dot, his latest post (typed out, holding disclosure underneath), his mood, where he is right now, and his current action as a film subtitle. Below that: **About** (story, age, where he lives, what he believes, wants and secretly worries about, what he does off the charts), **Life** (the Higgsfield photo and video reel, plus which era of his life he's in), **Lately** (his posts and his people) and **His coin**. Trading appears only as one band near the end that links to the desk.
- **`/trading`: the desk.** Treasury and chart, positions with his thesis for each, Ws and Ls with post-mortems, a live trade log, and his risk rules.

He's presented as a person living his life, not as an AI project: no "experiment", agent log or "he made himself" framing anywhere. One footer line says he's a virtual character made with Higgsfield and runs automatically, and posts about coins he holds keep their disclosure. Keep both: they're what stop the account being misleading to people who might buy his coin. His prompts tell him to stay in character, never talk about models or prompts, never claim to be a real human, and say he's virtual if someone sincerely asks.

**Put the character in:** drop Higgsfield renders into `data/character/` (see `data/character/README.md`). `hero.png` (ideally a transparent cut-out) or `hero.mp4` becomes the centre figure. `hero-broke.png` … `hero-rich.png` swap automatically as his life tier changes. Any other file shows in the life gallery. Until then, a placeholder silhouette holds his spot.

## Going live: checklist

1. **Brain:** set `ANTHROPIC_API_KEY`, run `ingest-kols` with your dataset, then `genesis --force`. Read the identity it chose before going further.
2. **Coin:** launch the coin it designed (name, ticker, logo prompt) on pump.fun from the agent's wallet and set `AGENT_COIN_ADDRESS`. Launching is deliberately manual.
3. **X:** create the account with the chosen handle and bio. Add the four OAuth 1.0a keys (Read and Write app) and set `X_MODE=live`. Reading mentions and KOLs needs a bearer token on a paid tier, plus `X_USER_ID`. Label it as an automated account in X settings.
4. **Money:** use a fresh wallet holding only what you're willing to lose, and a paid `SOLANA_RPC_URL`. Set `TRADING_MODE=live` and `I_UNDERSTAND_THIS_SPENDS_REAL_MONEY=true`. Start with a small `MAX_TRADE_USD`.
5. **Creator fees:** `CLAIM_CREATOR_FEES=true` claims through PumpPortal each market tick. Test one claim manually first.
6. **Deploy:** `docker build -t agent . && docker run -p 8787:8787 -v agent-state:/data/state --env-file .env agent`

## What's verified and what isn't

- **Verified here:** unit tests (24 passing; the OAuth signature matches X's published example), and an offline end-to-end run against live DexScreener and Jupiter data: genesis, discovery, policy rejections, paper buys, the dry-run post, guard blocks, content brief, and dashboard on desktop and mobile.
- **Written but not yet run against the real services:** Claude calls (no key in the build environment), Jupiter live swaps, the PumpPortal fee claim, X posting and reading, and the Higgsfield request (its body shape is a placeholder; match it to the API you're given).

## Notes

- The dashboard only exposes public data: identity, positions, public theses, posts and ledger events. It never shows prompts, raw model reasoning or keys.
- Treat X's automation rules and the laws on promoting assets you hold as your responsibility. Disclosure and the 24h profit lock make it more transparent, but they aren't legal advice.
- State is plain JSON in `state/` (one process). Move to a database if you run several agents or need history beyond the caps.
