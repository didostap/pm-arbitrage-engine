import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../common/prisma.service.js';
import { EVENT_NAMES } from '../../common/events/event-catalog.js';
import type {
  OpportunityIdentifiedEvent,
  OpportunityFilteredEvent,
} from '../../common/events/detection.events.js';

/**
 * Fields extracted from OpportunityIdentifiedEvent.opportunity (Record<string, unknown>).
 * Local typed accessor — the event class uses a generic record for extensibility.
 */
interface MatchAprFields {
  matchId?: string | null;
  netEdge?: number | null;
  annualizedReturn?: number | null;
  enrichedAt?: Date | null;
}

/**
 * Persists APR and net-edge data from detection events onto contract_matches rows.
 *
 * Both handlers write lastNetEdge and lastAnnualizedReturn unconditionally —
 * either the freshly computed value or null. This prevents stale data from a
 * prior detection cycle persisting alongside fresh values from the current cycle.
 *
 * OpportunityFilteredEvent emission sites (edge-calculator.service.ts):
 *   - negative_edge / below_threshold (enrichDislocation ~L217): no annualizedReturn
 *   - no_resolution_date (checkCapitalEfficiency ~L309): no annualizedReturn
 *   - resolution_date_passed (checkCapitalEfficiency ~L346): no annualizedReturn
 *   - annualized_return_below_threshold (checkCapitalEfficiency ~L385): passes computed value
 */
@Injectable()
export class MatchAprUpdaterService {
  private readonly logger = new Logger(MatchAprUpdaterService.name);

  constructor(private readonly prisma: PrismaService) {}

  @OnEvent(EVENT_NAMES.OPPORTUNITY_IDENTIFIED)
  async handleOpportunityIdentified(
    event: OpportunityIdentifiedEvent,
  ): Promise<void> {
    const { matchId, netEdge, annualizedReturn, enrichedAt } =
      event.opportunity as MatchAprFields;
    if (!matchId) return;

    const data: Record<string, unknown> = {
      lastNetEdge: netEdge != null ? String(netEdge) : null,
      lastAnnualizedReturn:
        annualizedReturn != null ? String(annualizedReturn) : null,
      lastComputedAt: enrichedAt ?? new Date(),
    };

    try {
      await this.prisma.contractMatch.update({
        where: { matchId },
        data,
      });
    } catch (error) {
      this.logger.error({
        message: 'Failed to update match APR from identified event',
        matchId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  @OnEvent(EVENT_NAMES.OPPORTUNITY_FILTERED)
  async handleOpportunityFiltered(
    event: OpportunityFilteredEvent,
  ): Promise<void> {
    const matchId = event.matchId;
    if (!matchId) return;

    const data: Record<string, unknown> = {
      lastNetEdge: String(event.netEdge),
      lastAnnualizedReturn:
        event.annualizedReturn != null ? String(event.annualizedReturn) : null,
      lastComputedAt: new Date(),
    };

    try {
      await this.prisma.contractMatch.update({
        where: { matchId },
        data,
      });
    } catch (error) {
      this.logger.error({
        message: 'Failed to update match APR from filtered event',
        matchId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
