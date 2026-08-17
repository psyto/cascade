#!/usr/bin/env node
// Incremental updater for the liquidation index.
//
// Reads data/index.json, works out which UTC days are missing, collects only
// those, merges, and writes the file back. Designed to be run by a scheduler
// once a day and to be cheap when there is nothing to do.
//
//   node daily.mjs              # bring data/index.json up to yesterday
//   node daily.mjs --dry        # say what it would fetch, fetch nothing
//
// Two rules, both of which exist because a liquidation index is mostly zeros
// and a broken run looks exactly like a quiet week:
//
//   1. A day is either fully collected or absent. There is no partial day.
//   2. Already-committed days are never rewritten. If a re-run disagrees with
//      a stored day, that is a finding — the run stops and says so rather than
//      quietly replacing history.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STORE = join(HERE, 'data', 'index.json');
const DRY = process.argv.includes('--dry');
const die = m => { console.error('\nREFUSED: '+m+'\n'); process.exit(2); };

const dayStr = d => d.toISOString().slice(0,10);
const addDays = (s, n) => dayStr(new Date(Date.parse(s+'T00:00:00Z') + n*86400000));

// Yesterday UTC: today is still running, and a half day is not a day.
const today = dayStr(new Date());
const lastComplete = addDays(today, -1);

let store = { days: [], by_source: {}, unpriced_by_symbol: {}, updated: null };
if (existsSync(STORE)) {
  try { store = JSON.parse(readFileSync(STORE,'utf8')); }
  catch (e) { die(`data/index.json is unreadable (${e.message}). Refusing to overwrite it.`); }
}
const have = new Map(store.days.map(d => [d.date, d]));
const first = store.days.length ? store.days[0].date : null;

// The window to fetch: everything after the last stored day, up to yesterday.
// With an empty store, seed 90 days so a fresh clone has a usable series.
const from = store.days.length ? addDays(store.days[store.days.length-1].date, 1)
                               : addDays(lastComplete, -89);
if (from > lastComplete) {
  console.log(`up to date — ${store.days.length} days, latest ${store.days.length ? store.days[store.days.length-1].date : '(none)'}`);
  process.exit(0);
}
const to = addDays(lastComplete, 1);   // index.mjs takes [from, to)

console.log(`store: ${store.days.length} days${first ? ` (${first} → ${store.days[store.days.length-1].date})` : ''}`);
console.log(`fetch: ${from} → ${lastComplete}`);
if (DRY) process.exit(0);

let out;
try {
  out = execFileSync(process.execPath, [join(HERE,'index.mjs'), from, to, '--json'],
    { encoding:'utf8', maxBuffer: 256*1024*1024, stdio:['ignore','pipe','inherit'] });
} catch (e) {
  die(`collector failed for ${from}..${lastComplete}. Nothing was written. ` +
      `A missing day is recoverable; a half-collected one is not.`);
}
let fresh;
try { fresh = JSON.parse(out); } catch { die('collector produced no parseable JSON'); }
if (!Array.isArray(fresh.days) || !fresh.days.length) die('collector returned no days');

// Rule 2: never rewrite a stored day.
for (const d of fresh.days){
  const old = have.get(d.date);
  if (!old) continue;
  if (old.usd !== d.usd || old.n !== d.n)
    die(`${d.date} already stored as $${old.usd} / ${old.n} events but re-collected as ` +
        `$${d.usd} / ${d.n}. History is not rewritten here. Investigate before touching the store.`);
}
const merged = [...store.days.filter(d => !fresh.days.some(f => f.date === d.date)), ...fresh.days]
  .sort((a,b) => a.date.localeCompare(b.date));

// Cumulative source and residual tallies
const by = { ...store.by_source };
for (const [k,v] of Object.entries(fresh.by_source ?? {})){
  by[k] = { usd: (by[k]?.usd ?? 0) + v.usd, n: (by[k]?.n ?? 0) + v.n };
}
const un = { ...store.unpriced_by_symbol };
for (const [k,v] of Object.entries(fresh.unpriced_by_symbol ?? {})) un[k] = (un[k] ?? 0) + v;

mkdirSync(dirname(STORE), { recursive: true });
writeFileSync(STORE, JSON.stringify({
  updated: new Date().toISOString(),
  from: merged[0].date, to: merged[merged.length-1].date,
  days: merged, by_source: by, unpriced_by_symbol: un,
  sources: fresh.sources ?? store.sources,
}, null, 1) + '\n');

const added = fresh.days.filter(d => !have.has(d.date));
const M = v => '$'+(v/1e6).toFixed(2)+'M';
console.log(`\nadded ${added.length} day(s):`);
for (const d of added) console.log(`  ${d.date}  ${M(d.usd).padStart(10)}  ${String(d.n).padStart(5)} events`);
const roll = merged.slice(-30).reduce((a,d)=>a+d.usd,0);
console.log(`\nstore now ${merged.length} days, ${merged[0].date} → ${merged[merged.length-1].date}`);
console.log(`30-day rolling index: ${M(roll)}`);
