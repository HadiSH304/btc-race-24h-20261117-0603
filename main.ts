import { runBars, BarsState, type Batch, type Fill } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const WARMUP = 360;
const MAX_SEQ = 1300;
const RANGE_PCT = 85;
const DROP_PCT_NUM = 975n;   // 2.5% drop
const DROP_PCT_DEN = 1000n;
const TP_NUM = 1008n;        // +0.8% take profit
const TP_DEN = 1000n;
const SL_NUM = 992n;         // -0.8% stop loss
const SL_DEN = 1000n;
const TIME_STOP = 200;
const BUY_PCT = 95n;
const MAX_SLIPPAGE = 100;
const MAX_TRADES = 5;

const ranges: bigint[] = [];
let rollingHigh = 0n;
let entryPrice = 0n;
let entrySeq = -1;
let totalTrades = 0n;
let inTrade = false;

const historyLows: bigint[] = [];
const historyCloses: bigint[] = [];

function percentile(arr: bigint[], p: number): bigint {
  if (arr.length === 0) return 0n;
  const sorted = [...arr].sort((a, b) => (a > b ? 1 : -1));
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function onBatch(state: BarsState, batch: Batch): Promise<readonly { side: 'buy' | 'sell'; symbol: string; notional_quote_units?: bigint; qty?: bigint; max_slippage_bps: number }[] | void> {
  const bar = state.latest.get(SYMBOL);
  if (!bar) return;
  const close = BigInt(bar.c);
  const range = BigInt(bar.h) - BigInt(bar.l);
  const low = BigInt(bar.l);
  ranges.push(range);
  historyLows.push(low);
  historyCloses.push(close);

  const pos = state.positions.get(SYMBOL);
  const holding = pos && pos.qty > 0n;

  if (inTrade && !holding) {
    rollingHigh = close;
    inTrade = false;
  }

  if (holding) {
    inTrade = true;
    const seq = batch.seq;
    if (close * TP_DEN >= entryPrice * TP_NUM ||
        close * SL_DEN <= entryPrice * SL_NUM ||
        seq - entrySeq >= TIME_STOP) {
      return [{ side: 'sell', symbol: SYMBOL, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE }];
    }
    return;
  }

  if (batch.seq < WARMUP || batch.seq >= MAX_SEQ || state.warmingUp) return;
  if (totalTrades >= MAX_TRADES) return;

  rollingHigh = rollingHigh === 0n ? close : (close > rollingHigh ? close : rollingHigh);

  const pctile = percentile(ranges, RANGE_PCT);
  const normalEntry = range >= pctile && close * DROP_PCT_DEN <= rollingHigh * DROP_PCT_NUM;

  let fallbackEntry = false;
  if (!normalEntry && batch.seq >= 1200 && totalTrades === 0n) {
    if (historyLows.length >= 128 && historyCloses.length >= 2) {
      const startIdx = historyLows.length - 120;
      const endIdx = historyLows.length - 8;
      const lookbackLows = historyLows.slice(startIdx, endIdx);
      const minLow = lookbackLows.reduce((a, b) => (a < b ? a : b));
      const prevClose = historyCloses[historyCloses.length - 2];
      if (low <= minLow && close > minLow && close > prevClose) {
        fallbackEntry = true;
      }
    }
  }

  if (normalEntry || fallbackEntry) {
    const notional = state.cash * BUY_PCT / 100n;
    if (notional <= 0n) return;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE }];
  }
}

async function onBatchWrapper(state: BarsState, batch: Batch) {
  for (const fill of batch.fills) {
    if (fill.symbol === SYMBOL && fill.status === 'filled' && fill.side === 'buy') {
      entryPrice = BigInt(fill.price);
      entrySeq = batch.seq;
      totalTrades += 1n;
      inTrade = true;
    }
  }
  return onBatch(state, batch);
}

await runBars({ onBatch: onBatchWrapper });