import Decimal from 'decimal.js';
import { FeeSchedule } from '../../../common/types';
import { RawDislocation } from './raw-dislocation.type';

export interface FeeBreakdown {
  buyFeeCost: Decimal;
  sellFeeCost: Decimal;
  gasFraction: Decimal;
  totalCosts: Decimal;
  buyFeeSchedule: FeeSchedule;
  sellFeeSchedule: FeeSchedule;
}

export interface LiquidityDepth {
  buyBestAskSize: number;
  sellBestAskSize: number;
  buyBestBidSize: number;
  sellBestBidSize: number;
}

export interface EnrichedOpportunity {
  dislocation: RawDislocation;
  netEdge: Decimal;
  grossEdge: Decimal;
  feeBreakdown: FeeBreakdown;
  liquidityDepth: LiquidityDepth;
  recommendedPositionSize: null;
  enrichedAt: Date;
}
