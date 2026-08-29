# Free Order Flow bridge

This module is intentionally **disabled by default** until a real MT5/tick feed is available.

## Data contract

The bridge may publish JSON containing:
- `timestamp`
- `symbol`
- `delta`
- `cvd`
- `buyVolume`
- `sellVolume`
- `imbalance`
- `absorption`
- `source`
- `isReal`

The analysis engine must reject the data when `isReal !== true` or when the source is missing/stale.

## Important XAUUSD limitation

Spot XAUUSD has no single centralized global order book. Broker/MT5 tick data describes that broker's feed. Exchange futures data can be used as a proxy, but must be labeled as a proxy rather than global spot order flow.

## Activation rule

Do not enable Order Flow as a mandatory signal gate until a live feed has been connected and validated against the broker symbol/time stamps.
