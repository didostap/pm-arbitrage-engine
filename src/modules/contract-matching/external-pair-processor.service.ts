import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import pLimit from 'p-limit';
import { PrismaService } from '../../common/prisma.service';
import {
  ODDSPIPE_PAIR_PROVIDER_TOKEN,
  PREDEXON_PAIR_PROVIDER_TOKEN,
} from '../../common/interfaces/external-pair-provider.interface';
import type { IExternalPairProvider } from '../../common/interfaces/external-pair-provider.interface';
import { SCORING_STRATEGY_TOKEN } from '../../common/interfaces/scoring-strategy.interface';
import type { IScoringStrategy } from '../../common/interfaces/scoring-strategy.interface';
import { CLUSTER_CLASSIFIER_TOKEN } from '../../common/interfaces/cluster-classifier.interface';
import type { IClusterClassifier } from '../../common/interfaces/cluster-classifier.interface';
import { EVENT_NAMES } from '../../common/events/event-catalog';
import { MatchApprovedEvent } from '../../common/events/match-approved.event';
import { MatchAutoApprovedEvent } from '../../common/events/match-auto-approved.event';
import { MatchPendingReviewEvent } from '../../common/events/match-pending-review.event';
import { ClusterAssignedEvent } from '../../common/events/risk.events';
import { LlmScoringError } from '../../common/errors/llm-scoring-error';
import { asMatchId, asContractId } from '../../common/types/branded.type';
import type { ExternalMatchedPair } from '../../common/types';

interface ExistingMatchDescription {
  polymarketDescription: string | null;
  kalshiDescription: string | null;
}

function normalizeTitle(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

/** Jaccard-like token overlap — handles word reordering in prediction market titles */
export function computeTitleSimilarity(title1: string, title2: string): number {
  const tokens1 = normalizeTitle(title1);
  const tokens2 = normalizeTitle(title2);
  if (tokens1.length === 0 && tokens2.length === 0) return 0;
  const set1 = new Set(tokens1);
  const set2 = new Set(tokens2);
  const intersection = new Set([...set1].filter((t) => set2.has(t)));
  return intersection.size / Math.max(set1.size, set2.size);
}

export interface ExternalPairSourceStats {
  source: string;
  fetched: number;
  deduplicated: number;
  scored: number;
  autoApproved: number;
  pendingReview: number;
  autoRejected: number;
  scoringFailures: number;
  unresolvable: number;
  providerError?: string;
}

export interface ExternalPairProcessorResult {
  sources: ExternalPairSourceStats[];
}

/**
 * 7 deps rationale: Facade coordinating 2 external pair providers +
 * LLM scoring + cluster classification + persistence + events + config
 */
@Injectable()
export class ExternalPairProcessorService {
  private readonly logger = new Logger(ExternalPairProcessorService.name);
  private readonly autoApproveThreshold: number;
  private readonly minReviewThreshold: number;
  private readonly llmConcurrency: number;
  private readonly dedupTitleThreshold: number;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ODDSPIPE_PAIR_PROVIDER_TOKEN)
    private readonly oddsPipeProvider: IExternalPairProvider,
    @Inject(PREDEXON_PAIR_PROVIDER_TOKEN)
    private readonly predexonProvider: IExternalPairProvider,
    @Inject(SCORING_STRATEGY_TOKEN)
    private readonly scoringStrategy: IScoringStrategy,
    @Inject(CLUSTER_CLASSIFIER_TOKEN)
    private readonly clusterClassifier: IClusterClassifier,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
  ) {
    this.autoApproveThreshold = Number(
      this.configService.get<number>('LLM_AUTO_APPROVE_THRESHOLD', 85),
    );
    this.minReviewThreshold = Number(
      this.configService.get<number>('LLM_MIN_REVIEW_THRESHOLD', 40),
    );
    this.llmConcurrency = Math.max(
      1,
      Number(
        this.configService.get<number>('EXTERNAL_PAIR_LLM_CONCURRENCY', 5),
      ) || 1,
    );
    this.dedupTitleThreshold = Number(
      this.configService.get<number>(
        'EXTERNAL_PAIR_DEDUP_TITLE_THRESHOLD',
        0.45,
      ),
    );
  }

  async processAllProviders(
    enrichFn?: (pairs: ExternalMatchedPair[]) => Promise<ExternalMatchedPair[]>,
  ): Promise<ExternalPairProcessorResult> {
    const providers: { provider: IExternalPairProvider; sourceId: string }[] = [
      { provider: this.oddsPipeProvider, sourceId: 'oddspipe' },
      { provider: this.predexonProvider, sourceId: 'predexon' },
    ];

    const allPairs: { pair: ExternalMatchedPair; sourceId: string }[] = [];
    const sourceStatsMap = new Map<string, ExternalPairSourceStats>();

    for (const { provider, sourceId } of providers) {
      const stats: ExternalPairSourceStats = {
        source: sourceId,
        fetched: 0,
        deduplicated: 0,
        scored: 0,
        autoApproved: 0,
        pendingReview: 0,
        autoRejected: 0,
        scoringFailures: 0,
        unresolvable: 0,
      };
      sourceStatsMap.set(sourceId, stats);

      try {
        const pairs = await provider.fetchPairs();
        stats.fetched = pairs.length;
        for (const pair of pairs) {
          allPairs.push({ pair, sourceId });
        }
      } catch (error) {
        stats.providerError =
          error instanceof Error ? error.message : String(error);
        this.logger.warn({
          message: `External pair provider ${sourceId} failed`,
          data: { error: stats.providerError },
        });
      }
    }

    // Enrich pairs with catalog-based ID resolution (OddsPipe pairs lack IDs)
    if (enrichFn) {
      try {
        const rawPairs = allPairs.map((p) => p.pair);
        const enriched = await enrichFn(rawPairs);
        for (let i = 0; i < allPairs.length; i++) {
          allPairs[i]!.pair = enriched[i] ?? allPairs[i]!.pair;
        }
      } catch (error) {
        this.logger.warn({
          message: 'Enrichment callback failed, processing with raw pairs',
          data: {
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }

    // Pre-fetch existing match descriptions for fuzzy title dedup (OddsPipe)
    const existingDescriptions = await this.prisma.contractMatch.findMany({
      select: { polymarketDescription: true, kalshiDescription: true },
    });

    const limit = pLimit(this.llmConcurrency);
    const tasks = allPairs.map(({ pair, sourceId }) =>
      limit(() =>
        this.processPair(
          pair,
          sourceId,
          sourceStatsMap.get(sourceId)!,
          existingDescriptions,
        ),
      ),
    );
    await Promise.allSettled(tasks);

    return {
      sources: [...sourceStatsMap.values()],
    };
  }

  private async processPair(
    pair: ExternalMatchedPair,
    sourceId: string,
    stats: ExternalPairSourceStats,
    existingDescriptions: ExistingMatchDescription[],
  ): Promise<void> {
    // Check if both IDs are present — required for ContractMatch creation
    if (!pair.polymarketId || !pair.kalshiId) {
      stats.unresolvable++;
      this.logger.debug({
        message: 'Skipping ID-less external pair — unresolvable',
        data: {
          source: sourceId,
          polymarketTitle: pair.polymarketTitle,
          kalshiTitle: pair.kalshiTitle,
        },
      });
      return;
    }

    // Dedup: composite key check
    const existing = await this.prisma.contractMatch.findFirst({
      where: {
        polymarketContractId: pair.polymarketId,
        kalshiContractId: pair.kalshiId,
      },
    });

    if (existing) {
      stats.deduplicated++;
      return;
    }

    // Dedup: fuzzy title match for OddsPipe pairs (AC #6)
    // Bias toward inclusion — threshold 0.45 means only high-similarity titles are deduped
    if (sourceId === 'oddspipe') {
      const isFuzzyDup = existingDescriptions.some((em) => {
        if (!em.polymarketDescription || !em.kalshiDescription) return false;
        const polySim = computeTitleSimilarity(
          pair.polymarketTitle,
          em.polymarketDescription,
        );
        const kalshiSim = computeTitleSimilarity(
          pair.kalshiTitle,
          em.kalshiDescription,
        );
        return (
          polySim >= this.dedupTitleThreshold &&
          kalshiSim >= this.dedupTitleThreshold
        );
      });

      if (isFuzzyDup) {
        stats.deduplicated++;
        this.logger.debug({
          message: 'OddsPipe pair deduplicated via fuzzy title match',
          data: {
            polymarketTitle: pair.polymarketTitle,
            kalshiTitle: pair.kalshiTitle,
            threshold: this.dedupTitleThreshold,
          },
        });
        return;
      }
    }

    // Score via LLM
    try {
      const result = await this.scoringStrategy.scoreMatch(
        pair.polymarketTitle,
        pair.kalshiTitle,
        { resolutionDate: pair.settlementDate, category: pair.category },
      );

      const effectiveScore = result.score;
      const isAutoApproved = effectiveScore >= this.autoApproveThreshold;
      const isBelowReviewThreshold = effectiveScore < this.minReviewThreshold;

      const originEnum = sourceId === 'predexon' ? 'PREDEXON' : 'ODDSPIPE';

      const match = await this.prisma.contractMatch.create({
        data: {
          polymarketContractId: pair.polymarketId,
          kalshiContractId: pair.kalshiId,
          polymarketDescription: pair.polymarketTitle,
          kalshiDescription: pair.kalshiTitle,
          confidenceScore: effectiveScore,
          origin: originEnum,
          operatorApproved: isAutoApproved,
          operatorApprovalTimestamp: isAutoApproved ? new Date() : null,
          primaryLeg: 'kalshi',
          operatorRationale: isAutoApproved
            ? `Auto-approved by external pair ingestion (source: ${sourceId}, score: ${effectiveScore}, model: ${result.model})`
            : isBelowReviewThreshold
              ? `Auto-rejected: below review threshold (score: ${effectiveScore}, threshold: ${this.minReviewThreshold})`
              : null,
          divergenceNotes:
            'Direction validation skipped — external pair lacks outcome metadata',
          polymarketClobTokenId: pair.polymarketClobTokenId ?? null,
          polymarketRawCategory: pair.category ?? null,
          kalshiRawCategory: pair.category ?? null,
          polymarketOutcomeLabel: pair.polymarketOutcomeLabel ?? null,
          kalshiOutcomeLabel: pair.kalshiOutcomeLabel ?? null,
          resolutionDate: pair.settlementDate ?? null,
        },
      });

      stats.scored++;

      // Cluster classification for non-rejected matches
      if (!isBelowReviewThreshold) {
        try {
          const assignment = await this.clusterClassifier.classifyMatch(
            null,
            null,
            pair.polymarketTitle,
            pair.kalshiTitle,
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
            message: 'Cluster classification failed for external pair',
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

      // Event emission
      if (isAutoApproved) {
        stats.autoApproved++;
        this.eventEmitter.emit(
          EVENT_NAMES.MATCH_APPROVED,
          new MatchApprovedEvent(
            asMatchId(match.matchId),
            asContractId(pair.polymarketId),
            asContractId(pair.kalshiId),
            `Auto-approved by external pair ingestion (source: ${sourceId}, score: ${effectiveScore})`,
          ),
        );
        this.eventEmitter.emit(
          EVENT_NAMES.MATCH_AUTO_APPROVED,
          new MatchAutoApprovedEvent(
            asMatchId(match.matchId),
            effectiveScore,
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
            effectiveScore,
            result.model,
            result.escalated,
          ),
        );
      }
    } catch (error) {
      if (error instanceof LlmScoringError) {
        stats.scoringFailures++;
        this.logger.error({
          message: 'LLM scoring failed for external pair',
          data: {
            source: sourceId,
            polymarketId: pair.polymarketId,
            kalshiId: pair.kalshiId,
            error: error.message,
          },
        });
        return;
      }

      // Handle P2002 unique constraint violation (race condition)
      if (
        error instanceof Error &&
        'code' in error &&
        (error as { code: string }).code === 'P2002'
      ) {
        stats.deduplicated++;
        this.logger.debug({
          message: 'Duplicate match detected (race condition)',
          data: {
            polymarketId: pair.polymarketId,
            kalshiId: pair.kalshiId,
          },
        });
        return;
      }

      stats.scoringFailures++;
      throw error;
    }
  }
}
