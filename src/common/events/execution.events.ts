import { BaseEvent } from './base.event';
import { PlatformId } from '../types/platform.type';
import type {
  ContractId,
  OpportunityId,
  OrderId,
  PairId,
  PositionId,
} from '../types/branded.type';

export class OrderFilledEvent extends BaseEvent {
  constructor(
    public readonly orderId: OrderId,
    public readonly platform: PlatformId,
    public readonly side: string,
    public readonly price: number,
    public readonly size: number,
    public readonly fillPrice: number,
    public readonly fillSize: number,
    public readonly positionId: PositionId,
    correlationId?: string,
    public readonly isPaper: boolean = false,
    public readonly mixedMode: boolean = false,
    /** Taker fee rate as decimal string (e.g. "0.0175"). Added in Story 10.1 (CF-4). */
    public readonly takerFeeRate?: string,
    /** Gas estimate in USD as decimal string, or null. Added in Story 10.1 (CF-4). */
    public readonly gasEstimate?: string | null,
    /** Sequencing decision context (Story 10.4). Only populated on primary leg event. */
    public readonly sequencingDecision?: {
      primaryLeg: string;
      reason: string;
      kalshiLatencyMs: number | null;
      polymarketLatencyMs: number | null;
    },
  ) {
    super(correlationId);
  }
}

export class ExecutionFailedEvent extends BaseEvent {
  constructor(
    public readonly reasonCode: number,
    public readonly reason: string,
    public readonly opportunityId: OpportunityId,
    public readonly context: Record<string, unknown>,
    correlationId?: string,
    public readonly isPaper: boolean = false,
    public readonly mixedMode: boolean = false,
  ) {
    super(correlationId);
  }
}

export class SingleLegExposureEvent extends BaseEvent {
  constructor(
    public readonly positionId: PositionId,
    public readonly pairId: PairId,
    public readonly expectedEdge: number,
    public readonly filledLeg: {
      platform: PlatformId;
      orderId: OrderId;
      side: string;
      price: number;
      size: number;
      fillPrice: number;
      fillSize: number;
    },
    public readonly failedLeg: {
      platform: PlatformId;
      reason: string;
      reasonCode: number;
      attemptedPrice: number;
      attemptedSize: number;
    },
    public readonly currentPrices: {
      kalshi: { bestBid: number | null; bestAsk: number | null };
      polymarket: { bestBid: number | null; bestAsk: number | null };
    },
    public readonly pnlScenarios: {
      closeNowEstimate: string;
      retryAtCurrentPrice: string;
      holdRiskAssessment: string;
    },
    public readonly recommendedActions: string[],
    correlationId?: string,
    public readonly origin?: string,
    public readonly isPaper: boolean = false,
    public readonly mixedMode: boolean = false,
  ) {
    super(correlationId);
  }
}

export class ExitTriggeredEvent extends BaseEvent {
  constructor(
    public readonly positionId: PositionId,
    public readonly pairId: PairId,
    public readonly exitType:
      | 'take_profit'
      | 'stop_loss'
      | 'time_based'
      | 'manual'
      | 'edge_evaporation'
      | 'model_confidence'
      | 'time_decay'
      | 'risk_budget'
      | 'liquidity_deterioration'
      | 'profit_capture',
    public readonly initialEdge: string,
    public readonly finalEdge: string,
    public readonly realizedPnl: string,
    public readonly kalshiCloseOrderId: OrderId,
    public readonly polymarketCloseOrderId: OrderId,
    correlationId?: string,
    public readonly isPaper: boolean = false,
    public readonly mixedMode: boolean = false,
    public readonly chunksCompleted?: number,
    public readonly isPartial?: boolean,
  ) {
    super(correlationId);
  }
}

/** Emitted per-position in shadow mode with both fixed and model evaluation results (Story 10.2). */
export class ShadowComparisonEvent extends BaseEvent {
  constructor(
    public readonly positionId: PositionId,
    public readonly pairId: PairId,
    public readonly fixedResult: {
      triggered: boolean;
      type?: string;
      currentPnl: string;
    },
    public readonly modelResult: {
      triggered: boolean;
      type?: string;
      currentPnl: string;
      criteria: Array<{
        criterion: string;
        proximity: string;
        triggered: boolean;
        detail?: string;
      }>;
    },
    public readonly timestamp: Date,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}

/** Emitted once daily in shadow mode with aggregate comparison summary (Story 10.2). */
export class ShadowDailySummaryEvent extends BaseEvent {
  constructor(
    public readonly date: string,
    public readonly totalComparisons: number,
    public readonly fixedTriggerCount: number,
    public readonly modelTriggerCount: number,
    public readonly criterionTriggerCounts: Record<string, number>,
    public readonly cumulativePnlDelta: string,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}

/**
 * Partial SingleLegContext reconstructed from SingleLegExposureEvent for audit trail.
 * Fields `primaryOrder`, `enriched`, `opportunity` are always null — not available from event data.
 */
export interface PartialSingleLegContext {
  pairId: string;
  primaryLeg: string;
  primaryOrderId: string;
  primaryOrder: null;
  primarySide: string;
  secondarySide: string;
  primaryPrice: string;
  secondaryPrice: string;
  primarySize: number;
  secondarySize: number;
  enriched: null;
  opportunity: null;
  errorCode: number;
  errorMessage: string;
  isPaper: boolean;
  mixedMode: boolean;
}

/** [Story 10.3] Emitted when auto-unwind is attempted on a single-leg exposure. */
export class AutoUnwindEvent extends BaseEvent {
  constructor(
    public readonly positionId: PositionId,
    public readonly pairId: PairId,
    public readonly action:
      | 'close'
      | 'skip_loss_limit'
      | 'skip_already_resolved'
      | 'failed',
    public readonly result: 'success' | 'failed' | 'skipped',
    public readonly singleLegContext: PartialSingleLegContext,
    public readonly estimatedLossPct: number | null,
    public readonly realizedPnl: string | null,
    public readonly closeOrderId: string | null,
    public readonly timeElapsedMs: number,
    public readonly simulated: boolean,
    correlationId?: string,
    public readonly isPaper: boolean = false,
    public readonly mixedMode: boolean = false,
  ) {
    super(correlationId);
  }
}

export class ComplianceBlockedEvent extends BaseEvent {
  constructor(
    public readonly opportunityId: OpportunityId,
    public readonly pairId: PairId,
    public readonly violations: Array<{
      platform: string;
      category: string;
      rule: string;
    }>,
    correlationId?: string,
    public readonly isPaper: boolean = false,
    public readonly mixedMode: boolean = false,
  ) {
    super(correlationId);
  }
}

export class DepthCheckFailedEvent extends BaseEvent {
  constructor(
    public readonly platform: PlatformId,
    public readonly contractId: ContractId,
    public readonly side: 'buy' | 'sell',
    public readonly errorType: string,
    public readonly errorMessage: string,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}

export class SingleLegResolvedEvent extends BaseEvent {
  constructor(
    public readonly positionId: PositionId,
    public readonly pairId: PairId,
    public readonly resolutionType: 'retried' | 'closed',
    public readonly resolvedOrder: {
      orderId: OrderId;
      platform: PlatformId;
      status: string;
      filledPrice: number;
      filledQuantity: number;
    },
    public readonly originalEdge: number,
    public readonly newEdge: number | null,
    public readonly retryPrice: number | null,
    public readonly realizedPnl: string | null,
    correlationId?: string,
    public readonly isPaper: boolean = false,
    public readonly mixedMode: boolean = false,
  ) {
    super(correlationId);
  }
}
