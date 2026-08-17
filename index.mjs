#!/usr/bin/env node
// Cross-chain, cross-protocol DeFi liquidation index — collector.
//
// One daily USD series from every lending protocol below. The quantity is the
// DEBT REPAID by the liquidator: it is the one number every protocol reports
// and the one that means the same thing everywhere.
//
// Every address, selector and event signature here was read off chain data or
// derived with a self-verified keccak. None was recalled — an earlier version
// guessed Morpho's selector and silently valued a whole protocol at zero.
//
//   node index.mjs 2026-06-01 2026-08-17
//   node index.mjs 2026-06-01 2026-08-17 --json > index.json
//
// Zero dependencies. Node 18+.

// `logs` says where to READ EVENTS from. Blockscout returns a timestamp per
// log, which is convenient; public RPCs do not, so for those chains events are
// bucketed by block number against day-boundary blocks instead. Base's and
// Arbitrum's Blockscout instances rate-limit us to a standstill, so they read
// from their own RPCs — which cap ranges at 10k blocks but serve history.
const CHAINS = {
  ethereum: { api:'https://eth.blockscout.com/api', rpc:'https://ethereum-rpc.publicnode.com',
              logs:'explorer' },
  base:     { api:'https://base.blockscout.com/api', rpc:'https://mainnet.base.org',
              logRpc:'https://mainnet.base.org', logs:'rpc', rpcSpan: 9_999 },
  arbitrum: { api:'https://arbitrum.blockscout.com/api', rpc:'https://arbitrum-one-rpc.publicnode.com',
              logRpc:'https://arb1.arbitrum.io/rpc', logs:'rpc', rpcSpan: 9_999 },
};

const T_AAVE   = '0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286'; // LiquidationCall(address,address,address,uint256,uint256,address,bool)
const T_MORPHO = '0xa4946ede45d0c6f06a0f5ce92c9ad3b4751452d2fe0e25010783bcab57a67e41'; // Liquidate(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)
const T_COMET  = '0x1547a878dc89ad3c367b6338b4be6a65a5dd74fb77ae044da1e8747ef1f4f62f'; // AbsorbDebt(address,address,uint256,uint256)

const SOURCES = [
  { chain:'ethereum', name:'Aave V3',     kind:'aave',   addr:'0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', topic0:T_AAVE },
  { chain:'ethereum', name:'Spark',       kind:'aave',   addr:'0xC13e21B648A5Ee794902342038FF3aDAB66BE987', topic0:T_AAVE },
  { chain:'ethereum', name:'Morpho Blue', kind:'morpho', addr:'0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb', topic0:T_MORPHO },
  { chain:'ethereum', name:'Compound V3', kind:'comet',  addr:'0xc3d688B66703497DAA19211EEdff47f25384cdc3', topic0:T_COMET },
  { chain:'base',     name:'Aave V3',     kind:'aave',   addr:'0xA238Dd80C259a72e81d7e4664a9801593F98d1c5', topic0:T_AAVE },
  { chain:'base',     name:'Morpho Blue', kind:'morpho', addr:'0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb', topic0:T_MORPHO },
  { chain:'base',     name:'Compound V3', kind:'comet',  addr:'0xb125E6687d4313864e53df431d5425969c15Eb2F', topic0:T_COMET },
  { chain:'arbitrum', name:'Aave V3',     kind:'aave',   addr:'0x794a61358D6845594F94dc1DB02A252b5b4814aD', topic0:T_AAVE },
];

// ETH/USD is global, so one mainnet feed prices every chain's ETH-denominated debt.
const CL_AGG = '0x7d4e742018fb52e48b08be73d041c18b21de6fb5';
const ANSWER = '0x0559884fd3a460db3073b7fc896cc77986f16e378210ded43186175bf646fc5f';

const SEL_DECIMALS = '0x313ce567', SEL_SYMBOL = '0x95d89b41';
const SEL_MARKETPARAMS = '0x2c3c9157';   // idToMarketParams(bytes32), verified on a live market
const SEL_BASETOKEN    = '0xc55dae63';   // baseToken(), verified against Comet USDC on mainnet

// Symbol heuristic, not a proof: a token named *USD* that depegs is still
// counted at a dollar here. Anything in neither set stays UNPRICED and is
// reported as a residual rather than guessed at.
const USD_PEG = new Set(['USDC','USDbC','USDT','DAI','GHO','USDe','USDtb','PYUSD','USDS','sUSDS',
  'FRAX','LUSD','crvUSD','USD0','USDL','RLUSD','USDA','deUSD','AUSD','frxUSD','USR','apxUSD',
  'rUSD','USDU','VUSD','USDG','mUSD','USDR','USDCV','eUSD','USDz','USDX','USD+',
  'USD\u20AE0','FXUSD','fxUSD','USDF','USDD','USDB','msUSD','yUSD','sUSDe']);
const ETH_LIKE = new Set(['WETH','ETH','wstETH','weETH','rETH','ezETH','cbETH','osETH','rsETH','msETH','wrsETH']);

const MAX_ROWS = 1000;
// Never ask an explorer for a huge range: a slow query looks the same as a
// dead one, and the retry budget gets spent on timeouts instead of data.
const SPAN = { ethereum: 60_000, base: 120_000, arbitrum: 900_000 };
const sleep = ms => new Promise(r=>setTimeout(r,ms));
// One global queue with a floor between explorer requests. Public endpoints
// rate-limit on burst, and a 429 is indistinguishable from an empty range —
// which is exactly the silent-truncation failure this whole script refuses.
let _gate = Promise.resolve();
const GAP = Number(process.env.CASCADE_GAP ?? 700);
function throttle(fn){
  const run = _gate.then(() => fn());
  _gate = run.then(() => sleep(GAP), () => sleep(GAP));
  return run;
}
const day = ts => new Date(ts*1000).toISOString().slice(0,10);
const die = m => { console.error('\nREFUSED: '+m+'\n'); process.exit(2); };

async function api(chain, p){
  const url = CHAINS[chain].api + '?' + new URLSearchParams(p);
  for (let i=0;i<8;i++){
    let t; try { t = await throttle(async () => (await fetch(url)).text()); } catch { await sleep(1000*(i+1)); continue; }
    if (t.trimStart().startsWith('<')) { await sleep(1000*(i+1)); continue; }
    let j; try { j = JSON.parse(t); } catch { await sleep(1000*(i+1)); continue; }
    // An empty range is DATA, not a failure. Blockscout says {"status":"0",
    // "message":"No logs found","result":[]} — an earlier pattern only matched
    // "not found", so quiet windows were retried eight times and then refused.
    if (j.status === '0' && Array.isArray(j.result) && j.result.length === 0
        && /no\s+(logs|records|transactions)?\s*found|no records/i.test(String(j.message))) return [];
    if (j.status !== '1') { await sleep(1000*(i+1)); continue; }
    return Array.isArray(j.result) ? j.result : [];
  }
  die(`${chain} API silent for ${JSON.stringify(p)}. A partial read is not a smaller answer.`);
}
async function rpc(chain, to, data){
  try {
    const r = await fetch(CHAINS[chain].rpc, { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_call',params:[{to,data},'latest']}) });
    const j = await r.json();
    return j.result && j.result !== '0x' ? j.result : null;
  } catch { return null; }
}
async function rpcRaw(chain, method, params){
  for (let i=0;i<6;i++){
    try {
      const r = await fetch(CHAINS[chain].rpc, { method:'POST', headers:{'content-type':'application/json'},
        body: JSON.stringify({jsonrpc:'2.0',id:1,method,params}) });
      const j = await r.json();
      if (j.result != null) return j.result;
    } catch {}
    await sleep(600*(i+1));
  }
  die(`${chain}: RPC ${method} failed`);
}
const _ts = new Map();
const blockTs = async (chain, n) => {
  const k = chain+':'+n;
  if (_ts.has(k)) return _ts.get(k);
  const b = await rpcRaw(chain, 'eth_getBlockByNumber', ['0x'+n.toString(16), false]);
  if (!b?.timestamp) die(`${chain}: block ${n} has no timestamp`);
  const v = Number(BigInt(b.timestamp)); _ts.set(k, v); return v;
};

// Binary search on block timestamps, over the chain's own RPC.
// The explorers' getblocknobytime is rate-limited to the point of being
// unusable on some chains, and it returns {"result":null} when it throttles —
// which Number() turns into block ZERO, a silently empty range. This does not
// have that failure mode: it either brackets the timestamp or refuses.
async function blockAt(chain, ts, closest){
  const key = `bat:${chain}:${ts}:${closest}`;
  return once(key, async () => {
    const hi0 = Number(BigInt(await rpcRaw(chain, 'eth_blockNumber', [])));
    if (await blockTs(chain, hi0) < ts) return hi0;
    let lo = 1, hi = hi0;
    if (await blockTs(chain, lo) > ts) die(`${chain}: ${ts} predates the chain`);
    while (hi - lo > 1){
      const mid = Math.floor((lo + hi) / 2);
      if (await blockTs(chain, mid) <= ts) lo = mid; else hi = mid;
    }
    return closest === 'after' ? hi : lo;   // lo <= ts < hi
  });
}
async function logsViaRpc(chain, addr, topic0, from, to){
  const span = CHAINS[chain].rpcSpan ?? 9_999;
  const url = CHAINS[chain].logRpc ?? CHAINS[chain].rpc;
  const out = [];
  for (let b = from; b <= to; b += span + 1){
    const e = Math.min(b + span, to);
    let got = null;
    for (let i=0;i<6;i++){
      try {
        const r = await throttle(async () => (await fetch(url, {method:'POST',
          headers:{'content-type':'application/json'},
          body: JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_getLogs',params:[{address:addr,
            topics:[topic0], fromBlock:'0x'+b.toString(16), toBlock:'0x'+e.toString(16)}]})})).json());
        if (Array.isArray(r?.result)) { got = r.result; break; }
      } catch {}
      await sleep(400*(i+1));
    }
    if (got === null) die(`${chain} RPC getLogs failed for ${b}..${e}. A partial read is not a smaller answer.`);
    out.push(...got);
  }
  return out;
}
async function logs(chain, addr, topic0, from, to, d=0){
  if (d === 0 && CHAINS[chain].logs === 'rpc') return logsViaRpc(chain, addr, topic0, from, to);
  const span = SPAN[chain] ?? 100_000;
  if (d === 0 && to - from > span){
    const out = [];
    for (let b = from; b <= to; b += span + 1){
      const e = Math.min(b + span, to);
      out.push(...await logs(chain, addr, topic0, b, e, 1));
      await sleep(120);
    }
    return out;
  }
  const r = await api(chain, {module:'logs',action:'getLogs',address:addr,topic0,fromBlock:String(from),toBlock:String(to)});
  if (r.length < MAX_ROWS) return r;
  if (to - from < 2) die(`${MAX_ROWS} logs in 2 blocks on ${chain} — cannot subdivide`);
  if (d > 22) die('subdivision depth exceeded');
  const mid = (from + to) >> 1;
  await sleep(120);
  const a = await logs(chain, addr, topic0, from, mid, d+1);
  await sleep(120);
  return a.concat(await logs(chain, addr, topic0, mid+1, to, d+1));
}

const meta = new Map();                    // "chain:addr" -> {symbol,decimals}
async function token(chain, addr){
  const k = chain+':'+addr.toLowerCase();
  if (meta.has(k)) return meta.get(k);
  const dHex = await rpc(chain, addr, SEL_DECIMALS);
  const sHex = await rpc(chain, addr, SEL_SYMBOL);
  let symbol = '?';
  if (sHex) {
    try {
      const b = Buffer.from(sHex.slice(2),'hex');
      const off = Number(BigInt('0x'+b.subarray(0,32).toString('hex')));
      const len = Number(BigInt('0x'+b.subarray(off,off+32).toString('hex')));
      symbol = b.subarray(off+32, off+32+len).toString('utf8');
    } catch { symbol = Buffer.from(sHex.slice(2),'hex').toString('utf8').replace(/\0+$/,''); }
  }
  const m = { symbol, decimals: dHex ? Number(BigInt(dHex)) : null };
  meta.set(k,m); return m;
}
const cache = new Map();
async function once(k, fn){ if (!cache.has(k)) cache.set(k, await fn()); return cache.get(k); }

// ---- main -----------------------------------------------------------------
const [fromDate, toDate] = process.argv.slice(2).filter(a=>!a.startsWith('--'));
const asJson = process.argv.includes('--json');
if (!fromDate || !toDate) { console.error('usage: node index.mjs YYYY-MM-DD YYYY-MM-DD [--json]'); process.exit(1); }
const tsFrom = Date.parse(fromDate+'T00:00:00Z')/1000, tsTo = Date.parse(toDate+'T00:00:00Z')/1000;
if (!tsFrom || !tsTo || tsTo <= tsFrom) die('bad date range');

const bE0 = await blockAt('ethereum', tsFrom-86400, 'before');
const bE1 = await blockAt('ethereum', tsTo, 'before');
const px = (await logs('ethereum', CL_AGG, ANSWER, bE0, bE1))
  .map(l=>({ts:parseInt(l.timeStamp,16), p:Number(BigInt(l.topics[1]))/1e8})).sort((a,b)=>a.ts-b.ts);
if (!px.length) die(`no Chainlink updates — aggregator ${CL_AGG} may have rotated`);
const ethOn = new Map(); for (const u of px) ethOn.set(day(u.ts), u.p);
process.stderr.write(`chainlink ${px.length} updates / ${ethOn.size} days\n`);

// Day boundaries per chain, so RPC-sourced logs (which carry no timestamp)
// can be bucketed by block number without one lookup per event.
const bounds = new Map();
for (const chain of new Set(SOURCES.map(s=>s.chain))){
  if (CHAINS[chain].logs !== 'rpc') continue;
  const arr = [];
  for (let t = tsFrom; t <= tsTo; t += 86400) arr.push([await blockAt(chain, t, 'after'), t]);
  bounds.set(chain, arr);
  process.stderr.write(`${chain}: ${arr.length} day boundaries resolved\n`);
}
function dayOfBlock(chain, bn){
  const arr = bounds.get(chain);
  if (!arr) die(`${chain}: no day boundaries`);
  let lo = 0, hi = arr.length - 1, best = 0;
  while (lo <= hi){ const m = (lo+hi)>>1; if (arr[m][0] <= bn){ best = m; lo = m+1; } else hi = m-1; }
  return arr[best][1];
}

const raw = [];
for (const s of SOURCES){
  const [b0,b1] = await once(`blk:${s.chain}`, async () =>
    [await blockAt(s.chain, tsFrom,'after'), await blockAt(s.chain, tsTo,'before')]);
  const rows = await logs(s.chain, s.addr, s.topic0, b0, b1);
  process.stderr.write(`${(s.chain+' '+s.name).padEnd(26)} ${String(rows.length).padStart(6)} events\n`);
  for (const l of rows) raw.push({ s, l });
  await sleep(200);
}

for (const r of raw){
  const { s, l } = r;
  if (s.kind === 'aave')        r.debt = '0x'+l.topics[2].slice(26);
  else if (s.kind === 'morpho') r.debt = await once(`mp:${s.chain}:${l.topics[1]}`, async () => {
    const res = await rpc(s.chain, s.addr, SEL_MARKETPARAMS + l.topics[1].slice(2));
    return res ? '0x'+res.slice(26,66) : null; });
  else if (s.kind === 'comet')  r.debt = await once(`bt:${s.chain}:${s.addr}`, async () => {
    const res = await rpc(s.chain, s.addr, SEL_BASETOKEN);
    return res ? '0x'+res.slice(26,66) : null; });
  r.amount = BigInt('0x'+l.data.slice(2,66));
  r.ts = l.timeStamp != null ? parseInt(l.timeStamp,16)
       : dayOfBlock(s.chain, Number(BigInt(l.blockNumber)));
}
const pairs = [...new Set(raw.filter(r=>r.debt).map(r=>r.s.chain+'|'+r.debt))];
process.stderr.write(`resolving ${pairs.length} debt tokens\n`);
for (const p of pairs){ const [c,a] = p.split('|'); await token(c,a); }

const perDay = new Map(), perSrc = new Map(), unpriced = new Map();
for (const r of raw){
  const d = day(r.ts);
  const m = r.debt ? meta.get(r.s.chain+':'+r.debt.toLowerCase()) : null;
  let usd = null;
  if (m && m.decimals != null){
    const amt = Number(r.amount) / 10 ** m.decimals;
    if (USD_PEG.has(m.symbol)) usd = amt;
    else if (ETH_LIKE.has(m.symbol)) { const p = ethOn.get(d); if (p) usd = amt*p; }
  }
  const dd = perDay.get(d) ?? {usd:0,n:0,unp:0};
  dd.n++; if (usd==null) dd.unp++; else dd.usd += usd; perDay.set(d,dd);
  const key = `${r.s.chain} ${r.s.name}`;
  const ss = perSrc.get(key) ?? {usd:0,n:0}; ss.n++; if (usd!=null) ss.usd += usd; perSrc.set(key,ss);
  if (usd==null) unpriced.set(m?.symbol ?? '?', (unpriced.get(m?.symbol ?? '?') ?? 0)+1);
}

const days = [];
for (let t=tsFrom; t<tsTo; t+=86400){
  const d = day(t), v = perDay.get(d) ?? {usd:0,n:0,unp:0};
  days.push({ date:d, usd:Math.round(v.usd), n:v.n, unpriced:v.unp, eth:ethOn.get(d) ?? null });
}
const total = days.reduce((a,d)=>a+d.usd,0), nAll = days.reduce((a,d)=>a+d.n,0);
const nUnp = days.reduce((a,d)=>a+d.unpriced,0);

if (asJson){
  console.log(JSON.stringify({from:fromDate,to:toDate,days,
    by_source:Object.fromEntries([...perSrc].map(([k,v])=>[k,{usd:Math.round(v.usd),n:v.n}])),
    unpriced_by_symbol:Object.fromEntries(unpriced), sources:SOURCES},null,2));
} else {
  const M = v => '$'+(v/1e6).toFixed(2)+'M';
  console.log(`\n  CROSS-CHAIN LIQUIDATION INDEX   ${fromDate} -> ${toDate}   (${days.length} days)\n`);
  for (const [k,v] of [...perSrc].sort((a,b)=>b[1].usd-a[1].usd))
    console.log(`    ${k.padEnd(24)} ${String(v.n).padStart(6)} events   ${M(v.usd).padStart(10)}`);
  console.log(`\n  total ${nAll} events, ${M(total)} priced; ${nUnp} unpriced (${(nUnp/nAll*100).toFixed(1)}%)`);
  if (unpriced.size) console.log(`  unpriced: ${[...unpriced].sort((a,b)=>b[1]-a[1]).slice(0,14).map(([s,n])=>`${s}:${n}`).join(' ')}`);
  const srt = [...days].sort((a,b)=>b.usd-a.usd);
  console.log(`\n  largest days`);
  for (const d of srt.slice(0,8)) console.log(`    ${d.date}  ${M(d.usd).padStart(10)}   ${String(d.n).padStart(6)} events`);
  const med = [...days].sort((a,b)=>a.usd-b.usd)[Math.floor(days.length/2)].usd;
  console.log(`\n  top1 ${(srt[0].usd/total*100).toFixed(0)}%   top7 ${(srt.slice(0,7).reduce((a,d)=>a+d.usd,0)/total*100).toFixed(0)}%`);
  console.log(`  zero days ${days.filter(d=>d.usd===0).length}/${days.length}   median $${med.toLocaleString()}   mean ${M(total/days.length)}\n`);
}
