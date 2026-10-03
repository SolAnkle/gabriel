// Persistent state as plain JSON files (atomic writes), plus an append-only public ledger.
// Small enough for one agent; swap for a database when it outgrows a single process.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { config } from './config.js';

const DEFAULTS = {
  agent: () => ({ status: 'unborn', identity: null, voice: null, coin: null, visual: null, genesis: [], createdAt: null }),
  portfolio: () => ({
    mode: null,
    cashUsd: 0,
    feesEarnedUsd: 0,
    positions: [], // open: {address, symbol, chainId, amount, costUsd, entryPrice, lastPrice, openedAt, thesis, ...}
    closed: [],
    trades: [], // every fill, buy or sell
    snapshots: [], // {at, treasuryUsd}
  }),
  memory: () => ({
    people: {}, // handle -> {handle, firstSeen, lastSeen, sentiment, tags, notes[], interactions[]}
    predictions: [], // {id, at, text, token, resolved, correct}
    jokes: [], // running bits: {id, text, uses, lastUsed}
    lessons: [], // reflection output
    voiceNotes: [], // bounded style adjustments from reflection
  }),
  social: () => ({ posts: [], queue: [], seenTweetIds: [], decisions: [], lastMentionId: null, lastWatchedId: null }),
  research: () => ({ history: {}, reports: [] }),
  content: () => ({ briefs: [] }),
  kols: () => ({ analyzedAt: null, accounts: [], blend: null, signatures: [], synthesis: null }),
};

const bus = new EventEmitter();
bus.setMaxListeners(100);
const cache = new Map();

function file(name) {
  return path.join(config.stateDir, `${name}.json`);
}

export function load(name) {
  if (cache.has(name)) return cache.get(name);
  fs.mkdirSync(config.stateDir, { recursive: true });
  let value;
  try {
    value = { ...DEFAULTS[name](), ...JSON.parse(fs.readFileSync(file(name), 'utf8')) };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    value = DEFAULTS[name]();
  }
  cache.set(name, value);
  return value;
}

export function save(name) {
  const value = cache.get(name);
  if (!value) return;
  const target = file(name);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, target);
}

/** Loads, lets fn mutate, saves. Returns fn's result. */
export function update(name, fn) {
  const value = load(name);
  const result = fn(value);
  save(name);
  return result;
}

/** Test helper: forget cached state so the next load reads from disk (or defaults). */
export function resetCache() {
  cache.clear();
}

// ---------- Public activity ledger ----------
// Everything the dashboard shows comes from here. Only public explanations go in: never raw
// model reasoning, prompts, or secrets.

const ledgerFile = () => path.join(config.stateDir, 'ledger.jsonl');

export function record(type, summary, data = {}) {
  fs.mkdirSync(config.stateDir, { recursive: true });
  const event = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, at: new Date().toISOString(), type, summary, data };
  fs.appendFileSync(ledgerFile(), JSON.stringify(event) + '\n');
  bus.emit('event', event);
  console.log(`[${event.at.slice(11, 19)}] ${type.padEnd(10)} ${summary}`);
  return event;
}

export function readLedger(limit = 200) {
  try {
    const lines = fs.readFileSync(ledgerFile(), 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => JSON.parse(l)).reverse();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

export function onLedgerEvent(fn) {
  bus.on('event', fn);
  return () => bus.off('event', fn);
}
