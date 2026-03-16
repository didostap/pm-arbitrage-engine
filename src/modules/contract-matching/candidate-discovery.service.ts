import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CronJob } from 'cron';
import { CatalogSyncService } from './catalog-sync.service.js';
import { PreFilterService } from './pre-filter.service.js';
import { OutcomeDirectionValidator } from './outcome-direction-validator.js';
import { SCORING_STRATEGY_TOKEN } from '../../common/interfaces/scoring-strategy.interface.js';
import type { IScoringStrategy } from '../../common/interfaces/scoring-strategy.interface.js';
import { CLUSTER_CLASSIFIER_TOKEN } from '../../common/interfaces/cluster-classifier.interface.js';
import type { IClusterClassifier } from '../../common/interfaces/cluster-classifier.interface.js';
import { ClusterAssignedEvent } from '../../common/events/risk.events.js';
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
import { ConfigValidationError } from '../../common/errors/config-validation-error.js';
import { withCorrelationId } from '../../common/services/correlation-context.js';
import { asMatchId, asContractId } from '../../common/types/branded.type.js';

interface DiscoveryStats {
  catalogsFetched: number;
  candidatesPreFiltered: number;
  pairsScored: number;
  autoApproved: number;
  autoRejected: number;
  pendingReview: number;
  scoringFailures: number;
}

function isWithinSettlementWindow(
  dateA?: Date,
  dateB?: Date,
  windowDays = 7,
): boolean {
  if (!dateA || !dateB) {
    return false;
  }
  const diffMs = Math.abs(dateA.getTime() - dateB.getTime());
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return diffDays <= windowDays;
}

@Injectable()
export class CandidateDiscoveryService implements OnModuleInit {
  private readonly logger = new Logger(CandidateDiscoveryService.name);
  private readonly autoApproveThreshold: number;
  private readonly minReviewThreshold: number;
  private readonly preFilterThreshold: number;
  private readonly settlementWindowDays: number;
  private readonly maxCandidatesPerContract: number;
  private readonly llmConcurrency: number;

  constructor(
    private readonly catalogSync: CatalogSyncService,
    private readonly preFilter: PreFilterService,
    @Inject(SCORING_STRATEGY_TOKEN)
    private readonly scoringStrategy: IScoringStrategy,
    @Inject(CLUSTER_CLASSIFIER_TOKEN)
    private readonly clusterClassifier: IClusterClassifier,
    private readonly directionValidator: OutcomeDirectionValidator,
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {
    this.autoApproveThreshold = Number(
      this.configService.get<number>('LLM_AUTO_APPROVE_THRESHOLD', 85),
    );
    this.minReviewThreshold = Number(
      this.configService.get<number>('LLM_MIN_REVIEW_THRESHOLD', 40),
    );
    this.preFilterThreshold = Number(
      this.configService.get<number>('DISCOVERY_PREFILTER_THRESHOLD', 0.25),
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
    this.llmConcurrency = Math.max(
      1,
      Number(this.configService.get<number>('DISCOVERY_LLM_CONCURRENCY', 10)) ||
        1,
    );
  }

  onModuleInit(): void {
    if (this.minReviewThreshold >= this.autoApproveThreshold) {
      throw new ConfigValidationError(
        `LLM_MIN_REVIEW_THRESHOLD (${this.minReviewThreshold}) must be less than LLM_AUTO_APPROVE_THRESHOLD (${this.autoApproveThreshold})`,
        [
          `LLM_MIN_REVIEW_THRESHOLD (${this.minReviewThreshold}) must be less than LLM_AUTO_APPROVE_THRESHOLD (${this.autoApproveThreshold})`,
        ],
      );
    }

    const enabled =
      this.configService.get<boolean>('DISCOVERY_ENABLED') ?? false;
    if (!enabled) {
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

    const runOnStartup =
      this.configService.get<boolean>('DISCOVERY_RUN_ON_STARTUP') ?? false;
    if (runOnStartup) {
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
        autoRejected: 0,
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

        let track = 0;
        // Single-direction: Polymarket → Kalshi (TF-IDF cosine is symmetric)
        for (const polyContract of polyContracts) {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          track++;
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

          const candidatePairs = ranked
            .slice(0, this.maxCandidatesPerContract)
            .map((candidate) => ({
              candidate,
              kalshiContract: kalshiContracts.find(
                (k) => k.contractId === candidate.id,
              ),
            }))
            .filter(
              (
                pair,
              ): pair is typeof pair & {
                kalshiContract: ContractSummary;
              } => pair.kalshiContract !== undefined,
            );

          // Process candidates in parallel batches.
          // Stats mutations inside processCandidate (e.g. stats.pairsScored++)
          // are synchronous increments that execute between await points in
          // Node.js's single-threaded event loop — no two increments can
          // interleave mid-operation. Do not refactor those increments to
          // span an await without revisiting concurrency safety.
          const batchStart = Date.now();

          for (let i = 0; i < candidatePairs.length; i += this.llmConcurrency) {
            const batch = candidatePairs.slice(i, i + this.llmConcurrency);
            const results = await Promise.allSettled(
              batch.map(({ kalshiContract }) =>
                this.processCandidate(polyContract, kalshiContract, stats),
              ),
            );

            for (const [idx, result] of results.entries()) {
              if (result.status === 'rejected') {
                stats.scoringFailures++;
                const { kalshiContract } = batch[idx]!;
                this.logger.error({
                  message: 'Candidate processing failed',
                  data: {
                    polyContractId: polyContract.contractId,
                    kalshiContractId: kalshiContract.contractId,
                    error:
                      result.reason instanceof Error
                        ? result.reason.message
                        : String(result.reason),
                  },
                });
              }
            }
          }

          this.logger.debug({
            message: 'Candidate batch completed',
            data: {
              polyContractId: polyContract.contractId,
              candidateCount: candidatePairs.length,
              concurrency: this.llmConcurrency,
              durationMs: Date.now() - batchStart,
            },
          });
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

      // Direction validation gate — runs before DB create
      let effectiveScore = result.score;
      let effectiveClobTokenId = polyContract.clobTokenId ?? null;
      let effectivePolyLabel = polyContract.outcomeLabel ?? null;
      let divergenceNotes: string | null = null;

      const directionResult = await this.directionValidator.validateDirection(
        polyContract,
        kalshiContract,
      );

      if (directionResult.aligned === false) {
        // Direction mismatch — cap score, force manual review
        effectiveScore = Math.min(effectiveScore, 50);
        divergenceNotes = `Direction mismatch: ${directionResult.reason}`;
        this.logger.warn({
          message: 'Outcome direction mismatch detected',
          data: {
            polyContractId: polyContract.contractId,
            kalshiContractId: kalshiContract.contractId,
            reason: directionResult.reason,
            originalScore: result.score,
            cappedScore: effectiveScore,
          },
        });
      } else if (directionResult.correctedTokenId) {
        // Self-corrected — swap token
        effectiveClobTokenId = directionResult.correctedTokenId;
        effectivePolyLabel =
          directionResult.correctedLabel ?? effectivePolyLabel;
        this.logger.log({
          message: 'Outcome direction self-corrected',
          data: {
            polyContractId: polyContract.contractId,
            kalshiContractId: kalshiContract.contractId,
            correctedTokenId: directionResult.correctedTokenId,
            reason: directionResult.reason,
          },
        });
      }

      const isAutoApproved =
        effectiveScore >= this.autoApproveThreshold &&
        directionResult.aligned !== false;
      const isBelowReviewThreshold = effectiveScore < this.minReviewThreshold;

      const match = await this.prisma.contractMatch.create({
        data: {
          polymarketContractId: polyContract.contractId,
          polymarketClobTokenId: effectiveClobTokenId,
          kalshiContractId: kalshiContract.contractId,
          polymarketDescription: polyContract.description,
          kalshiDescription: kalshiContract.description,
          polymarketRawCategory: polyContract.category ?? null,
          kalshiRawCategory: kalshiContract.category ?? null,
          polymarketOutcomeLabel: effectivePolyLabel,
          kalshiOutcomeLabel: kalshiContract.outcomeLabel ?? null,
          confidenceScore: effectiveScore,
          resolutionDate:
            polyContract.settlementDate ??
            kalshiContract.settlementDate ??
            null,
          operatorApproved: isAutoApproved,
          operatorApprovalTimestamp: isAutoApproved ? new Date() : null,
          primaryLeg: 'kalshi',
          operatorRationale: isAutoApproved
            ? `Auto-approved by discovery pipeline (score: ${effectiveScore}, model: ${result.model}, escalated: ${result.escalated})`
            : isBelowReviewThreshold
              ? `Auto-rejected: below review threshold (score: ${effectiveScore}, threshold: ${this.minReviewThreshold})`
              : null,
          divergenceNotes,
        },
      });

      stats.pairsScored++;

      // Classify into correlation cluster only for tradeable matches
      // Auto-rejected matches will never become positions — skip LLM cost
      if (!isBelowReviewThreshold) {
        try {
          const assignment = await this.clusterClassifier.classifyMatch(
            polyContract.category ?? null,
            kalshiContract.category ?? null,
            polyContract.description,
            kalshiContract.description,
          );
          await this.prisma.contractMatch.update({
            where: { matchId: match.matchId },
            data: { clusterId: assignment.clusterId as string },
          });
          this.eventEmitter.emit(
            EVENT_NAMES.CLUSTER_ASSIGNED,
            new ClusterAssignedEvent(
              asMatchId(match.matchId),
              assignment.clusterId,
              assignment.clusterName,
              assignment.wasLlmClassified,
            ),
          );
        } catch (classifyError) {
          this.logger.warn({
            message: 'Cluster classification failed for match',
            data: {
              matchId: match.matchId,
              error:
                classifyError instanceof Error
                  ? classifyError.message
                  : String(classifyError),
            },
          });
        }
      }

      if (isAutoApproved) {
        stats.autoApproved++;
        this.eventEmitter.emit(
          EVENT_NAMES.MATCH_APPROVED,
          new MatchApprovedEvent(
            asMatchId(match.matchId),
            asContractId(polyContract.contractId),
            asContractId(kalshiContract.contractId),
            `Auto-approved by discovery pipeline (score: ${result.score})`,
          ),
        );
        this.eventEmitter.emit(
          EVENT_NAMES.MATCH_AUTO_APPROVED,
          new MatchAutoApprovedEvent(
            asMatchId(match.matchId),
            result.score,
            result.model,
            result.escalated,
          ),
        );
      } else if (isBelowReviewThreshold) {
        stats.autoRejected++;
      } else {
        stats.pendingReview++;
        this.eventEmitter.emit(
          EVENT_NAMES.MATCH_PENDING_REVIEW,
          new MatchPendingReviewEvent(
            asMatchId(match.matchId),
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
