import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';

import type {
  IScoringStrategy,
  ScoringResult,
  ResolutionContext,
} from '../../common/interfaces/scoring-strategy.interface.js';
import { SCORING_STRATEGY_TOKEN } from '../../common/interfaces/scoring-strategy.interface.js';
import { PrismaService } from '../../common/prisma.service.js';
import {
  SystemHealthError,
  SYSTEM_HEALTH_ERROR_CODES,
} from '../../common/errors/system-health-error.js';
import { EVENT_NAMES } from '../../common/events/event-catalog.js';
import { MatchApprovedEvent } from '../../common/events/match-approved.event.js';
import { MatchAutoApprovedEvent } from '../../common/events/match-auto-approved.event.js';
import { MatchPendingReviewEvent } from '../../common/events/match-pending-review.event.js';
import { KnowledgeBaseService } from './knowledge-base.service.js';

@Injectable()
export class ConfidenceScorerService {
  private readonly logger = new Logger(ConfidenceScorerService.name);
  private readonly autoApproveThreshold: number;

  constructor(
    @Inject(SCORING_STRATEGY_TOKEN)
    private readonly scoringStrategy: IScoringStrategy,
    private readonly knowledgeBase: KnowledgeBaseService,
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
  ) {
    this.autoApproveThreshold = this.configService.get<number>(
      'LLM_AUTO_APPROVE_THRESHOLD',
      85,
    );
  }

  async scoreMatch(matchId: string): Promise<ScoringResult | undefined> {
    const match = await this.prisma.contractMatch.findUnique({
      where: { matchId },
    });

    if (!match) {
      throw new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.NOT_FOUND,
        `Contract match '${matchId}' not found`,
        'warning',
        'ConfidenceScorerService',
      );
    }

    // Guard: already approved → skip silently (idempotency)
    if (match.operatorApproved) {
      this.logger.log({
        message: 'Match already approved, skipping scoring',
        data: { matchId },
      });
      return undefined;
    }

    // Guard: missing descriptions → skip with warning
    if (!match.polymarketDescription || !match.kalshiDescription) {
      this.logger.warn({
        message: 'Cannot score match without descriptions',
        data: {
          matchId,
          hasPolyDescription: !!match.polymarketDescription,
          hasKalshiDescription: !!match.kalshiDescription,
        },
      });
      return undefined;
    }

    // Query resolution context for feedback integration (graceful degradation)
    let resolutionContext: ResolutionContext | undefined;
    try {
      resolutionContext = await this.knowledgeBase.getResolutionContext(
        undefined, // v1: no per-category filtering (ContractMatch has no category field)
      );
    } catch (error) {
      this.logger.warn({
        message:
          'Failed to fetch resolution context — scoring without feedback data',
        data: {
          matchId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }

    // Score via strategy
    const result = await this.scoringStrategy.scoreMatch(
      match.polymarketDescription,
      match.kalshiDescription,
      {
        resolutionDate: match.resolutionDate ?? undefined,
        resolutionContext,
      },
    );

    // Persist score
    await this.knowledgeBase.updateConfidenceScore(matchId, result.score);

    // Auto-approve or queue for review
    if (result.score >= this.autoApproveThreshold) {
      const rationale = `Auto-approved by confidence scorer (score: ${result.score}, model: ${result.model}, escalated: ${result.escalated})`;

      const updateResult = await this.prisma.contractMatch.updateMany({
        where: { matchId, operatorApproved: false },
        data: {
          operatorApproved: true,
          operatorRationale: rationale,
          operatorApprovalTimestamp: new Date(),
        },
      });

      // Only emit events if the update actually changed a row (race condition guard)
      if (updateResult.count === 0) {
        this.logger.log({
          message: 'Match was approved concurrently, skipping event emission',
          data: { matchId },
        });
        return result;
      }

      this.eventEmitter.emit(
        EVENT_NAMES.MATCH_APPROVED,
        new MatchApprovedEvent(
          matchId,
          match.polymarketContractId,
          match.kalshiContractId,
          rationale,
        ),
      );

      this.eventEmitter.emit(
        EVENT_NAMES.MATCH_AUTO_APPROVED,
        new MatchAutoApprovedEvent(
          matchId,
          result.score,
          result.model,
          result.escalated,
        ),
      );

      this.logger.log({
        message: 'Match auto-approved',
        data: {
          matchId,
          score: result.score,
          model: result.model,
          escalated: result.escalated,
        },
      });
    } else {
      this.eventEmitter.emit(
        EVENT_NAMES.MATCH_PENDING_REVIEW,
        new MatchPendingReviewEvent(
          matchId,
          result.score,
          result.model,
          result.escalated,
        ),
      );

      this.logger.log({
        message: 'Match queued for operator review',
        data: { matchId, score: result.score },
      });
    }

    return result;
  }
}
