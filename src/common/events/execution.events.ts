import { BaseEvent } from './base.event';
import { PlatformId } from '../types/platform.type';

export class OrderFilledEvent extends BaseEvent {
  constructor(
    public readonly orderId: string,
    public readonly platform: PlatformId,
    public readonly side: string,
    public readonly price: number,
    public readonly size: number,
    public readonly fillPrice: number,
    public readonly fillSize: number,
    public readonly positionId: string,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}

export class ExecutionFailedEvent extends BaseEvent {
  constructor(
    public readonly reasonCode: number,
    public readonly reason: string,
    public readonly opportunityId: string,
    public readonly context: Record<string, unknown>,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}

export class SingleLegExposureEvent extends BaseEvent {
  constructor(
    public readonly positionId: string,
    public readonly pairId: string,
    public readonly expectedEdge: number,
    public readonly filledLeg: {
      platform: PlatformId;
      orderId: string;
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
  ) {
    super(correlationId);
  }
}
