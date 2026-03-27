import Decimal from 'decimal.js';

/**
 * Calculate profit factor as sum(winPnl) / abs(sum(lossPnl)).
 * Returns null when there are no losing trades (division by zero).
 */
export function calculateProfitFactor(
  positions: { realizedPnl: Decimal }[],
): Decimal | null {
  let grossWin = new Decimal(0);
  let grossLoss = new Decimal(0);

  for (const pos of positions) {
    if (pos.realizedPnl.gt(0)) {
      grossWin = grossWin.plus(pos.realizedPnl);
    } else if (pos.realizedPnl.lt(0)) {
      grossLoss = grossLoss.plus(pos.realizedPnl.abs());
    }
  }

  return grossLoss.gt(0) ? grossWin.div(grossLoss) : null;
}

/**
 * Calculate annualized Sharpe ratio: mean(dailyReturns) / stddev(dailyReturns) * sqrt(252).
 * Returns null when: no positions, zero bankroll, <= 1 trading day, or zero stddev.
 */
export function calculateSharpeRatio(
  bankroll: Decimal,
  positions: { realizedPnl: Decimal; exitTimestamp: Date }[],
): Decimal | null {
  if (positions.length === 0 || bankroll.isZero()) return null;

  // Group P&L by day
  const dailyReturns = new Map<string, Decimal>();
  for (const pos of positions) {
    const day = pos.exitTimestamp.toISOString().slice(0, 10);
    const existing = dailyReturns.get(day) ?? new Decimal(0);
    dailyReturns.set(day, existing.plus(pos.realizedPnl));
  }

  const returns = [...dailyReturns.values()].map((r) => r.div(bankroll));
  if (returns.length <= 1) return null;

  const mean = returns
    .reduce((acc, r) => acc.plus(r), new Decimal(0))
    .div(returns.length);

  const variance = returns
    .reduce((acc, r) => acc.plus(r.minus(mean).pow(2)), new Decimal(0))
    .div(returns.length - 1);

  const stddev = variance.sqrt();
  if (stddev.isZero()) return null;

  return mean.div(stddev).mul(new Decimal(252).sqrt());
}
