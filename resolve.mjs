#!/usr/bin/env node
// Cascade wager — resolution script.
//
//   THE CLAIM, per calendar month:
//     "The month's largest Aave V3 liquidation day is NOT among the month's
//      three largest ETH down-days."
//
// Every input is on-chain and every step is deterministic. There is no
// off-chain price source, no discretionary judgement, and no place for a
// resolver to insert an opinion. Anyone can re-run this and must land on the
// same verdict; if they do not, the wager is void, not arguable.
//
//   node resolve.mjs 2026-06
//   node resolve.mjs 2026-06 --json
//
// Zero dependencies. Node 18+ (global fetch).

const API = 'https://eth.blockscout.com/api';

// ---- subjects, each verified on mainnet 2026-08-17 -------------------------
const AAVE_POOL   = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'; // Aave V3 Pool (proxy)
const LIQ_TOPIC   = '0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286';
//                    keccak256("LiquidationCall(address,address,address,uint256,uint256,address,bool)")
const CL_PROXY    = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419'; // EACAggregatorProxy, description() == "ETH / USD", decimals() == 8
const CL_AGG      = '0x7d4e742018fb52e48b08be73d041c18b21de6fb5'; // proxy.aggregator() at the time of writing
const ANSWER_TOPIC= '0x0559884fd3a460db3073b7fc896cc77986f16e378210ded43186175bf646fc5f';
//                    keccak256("AnswerUpdated(int256,uint256,uint256)")

const TOP_N_DOWN  = 3;      // claim is about the N largest down-days
const MAX_ROWS    = 1000;   // Blockscout's per-response cap. Hitting it is an error, never a truncation.
const STALE_LIMIT = 6*3600; // a boundary with no Chainlink update within this window is a refusal

// ---- tiny helpers ---------------------------------------------------------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const iso   = ts => new Date(ts*1000).toISOString();
const day   = ts => iso(ts).slice(0,10);

function die(msg){ console.error('\nREFUSED: ' + msg + '\n'); process.exit(2); }

async function api(params){
  const url = API + '?' + new URLSearchParams(params).toString();
  for (let attempt=0; attempt<4; attempt++){
    const r = await fetch(url);
    const t = await r.text();
    if (t.trimStart().startsWith('<')) { await sleep(1500); continue; }   // rate-limited HTML
    let j; try { j = JSON.parse(t); } catch { await sleep(1500); continue; }
    if (j.status === '0' && /no records|not found/i.test(String(j.message))) return [];
    if (j.status !== '1') { await sleep(1500); continue; }
    return Array.isArray(j.result) ? j.result : [];
  }
  die(`the API did not answer for ${JSON.stringify(params)} after 4 attempts. A partial read is not a smaller answer.`);
}

async function blockAt(ts, closest){
  const r = await fetch(`${API}?module=block&action=getblocknobytime&timestamp=${ts}&closest=${closest}`);
  const j = await r.json();
  const n = Number(j?.result?.blockNumber ?? j?.result);
  if (!Number.isFinite(n)) die(`could not map timestamp ${ts} (${iso(ts)}) to a block.`);
  return n;
}

// Pull every log in [from,to], subdividing whenever a response hits the cap.
// A truncated read that looks like a small month is the failure mode this guards.
async function logsExhaustive(address, topic0, from, to, depth=0){
  const rows = await api({ module:'logs', action:'getLogs', address, topic0,
                           fromBlock:String(from), toBlock:String(to) });
  if (rows.length < MAX_ROWS) return rows;
  if (to - from < 2) die(`${MAX_ROWS} logs inside a 2-block range — cannot subdivide further.`);
  if (depth > 12)    die('log subdivision exceeded depth 12.');
  const mid = Math.floor((from + to) / 2);
  await sleep(250);
  const a = await logsExhaustive(address, topic0, from, mid, depth+1);
  await sleep(250);
  const b = await logsExhaustive(address, topic0, mid+1, to, depth+1);
  return a.concat(b);
}

// ---- month arithmetic (UTC only) ------------------------------------------
function monthBounds(ym){
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) die(`month must look like 2026-06, got "${ym}"`);
  const y = +m[1], mo = +m[2];
  const start = Date.UTC(y, mo-1, 1) / 1000;
  const end   = Date.UTC(mo === 12 ? y+1 : y, mo === 12 ? 0 : mo, 1) / 1000;
  return { start, end };
}

// ---- main -----------------------------------------------------------------
const ym    = process.argv[2];
const asJson= process.argv.includes('--json');
if (!ym) { console.error('usage: node resolve.mjs YYYY-MM [--json]'); process.exit(1); }

const { start, end } = monthBounds(ym);
const now = Math.floor(Date.now()/1000);
const settled = end <= now;

// One extra day before the month: the first day's return needs the prior boundary.
const priceFrom = start - 24*3600;

const [bLiqFrom, bLiqTo, bPxFrom] = await Promise.all([
  blockAt(start, 'after'), blockAt(end-1, 'before'), blockAt(priceFrom, 'before'),
]);

process.stderr.write(`reading Aave liquidations   blocks ${bLiqFrom}..${bLiqTo}\n`);
const liqLogs = await logsExhaustive(AAVE_POOL, LIQ_TOPIC, bLiqFrom, bLiqTo);
process.stderr.write(`  ${liqLogs.length} LiquidationCall\n`);

process.stderr.write(`reading Chainlink ETH/USD   blocks ${bPxFrom}..${bLiqTo}\n`);
const pxLogs = await logsExhaustive(CL_AGG, ANSWER_TOPIC, bPxFrom, bLiqTo);
process.stderr.write(`  ${pxLogs.length} AnswerUpdated\n`);

if (pxLogs.length === 0)
  die(`no AnswerUpdated from aggregator ${CL_AGG} in this window. The proxy may have rotated its aggregator; read ${CL_PROXY}.aggregator() and re-run with the correct one. A silent gap here would fabricate a price.`);

// --- liquidations per UTC day
const perDay = new Map();
for (const l of liqLogs){
  const ts = parseInt(l.timeStamp, 16);
  if (ts < start || ts >= end) continue;
  const d = day(ts);
  perDay.set(d, (perDay.get(d) ?? 0) + 1);
}

// --- price at each 00:00 UTC boundary: the last update at or before it
const updates = pxLogs
  .map(l => {
    let v = BigInt(l.topics[1]);
    if (v >> 255n) v -= (1n << 256n);            // int256, defensive
    return { ts: parseInt(l.timeStamp,16), price: Number(v) / 1e8 };
  })
  .sort((a,b) => a.ts - b.ts);

function priceAt(ts){
  let lo = 0, hi = updates.length - 1, best = -1;
  while (lo <= hi){
    const mid = (lo + hi) >> 1;
    if (updates[mid].ts <= ts) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (best < 0) return null;
  if (ts - updates[best].ts > STALE_LIMIT) return null;
  return updates[best];
}

// --- daily returns, boundary to boundary
const days = [];
for (let t = start; t < end; t += 24*3600){
  const d  = day(t);
  const p0 = priceAt(t), p1 = priceAt(Math.min(t + 24*3600, end));
  if (t + 24*3600 > now) continue;                       // month still running
  if (!p0 || !p1)
    die(`no Chainlink update within ${STALE_LIMIT/3600}h of a boundary on ${d}. Refusing rather than interpolating.`);
  days.push({
    date: d,
    ret: (p1.price - p0.price) / p0.price * 100,
    open: p0.price, close: p1.price,
    liq: perDay.get(d) ?? 0,
  });
}
if (days.length === 0) die('no complete days in this window yet.');

// --- the two facts the claim compares. Ties break to the EARLIER date, stated up front.
const byLiq  = [...days].sort((a,b) => b.liq - a.liq || a.date.localeCompare(b.date));
const byDown = [...days].sort((a,b) => a.ret - b.ret || a.date.localeCompare(b.date));

const biggestLiq = byLiq[0];
const topDown    = byDown.slice(0, TOP_N_DOWN);
const inTopDown  = topDown.some(d => d.date === biggestLiq.date);
const claimHolds = !inTopDown;

// --- report
if (asJson){
  console.log(JSON.stringify({
    month: ym, settled, claim_holds: claimHolds,
    biggest_liquidation_day: biggestLiq, top_down_days: topDown,
    days, sources: { AAVE_POOL, LIQ_TOPIC, CL_PROXY, CL_AGG, ANSWER_TOPIC,
                     blocks: { liq:[bLiqFrom,bLiqTo], price:[bPxFrom,bLiqTo] } },
  }, null, 2));
} else {
  const pad = (s,n) => String(s).padStart(n);
  console.log(`\n  CASCADE WAGER — ${ym}${settled ? '' : '   (MONTH IN PROGRESS — provisional)'}`);
  console.log(`  claim: the largest liquidation day is NOT among the ${TOP_N_DOWN} largest down-days\n`);

  console.log(`  largest liquidation day`);
  console.log(`    ${biggestLiq.date}   ${pad(biggestLiq.liq,5)} liquidations   ETH ${biggestLiq.ret >= 0 ? '+' : ''}${biggestLiq.ret.toFixed(2)}%\n`);

  console.log(`  ${TOP_N_DOWN} largest down-days`);
  for (const d of topDown)
    console.log(`    ${d.date}   ETH ${d.ret.toFixed(2)}%   ${pad(d.liq,5)} liquidations${d.date === biggestLiq.date ? '   <-- SAME DAY' : ''}`);

  const total = days.reduce((a,d) => a + d.liq, 0);
  const share = total ? (biggestLiq.liq / total * 100).toFixed(0) : '0';
  console.log(`\n  month total ${total} liquidations over ${days.length} days; the top day is ${share}% of them`);
  console.log(`\n  VERDICT: ${claimHolds ? 'CLAIM HOLDS' : 'CLAIM FAILS'}${settled ? '' : ' (provisional)'}\n`);
  console.log(`  reproduce: node resolve.mjs ${ym}`);
  console.log(`  aave  ${AAVE_POOL}  topic0 ${LIQ_TOPIC.slice(0,18)}…`);
  console.log(`  price ${CL_AGG}  (aggregator of ${CL_PROXY.slice(0,18)}…)`);
  console.log(`  blocks ${bLiqFrom}..${bLiqTo}\n`);
}
