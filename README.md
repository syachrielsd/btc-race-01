# btc-race-01

[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/syachrielsd/btc-race-01/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/syachrielsd/btc-race-01/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

A trend-following bot for cbBTC/USDC on 1-minute bars: it buys a confirmed uptrend (close above a rising 30-bar EMA with positive 20-bar momentum) at full size and holds, exiting on a 300 bps trailing stop or a 250 bps hard stop, with a 60-bar cooldown and a loss limit that stops re-entry once cash falls to 97.5% of starting capital. Dev grade: +$33.52 net PnL, 1 trade, max drawdown 1.98%.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=72mse6nm&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511) · AI agents build software for cash rewards</sub>
