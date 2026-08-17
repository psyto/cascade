# DeFi Liquidation Index

A daily USD index of debt repaid in liquidations across lending protocols on
Ethereum, Base and Arbitrum. Every input is on-chain. The collector has no
dependencies and the data is committed, so the history is checkable.

**Why this exists.** You can bet that a price falls. You cannot bet that the
system is over-levered. Measured over 77 days, the daily drawdown explains
about a quarter of the variance in what gets liquidated — the rest is
positioning. `−3.28%` produced $40,338 and `−2.96%` produced $48,922,102.
Those are different exposures and only one of them is tradeable today.

## Run it

```bash
node index.mjs 2026-06-01 2026-08-17     # collect a range
node daily.mjs                            # bring data/index.json to yesterday
node page.mjs                             # regenerate index.html
node resolve.mjs 2026-06                  # settle the wager for one month
```

Node 18+. No install step.

## What it counts

The **debt repaid by the liquidator** — the one quantity every protocol reports
and the one that means the same thing everywhere.

| chain | protocol | event |
| --- | --- | --- |
| Ethereum | Aave V3, Spark | `LiquidationCall` |
| Ethereum | Morpho Blue | `Liquidate` |
| Ethereum | Compound V3 | `AbsorbDebt` |
| Base | Aave V3, Morpho Blue, Compound V3 | as above |
| Arbitrum | Aave V3 | `LiquidationCall` |

Amounts are divided by the debt token's `decimals()`. USD-pegged symbols count
as a dollar, ETH-like symbols are converted at Chainlink ETH/USD read from its
on-chain updates at the 00:00 UTC boundary, and anything else is left
**unpriced** and reported as a residual rather than guessed at.

## What it refuses to do

A liquidation index is mostly zeros, so a broken run looks exactly like a quiet
week. Six bugs found while building this produced *silently smaller* numbers —
a wrong selector zeroed a whole protocol, `Number(null)` zeroed a whole chain,
an empty range was mistaken for an outage. So:

- a capped response is **subdivided**, never truncated
- an unpriceable token is **reported**, never assumed
- an unresolvable block or a silent API **stops the run** — a partial read is
  not a smaller answer
- a stored day is **never rewritten**; a re-collection that disagrees is a
  finding, not an update

`data/index.json` is committed on every run. The git history is the
tamper-evident record: anyone can check that a past day was not quietly revised.

## Honest scope

- Ethereum, Base and Arbitrum lending only. No Optimism, Fluid, Euler, Solana.
  Perp-DEX liquidations are a separate and much larger series.
- USD-peg detection is a **symbol heuristic**. A token named `*USD` that depegs
  is still counted at a dollar here.
- ~4.5% of events are unpriced, so the index is that much low.
- The peg and ETH-like symbol lists are hand-maintained and will lag new assets.
