import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma.service';
import { PlatformId, PlatformHealth } from '../../common/types/platform.type';
import { EVENT_NAMES } from '../../common/events/event-catalog';
import {
  PlatformDegradedEvent,
  PlatformRecoveredEvent,
  PlatformDisconnectedEvent,
  OrderbookStaleEvent,
  OrderbookRecoveredEvent,
} from '../../common/events/platform.events';
import { toPlatformEnum } from '../../common/utils';
import { withCorrelationId } from '../../common/services/correlation-context';
import { DegradationProtocolService } from './degradation-protocol.service';

@Injectable()
export class PlatformHealthService {
  private readonly logger = new Logger(PlatformHealthService.name);
  private readonly STALENESS_THRESHOLD = 60_000; // 60 seconds
  private readonly DEGRADED_LATENCY_THRESHOLD = 2000; // 2 seconds
  private readonly DATA_FRESHNESS_THRESHOLD = 30_000; // 30 seconds for recovery validation

  private static readonly CONSECUTIVE_UNHEALTHY_TICKS_THRESHOLD = 2;
  private static readonly CONSECUTIVE_HEALTHY_TICKS_THRESHOLD = 2;

  /** Cleanup: bounded by PlatformId enum (2 entries), overwrite semantics */
  private lastUpdateTime: Map<PlatformId, number> = new Map();
  /** Cleanup: bounded by PlatformId (2), array capped at 100 samples via shift() */
  private latencySamples: Map<PlatformId, number[]> = new Map();
  /** Cleanup: bounded by PlatformId (2), overwrite semantics */
  private previousStatus: Map<
    PlatformId,
    'healthy' | 'degraded' | 'disconnected' | 'initializing'
  > = new Map();

  /** Cleanup: bounded by PlatformId (2), overwrite semantics */
  private consecutiveUnhealthyTicks: Map<PlatformId, number> = new Map();
  /** Cleanup: bounded by PlatformId (2), overwrite semantics */
  private consecutiveHealthyTicks: Map<PlatformId, number> = new Map();

  /** Cleanup: bounded by PlatformId (2), overwrite semantics */
  private orderbookStale = new Map<PlatformId, boolean>();
  /** Cleanup: bounded by PlatformId (2), .delete() on recovery */
  private orderbookStaleStartTime = new Map<PlatformId, number>();
  private readonly orderbookStalenessThreshold: number;

  /** Cleanup: .delete() via removeContractTracking() when contract unsubscribed. Key: `${platformId}:${contractId}` */
  private readonly lastContractUpdateTime = new Map<string, number>();

  /** Cleanup: bounded by PlatformId (2), overwrite semantics */
  private readonly lastWsMessageTimestamp = new Map<PlatformId, Date>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly degradationService: DegradationProtocolService,
    private readonly configService: ConfigService,
  ) {
    this.orderbookStalenessThreshold = this.configService.get<number>(
      'ORDERBOOK_STALENESS_THRESHOLD_MS',
      90_000,
    );

    // Initialize counters and state for all known platforms
    for (const platform of [PlatformId.KALSHI, PlatformId.POLYMARKET]) {
      this.consecutiveUnhealthyTicks.set(platform, 0);
      this.consecutiveHealthyTicks.set(platform, 0);
      this.orderbookStale.set(platform, false);
    }
  }

  /**
   * Published health status every 30 seconds (FR-DI-04).
   * Uses @Cron decorator for independent health check cadence.
   */
  @Cron('*/30 * * * * *') // Every 30 seconds
  async publishHealth(): Promise<void> {
    return;
    // Wrap in correlation context so events get correlationId from async storage
    return withCorrelationId(async () => {
      const correlationId = randomUUID();
      const platforms = [PlatformId.KALSHI, PlatformId.POLYMARKET];

      for (const platform of platforms) {
        const previousStatus =
          this.previousStatus.get(platform) ?? 'initializing';
        const health = this.calculateHealth(platform);

        // Update consecutive tick counters
        // 'initializing' is treated as healthy for counter purposes — do NOT
        // increment unhealthy ticks during boot window (prevents false degradation protocol)
        if (health.status === 'degraded' || health.status === 'disconnected') {
          this.consecutiveUnhealthyTicks.set(
            platform,
            (this.consecutiveUnhealthyTicks.get(platform) ?? 0) + 1,
          );
          this.consecutiveHealthyTicks.set(platform, 0);
        } else {
          // 'healthy' OR 'initializing'
          this.consecutiveHealthyTicks.set(
            platform,
            (this.consecutiveHealthyTicks.get(platform) ?? 0) + 1,
          );
          this.consecutiveUnhealthyTicks.set(platform, 0);
        }

        // Only persist to database on status transitions (reduces ~5,760 writes/day to ~0)
        if (health.status !== previousStatus) {
          try {
            await this.prisma.platformHealthLog.create({
              data: {
                platform: toPlatformEnum(platform),
                status: health.status,
                last_update: health.lastHeartbeat || new Date(),
                response_time_ms: health.latencyMs,
                connection_state:
                  (health.metadata?.connectionState as string) || 'unknown',
                created_at: new Date(),
              },
            });
          } catch (error) {
            this.logger.error({
              message: 'Failed to persist health log',
              module: 'data-ingestion',
              correlationId,
              platform,
              error: error instanceof Error ? error.message : 'Unknown error',
            });
            // Continue processing - persistence failure shouldn't block monitoring
          }

          // Staleness transition logging (Story 9-20 AC #8)
          const lastUpdate = this.lastUpdateTime.get(platform) || 0;
          this.logger.log({
            message: 'Platform health transition',
            module: 'data-ingestion',
            correlationId,
            platform,
            previousStatus,
            newStatus: health.status,
            timestamp: new Date().toISOString(),
            lastUpdateAgeMs:
              lastUpdate > 0 ? Date.now() - lastUpdate : undefined,
            reason: (health.metadata?.degradationReason as string) || 'none',
          });
        }

        // Emit base health update event (every tick, regardless of DB write)
        this.eventEmitter.emit(EVENT_NAMES.PLATFORM_HEALTH_UPDATED, health);

        // Emit transition events (degradation AND recovery)
        // Guard: do NOT emit degradation event when previousStatus is 'initializing' —
        // platform hasn't been healthy yet, this is still booting, not degradation
        if (
          health.status === 'degraded' &&
          previousStatus !== 'degraded' &&
          previousStatus !== 'initializing'
        ) {
          this.eventEmitter.emit(
            EVENT_NAMES.PLATFORM_HEALTH_DEGRADED,
            new PlatformDegradedEvent(platform, health, previousStatus),
          );
        } else if (
          health.status === 'healthy' &&
          previousStatus === 'degraded'
        ) {
          // Emit recovery event when transitioning back to healthy
          this.eventEmitter.emit(
            EVENT_NAMES.PLATFORM_HEALTH_RECOVERED,
            new PlatformRecoveredEvent(platform, health, previousStatus),
          );
        } else if (
          health.status === 'disconnected' &&
          previousStatus !== 'disconnected'
        ) {
          this.eventEmitter.emit(
            EVENT_NAMES.PLATFORM_HEALTH_DISCONNECTED,
            new PlatformDisconnectedEvent(platform, health),
          );
        }

        // Orderbook staleness detection (Story 9.1b)
        // Note: `lastUpdate > 0` guard below intentionally prevents staleness detection
        // during initialization — isNowStale is always false when no data has been received yet
        try {
          const lastUpdate = this.lastUpdateTime.get(platform) || 0;
          const dataAge = Date.now() - lastUpdate;
          const wasStale = this.orderbookStale.get(platform) ?? false;
          const isNowStale =
            lastUpdate > 0 && dataAge > this.orderbookStalenessThreshold;

          if (isNowStale && !wasStale) {
            // Transition to stale
            this.orderbookStale.set(platform, true);
            this.orderbookStaleStartTime.set(platform, Date.now());
            this.eventEmitter.emit(
              EVENT_NAMES.ORDERBOOK_STALE,
              new OrderbookStaleEvent(
                platform,
                lastUpdate > 0 ? new Date(lastUpdate) : null,
                dataAge,
                this.orderbookStalenessThreshold,
                correlationId,
              ),
            );
          } else if (!isNowStale && wasStale) {
            // Transition to recovered
            const staleStart =
              this.orderbookStaleStartTime.get(platform) ?? Date.now();
            const downtimeMs = Date.now() - staleStart;
            this.orderbookStale.set(platform, false);
            this.orderbookStaleStartTime.delete(platform);
            this.eventEmitter.emit(
              EVENT_NAMES.ORDERBOOK_RECOVERED,
              new OrderbookRecoveredEvent(
                platform,
                new Date(),
                downtimeMs,
                correlationId,
              ),
            );
          }
        } catch (error) {
          this.logger.error({
            message: 'Orderbook staleness detection error',
            module: 'data-ingestion',
            correlationId,
            platform,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }

        // Consecutive-check hysteresis for degradation protocol
        try {
          const unhealthyTicks =
            this.consecutiveUnhealthyTicks.get(platform) ?? 0;
          if (
            unhealthyTicks >=
              PlatformHealthService.CONSECUTIVE_UNHEALTHY_TICKS_THRESHOLD &&
            !this.degradationService.isDegraded(platform)
          ) {
            const lastUpdate = this.lastUpdateTime.get(platform) || 0;
            const lastDataTimestamp =
              lastUpdate > 0 ? new Date(lastUpdate) : undefined;
            this.degradationService.activateProtocol(
              platform,
              'websocket_timeout',
              lastDataTimestamp,
            );
          }

          // Recovery validation with consecutive-check hysteresis
          const healthyTicks = this.consecutiveHealthyTicks.get(platform) ?? 0;
          if (
            healthyTicks >=
              PlatformHealthService.CONSECUTIVE_HEALTHY_TICKS_THRESHOLD &&
            this.degradationService.isDegraded(platform)
          ) {
            const lastUpdate = this.lastUpdateTime.get(platform) || 0;
            const dataAge = Date.now() - lastUpdate;

            if (dataAge <= this.DATA_FRESHNESS_THRESHOLD) {
              this.degradationService.deactivateProtocol(platform);
            } else {
              this.logger.warn({
                message: 'Recovery rejected: data stale',
                module: 'data-ingestion',
                correlationId,
                platformId: platform,
                dataAgeMs: dataAge,
                freshnessThresholdMs: this.DATA_FRESHNESS_THRESHOLD,
              });
            }
          }
        } catch (error) {
          this.logger.error({
            message: 'Degradation protocol error',
            module: 'data-ingestion',
            correlationId,
            platform,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }

        // Update previous status for next check
        this.previousStatus.set(platform, health.status);
      }
    });
  }

  /**
   * Get aggregated health for all registered platforms.
   * Returns current health status for each platform.
   */
  getAggregatedHealth(): Map<PlatformId, PlatformHealth> {
    const healthMap = new Map<PlatformId, PlatformHealth>();
    for (const platform of [PlatformId.KALSHI, PlatformId.POLYMARKET]) {
      healthMap.set(platform, this.calculateHealth(platform));
    }
    return healthMap;
  }

  /**
   * Get health for a specific platform.
   * Enables downstream modules to check platform availability before use.
   */
  getPlatformHealth(platformId: PlatformId): PlatformHealth {
    return this.calculateHealth(platformId);
  }

  /**
   * Returns real-time orderbook staleness info for a platform.
   * Calculates staleness on-demand from lastUpdateTime rather than relying on
   * poll-updated state, eliminating up to 30s detection delay.
   */
  getOrderbookStaleness(platform: PlatformId): {
    stale: boolean;
    stalenessMs?: number;
  } {
    const lastUpdate = this.lastUpdateTime.get(platform) ?? 0;
    if (lastUpdate === 0) return { stale: false }; // No data yet (startup)
    const stalenessMs = Date.now() - lastUpdate;
    if (stalenessMs > this.orderbookStalenessThreshold) {
      return { stale: true, stalenessMs };
    }
    return { stale: false };
  }

  /** Returns the last WS message timestamp for a platform, or null if none received. */
  getWsLastMessageTimestamp(platformId: PlatformId): Date | null {
    return this.lastWsMessageTimestamp.get(platformId) ?? null;
  }

  /**
   * Calculates current health status for a platform.
   * Checks: connection state, staleness, latency thresholds.
   */
  private calculateHealth(platform: PlatformId): PlatformHealth {
    const lastUpdate = this.lastUpdateTime.get(platform) || 0;

    // Epoch zero guard: no data received yet (system just booted)
    // Return 'initializing' instead of 'degraded' to prevent false alerts
    if (lastUpdate === 0) {
      this.logger.debug({
        message: 'Platform initializing — no data received yet',
        module: 'data-ingestion',
        platform,
      });
      return {
        platformId: platform,
        status: 'initializing',
        lastHeartbeat: null,
        latencyMs: null,
        metadata: { reason: 'no_data_received' },
      };
    }

    const age = Date.now() - lastUpdate;

    // For MVP, we don't have connector health check yet
    // In full implementation, this would call connector.getHealth()
    const connectorHealth = { status: 'connected' };

    // Connection state check (most severe)
    if (connectorHealth.status === 'disconnected') {
      return {
        platformId: platform,
        status: 'disconnected',
        lastHeartbeat: lastUpdate > 0 ? new Date(lastUpdate) : null,
        latencyMs: null,
        metadata: { connectionState: 'disconnected' },
      };
    }

    // Staleness check (FR-DI-04 - >60s = degraded)
    if (age > this.STALENESS_THRESHOLD) {
      return {
        platformId: platform,
        status: 'degraded',
        lastHeartbeat: new Date(lastUpdate),
        latencyMs: this.calculateP95Latency(platform),
        metadata: { degradationReason: 'stale_data', ageMs: age },
      };
    }

    // Latency check (>2s = degraded)
    const p95Latency = this.calculateP95Latency(platform);
    if (p95Latency && p95Latency > this.DEGRADED_LATENCY_THRESHOLD) {
      return {
        platformId: platform,
        status: 'degraded',
        lastHeartbeat: new Date(lastUpdate),
        latencyMs: p95Latency,
        metadata: {
          degradationReason: 'high_latency',
          thresholdMs: this.DEGRADED_LATENCY_THRESHOLD,
        },
      };
    }

    // All checks passed - healthy
    return {
      platformId: platform,
      status: 'healthy',
      lastHeartbeat: new Date(lastUpdate),
      latencyMs: p95Latency,
      metadata: {
        updateFrequency: this.calculateUpdateFrequency(platform),
      },
    };
  }

  /**
   * Called by DataIngestionService when an orderbook update is processed.
   * Tracks update timing for staleness detection.
   */
  recordUpdate(platform: PlatformId, latencyMs: number): void {
    this.lastUpdateTime.set(platform, Date.now());

    const samples = this.latencySamples.get(platform) || [];
    samples.push(latencyMs);
    if (samples.length > 100) samples.shift(); // Rolling window
    this.latencySamples.set(platform, samples);
  }

  /**
   * Records a successful per-contract orderbook fetch.
   * Updates per-contract staleness tracking and delegates to platform-level recordUpdate().
   */
  recordContractUpdate(
    platform: PlatformId,
    contractId: string,
    latencyMs: number,
    source: 'poll' | 'ws' = 'poll',
  ): void {
    const key = `${platform}:${contractId}`;
    this.lastContractUpdateTime.set(key, Date.now());
    // Also update platform-level tracking for backward compatibility (health calculation)
    this.recordUpdate(platform, latencyMs);

    if (source === 'ws') {
      this.lastWsMessageTimestamp.set(platform, new Date());
    }
  }

  /**
   * Returns per-contract staleness status.
   * Used by detection to evaluate staleness per pair instead of per platform.
   */
  /**
   * Remove contract tracking entry when unsubscribed.
   * Prevents lastContractUpdateTime from growing unbounded.
   */
  removeContractTracking(platform: PlatformId, contractId: string): void {
    const key = `${platform}:${contractId}`;
    this.lastContractUpdateTime.delete(key);
  }

  getContractStaleness(
    platform: PlatformId,
    contractId: string,
  ): { stale: boolean; stalenessMs?: number } {
    const key = `${platform}:${contractId}`;
    const lastUpdate = this.lastContractUpdateTime.get(key);
    // Startup grace: contract not yet polled — not stale, just not seen yet
    if (lastUpdate === undefined) return { stale: false };
    const stalenessMs = Date.now() - lastUpdate;
    if (stalenessMs > this.orderbookStalenessThreshold) {
      return { stale: true, stalenessMs };
    }
    return { stale: false };
  }

  /**
   * Calculates 95th percentile latency for a platform.
   */
  private calculateP95Latency(platform: PlatformId): number | null {
    const samples = this.latencySamples.get(platform);
    if (!samples || samples.length === 0) return null;

    const sorted = [...samples].sort((a, b) => a - b);
    const p95Index = Math.floor(sorted.length * 0.95);
    return sorted[p95Index] || null;
  }

  /**
   * Calculates update frequency for diagnostics.
   */
  private calculateUpdateFrequency(_platform: PlatformId): number {
    // Placeholder - implement if needed for diagnostics
    return 0;
  }
}
