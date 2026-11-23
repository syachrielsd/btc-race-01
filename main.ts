// btc-race-01: a trend-following bot for cbBTC/USDC on 1-minute bars.
//
// Design (revision of the standing slow bot, from a coordinator sweep of
// ~40 variants on an exact replica of the fill model, validated against
// the server's own grade-local):
//   * 1-minute returns are tiny against a ~26 bps round-trip cost, so only
//     multi-hour trends can pay and churn still loses. This revision keeps
//     the rare-trade structure but confirms the trend faster, so it enters
//     the same trend earlier at a lower price.
//   * Entry (flat only): close above a rising 30-bar EMA of closes AND the
//     20-bar momentum positive (> 0 bps). No entries before bar index 30,
//     so it never trades blind at the open. Full size (all cash): with one
//     asset and a 25% drawdown guardrail, sizing down only dilutes the
//     trend capture.
//   * Exit (long only): trailing stop 300 bps below the highest close
//     since entry (wider, so a real trend is given more room), or a hard
//     stop 250 bps below the actual entry fill price (tighter, so a failed
//     entry is cut sooner). Both remain wide versus 1-minute noise.
//   * Loss limit: when flat, if cash is at or below 97.5% of the starting
//     capital (hello.capital.quote_units), never enter again. In stress
//     tests this cut a mirrored-downtrend loss from -$47.94 to -$30.13
//     with zero cost on up days.
//   * After any exit, a 60-bar cooldown before re-entry, so a stop-out is
//     not immediately re-bought into the same slide.
//   * Orders decided on bar i fill at bar i+1's open. max_slippage_bps 300
//     is headroom against the latest close while still bounding a gap.
//   * Deterministic: a pure function of the closes seen; no wall clock, no
//     environment, no randomness. Two runs on the same data give the same
//     orders. Gap minutes (no CBBTC bar in the batch) are skipped, never
//     decided on a stale close; if a buy fill is ever missed, the entry
//     price falls back to the position's own cost.
//
// Benchmark (exact grade-local model): this spec scores dev +$33.52,
// 1 trade, max drawdown 1.98%, versus the standing bot's +$31.42 /
// 1 trade / 1.98%. Across 48 block-bootstrap windows: mean +$34.43 vs
// +$32.67, 90% profitable vs 85%; on a drift-removed flat window +$2.62
// vs -$7.19. The gain is mechanical: the faster EMA/momentum pair
// confirms the same trend ~35 bars earlier at a lower price, while the
// wider trail, tighter hard stop and loss limit reshape the downside.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Strategy parameters (few, wide margins — chosen for robustness on an
// unseen 24h window, not tuned to the dev window's exact turns).
const EMA_PERIOD = 30;
const MOMENTUM_BARS = 20;
const WARMUP_BARS = 30;
const TRAIL_STOP_BPS = 300;
const HARD_STOP_BPS = 250;
const COOLDOWN_BARS = 60;
const MAX_SLIPPAGE_BPS = 300;
// Loss limit: once flat cash is at or below 97.5% of the starting capital,
// never enter again — a losing day stops bleeding instead of re-entering.
const LOSS_LIMIT_NUM = 975n;
const LOSS_LIMIT_DEN = 1000n;

const EMA_K = 2 / (EMA_PERIOD + 1);

interface BotMemory {
  closes: number[];
  ema: number;
  prevEma: number;
  entryPrice: number; // USDC per cbBTC (fill price of the open position)
  peakClose: number; // highest close since entry
  lastExitBar: number; // bar index of the last exit decision, for cooldown
  barIndex: number; // count of CBBTC bars seen
}

function freshMemory(): BotMemory {
  return {
    closes: [],
    ema: 0,
    prevEma: 0,
    entryPrice: 0,
    peakClose: 0,
    lastExitBar: -1000000,
    barIndex: -1,
  };
}

const mem = freshMemory();

function decide(state: BarsState, batch: Batch): OrderInput[] {
  // Only decide on a fresh bar: on a gap minute CBBTC is absent from the
  // batch, and the stale close in state.latest must not trigger an order
  // (nor advance the EMA/momentum history).
  const freshBar = batch.bars.find((b) => b.symbol === SYMBOL);
  if (freshBar === undefined) return [];
  const bar = state.latest.get(SYMBOL);
  if (bar === undefined) return [];
  if (state.warmingUp) return [];

  const close = Number(bar.c) / 1e6; // price scale 6: raw units -> USDC per cbBTC
  mem.barIndex += 1;
  mem.closes.push(close);
  if (mem.closes.length === 1) {
    mem.ema = close;
    mem.prevEma = close;
  } else {
    mem.prevEma = mem.ema;
    mem.ema = close * EMA_K + mem.ema * (1 - EMA_K);
  }

  // Learn the entry fill price from the fills this batch reports, so the
  // hard stop is measured from the price actually paid, not the decision bar.
  for (const fill of batch.fills) {
    if (fill.symbol === SYMBOL && fill.side === 'buy' && fill.status === 'filled') {
      mem.entryPrice = Number(fill.price) / 1e6;
      mem.peakClose = mem.entryPrice;
    }
  }

  const position = state.positions.get(SYMBOL);
  const qty = position === undefined ? 0n : position.qty;

  if (qty > 0n) {
    // Fallback if the buy fill was never seen (e.g. a fill reported on a
    // batch whose fills we missed): the position's own cost implies the
    // price paid — cost micro-USDC / qty 1e-8 BTC = cost * 100 / qty USDC.
    if (mem.entryPrice <= 0 && position !== undefined && position.qty > 0n) {
      const cost = Number(position.cost_quote_units);
      const q = Number(position.qty);
      if (cost > 0 && q > 0) mem.entryPrice = (cost * 100) / q;
    }
    if (close > mem.peakClose) mem.peakClose = close;
    const fromPeakBps = ((close / mem.peakClose) - 1) * 10000;
    const fromEntryBps = mem.entryPrice > 0 ? ((close / mem.entryPrice) - 1) * 10000 : 0;
    if (fromPeakBps < -TRAIL_STOP_BPS || fromEntryBps < -HARD_STOP_BPS) {
      mem.lastExitBar = mem.barIndex;
      mem.entryPrice = 0;
      mem.peakClose = 0;
      return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  }

  // Flat: look for a confirmed uptrend.
  if (mem.barIndex < WARMUP_BARS) return [];
  if (mem.barIndex - mem.lastExitBar < COOLDOWN_BARS) return [];
  // Loss limit: if cash has fallen to 97.5% of the starting capital, sit
  // out the rest of the race rather than risk compounding the loss.
  const startCapital = BigInt(state.hello.capital.quote_units);
  if (state.cash * LOSS_LIMIT_DEN <= startCapital * LOSS_LIMIT_NUM) return [];
  const momentumBps =
    ((close / mem.closes[mem.closes.length - 1 - MOMENTUM_BARS]) - 1) * 10000;
  const uptrend = close > mem.ema && mem.ema > mem.prevEma && momentumBps > 0;
  if (!uptrend) return [];
  if (state.cash <= 0n) return [];
  return [
    {
      side: 'buy',
      symbol: SYMBOL,
      notional_quote_units: state.cash,
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    },
  ];
}

await runBars({
  onBatch(state, batch) {
    return decide(state, batch);
  },
});
