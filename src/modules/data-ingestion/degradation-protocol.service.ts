import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { EVENT_NAMES } from '../../common/events/event-catalog.js';
import {
  DegradationProtocolActivatedEvent,
  DegradationProtocolDeactivatedEvent,
} from '../../common/events/platform.events.js';
import { PlatformId } from '../../common/types/platform.type.js';

export interface DegradationState {
  degradedAt: Date;
  reason: string;
  pollingCycleCount: number;
}

@Injectable()
export class DegradationProtocolService {
  private readonly logger = new Logger(DegradationProtocolService.name);
  private readonly degradedPlatforms = new Map<PlatformId, DegradationState>();
  private readonly thresholdMultiplier: number;
  private readonly allPlatforms: PlatformId[] = Object.values(PlatformId);

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
  ) {
    this.thresholdMultiplier = this.configService.get<number>(
      'DEGRADATION_THRESHOLD_MULTIPLIER',
      1.5,
    );
  }

  /**
   * Activates degradation protocol for a platform.
   * Idempotent — calling again for an already-degraded platform is a no-op.
   */
  activateProtocol(
    platformId: PlatformId,
    reason: string,
    lastDataTimestamp?: Date,
  ): void {
    if (this.degradedPlatforms.has(platformId)) {
      this.logger.warn({
        message:
          'Degradation protocol already active, ignoring duplicate activation',
        module: 'data-ingestion',
        platformId,
        reason,
      });
      return;
    }

    const activatedAt = new Date();
    this.degradedPlatforms.set(platformId, {
      degradedAt: activatedAt,
      reason,
      pollingCycleCount: 0,
    });

    const healthyPlatforms = this.allPlatforms.filter(
      (p) => !this.degradedPlatforms.has(p),
    );

    this.eventEmitter.emit(
      EVENT_NAMES.DEGRADATION_PROTOCOL_ACTIVATED,
      new DegradationProtocolActivatedEvent(
        platformId,
        reason,
        lastDataTimestamp ?? null,
        activatedAt,
        healthyPlatforms,
      ),
    );

    this.logger.warn({
      message: 'Degradation protocol activated',
      module: 'data-ingestion',
      platformId,
      reason,
      healthyPlatforms,
      thresholdMultiplier: this.thresholdMultiplier,
    });
  }

  /**
   * Deactivates degradation protocol for a platform (recovery).
   * Logs outage duration and impact summary.
   */
  deactivateProtocol(platformId: PlatformId): void {
    const state = this.degradedPlatforms.get(platformId);
    if (!state) {
      this.logger.warn({
        message: 'Attempted to deactivate protocol for non-degraded platform',
        module: 'data-ingestion',
        platformId,
      });
      return;
    }

    const recoveredAt = new Date();
    const outageDurationMs = recoveredAt.getTime() - state.degradedAt.getTime();

    this.degradedPlatforms.delete(platformId);

    const impactSummary = {
      pollingCycleCount: state.pollingCycleCount,
      reason: state.reason,
    };

    this.eventEmitter.emit(
      EVENT_NAMES.DEGRADATION_PROTOCOL_DEACTIVATED,
      new DegradationProtocolDeactivatedEvent(
        platformId,
        outageDurationMs,
        recoveredAt,
        impactSummary,
      ),
    );

    this.logger.log({
      message: 'Degradation protocol deactivated — platform recovered',
      module: 'data-ingestion',
      platformId,
      outageDurationMs,
      pollingCycleCount: state.pollingCycleCount,
      reason: state.reason,
    });
  }

  /**
   * Returns the edge threshold multiplier for a given platform.
   *
   * - If `platformId` is degraded: returns 1.0 (its data is unreliable, don't use it for detection)
   * - If `platformId` is healthy but ANY other platform is degraded: returns the configured
   *   widening multiplier (default 1.5) per NFR-R2 — widen thresholds on remaining healthy platforms
   * - If ALL platforms are healthy: returns 1.0 (normal thresholds)
   *
   * Epic 3's detection service multiplies its minimum edge threshold by this value:
   *   effectiveThreshold = baseThreshold * getEdgeThresholdMultiplier(platformId)
   */
  getEdgeThresholdMultiplier(platformId: PlatformId): number {
    if (this.degradedPlatforms.has(platformId)) return 1.0;
    if (this.degradedPlatforms.size > 0) return this.thresholdMultiplier;
    return 1.0;
  }

  /**
   * Check if a platform is currently in degradation protocol.
   */
  isDegraded(platformId: PlatformId): boolean {
    return this.degradedPlatforms.has(platformId);
  }

  /**
   * Get degradation details for a platform, or null if not degraded.
   */
  getDegradationState(platformId: PlatformId): DegradationState | null {
    return this.degradedPlatforms.get(platformId) ?? null;
  }

  /**
   * Increments the polling cycle counter for outage impact tracking.
   */
  incrementPollingCycle(platformId: PlatformId): void {
    const state = this.degradedPlatforms.get(platformId);
    if (state) {
      state.pollingCycleCount++;
    }
  }
}
