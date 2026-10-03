// Things that happened that the agent MAY want to talk about. The social engine decides.
import { update } from '../store.js';

export function enqueueSocial(kind, data) {
  update('social', (s) => {
    s.queue.push({ kind, data, at: new Date().toISOString() });
    if (s.queue.length > 50) s.queue.splice(0, s.queue.length - 50);
  });
}
