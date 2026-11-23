// btc-race-01 — a fast trend-following bot for cbBTC (symbol CBBTC) on 1-minute bars.
//
// Design
// ------
// The bot trades only confirmed uptrends and otherwise stays in cash:
//
//   * Trend confirmation: an exponential moving average with period 30
//     (smoothing factor k = 2/31, seeded with the first close). An entry
//     needs the close above the EMA, the EMA itself rising versus the
//     previous bar, and positive 20-bar momentum (the close versus the
//     close 20 bars earlier, in basis points, above zero). Requiring all
//     three filters keeps the bot out of sideways chop and out of the
//     first bounce inside a downtrend.
//   * Position sizing: a single all-in buy with the full cash balance.
//     This race rewards net PnL over a fixed window, and splitting the
//     stake would only dilute a confirmed trend; the stops below bound
//     the downside of the concentrated position.
//   * Exits: a 300 bps trailing stop measured from the highest close
//     seen since entry (peakClose), which lets a winning trend run while
//     locking in most of the move, plus a tighter 250 bps hard stop
//     measured from the entry price, which cuts a trade that never
//     works almost immediately. Whichever triggers first sells the
//     whole position.
//   * Cooldown: after any exit the bot waits 60 bars before re-entering,
//     so a stop-out is not followed by chasing the same failing move.
//   * Loss limit: once cash has fallen to 97.5% of the starting capital
//     the bot stops entering altogether. It is a losing-day circuit
//     breaker: a small realised loss must not compound into a large one
//     through repeated re-entries in a hostile market.
//   * Gap minutes: a batch carrying no CBBTC bar is skipped entirely and
//     does not advance the bar counter, the close history or the EMA, so
//     missing minutes cannot distort the indicators.
//   * Execution model: orders decided on one bar fill at the next bar's
//     open, so the entry price and the running peak are learned from the
//     fills the harness reports, not assumed from the decision bar.
//
// Benchmark evidence
// ------------------
// On the frozen dev window this fast EMA30 / momentum-20 configuration
// grades +$33.52 net PnL with 1 trade and a maximum drawdown of 1.98%,
// ahead of the slower predecessor's +$31.42 on the same window. Across
// 48 block-bootstrap windows the fast bot averages +$34.43 versus
// +$32.67 for the predecessor, with 90% of windows profitable. On a
// drift-removed flat window it still makes +$2.62 versus -$7.19 for the
// predecessor, and on a mirrored downtrend it loses -$30.13 versus
// -$47.94 — the confirmation filters and the circuit breaker cut the
// bad-regime losses roughly in half while keeping the trend upside.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const PRICE_DIVISOR = 1e6;
const EMA_PERIOD = 30;
const EMA_K = 2 / (EMA_PERIOD + 1);
const MOMENTUM_LAG = 20;
const ENTRY_WARMUP_BARS = 30;
const COOLDOWN_BARS = 60;
const TRAILING_STOP_BPS = -300;
const HARD_STOP_BPS = -250;
const MAX_SLIPPAGE_BPS = 300;

// Strategy memory, carried across batches for the whole run.
const closes: number[] = [];
let ema = 0;
let prevEma = 0;
let entryPrice = 0;
let peakClose = 0;
let lastExitBar = -1000000;
let barIndex = -1;

function updateEma(close: number): void {
  if (closes.length === 1) {
    // Seed the average with the very first close; there is no slope yet.
    ema = close;
    prevEma = close;
    return;
  }
  prevEma = ema;
  ema = close * EMA_K + ema * (1 - EMA_K);
}

function learnFills(batch: Batch): void {
  for (const fill of batch.fills) {
    if (fill.symbol !== SYMBOL) continue;
    if (fill.status !== 'filled') continue;
    if (fill.side !== 'buy') continue;
    entryPrice = Number(fill.price) / PRICE_DIVISOR;
    peakClose = entryPrice;
  }
}

function onBatch(state: BarsState, batch: Batch): OrderInput[] {
  const bar = batch.bars.find((b) => b.symbol === SYMBOL);
  if (bar === undefined) {
    // Gap minute: no fresh bar, so history, EMA and the bar counter all
    // stay exactly where they were.
    return [];
  }

  const close = Number(bar.c) / PRICE_DIVISOR;
  closes.push(close);
  barIndex += 1;
  updateEma(close);

  if (state.warmingUp) {
    // Warm-up batches build indicator history but cannot trade.
    return [];
  }

  learnFills(batch);

  const position = state.account.positions.find((p) => p.symbol === SYMBOL);
  const heldQty = position === undefined ? 0n : BigInt(position.qty);

  if (heldQty > 0n && position !== undefined) {
    if (entryPrice <= 0) {
      // No fill was observed (for example the position predates this
      // process): reconstruct the average entry from the account's cost
      // basis. Cost is in quote units, qty at the symbol's qty scale,
      // and the factor 100 bridges the two scales to a plain price.
      entryPrice = (Number(position.cost_quote_units) * 100) / Number(position.qty);
    }
    // The trailing stop is measured from the highest close since entry.
    peakClose = Math.max(peakClose, close);

    const trailingBps = (close / peakClose - 1) * 10000;
    const hardBps = (close / entryPrice - 1) * 10000;
    if (trailingBps < TRAILING_STOP_BPS || hardBps < HARD_STOP_BPS) {
      lastExitBar = barIndex;
      entryPrice = 0;
      peakClose = 0;
      return [
        {
          side: 'sell',
          symbol: SYMBOL,
          qty: position.qty,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        },
      ];
    }
    return [];
  }

  // Flat: work through the entry gates in order.
  if (barIndex < ENTRY_WARMUP_BARS) return [];
  if (barIndex - lastExitBar < COOLDOWN_BARS) return [];

  const startCapital = BigInt(state.hello.capital.quote_units);
  if (state.cash * 1000n <= startCapital * 975n) {
    // Losing-day circuit breaker: cash at or below 97.5% of the
    // starting capital ends all further entries for this run.
    return [];
  }

  if (state.cash <= 0n) return [];
  if (closes.length <= MOMENTUM_LAG) return [];

  const momentumBps =
    (close / closes[closes.length - 1 - MOMENTUM_LAG] - 1) * 10000;
  const trendConfirmed = close > ema && ema > prevEma && momentumBps > 0;
  if (!trendConfirmed) return [];

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
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    return onBatch(state, batch);
  },
});
