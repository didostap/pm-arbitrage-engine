import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CronJob } from 'cron';
import { CatalogSyncService } from './catalog-sync.service.js';
import { PreFilterService } from './pre-filter.service.js';
import { SCORING_STRATEGY_TOKEN } from '../../common/interfaces/scoring-strategy.interface.js';
import type { IScoringStrategy } from '../../common/interfaces/scoring-strategy.interface.js';
import type { ContractSummary } from '../../common/interfaces/contract-catalog-provider.interface.js';
import type { FilterCandidate } from './pre-filter.service.js';
import { PlatformId } from '../../common/types/platform.type.js';
import { PrismaService } from '../../common/prisma.service.js';
import { EVENT_NAMES } from '../../common/events/event-catalog.js';
import { DiscoveryRunCompletedEvent } from '../../common/events/discovery-run-completed.event.js';
import { MatchApprovedEvent } from '../../common/events/match-approved.event.js';
import { MatchAutoApprovedEvent } from '../../common/events/match-auto-approved.event.js';
import { MatchPendingReviewEvent } from '../../common/events/match-pending-review.event.js';
import { LlmScoringError } from '../../common/errors/llm-scoring-error.js';
import { withCorrelationId } from '../../common/services/correlation-context.js';

interface DiscoveryStats {
  catalogsFetched: number;
  candidatesPreFiltered: number;
  pairsScored: number;
  autoApproved: number;
  pendingReview: number;
  scoringFailures: number;
}

function isWithinSettlementWindow(
  dateA?: Date,
  dateB?: Date,
  windowDays = 7,
): boolean {
  if (!dateA || !dateB) return true;
  const diffMs = Math.abs(dateA.getTime() - dateB.getTime());
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return diffDays <= windowDays;
}

@Injectable()
export class CandidateDiscoveryService implements OnModuleInit {
  private readonly logger = new Logger(CandidateDiscoveryService.name);
  private readonly autoApproveThreshold: number;
  private readonly preFilterThreshold: number;
  private readonly settlementWindowDays: number;
  private readonly maxCandidatesPerContract: number;

  constructor(
    private readonly catalogSync: CatalogSyncService,
    private readonly preFilter: PreFilterService,
    @Inject(SCORING_STRATEGY_TOKEN)
    private readonly scoringStrategy: IScoringStrategy,
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {
    this.autoApproveThreshold = Number(
      this.configService.get<number>('LLM_AUTO_APPROVE_THRESHOLD', 85),
    );
    this.preFilterThreshold = Number(
      this.configService.get<number>('DISCOVERY_PREFILTER_THRESHOLD', 0.15),
    );
    this.settlementWindowDays = Number(
      this.configService.get<number>('DISCOVERY_SETTLEMENT_WINDOW_DAYS', 7),
    );
    this.maxCandidatesPerContract = Number(
      this.configService.get<number>(
        'DISCOVERY_MAX_CANDIDATES_PER_CONTRACT',
        20,
      ),
    );
  }

  onModuleInit(): void {
    const enabled = this.configService.get<string>(
      'DISCOVERY_ENABLED',
      'false',
    );
    if (enabled !== 'true') {
      this.logger.log({ message: 'Discovery pipeline disabled' });
      return;
    }
    const cronExpr = this.configService.get<string>(
      'DISCOVERY_CRON_EXPRESSION',
      '0 0 8,20 * * *',
    );
    const job = new CronJob(cronExpr, () => {
      void this.runDiscovery();
    });
    this.schedulerRegistry.addCronJob('candidate-discovery', job);
    job.start();
    this.logger.log({
      message: 'Discovery pipeline enabled',
      data: { cron: cronExpr },
    });

    const runOnStartup = this.configService.get<string>(
      'DISCOVERY_RUN_ON_STARTUP',
      'false',
    );
    if (runOnStartup === 'true') {
      setTimeout(() => {
        void this.runDiscovery();
      }, 3000);
    }
  }

  async runDiscovery(): Promise<void> {
    await withCorrelationId(async () => {
      const startTime = Date.now();
      const stats: DiscoveryStats = {
        catalogsFetched: 0,
        candidatesPreFiltered: 0,
        pairsScored: 0,
        autoApproved: 0,
        pendingReview: 0,
        scoringFailures: 0,
      };

      try {
        const catalogs = await this.catalogSync.syncCatalogs();
        stats.catalogsFetched = catalogs.size;

        if (catalogs.size < 2) {
          this.logger.warn({
            message: 'Discovery skipped: insufficient platforms',
            data: { platformsAvailable: catalogs.size },
          });
          this.emitCompletedEvent(stats, startTime);
          return;
        }

        const polyContracts = catalogs.get(PlatformId.POLYMARKET) ?? [];
        const kalshiContracts = catalogs.get(PlatformId.KALSHI) ?? [];

        // Single-direction: Polymarket → Kalshi (TF-IDF cosine is symmetric)
        for (const polyContract of polyContracts) {
          const dateCandidates = this.filterBySettlementDate(
            kalshiContracts,
            polyContract.settlementDate,
          );

          const filterCandidates: FilterCandidate[] = dateCandidates.map(
            (c) => ({
              id: c.contractId,
              description: c.title || c.description,
            }),
          );

          const ranked = this.preFilter.filterCandidates(
            polyContract.title,
            filterCandidates,
            this.preFilterThreshold,
          );

          stats.candidatesPreFiltered += ranked.length;

          for (const candidate of ranked.slice(
            0,
            this.maxCandidatesPerContract,
          )) {
            const kalshiContract = kalshiContracts.find(
              (k) => k.contractId === candidate.id,
            );
            if (!kalshiContract) continue;

            try {
              await this.processCandidate(polyContract, kalshiContract, stats);
            } catch (error) {
              stats.scoringFailures++;
              this.logger.error({
                message: 'Candidate processing failed',
                data: {
                  polyContractId: polyContract.contractId,
                  kalshiContractId: kalshiContract.contractId,
                  error: error instanceof Error ? error.message : String(error),
                },
              });
            }
          }
        }
      } catch (error) {
        this.logger.error({
          message: 'Discovery run failed unexpectedly',
          data: {
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }

      this.emitCompletedEvent(stats, startTime);
    });
  }

  private filterBySettlementDate(
    contracts: ContractSummary[],
    sourceDate?: Date,
  ): ContractSummary[] {
    return contracts.filter((c) =>
      isWithinSettlementWindow(
        sourceDate,
        c.settlementDate,
        this.settlementWindowDays,
      ),
    );
  }

  private async processCandidate(
    polyContract: ContractSummary,
    kalshiContract: ContractSummary,
    stats: DiscoveryStats,
  ): Promise<void> {
    // Check if pair already exists in knowledge base
    const existing = await this.prisma.contractMatch.findFirst({
      where: {
        polymarketContractId: polyContract.contractId,
        kalshiContractId: kalshiContract.contractId,
      },
    });

    if (existing) {
      this.logger.debug({
        message: 'Skipping existing match',
        data: {
          polyContractId: polyContract.contractId,
          kalshiContractId: kalshiContract.contractId,
        },
      });
      return;
    }

    try {
      const result = await this.scoringStrategy.scoreMatch(
        polyContract.description,
        kalshiContract.description,
        {
          resolutionDate:
            polyContract.settlementDate ?? kalshiContract.settlementDate,
          category: polyContract.category ?? kalshiContract.category,
        },
      );

      const isAutoApproved = result.score >= this.autoApproveThreshold;

      const match = await this.prisma.contractMatch.create({
        data: {
          polymarketContractId: polyContract.contractId,
          kalshiContractId: kalshiContract.contractId,
          polymarketDescription: polyContract.description,
          kalshiDescription: kalshiContract.description,
          confidenceScore: result.score,
          resolutionDate:
            polyContract.settlementDate ??
            kalshiContract.settlementDate ??
            null,
          operatorApproved: isAutoApproved,
          operatorApprovalTimestamp: isAutoApproved ? new Date() : null,
          operatorRationale: isAutoApproved
            ? `Auto-approved by discovery pipeline (score: ${result.score}, model: ${result.model}, escalated: ${result.escalated})`
            : null,
        },
      });

      stats.pairsScored++;

      if (isAutoApproved) {
        stats.autoApproved++;
        this.eventEmitter.emit(
          EVENT_NAMES.MATCH_APPROVED,
          new MatchApprovedEvent(
            match.matchId,
            polyContract.contractId,
            kalshiContract.contractId,
            `Auto-approved by discovery pipeline (score: ${result.score})`,
          ),
        );
        this.eventEmitter.emit(
          EVENT_NAMES.MATCH_AUTO_APPROVED,
          new MatchAutoApprovedEvent(
            match.matchId,
            result.score,
            result.model,
            result.escalated,
          ),
        );
      } else {
        stats.pendingReview++;
        this.eventEmitter.emit(
          EVENT_NAMES.MATCH_PENDING_REVIEW,
          new MatchPendingReviewEvent(
            match.matchId,
            result.score,
            result.model,
            result.escalated,
          ),
        );
      }
    } catch (error) {
      if (error instanceof LlmScoringError) {
        stats.scoringFailures++;
        this.logger.error({
          message: 'LLM scoring failed for candidate pair',
          data: {
            polyContractId: polyContract.contractId,
            kalshiContractId: kalshiContract.contractId,
            error: error.message,
            code: error.code,
          },
        });
        return;
      }
      // Handle unique constraint violation (race condition between findFirst and create)
      if (
        error instanceof Error &&
        'code' in error &&
        (error as { code: string }).code === 'P2002'
      ) {
        this.logger.debug({
          message: 'Duplicate match detected (race condition)',
          data: {
            polyContractId: polyContract.contractId,
            kalshiContractId: kalshiContract.contractId,
          },
        });
        return;
      }
      throw error;
    }
  }

  private emitCompletedEvent(stats: DiscoveryStats, startTime: number): void {
    const durationMs = Date.now() - startTime;
    this.eventEmitter.emit(
      EVENT_NAMES.DISCOVERY_RUN_COMPLETED,
      new DiscoveryRunCompletedEvent({ ...stats, durationMs }),
    );
    this.logger.log({
      message: 'Discovery run completed',
      data: { ...stats, durationMs },
    });
  }
}
