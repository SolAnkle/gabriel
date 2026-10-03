// Content engine: the character's visual life follows the wallet. When something notable happens
// (life tier changes, big win, big loss, rug) the agent writes a scene brief for Higgsfield, using its
// fixed visual identity so the character stays consistent.
import { config } from '../config.js';
import { load, update, record } from '../store.js';
import { think, obj, str, oneOf } from '../brain/llm.js';
import { identityLayer, voiceLayer } from '../brain/persona.js';
import { lifeTier } from '../trading/treasury.js';
import { treasuryValue } from '../trading/policy.js';
import { enqueueSocial } from '../social/queue.js';

/** What, if anything, is worth a new visual. Deterministic. */
export function contentTrigger(state) {
  const { tier, lastTier, treasury, lastTreasury, lastClosed, lastBriefAt, now } = state;
  if (lastTier && tier !== lastTier) return { kind: 'tier-change', detail: `${lastTier} -> ${tier}` };
  if (lastTreasury && treasury / lastTreasury - 1 <= -0.3) return { kind: 'drawdown', detail: `treasury down ${Math.round((1 - treasury / lastTreasury) * 100)}% since last scene` };
  if (lastTreasury && treasury / lastTreasury - 1 >= 0.3) return { kind: 'run-up', detail: `treasury up ${Math.round((treasury / lastTreasury - 1) * 100)}% since last scene` };
  if (lastClosed && Date.parse(lastClosed.closedAt) > (lastBriefAt ? Date.parse(lastBriefAt) : 0)) {
    if (lastClosed.pnlPct >= 2) return { kind: 'big-win', detail: `$${lastClosed.symbol} +${Math.round(lastClosed.pnlPct * 100)}%` };
    if (lastClosed.pnlPct <= -0.6) return { kind: 'rugged', detail: `$${lastClosed.symbol} ${Math.round(lastClosed.pnlPct * 100)}%` };
  }
  if (!lastBriefAt || now - Date.parse(lastBriefAt) > 24 * 3_600_000) return { kind: 'daily-life', detail: 'a normal day' };
  return null;
}

export async function contentTick() {
  const pf = load('portfolio');
  const content = load('content');
  const last = content.briefs.at(-1);
  const tier = lifeTier(pf);
  const treasury = treasuryValue(pf);
  const trigger = contentTrigger({ tier, lastTier: last?.tier, treasury, lastTreasury: last?.treasuryUsd, lastClosed: pf.closed.at(-1), lastBriefAt: last?.at, now: Date.now() });
  if (!trigger) return null;
  if (trigger.kind === 'tier-change') enqueueSocial('life', { from: last.tier, to: tier });

  const { visual } = load('agent');
  const brief = await think({
    label: 'content', effort: 'medium', system: [identityLayer(), voiceLayer()],
    prompt: `Your fixed look (never change it): ${JSON.stringify({ appearance: visual?.appearance, wardrobe: visual?.wardrobe, signatureItems: visual?.signatureItems })}
Your environment at this life tier (${tier}): ${visual?.environmentByTier?.[tier]}
What happened: ${trigger.kind} (${trigger.detail}). Treasury $${Math.round(treasury)}.

Write ONE scene for your next image or short video, and the caption you'd post with it.`,
    schema: obj({
      format: oneOf(['image', 'video']), scene: str('what the camera sees, setting, action, lighting, mood'),
      shot: str('camera framing'), caption: str('in your voice, under 200 chars'),
    }),
    offline: () => ({
      format: 'image', shot: 'medium shot from behind the monitors',
      scene: trigger.kind === 'drawdown' || trigger.kind === 'rugged' ? 'sitting in a dark room lit only by a red chart, hood up, untouched noodles' : `${visual?.environmentByTier?.[tier] || 'desk'}, late night, monitor glow`,
      caption: trigger.kind === 'drawdown' || trigger.kind === 'rugged' ? 'portfolio has entered witness protection' : 'another night of watching lines',
    }),
  });

  const entry = {
    id: Date.now().toString(36), at: new Date().toISOString(), tier, treasuryUsd: Math.round(treasury), trigger,
    ...brief, prompt: `${visual?.appearance}. Wearing ${visual?.wardrobe}, ${visual?.signatureItems?.join(', ')}. ${brief.scene}. ${brief.shot}.`,
    status: 'queued', mediaUrl: null,
  };
  if (config.higgsfield.endpoint && config.higgsfield.apiKey) {
    try {
      const res = await fetch(config.higgsfield.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.higgsfield.apiKey}` },
        body: JSON.stringify({ character_id: config.higgsfield.characterId, prompt: entry.prompt, type: brief.format }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
      Object.assign(entry, { status: 'submitted', job: body });
    } catch (err) {
      Object.assign(entry, { status: 'failed', error: err.message });
    }
  }
  update('content', (c) => {
    c.briefs.push(entry);
    if (c.briefs.length > 200) c.briefs.splice(0, c.briefs.length - 200);
  });
  record('content', `New ${brief.format} scene (${trigger.kind}): "${brief.caption}"`, { scene: brief.scene, tier, status: entry.status });
  return entry;
}
