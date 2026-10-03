# Character renders

The website is built around the character. Drop Higgsfield renders here; the server picks them up live.

| File | Used for |
|---|---|
| `hero.png` / `.webp` / `.mp4` / `.webm` | The big character in the middle of the intro page |
| `hero-broke.*`, `hero-surviving.*`, `hero-comfortable.*`, `hero-winning.*`, `hero-rich.*` | Optional: a different hero per life tier, so his look follows the wallet |
| anything else (`01-desk.png`, `rug-reaction.mp4`, ...) | The "His life" gallery, in file-name order |

For the best effect export the hero as a **transparent cut-out** (PNG/WebP with no background), full body or
waist-up, roughly 3:4 or 9:16. The page puts his name in giant letters behind him and the room glow around
him, so a cut-out sits *in* the scene instead of on top of it. A short looping video (idle breathing,
glancing at a monitor) works too and autoplays muted.

Instead of files you can set `CHARACTER_HERO_URL`, or let Higgsfield scene results (`mediaUrl`) fill it.
