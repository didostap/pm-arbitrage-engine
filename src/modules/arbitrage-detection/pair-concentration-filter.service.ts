import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Decimal from 'decimal.js';
import type {
  IPairConcentrationFilter,
  ConcentrationFilterResult,
} from '../../common/interfaces/pair-concentration-filter.interface';
import type { EnrichedOpportunity } from './types/enriched-opportunity.type';
import { PositionRepository } from '../../persistence/repositories/position.repository';
import { ConfigAccessor } from '../../common/config/config-accessor.service';
import { OpportunityFilteredEvent } from '../../common/events/detection.events';
import { EVENT_NAMES } from '../../common/events/event-catalog';
import {
  SystemHealthError,
  SYSTEM_HEALTH_ERROR_CODES,
} from '../../common/errors/system-health-error';

@Injectable()
export class PairConcentrationFilterService implements IPairConcentrationFilter {
  private readonly logger = new Logger(PairConcentrationFilterService.name);

  constructor(
    private readonly positionRepository: PositionRepository,
    private readonly configAccessor: ConfigAccessor,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async filterOpportunities(
    opportunities: EnrichedOpportunity[],
    isPaper: boolean,
  ): Promise<ConcentrationFilterResult> {
    if (opportunities.length === 0) {
      return { passed: [], filtered: [] };
    }

    const config = await this.configAccessor.get();
    const cooldownMinutes = config.pairCooldownMinutes;
    const maxConcurrent = config.pairMaxConcurrentPositions;
    const diversityThreshold = config.pairDiversityThreshold;

    let latestDates: Map<string, Date>;
    let openCounts: Map<string, number>;

    try {
      const pairIds = [
        ...new Set(
          opportunities.map((o) => o.dislocation.pairConfig.matchId ?? ''),
        ),
      ].filter(Boolean);

      // Both queries target the same isPaper partition. They are not wrapped in a
      // DB transaction because: (a) this filter is a quality gate, not a safety gate —
      // fail-open design means slight inconsistency is permissive, never restrictive;
      // (b) adding a transaction would increase hot-path latency for negligible gain.
      [latestDates, openCounts] = await Promise.all([
        this.positionRepository.getLatestPositionDateByPairIds(
          pairIds,
          isPaper,
        ),
        this.positionRepository.getActivePositionCountsByPair(isPaper),
      ]);
    } catch (error) {
      this.logger.warn({
        message: 'Concentration filter repository query failed — fail-open',
        data: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
      const healthError = new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.CONCENTRATION_FILTER_FAILURE,
        'Concentration filter repository query failed',
        'critical',
        'PairConcentrationFilterService',
      );
      this.eventEmitter.emit(EVENT_NAMES.SYSTEM_HEALTH_CRITICAL, healthError);
      return { passed: [...opportunities], filtered: [] };
    }

    // Compute diversity stats from DB snapshot
    const totalOpen = Array.from(openCounts.values()).reduce(
      (sum, c) => sum + c,
      0,
    );
    const uniquePairsCount = openCounts.size;
    const average = uniquePairsCount > 0 ? totalOpen / uniquePairsCount : 0;

    const passed: EnrichedOpportunity[] = [];
    const filtered: { opportunity: EnrichedOpportunity; reason: string }[] = [];

    // Cooldown uses wall-clock time. Granularity is minutes (default 30),
    // so sub-second NTP drift is irrelevant for this check.
    const now = Date.now();

    // Track in-batch virtual increments so two opportunities for the same pair
    // in one batch don't both slip past the concurrent limit (Finding #4).
    /** Cleanup: scoped to this method call — no persistent state */
    const batchIncrements = new Map<string, number>();

    for (const opportunity of opportunities) {
      const pairId = opportunity.dislocation.pairConfig.matchId ?? '';
      let reason: string | null = null;

      // 1. Cooldown check
      if (cooldownMinutes > 0) {
        const latestDate = latestDates.get(pairId);
        if (
          latestDate &&
          now - latestDate.getTime() < cooldownMinutes * 60_000
        ) {
          reason = 'pair_cooldown_active';
        }
      }

      // 2. Concurrent check (DB count + in-batch virtual increments)
      if (!reason && maxConcurrent > 0) {
        const dbCount = openCounts.get(pairId) ?? 0;
        const batchCount = batchIncrements.get(pairId) ?? 0;
        if (dbCount + batchCount >= maxConcurrent) {
          reason = 'pair_max_concurrent_reached';
        }
      }

      // 3. Diversity check — AC-3 specifies `pairCount >= average` (at-or-above).
      // This creates an intentional cliff: pairs at exactly the average are blocked
      // while those below pass. This is per-spec to redistribute toward under-represented pairs.
      if (
        !reason &&
        diversityThreshold > 0 &&
        totalOpen >= diversityThreshold
      ) {
        const pairCount = openCounts.get(pairId) ?? 0;
        if (pairCount >= average) {
          reason = 'pair_above_average_concentration';
        }
      }

      if (reason) {
        filtered.push({ opportunity, reason });
        this.emitFilteredEvent(
          opportunity,
          reason,
          cooldownMinutes,
          maxConcurrent,
          diversityThreshold,
        );
      } else {
        passed.push(opportunity);
        // Track virtual increment for in-batch concurrent awareness
        batchIncrements.set(pairId, (batchIncrements.get(pairId) ?? 0) + 1);
      }
    }

    return { passed, filtered };
  }

  private emitFilteredEvent(
    opportunity: EnrichedOpportunity,
    reason: string,
    cooldownMinutes: number,
    maxConcurrent: number,
    diversityThreshold: number,
  ): void {
    const pairConfig = opportunity.dislocation.pairConfig;
    // threshold field reuses OpportunityFilteredEvent.threshold as the configured
    // limit value (non-monetary: minutes/count). Downstream consumers distinguish
    // concentration vs edge filtering by the `reason` string prefix ("pair_*").
    const configValue =
      reason === 'pair_cooldown_active'
        ? cooldownMinutes
        : reason === 'pair_max_concurrent_reached'
          ? maxConcurrent
          : diversityThreshold;

    const event = new OpportunityFilteredEvent(
      pairConfig.eventDescription,
      opportunity.netEdge,
      new Decimal(configValue),
      reason,
      undefined,
      {
        matchId: pairConfig.matchId,
        annualizedReturn: opportunity.annualizedReturn?.toNumber() ?? null,
      },
    );
    this.eventEmitter.emit(
      EVENT_NAMES.OPPORTUNITY_CONCENTRATION_FILTERED,
      event,
    );
  }
}
