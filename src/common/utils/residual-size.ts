import Decimal from 'decimal.js';

interface ResidualSizePosition {
  kalshiOrderId: string | null;
  polymarketOrderId: string | null;
  kalshiOrder: { fillSize: Decimal | { toString(): string } | null } | null;
  polymarketOrder: {
    fillSize: Decimal | { toString(): string } | null;
  } | null;
}

interface PairOrder {
  orderId: string;
  platform: string;
  fillSize: Decimal | { toString(): string } | null;
}

/**
 * Computes the residual (unfilled) contract size per leg for a position.
 *
 * For OPEN positions with no exit orders, returns entry fill sizes unchanged.
 * For EXIT_PARTIAL positions, subtracts all exit order fills from entry sizes.
 * Floors at zero defensively.
 */
export function getResidualSize(
  position: ResidualSizePosition,
  allPairOrders: PairOrder[],
): { kalshi: Decimal; polymarket: Decimal; floored: boolean } {
  const kalshiEntryFill = new Decimal(
    position.kalshiOrder?.fillSize?.toString() ?? '0',
  );
  const polymarketEntryFill = new Decimal(
    position.polymarketOrder?.fillSize?.toString() ?? '0',
  );

  // Filter out entry orders — everything else is an exit order
  const entryOrderIds = new Set<string>();
  if (position.kalshiOrderId) entryOrderIds.add(position.kalshiOrderId);
  if (position.polymarketOrderId) entryOrderIds.add(position.polymarketOrderId);

  const exitOrders = allPairOrders.filter((o) => !entryOrderIds.has(o.orderId));

  // Sum exit fill sizes per platform
  let kalshiExitSum = new Decimal(0);
  let polymarketExitSum = new Decimal(0);

  for (const order of exitOrders) {
    if (!order.fillSize) continue;
    const fillSize = new Decimal(order.fillSize.toString());
    if (order.platform === 'KALSHI') {
      kalshiExitSum = kalshiExitSum.plus(fillSize);
    } else if (order.platform === 'POLYMARKET') {
      polymarketExitSum = polymarketExitSum.plus(fillSize);
    }
  }

  // Residual = entry fill - exit fills, floored at zero
  const kalshiRaw = kalshiEntryFill.minus(kalshiExitSum);
  const polymarketRaw = polymarketEntryFill.minus(polymarketExitSum);
  const floored = kalshiRaw.isNeg() || polymarketRaw.isNeg();

  const kalshiResidual = Decimal.max(kalshiRaw, new Decimal(0));
  const polymarketResidual = Decimal.max(polymarketRaw, new Decimal(0));

  return { kalshi: kalshiResidual, polymarket: polymarketResidual, floored };
}
