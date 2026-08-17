#!/usr/bin/env node
// Renders data/index.json into index.html — a single self-contained page.
// No build step, no dependencies, no CDN. The page is regenerated on every
// update so the published number and the committed data cannot drift apart.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const d = JSON.parse(readFileSync(join(HERE,'data','index.json'),'utf8'));
const days = d.days;
if (!days?.length) { console.error('no days in store'); process.exit(2); }

const M = v => v >= 1e6 ? '$'+(v/1e6).toFixed(1)+'M'
            : v >= 1e3 ? '$'+Math.round(v/1e3)+'k'
            : '$'+v.toLocaleString('en-US');
const roll = n => days.slice(-n).reduce((a,x)=>a+x.usd,0);
const total = days.reduce((a,x)=>a+x.usd,0);
const nEv   = days.reduce((a,x)=>a+x.n,0);
const nUnp  = days.reduce((a,x)=>a+(x.unpriced??0),0);
const sorted = [...days].sort((a,b)=>b.usd-a.usd);
const median = [...days].map(x=>x.usd).sort((a,b)=>a-b)[Math.floor(days.length/2)];
const zero = days.filter(x=>x.usd===0).length;
const r30 = roll(30), r7 = roll(7);
const hist30 = days.map((_,i)=>days.slice(Math.max(0,i-29),i+1).reduce((a,x)=>a+x.usd,0));
const pct = Math.round(hist30.filter(v=>v<=r30).length / hist30.length * 100);
const srcs = Object.entries(d.by_source ?? {}).sort((a,b)=>b[1].usd-a[1].usd);

const esc = s => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

const html = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DeFi Liquidation Index — ${d.to}</title>
<style>
:root{--ground:#E7EDEF;--surface:#FCFEFE;--surface-2:#F1F6F7;--ink:#0F252C;--body:#2C444C;
--muted:#5F7883;--hair:#C8D6DA;--hair-soft:#DCE6E9;--accent:#BE5127;--accent-soft:#BE512714;--deep:#0B4F6C}
@media (prefers-color-scheme:dark){:root{--ground:#071519;--surface:#0D2028;--surface-2:#112B34;
--ink:#E2EDEF;--body:#B6CBD1;--muted:#7E9AA4;--hair:#1F404A;--hair-soft:#183440;
--accent:#E2794A;--accent-soft:#E2794A1F;--deep:#4FA6C6}}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--body);font-size:16px;line-height:1.7;
font-family:ui-serif,Georgia,"Hiragino Mincho ProN",serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:900px;margin:0 auto;padding:56px 24px 80px}
h1,h2,.sans{font-family:ui-sans-serif,system-ui,"Hiragino Kaku Gothic ProN",sans-serif;color:var(--ink)}
h1{font-size:clamp(26px,4.4vw,38px);letter-spacing:-.025em;font-weight:800;margin:0 0 8px;line-height:1.2}
h2{font-size:19px;letter-spacing:-.015em;font-weight:750;margin:44px 0 12px}
p{margin:0 0 14px} strong{color:var(--ink)}
.mono{font-family:ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums}
.eyebrow{font-family:ui-monospace,Menlo,monospace;font-size:11px;letter-spacing:.18em;
text-transform:uppercase;color:var(--muted);margin:0 0 14px}
.hero{background:var(--surface);border:1px solid var(--hair);border-radius:4px;padding:26px;margin:26px 0 0}
.big{font-family:ui-sans-serif,system-ui,sans-serif;font-size:clamp(38px,8vw,64px);font-weight:800;
letter-spacing:-.04em;color:var(--accent);line-height:1;font-variant-numeric:tabular-nums}
.sub{font-size:13px;color:var(--muted);margin-top:8px;font-family:ui-sans-serif,system-ui,sans-serif}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;
background:var(--hair);border:1px solid var(--hair);border-radius:3px;overflow:hidden;margin-top:22px}
.grid>div{background:var(--surface);padding:14px 16px}
.k{font-size:10px;letter-spacing:.13em;text-transform:uppercase;color:var(--muted);margin-bottom:4px}
.v{font-size:21px;font-weight:750;color:var(--ink);letter-spacing:-.02em;
font-family:ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse;font-size:13.5px;margin-top:14px}
th{font-family:ui-sans-serif,system-ui,sans-serif;font-size:10px;letter-spacing:.12em;text-transform:uppercase;
color:var(--muted);text-align:left;font-weight:600;padding:0 10px 7px 0;border-bottom:1px solid var(--hair)}
td{padding:8px 10px 8px 0;border-bottom:1px solid var(--hair-soft);font-variant-numeric:tabular-nums}
td.n{text-align:right;font-family:ui-monospace,Menlo,monospace}
svg{display:block;width:100%;height:auto;margin-top:14px}
.note{font-size:12.5px;color:var(--muted);line-height:1.65}
footer{margin-top:44px;padding-top:18px;border-top:1px solid var(--hair);font-size:12px;color:var(--muted)}
code{font-family:ui-monospace,Menlo,monospace;font-size:12.5px}
</style></head><body><div class="wrap">

<p class="eyebrow">DeFi Liquidation Index · updated ${esc(d.updated?.slice(0,16).replace('T',' '))} UTC</p>
<h1>30日ローリング清算指数</h1>

<div class="hero">
  <div class="big">${M(r30)}</div>
  <div class="sub">直近30日に清算された債務の名目額 — 観測期間中の <strong>${pct} パーセンタイル</strong>／直近7日 ${M(r7)}</div>
</div>

<div class="grid">
  <div><div class="k">観測日数</div><div class="v">${days.length}</div></div>
  <div><div class="k">累計名目額</div><div class="v">${M(total)}</div></div>
  <div><div class="k">イベント数</div><div class="v">${nEv.toLocaleString('en-US')}</div></div>
  <div><div class="k">中央値の日</div><div class="v">${M(median)}</div></div>
  <div><div class="k">清算ゼロの日</div><div class="v">${zero} / ${days.length}</div></div>
  <div><div class="k">未価格</div><div class="v">${(nUnp/nEv*100).toFixed(1)}%</div></div>
</div>

<h2 class="sans">推移</h2>
${chart(hist30, days)}

<h2 class="sans">最大の日</h2>
<table><thead><tr><th>日付</th><th style="text-align:right">名目額</th><th style="text-align:right">件数</th></tr></thead><tbody>
${sorted.slice(0,8).map(x=>`<tr><td class="mono">${x.date}</td><td class="n">${M(x.usd)}</td><td class="n">${x.n.toLocaleString('en-US')}</td></tr>`).join('\n')}
</tbody></table>

<h2 class="sans">ソース</h2>
<table><thead><tr><th>チェーン / プロトコル</th><th style="text-align:right">件数</th><th style="text-align:right">名目額</th></tr></thead><tbody>
${srcs.map(([k,v])=>`<tr><td>${esc(k)}</td><td class="n">${v.n.toLocaleString('en-US')}</td><td class="n">${M(v.usd)}</td></tr>`).join('\n')}
</tbody></table>

<h2 class="sans">自分で確かめる</h2>
<p class="note">この指数は再現できます。すべての入力はオンチェーンで、収集器はゼロ依存です。</p>
<p class="note"><code>git clone … &amp;&amp; node index.mjs ${esc(days[days.length-1].date)} ${esc(nextDay(days[days.length-1].date))}</code></p>
<p class="note">値付けは各清算イベントの返済債務額を、債務トークンの <code>decimals()</code> で割ったもの。USDペッグはシンボル一致で等価、ETH系は Chainlink ETH/USD で換算、それ以外は<strong>推測せず未価格として計上</strong>します。上限に当たった応答は切り捨てずに再分割し、値が取れなければ<strong>止まります</strong>。</p>
<p class="note"><strong>data/ はコミットされています。</strong>過去の日が後から書き換えられていないことは git の履歴で確認できます。この種の指数に唯一必須の性質です。</p>

<footer>
Sources: ${srcs.map(([k])=>esc(k)).join(' · ')}.
価格は Chainlink ETH/USD <code>0x5f4eC3Df…5c5b8419</code> のオンチェーン更新、各 00:00 UTC 直前の値。
未価格 ${nUnp.toLocaleString('en-US')} 件 (${(nUnp/nEv*100).toFixed(1)}%)。
</footer>
</div></body></html>`;

function nextDay(s){ return new Date(Date.parse(s+'T00:00:00Z')+86400000).toISOString().slice(0,10); }

function chart(series, days){
  const W=880,H=240,L=62,R=18,T=16,B=30, iw=W-L-R, ih=H-T-B;
  const max = Math.max(...series, 1);
  const ymax = Math.pow(10, Math.ceil(Math.log10(max)));
  const X = i => L + (series.length>1 ? i/(series.length-1)*iw : 0);
  const Y = v => T + ih - (v/ymax)*ih;
  let s = '';
  for (let i=0;i<=4;i++){
    const v = ymax*i/4;
    s += `<line x1="${L}" y1="${Y(v).toFixed(1)}" x2="${W-R}" y2="${Y(v).toFixed(1)}" stroke="var(--hair-soft)"/>`;
    s += `<text x="${L-8}" y="${(Y(v)+3.5).toFixed(1)}" text-anchor="end" font-size="9.5" fill="var(--muted)" font-family="ui-monospace,Menlo,monospace">${M(v)}</text>`;
  }
  let p = `M ${X(0)} ${Y(series[0]).toFixed(1)}`;
  series.forEach((v,i)=>{ if(i) p += ` L ${X(i).toFixed(1)} ${Y(v).toFixed(1)}`; });
  s += `<path d="${p} L ${X(series.length-1).toFixed(1)} ${Y(0)} L ${X(0)} ${Y(0)} Z" fill="var(--accent)" opacity=".13"/>`;
  s += `<path d="${p}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>`;
  const last = series.length-1;
  s += `<circle cx="${X(last).toFixed(1)}" cy="${Y(series[last]).toFixed(1)}" r="4" fill="var(--accent)"/>`;
  [0, Math.floor(last/2), last].forEach(i=>{
    s += `<text x="${X(i).toFixed(1)}" y="${T+ih+16}" text-anchor="${i===0?'start':i===last?'end':'middle'}" font-size="9.5" fill="var(--muted)" font-family="ui-monospace,Menlo,monospace">${days[i].date.slice(5)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="30日ローリング清算指数の推移">${s}</svg>`;
}

writeFileSync(join(HERE,'index.html'), html);
console.log(`index.html written — ${days.length} days, 30d rolling ${M(r30)} (${pct}th pct)`);
