// Long-term memory about people, predictions and running jokes.
import { load, update } from '../store.js';

const MAX_INTERACTIONS = 40;
const MAX_NOTES = 15;

export function getPerson(handle) {
  return load('memory').people[handle.toLowerCase()] || null;
}

export function rememberInteraction(handle, { direction, text, tweetId, sentimentDelta = 0, note, tags = [] }) {
  if (!handle) return;
  update('memory', (m) => {
    const key = handle.toLowerCase();
    const now = new Date().toISOString();
    const p = (m.people[key] ||= { handle, firstSeen: now, lastSeen: now, sentiment: 0, tags: [], notes: [], interactions: [] });
    p.lastSeen = now;
    p.sentiment = Math.max(-5, Math.min(5, p.sentiment + sentimentDelta));
    p.tags = [...new Set([...p.tags, ...tags])].slice(-12);
    if (note) p.notes.push(note);
    if (p.notes.length > MAX_NOTES) p.notes.splice(0, p.notes.length - MAX_NOTES);
    p.interactions.push({ at: now, direction, text: text.slice(0, 280), tweetId });
    if (p.interactions.length > MAX_INTERACTIONS) p.interactions.splice(0, p.interactions.length - MAX_INTERACTIONS);
  });
}

export function rememberJoke(text) {
  if (!text) return;
  update('memory', (m) => {
    const existing = m.jokes.find((j) => j.text.toLowerCase() === text.toLowerCase());
    if (existing) {
      existing.uses++;
      existing.lastUsed = new Date().toISOString();
    } else m.jokes.push({ id: Date.now().toString(36), text, uses: 1, lastUsed: new Date().toISOString() });
    if (m.jokes.length > 40) m.jokes.splice(0, m.jokes.length - 40);
  });
}

export function rememberPrediction(text, token) {
  if (!text) return;
  update('memory', (m) => m.predictions.push({ id: Date.now().toString(36), at: new Date().toISOString(), text, token: token || null, resolved: false, correct: null }));
}
