import { PlatformId, PlatformHealth } from '../types/platform.type';

/**
 * Event emitted when a platform transitions to degraded status.
 * Indicates staleness (>60s), high latency (>2s), or other issues.
 */
export class PlatformDegradedEvent {
  constructor(
    public readonly platformId: PlatformId,
    public readonly health: PlatformHealth,
    public readonly previousStatus: 'healthy' | 'degraded' | 'disconnected',
  ) {}
}

/**
 * Event emitted when a platform recovers from degraded status.
 * Indicates system health has been restored.
 */
export class PlatformRecoveredEvent {
  constructor(
    public readonly platformId: PlatformId,
    public readonly health: PlatformHealth,
    public readonly previousStatus: 'healthy' | 'degraded' | 'disconnected',
  ) {}
}

/**
 * Event emitted when a platform disconnects.
 * Indicates complete loss of connectivity.
 */
export class PlatformDisconnectedEvent {
  constructor(
    public readonly platformId: PlatformId,
    public readonly health: PlatformHealth,
  ) {}
}
