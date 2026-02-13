import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../common/prisma.service';
import { PlatformId, PlatformHealth } from '../../common/types/platform.type';
import {
  PlatformDegradedEvent,
  PlatformRecoveredEvent,
  PlatformDisconnectedEvent,
} from '../../common/events/platform.events';

@Injectable()
export class PlatformHealthService {
  private readonly logger = new Logger(PlatformHealthService.name);
  private readonly STALENESS_THRESHOLD = 60_000; // 60 seconds
  private readonly DEGRADED_LATENCY_THRESHOLD = 2000; // 2 seconds

  private lastUpdateTime: Map<PlatformId, number> = new Map();
  private latencySamples: Map<PlatformId, number[]> = new Map();
  private previousStatus: Map<
    PlatformId,
    'healthy' | 'degraded' | 'disconnected'
  > = new Map();

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Published health status every 30 seconds (FR-DI-04).
   * Uses @Cron decorator for independent health check cadence.
   */
  @Cron('*/30 * * * * *') // Every 30 seconds
  async publishHealth(): Promise<void> {
    const platforms = [PlatformId.KALSHI]; // Expand in Epic 2

    for (const platform of platforms) {
      const previousStatus = this.previousStatus.get(platform) || 'healthy';
      const health = this.calculateHealth(platform);

      // Persist to database (AWAIT to handle errors - not fire-and-forget)
      try {
        await this.prisma.platformHealthLog.create({
          data: {
            platform: platform, // string enum value
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
          platform,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        // Continue processing - persistence failure shouldn't block monitoring
      }

      // Emit base health update event
      this.eventEmitter.emit('platform.health.updated', health);

      // Emit transition events (degradation AND recovery)
      if (health.status === 'degraded' && previousStatus !== 'degraded') {
        this.eventEmitter.emit(
          'platform.health.degraded',
          new PlatformDegradedEvent(platform, health, previousStatus),
        );
      } else if (health.status === 'healthy' && previousStatus === 'degraded') {
        // Emit recovery event when transitioning back to healthy
        this.eventEmitter.emit(
          'platform.health.recovered',
          new PlatformRecoveredEvent(platform, health, previousStatus),
        );
      } else if (
        health.status === 'disconnected' &&
        previousStatus !== 'disconnected'
      ) {
        this.eventEmitter.emit(
          'platform.health.disconnected',
          new PlatformDisconnectedEvent(platform, health),
        );
      }

      // Update previous status for next check
      this.previousStatus.set(platform, health.status);
    }
  }

  /**
   * Calculates current health status for a platform.
   * Checks: connection state, staleness, latency thresholds.
   */
  private calculateHealth(platform: PlatformId): PlatformHealth {
    const lastUpdate = this.lastUpdateTime.get(platform) || 0;
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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private calculateUpdateFrequency(_platform: PlatformId): number {
    // Placeholder - implement if needed for diagnostics
    return 0;
  }
}
