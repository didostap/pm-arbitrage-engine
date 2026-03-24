import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Decimal from 'decimal.js';
import { EVENT_NAMES, OpportunityFilteredEvent } from '../../common/events';
import { FeeSchedule } from '../../common/types';
import { FinancialMath, FinancialDecimal } from '../../common/utils';
import { getCorrelationId } from '../../common/services/correlation-context';
import { RawDislocation } from './types/raw-dislocation.type';
import {
  FeeBreakdown,
  LiquidityDepth,
} from './types/enriched-opportunity.type';
import { FilteredDislocation } from './types/edge-calculation-result.type';

export function buildLiquidityDepth(
  dislocation: RawDislocation,
): LiquidityDepth {
  const buyBook = dislocation.buyOrderBook;
  const sellBook = dislocation.sellOrderBook;

  return {
    buyBestAskSize: buyBook.asks.length > 0 ? buyBook.asks[0]!.quantity : 0,
    sellBestAskSize: sellBook.asks.length > 0 ? sellBook.asks[0]!.quantity : 0,
    buyBestBidSize: buyBook.bids.length > 0 ? buyBook.bids[0]!.quantity : 0,
    sellBestBidSize: sellBook.bids.length > 0 ? sellBook.bids[0]!.quantity : 0,
    // Fillable-side depth: buy leg fills against asks, sell leg fills against bids
    buyTotalDepth: buyBook.asks.reduce((sum, l) => sum + l.quantity, 0),
    sellTotalDepth: sellBook.bids.reduce((sum, l) => sum + l.quantity, 0),
  };
}

export function buildFeeBreakdown(
  dislocation: RawDislocation,
  buyFeeSchedule: FeeSchedule,
  sellFeeSchedule: FeeSchedule,
  gasEstimate: Decimal,
  positionSizeUsd: Decimal,
): FeeBreakdown {
  const buyFeeRate = FinancialMath.calculateTakerFeeRate(
    dislocation.buyPrice,
    buyFeeSchedule,
  );
  const sellFeeRate = FinancialMath.calculateTakerFeeRate(
    dislocation.sellPrice,
    sellFeeSchedule,
  );
  const buyFeeCost = dislocation.buyPrice.mul(buyFeeRate);
  const sellFeeCost = dislocation.sellPrice.mul(sellFeeRate);
  const gasFraction = gasEstimate.div(positionSizeUsd);
  const totalCosts = buyFeeCost.plus(sellFeeCost).plus(gasFraction);

  return {
    buyFeeCost,
    sellFeeCost,
    gasFraction,
    totalCosts,
    buyFeeSchedule,
    sellFeeSchedule,
  };
}

export function filterInsufficientVwapDepth(
  pairEventDescription: string,
  dislocation: RawDislocation,
  filtered: FilteredDislocation[],
  eventEmitter: EventEmitter2,
): void {
  filtered.push({
    pairEventDescription,
    netEdge: '0',
    threshold: 'N/A',
    reason: 'insufficient_vwap_depth',
  });
  eventEmitter.emit(
    EVENT_NAMES.OPPORTUNITY_FILTERED,
    new OpportunityFilteredEvent(
      pairEventDescription,
      new FinancialDecimal(0),
      new FinancialDecimal(0),
      'insufficient_vwap_depth',
      undefined,
      { matchId: dislocation.pairConfig.matchId },
    ),
  );
}

export interface CapitalEfficiencyParams {
  dislocation: RawDislocation;
  netEdge: Decimal;
  pairEventDescription: string;
  filtered: FilteredDislocation[];
  minAnnualizedReturn: Decimal;
  logger: Logger;
  eventEmitter: EventEmitter2;
}

export function checkCapitalEfficiency(params: CapitalEfficiencyParams): {
  passed: boolean;
  annualizedReturn: Decimal | null;
} {
  const {
    dislocation,
    netEdge,
    pairEventDescription,
    filtered,
    minAnnualizedReturn: threshold,
    logger,
    eventEmitter,
  } = params;
  const resolutionDate = dislocation.pairConfig.resolutionDate;

  // Gate 1: Resolution date required
  if (!resolutionDate) {
    const reason = 'no_resolution_date';
    filtered.push({
      pairEventDescription,
      netEdge: netEdge.toString(),
      threshold: 'N/A',
      reason,
    });
    logger.debug({
      message: `Opportunity filtered: ${pairEventDescription} — no resolution date`,
      correlationId: getCorrelationId(),
      data: { pairEventDescription, reason },
    });
    eventEmitter.emit(
      EVENT_NAMES.OPPORTUNITY_FILTERED,
      new OpportunityFilteredEvent(
        pairEventDescription,
        netEdge,
        threshold,
        reason,
        undefined,
        { matchId: dislocation.pairConfig.matchId },
      ),
    );
    return { passed: false, annualizedReturn: null };
  }

  // Gate 2: Resolution date must be in the future
  const now = new Date();
  const daysToResolution = new FinancialDecimal(
    resolutionDate.getTime() - now.getTime(),
  ).div(86_400_000);

  if (daysToResolution.lte(0)) {
    const reason = 'resolution_date_passed';
    filtered.push({
      pairEventDescription,
      netEdge: netEdge.toString(),
      threshold: 'N/A',
      reason,
    });
    logger.debug({
      message: `Opportunity filtered: ${pairEventDescription} — resolution date in the past`,
      correlationId: getCorrelationId(),
      data: {
        pairEventDescription,
        resolutionDate: resolutionDate.toISOString(),
        reason,
      },
    });
    eventEmitter.emit(
      EVENT_NAMES.OPPORTUNITY_FILTERED,
      new OpportunityFilteredEvent(
        pairEventDescription,
        netEdge,
        threshold,
        reason,
        undefined,
        { matchId: dislocation.pairConfig.matchId },
      ),
    );
    return { passed: false, annualizedReturn: null };
  }

  // Gate 3: Annualized return threshold
  const annualizedReturn = netEdge.mul(
    new FinancialDecimal(365).div(daysToResolution),
  );

  if (annualizedReturn.lt(threshold)) {
    const reason = `annualized_return_${annualizedReturn.mul(100).toFixed(1)}%_below_${threshold.mul(100).toFixed(0)}%_minimum`;
    filtered.push({
      pairEventDescription,
      netEdge: netEdge.toString(),
      threshold: threshold.toString(),
      reason,
    });
    logger.debug({
      message: `Opportunity filtered: ${pairEventDescription} — annualized return below threshold`,
      correlationId: getCorrelationId(),
      data: {
        pairEventDescription,
        annualizedReturn: annualizedReturn.toString(),
        threshold: threshold.toString(),
        daysToResolution: daysToResolution.toFixed(1),
        resolutionDate: resolutionDate.toISOString(),
        reason,
      },
    });
    eventEmitter.emit(
      EVENT_NAMES.OPPORTUNITY_FILTERED,
      new OpportunityFilteredEvent(
        pairEventDescription,
        netEdge,
        threshold,
        reason,
        undefined,
        {
          matchId: dislocation.pairConfig.matchId,
          annualizedReturn: annualizedReturn.toNumber(),
        },
      ),
    );
    return { passed: false, annualizedReturn };
  }

  return { passed: true, annualizedReturn };
}
