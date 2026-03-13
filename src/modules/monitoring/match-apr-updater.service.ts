import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../common/prisma.service.js';
import { EVENT_NAMES } from '../../common/events/event-catalog.js';
import type {
  OpportunityIdentifiedEvent,
  OpportunityFilteredEvent,
} from '../../common/events/detection.events.js';

@Injectable()
export class MatchAprUpdaterService {
  private readonly logger = new Logger(MatchAprUpdaterService.name);

  constructor(private readonly prisma: PrismaService) {}

  @OnEvent(EVENT_NAMES.OPPORTUNITY_IDENTIFIED)
  async handleOpportunityIdentified(
    event: OpportunityIdentifiedEvent,
  ): Promise<void> {
    const matchId = event.opportunity['matchId'] as string | null | undefined;
    if (!matchId) return;

    const netEdge = event.opportunity['netEdge'] as number | null | undefined;
    const annualizedReturn = event.opportunity['annualizedReturn'] as
      | number
      | null
      | undefined;
    const enrichedAt = event.opportunity['enrichedAt'] as
      | Date
      | null
      | undefined;

    const data: Record<string, unknown> = {};

    if (netEdge != null) {
      data['lastNetEdge'] = String(netEdge);
    }
    if (annualizedReturn != null) {
      data['lastAnnualizedReturn'] = String(annualizedReturn);
    }
    data['lastComputedAt'] = enrichedAt ?? new Date();

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
      lastComputedAt: new Date(),
    };

    // netEdge is a Decimal instance on OpportunityFilteredEvent
    if (event.netEdge != null) {
      data['lastNetEdge'] = event.netEdge.toString();
    }

    // Only set annualizedReturn if non-null — preserve previously-persisted value
    if (event.annualizedReturn != null) {
      data['lastAnnualizedReturn'] = String(event.annualizedReturn);
    }

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
