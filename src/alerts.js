// Pushes important events to Telegram and/or Discord. Best effort: an alert failing never
// breaks trading, it only logs a warning.
import { config } from './config.js';

// Ledger event types worth a ping. Analyses, ignores and research chatter stay in the log only.
export const ALERT_TYPES = new Set(['trade', 'fees', 'error', 'sweep', 'control', 'social']);

export async function alert(text) {
  const { telegramBotToken, telegramChatId, discordWebhookUrl } = config.alerts;
  const jobs = [];
  if (telegramBotToken && telegramChatId) {
    jobs.push(fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: telegramChatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    }));
  }
  if (discordWebhookUrl) {
    jobs.push(fetch(discordWebhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: text.slice(0, 1900) }),
      signal: AbortSignal.timeout(10_000),
    }));
  }
  const results = await Promise.allSettled(jobs);
  for (const r of results) {
    if (r.status === 'rejected') console.warn('alert failed:', r.reason?.message);
    else if (!r.value.ok) console.warn('alert failed: HTTP', r.value.status);
  }
}
