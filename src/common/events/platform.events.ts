import { PlatformId, PlatformHealth } from '../types/platform.type';
import type { ContractId, PairId, PositionId } from '../types/branded.type';
import { BaseEvent } from './base.event';

/**
 * Event emitted when a platform transitions to degraded status.
 * Indicates staleness (>60s), high latency (>2s), or other issues.
 */
export class PlatformDegradedEvent extends BaseEvent {
  constructor(
    public readonly platformId: PlatformId,
    public readonly health: PlatformHealth,
    public readonly previousStatus: 'healthy' | 'degraded' | 'disconnected',
    correlationId?: string, // Optional - backward compatible
  ) {
    super(correlationId);
  }
}

/**
 * Event emitted when a platform recovers from degraded status.
 * Indicates system health has been restored.
 */
export class PlatformRecoveredEvent extends BaseEvent {
  constructor(
    public readonly platformId: PlatformId,
    public readonly health: PlatformHealth,
    public readonly previousStatus: 'healthy' | 'degraded' | 'disconnected',
    correlationId?: string, // Optional
  ) {
    super(correlationId);
  }
}

/**
 * Event emitted when a platform disconnects.
 * Indicates complete loss of connectivity.
 */
export class PlatformDisconnectedEvent extends BaseEvent {
  constructor(
    public readonly platformId: PlatformId,
    public readonly health: PlatformHealth,
    correlationId?: string, // Optional
  ) {
    super(correlationId);
  }
}

/**
 * Event emitted when degradation protocol is activated for a platform.
 * Downstream modules (execution, detection) subscribe to this event.
 */
export class DegradationProtocolActivatedEvent extends BaseEvent {
  constructor(
    public readonly platformId: PlatformId,
    public readonly reason: string,
    public readonly lastDataTimestamp: Date | null,
    public readonly activatedAt: Date,
    public readonly healthyPlatforms: PlatformId[],
    correlationId?: string,
  ) {
    super(correlationId);
  }
}

/**
 * Event emitted when degradation protocol is deactivated (platform recovered).
 */
export class DegradationProtocolDeactivatedEvent extends BaseEvent {
  constructor(
    public readonly platformId: PlatformId,
    public readonly outageDurationMs: number,
    public readonly recoveredAt: Date,
    public readonly impactSummary: {
      pollingCycleCount: number;
      reason: string;
    },
    correlationId?: string,
  ) {
    super(correlationId);
  }
}

/**
 * Event emitted when WebSocket order book data is detected as stale (>30s).
 * [Story 6.5.0a] Data staleness monitoring
 */
export class DataStaleEvent extends BaseEvent {
  constructor(
    public readonly platformId: PlatformId,
    public readonly tokenId: string,
    public readonly stalenessMs: number,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}

/**
 * Event emitted when platform orderbook data exceeds staleness threshold.
 * [Story 9.1b] Orderbook staleness detection
 */
export class OrderbookStaleEvent extends BaseEvent {
  constructor(
    public readonly platformId: PlatformId,
    public readonly lastUpdateTimestamp: Date | null,
    public readonly stalenessMs: number,
    public readonly thresholdMs: number,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}

/**
 * Event emitted when platform orderbook data resumes after staleness.
 * [Story 9.1b] Orderbook staleness recovery
 */
export class OrderbookRecoveredEvent extends BaseEvent {
  constructor(
    public readonly platformId: PlatformId,
    public readonly recoveryTimestamp: Date,
    public readonly downtimeMs: number,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}

/**
 * Event emitted when gas estimate changes significantly (>10% delta).
 * [Story 6.0] Gas Estimation
 */
export class PlatformGasUpdatedEvent extends BaseEvent {
  constructor(
    public readonly previousEstimateUsd: string,
    public readonly newEstimateUsd: string,
    public readonly changePercent: string,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}

/**
 * Event emitted when poll and WebSocket data diverge beyond threshold.
 * [Story 10-0-1] Data path divergence monitoring
 */
export class DataDivergenceEvent extends BaseEvent {
  constructor(
    public readonly platformId: PlatformId,
    public readonly contractId: ContractId,
    public readonly pollBestBid: string,
    public readonly pollBestAsk: string,
    public readonly pollTimestamp: string,
    public readonly wsBestBid: string,
    public readonly wsBestAsk: string,
    public readonly wsTimestamp: string,
    public readonly priceDelta: string,
    public readonly stalenessDeltaMs: number,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}

/**
 * Event emitted when exit monitor falls back to polling data due to stale WS.
 * Deduplicated: emitted once per position per stale period (not every cycle).
 * [Story 10.1] Data source tracking
 */
export class PlatformDataFallbackEvent extends BaseEvent {
  constructor(
    public readonly positionId: PositionId,
    public readonly pairId: PairId,
    public readonly platformId: string,
    public readonly staleDurationMs: number,
    public readonly fallbackSource: 'polling',
    correlationId?: string,
  ) {
    super(correlationId);
  }
}
