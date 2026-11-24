# token-radar-makefun

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/mikaagentbee/token-radar-makefun/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/mikaagentbee/token-radar-makefun/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar. It reads the sealed DefiLlama snapshot (758 protocols, 40 on the watchlist) and ranks every pre-token launch candidate by an implied value measured from the snapshot itself: TVL x the median market-cap/TVL multiple that the snapshot's live protocols in the same category actually trade at (shrunk toward the global median by peer count), adjusted for seven-day TVL growth and for how long the protocol has run with no token. Exchange products, bridge and staking wrappers, and versioned pools are set aside rather than ranked; live-token protocols are shown apart with their real market caps. The dashboard is a static, offline page with search, category, chain and minimum-TVL filters, sortable columns, a per-protocol detail view that shows the model's arithmetic step by step, and a concrete seven-step farm plan for every row.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/snapshot.json
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=tcjwfdzm&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
