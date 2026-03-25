import type Decimal from 'decimal.js';
import type { IPlatformConnector } from '../../common/interfaces/platform-connector.interface';
import type {
  RankedOpportunity,
  BudgetReservation,
} from '../../common/types/risk.type';
import type { OrderResult } from '../../common/types/index';
import type { PlatformId } from '../../common/types/platform.type';
import type { ExecutionResult } from '../../common/interfaces/execution-engine.interface';
import type { EnrichedOpportunity } from '../arbitrage-detection/types/enriched-opportunity.type';
import type { SequencingDecision } from './leg-sequencing.service';

export interface ExecutionMetadata {
  primaryLeg: string;
  sequencingReason: string;
  kalshiLatencyMs: number | null;
  polymarketLatencyMs: number | null;
  idealCount: number;
  matchedCount: number;
  kalshiDataSource: string;
  polymarketDataSource: string;
  divergenceDetected: boolean;
}

/** Shared pipeline state built incrementally in execute() and passed to helpers */
export interface PipelineState {
  enriched: EnrichedOpportunity;
  opportunity: RankedOpportunity;
  reservation: BudgetReservation;
  sequencingDecision: SequencingDecision;
  primaryLeg: 'kalshi' | 'polymarket';
  primaryConnector: IPlatformConnector;
  secondaryConnector: IPlatformConnector;
  primaryPlatform: PlatformId;
  secondaryPlatform: PlatformId;
  isPaper: boolean;
  mixedMode: boolean;
  primarySide: 'buy' | 'sell';
  secondarySide: 'buy' | 'sell';
  targetPrice: Decimal;
  secondaryTargetPrice: Decimal;
  primaryContractId: string;
  secondaryContractId: string;
  pairId: string;
  idealCount: number;
  executionMetadata: ExecutionMetadata;
}

export type SubmitSuccess = {
  ok: true;
  primaryOrderRecord: { orderId: string };
  secondaryOrderRecord: { orderId: string };
  primaryOrder: OrderResult;
  secondaryOrder: OrderResult;
  equalizedSize: number;
};

export type SubmitResult =
  | SubmitSuccess
  | { ok: false; result: ExecutionResult };
