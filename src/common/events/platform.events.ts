import { PlatformId, PlatformHealth } from '../types/platform.type';
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
