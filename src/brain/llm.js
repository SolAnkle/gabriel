// One entry point for every model call: structured JSON in, structured JSON out.
// Each caller passes an `offline` function so the agent still runs (scripted) without an API key.
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

const client = config.llmEnabled ? new Anthropic() : null;

/**
 * @param {object} opts
 * @param {string[]} opts.system  stable blocks first (identity, voice): they're cached
 * @param {string} opts.prompt    the volatile part of the request
 * @param {object} opts.schema    JSON schema the reply must match
 * @param {'low'|'medium'|'high'} [opts.effort]
 * @param {() => any} opts.offline  scripted answer when no API key is set
 */
export async function think({ system = [], prompt, schema, effort = 'medium', offline, label = 'think' }) {
  if (!client) return offline();

  const systemBlocks = system.filter(Boolean).map((text) => ({ type: 'text', text }));
  if (systemBlocks.length) systemBlocks[systemBlocks.length - 1].cache_control = { type: 'ephemeral' };

  const response = await client.beta.messages.create({
    model: config.model,
    max_tokens: 16000,
    output_config: { effort, format: { type: 'json_schema', schema } },
    // If a safety classifier declines, re-run on Anthropic's recommended fallback model.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: systemBlocks.length ? systemBlocks : undefined,
    messages: [{ role: 'user', content: prompt }],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error(`${label}: model declined (${response.stop_details?.category ?? 'unknown'})`);
  }
  if (response.stop_reason === 'max_tokens') throw new Error(`${label}: reply was cut off`);
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text);
}

/** Small helper for JSON schemas: every listed property required, nothing extra allowed. */
export function obj(properties) {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}
export const str = (description) => ({ type: 'string', ...(description && { description }) });
export const numb = (description) => ({ type: 'number', ...(description && { description }) });
export const int = (description) => ({ type: 'integer', ...(description && { description }) });
export const bool = (description) => ({ type: 'boolean', ...(description && { description }) });
export const arr = (items, description) => ({ type: 'array', items, ...(description && { description }) });
export const oneOf = (values, description) => ({ type: 'string', enum: values, ...(description && { description }) });
