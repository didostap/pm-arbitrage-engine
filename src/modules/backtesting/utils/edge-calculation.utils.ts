import Decimal from 'decimal.js';
import { FinancialMath } from '../../../common/utils/financial-math';
import type { BacktestTimeStepPair } from '../types/simulation.types';
import {
  DEFAULT_KALSHI_FEE_SCHEDULE,
  DEFAULT_POLYMARKET_FEE_SCHEDULE,
} from './fee-schedules';

export function calculateBestEdge(pairData: BacktestTimeStepPair): {
  bestEdge: Decimal;
  buySide: 'kalshi' | 'polymarket';
} {
  const one = new Decimal(1);
  const edgeA = FinancialMath.calculateGrossEdge(
    pairData.kalshiClose,
    one.minus(pairData.polymarketClose),
  );
  const edgeB = FinancialMath.calculateGrossEdge(
    pairData.polymarketClose,
    one.minus(pairData.kalshiClose),
  );

  if (edgeA.gt(edgeB)) {
    return { bestEdge: edgeA, buySide: 'kalshi' };
  }
  return { bestEdge: edgeB, buySide: 'polymarket' };
}

export function calculateNetEdge(
  grossEdge: Decimal,
  pairData: BacktestTimeStepPair,
  buySide: 'kalshi' | 'polymarket',
  gasEstimate: Decimal,
  positionSizeUsd: Decimal,
): Decimal {
  const buyPrice =
    buySide === 'kalshi' ? pairData.kalshiClose : pairData.polymarketClose;
  const sellPrice =
    buySide === 'kalshi'
      ? new Decimal(1).minus(pairData.polymarketClose)
      : new Decimal(1).minus(pairData.kalshiClose);

  const buyFee =
    buySide === 'kalshi'
      ? DEFAULT_KALSHI_FEE_SCHEDULE
      : DEFAULT_POLYMARKET_FEE_SCHEDULE;
  const sellFee =
    buySide === 'kalshi'
      ? DEFAULT_POLYMARKET_FEE_SCHEDULE
      : DEFAULT_KALSHI_FEE_SCHEDULE;

  return FinancialMath.calculateNetEdge(
    grossEdge,
    buyPrice,
    sellPrice,
    buyFee,
    sellFee,
    gasEstimate,
    positionSizeUsd,
  );
}

export function calculateCurrentEdge(
  pairData: BacktestTimeStepPair,
  gasEstimate: Decimal,
  positionSizeUsd: Decimal,
): Decimal {
  const { bestEdge, buySide } = calculateBestEdge(pairData);
  return calculateNetEdge(bestEdge, pairData, buySide, gasEstimate, positionSizeUsd);
}

export function isInTradingWindow(
  timestamp: Date,
  config: { tradingWindowStartHour: number; tradingWindowEndHour: number },
): boolean {
  const hour = timestamp.getUTCHours();
  if (config.tradingWindowStartHour <= config.tradingWindowEndHour) {
    return (
      hour >= config.tradingWindowStartHour &&
      hour < config.tradingWindowEndHour
    );
  }
  return (
    hour >= config.tradingWindowStartHour ||
    hour < config.tradingWindowEndHour
  );
}

export function inferResolutionPrice(
  pairData: BacktestTimeStepPair,
): Decimal | null {
  const kalshiPrice: Decimal = pairData.kalshiClose;
  const polyPrice: Decimal = pairData.polymarketClose;

  const maxPrice = Decimal.max(kalshiPrice, polyPrice);
  const minPrice = Decimal.min(kalshiPrice, new Decimal(1).minus(polyPrice));

  if (maxPrice.gte(new Decimal('0.95'))) return new Decimal('1.00');
  if (minPrice.lte(new Decimal('0.05'))) return new Decimal('0.00');
  return null;
}
