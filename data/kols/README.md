# KOL dataset

Put one file per account here, then run `npm run ingest-kols`.

- `<handle>.json`: an array of posts, each a string or `{ "text": "...", "likes": 12, "retweets": 3, "created_at": "..." }`
- `<handle>.txt`: one post per line

Aim for 500–2,000 posts per account across ~10 accounts. Engagement numbers are optional; when present, the
highest-engagement posts are weighted into the sample the model reads.

The analysis keeps **patterns** (sentence shape, humour, how they react to wins, losses and criticism, what makes
them reply) and blends them into one original personality. Each account's repeated 4-word phrases are stored as
"signatures", and any post the agent writes that contains one is rejected, so the character can't drift into
copying a real person.

Collect posts in line with X's terms of service. These files are git-ignored only if you add them to
`.gitignore`; keep scraped data out of public repos.
