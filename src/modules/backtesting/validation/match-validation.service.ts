import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma.service';
import { OddsPipeService } from '../ingestion/oddspipe.service';
import { PredexonMatchingService } from './predexon-matching.service';
import {
  SystemHealthError,
  SYSTEM_HEALTH_ERROR_CODES,
} from '../../../common/errors/system-health-error';
import { EVENT_NAMES } from '../../../common/events/event-catalog';
import { BacktestValidationCompletedEvent } from '../../../common/events/backtesting.events';
import { BacktestDataQualityWarningEvent } from '../../../common/events/backtesting.events';
import type {
  ExternalMatchedPair,
  ValidationReportEntry,
} from '../types/match-validation.types';
import {
  getEffectiveSources,
  type TriggerValidationDto,
} from '../dto/match-validation.dto';

// P-16: Removed "yes" and "no" — semantically meaningful in prediction market titles
const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'by',
  'from',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'can',
  'do',
  'does',
  'did',
  'has',
  'have',
  'had',
  'this',
  'that',
  'these',
  'those',
  'it',
  'its',
  'not',
  'if',
  'than',
  'then',
  'so',
  'as',
  'up',
]);

const DEFAULT_MATCH_THRESHOLD = 0.6;
const SAFETY_TIMEOUT_MS = 600_000; // 10 minutes
const DEFAULT_PAGE_SIZE = 50;

// P-17: Use null byte separator to avoid collisions with title content
const KEY_SEP = '\x00';

interface OurMatchRecord {
  matchId: string;
  polymarketContractId: string;
  kalshiContractId: string;
  polymarketDescription?: string | null;
  kalshiDescription?: string | null;
  confidenceScore?: number | null;
  operatorApproved: boolean;
}

interface OurMaps {
  byPolymarketId: Map<string, OurMatchRecord>;
  byKalshiId: Map<string, OurMatchRecord>;
  byComposite: Map<string, OurMatchRecord>;
}

interface PairAggregation {
  ourMatch?: OurMatchRecord;
  oddsPipe?: ExternalMatchedPair;
  predexon?: ExternalMatchedPair;
}

@Injectable()
export class MatchValidationService implements OnModuleDestroy {
  private readonly logger = new Logger(MatchValidationService.name);
  private _isRunning = false;
  private safetyTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly matchThreshold: number;

  get isRunning(): boolean {
    return this._isRunning;
  }

  onModuleDestroy(): void {
    if (this.safetyTimer) {
      clearTimeout(this.safetyTimer);
      this.safetyTimer = null;
    }
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly oddsPipeService: OddsPipeService,
    private readonly predexonService: PredexonMatchingService,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
  ) {
    const envThreshold = this.configService.get<string>(
      'VALIDATION_TITLE_MATCH_THRESHOLD',
    );
    this.matchThreshold =
      envThreshold !== undefined && envThreshold !== ''
        ? parseFloat(envThreshold)
        : DEFAULT_MATCH_THRESHOLD;
  }

  async runValidation(dto: TriggerValidationDto, correlationId?: string) {
    if (this._isRunning) {
      throw new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.BACKTEST_VALIDATION_FAILURE,
        'Validation already running',
        'warning',
        'match-validation',
      );
    }

    this._isRunning = true;
    this.safetyTimer = setTimeout(() => {
      this.logger.error(
        'Validation safety timeout (10min) — resetting _isRunning',
      );
      this._isRunning = false;
    }, SAFETY_TIMEOUT_MS);

    try {
      const startMs = Date.now();
      const effectiveCorrelationId = correlationId ?? crypto.randomUUID();
      const sources = getEffectiveSources(dto.includeSources);

      // 1. Load our ContractMatch records
      const ourMatches = await this.loadOurMatches();
      const ourMaps = this.buildLookupMaps(ourMatches);

      // 2-3. Fetch external pairs
      let oddsPipePairs: ExternalMatchedPair[] = [];
      let predexonPairs: ExternalMatchedPair[] = [];

      if (sources.includes('oddspipe')) {
        oddsPipePairs = await this.oddsPipeService.fetchMatchedPairs();
      }
      if (sources.includes('predexon')) {
        predexonPairs = await this.predexonService.fetchMatchedPairs();
      }

      // 4-6. Build aggregation map and categorize
      const aggregations = this.aggregatePairs(
        ourMatches,
        oddsPipePairs,
        predexonPairs,
        ourMaps,
      );

      // P-2: Detect cross-external conflicts before categorizing
      this.detectCrossExternalConflicts(aggregations);

      const entries = this.categorizeAll(aggregations);

      // Count categories
      const confirmedCount = entries.filter(
        (e) => e.category === 'confirmed',
      ).length;
      const ourOnlyCount = entries.filter(
        (e) => e.category === 'our-only',
      ).length;
      const externalOnlyCount = entries.filter(
        (e) => e.category === 'external-only',
      ).length;
      const conflictCount = entries.filter(
        (e) => e.category === 'conflict',
      ).length;

      const durationMs = Date.now() - startMs;

      // 7. Persist report
      const report = await this.prisma.matchValidationReport.create({
        data: {
          correlationId: effectiveCorrelationId,
          runTimestamp: new Date(),
          totalOurMatches: ourMatches.length,
          totalOddsPipePairs: oddsPipePairs.length,
          totalPredexonPairs: predexonPairs.length,
          confirmedCount,
          ourOnlyCount,
          externalOnlyCount,
          conflictCount,
          reportData: entries as unknown as Prisma.InputJsonValue,
          durationMs,
        },
      });

      // 8. Emit events (only after successful DB commit)
      this.eventEmitter.emit(
        EVENT_NAMES.BACKTEST_VALIDATION_COMPLETED,
        new BacktestValidationCompletedEvent({
          reportId: report.id,
          confirmedCount,
          ourOnlyCount,
          externalOnlyCount,
          conflictCount,
          correlationId: effectiveCorrelationId,
        }),
      );

      if (conflictCount > 0) {
        this.eventEmitter.emit(
          EVENT_NAMES.BACKTEST_DATA_QUALITY_WARNING,
          new BacktestDataQualityWarningEvent({
            source: 'match-validation',
            platform: 'cross-platform',
            contractId: 'all',
            flags: {
              hasGaps: false,
              hasSuspiciousJumps: false,
              hasSurvivorshipBias: false,
              hasStaleData: false,
              hasLowVolume: false,
              gapDetails: [],
              jumpDetails: [],
            },
            message: `Match validation found ${conflictCount} conflict(s) across sources`,
            correlationId: effectiveCorrelationId,
          }),
        );
      }

      return {
        ...report,
        totalOurMatches: ourMatches.length,
        totalOddsPipePairs: oddsPipePairs.length,
        totalPredexonPairs: predexonPairs.length,
        confirmedCount,
        ourOnlyCount,
        externalOnlyCount,
        conflictCount,
        reportData: entries as unknown as Prisma.InputJsonValue,
        durationMs,
      };
    } finally {
      this._isRunning = false;
      if (this.safetyTimer) {
        clearTimeout(this.safetyTimer);
        this.safetyTimer = null;
      }
    }
  }

  async getReports(page = 1, limit = DEFAULT_PAGE_SIZE) {
    const take = Math.min(limit, 100);
    const skip = (page - 1) * take;

    return this.prisma.matchValidationReport.findMany({
      orderBy: { runTimestamp: 'desc' },
      take,
      skip,
      select: {
        id: true,
        correlationId: true,
        runTimestamp: true,
        totalOurMatches: true,
        totalOddsPipePairs: true,
        totalPredexonPairs: true,
        confirmedCount: true,
        ourOnlyCount: true,
        externalOnlyCount: true,
        conflictCount: true,
        durationMs: true,
        createdAt: true,
      },
    });
  }

  async getReport(id: number) {
    return this.prisma.matchValidationReport.findUnique({
      where: { id },
    });
  }

  private async loadOurMatches(): Promise<OurMatchRecord[]> {
    const records = await this.prisma.contractMatch.findMany({
      select: {
        matchId: true,
        polymarketContractId: true,
        kalshiContractId: true,
        polymarketDescription: true,
        kalshiDescription: true,
        confidenceScore: true,
        operatorApproved: true,
      },
    });
    return records;
  }

  private buildLookupMaps(matches: OurMatchRecord[]): OurMaps {
    const byPolymarketId = new Map<string, OurMatchRecord>();
    const byKalshiId = new Map<string, OurMatchRecord>();
    const byComposite = new Map<string, OurMatchRecord>();

    for (const match of matches) {
      // P-10: Warn on duplicate IDs
      if (byPolymarketId.has(match.polymarketContractId)) {
        this.logger.warn(
          `Duplicate polymarketContractId "${match.polymarketContractId}" in ContractMatch (matchId: ${match.matchId}) — overwriting previous entry`,
        );
      }
      if (byKalshiId.has(match.kalshiContractId)) {
        this.logger.warn(
          `Duplicate kalshiContractId "${match.kalshiContractId}" in ContractMatch (matchId: ${match.matchId}) — overwriting previous entry`,
        );
      }

      byPolymarketId.set(match.polymarketContractId, match);
      byKalshiId.set(match.kalshiContractId, match);
      byComposite.set(
        `${match.polymarketContractId}${KEY_SEP}${match.kalshiContractId}`,
        match,
      );
    }

    return { byPolymarketId, byKalshiId, byComposite };
  }

  private aggregatePairs(
    ourMatches: OurMatchRecord[],
    oddsPipePairs: ExternalMatchedPair[],
    predexonPairs: ExternalMatchedPair[],
    ourMaps: OurMaps,
  ): Map<string, PairAggregation> {
    const aggregations = new Map<string, PairAggregation>();

    // Seed with our matches
    for (const match of ourMatches) {
      const key = `${match.polymarketContractId}${KEY_SEP}${match.kalshiContractId}`;
      aggregations.set(key, { ourMatch: match });
    }

    // Process external pairs
    for (const pair of [...oddsPipePairs, ...predexonPairs]) {
      this.addExternalPair(pair, ourMaps, aggregations);
    }

    return aggregations;
  }

  private addExternalPair(
    pair: ExternalMatchedPair,
    ourMaps: OurMaps,
    aggregations: Map<string, PairAggregation>,
  ): void {
    const matchedOur = this.matchExternalPair(pair, ourMaps);

    if (matchedOur) {
      const key = `${matchedOur.polymarketContractId}${KEY_SEP}${matchedOur.kalshiContractId}`;
      const agg = aggregations.get(key) ?? { ourMatch: matchedOur };

      if (pair.source === 'oddspipe') {
        agg.oddsPipe = pair;
      } else {
        agg.predexon = pair;
      }

      aggregations.set(key, agg);
    } else {
      // P-8: Warn for unmatched OddsPipe pairs
      if (pair.source === 'oddspipe') {
        this.logger.warn(
          `Unmatched OddsPipe pair: PM="${pair.polymarketTitle}" / K="${pair.kalshiTitle}"`,
        );
      }

      // P-2: Use source-agnostic key based on Polymarket identifier for cross-external comparison
      const pmKey = pair.polymarketId ?? pair.polymarketTitle;
      const externalKey = `ext${KEY_SEP}${pmKey}`;
      const agg = aggregations.get(externalKey) ?? {};

      if (pair.source === 'oddspipe') {
        agg.oddsPipe = pair;
      } else {
        agg.predexon = pair;
      }

      aggregations.set(externalKey, agg);
    }
  }

  /**
   * P-2: After aggregation, detect conflicts where two external sources
   * map the same Polymarket contract to different Kalshi contracts.
   * Cross-checks across aggregation buckets since OddsPipe (title-keyed)
   * and Predexon (ID-keyed) may land in different entries.
   */
  private detectCrossExternalConflicts(
    aggregations: Map<string, PairAggregation>,
  ): void {
    // First pass: check within same aggregation (both sources landed in same bucket)
    for (const [, agg] of aggregations) {
      if (agg.ourMatch) continue;
      if (!agg.oddsPipe || !agg.predexon) continue;

      const opKalshi = agg.oddsPipe.kalshiId ?? agg.oddsPipe.kalshiTitle;
      const pdKalshi = agg.predexon.kalshiId ?? agg.predexon.kalshiTitle;

      if (opKalshi !== pdKalshi) {
        (agg as PairAggregation & { _crossExternalConflict?: string })[
          '_crossExternalConflict'
        ] =
          `OddsPipe pairs PM "${agg.oddsPipe.polymarketTitle}" with K "${opKalshi}", but Predexon pairs it with K "${pdKalshi}"`;
      }
    }

    // Second pass: cross-check across buckets by normalized Polymarket title
    const oddsPipeByTitle = new Map<
      string,
      { key: string; agg: PairAggregation }
    >();
    const predexonByTitle = new Map<
      string,
      { key: string; agg: PairAggregation }
    >();

    for (const [key, agg] of aggregations) {
      if (agg.ourMatch) continue;
      if (agg.oddsPipe && !agg.predexon) {
        const normTitle = agg.oddsPipe.polymarketTitle.toLowerCase().trim();
        oddsPipeByTitle.set(normTitle, { key, agg });
      }
      if (agg.predexon && !agg.oddsPipe) {
        const normTitle = agg.predexon.polymarketTitle.toLowerCase().trim();
        predexonByTitle.set(normTitle, { key, agg });
      }
    }

    for (const [title, opEntry] of oddsPipeByTitle) {
      const pdEntry = predexonByTitle.get(title);
      if (!pdEntry) continue;

      const opPair = opEntry.agg.oddsPipe!;
      const pdPair = pdEntry.agg.predexon!;

      // Compare Kalshi identifiers: only flag conflict when both use the same
      // identifier type (both IDs or both titles). Mixed (ID vs title) is
      // inconclusive — can't determine agreement or conflict.
      const bothHaveIds = opPair.kalshiId != null && pdPair.kalshiId != null;
      const bothTitleOnly = opPair.kalshiId == null && pdPair.kalshiId == null;

      let isConflict = false;
      let opKalshiLabel: string;
      let pdKalshiLabel: string;

      if (bothHaveIds) {
        opKalshiLabel = opPair.kalshiId!;
        pdKalshiLabel = pdPair.kalshiId!;
        isConflict = opKalshiLabel !== pdKalshiLabel;
      } else if (bothTitleOnly) {
        opKalshiLabel = opPair.kalshiTitle;
        pdKalshiLabel = pdPair.kalshiTitle;
        isConflict = opKalshiLabel !== pdKalshiLabel;
      } else {
        // Mixed: one has ID, other has only title — inconclusive, skip
        continue;
      }

      if (isConflict) {
        const merged: PairAggregation & { _crossExternalConflict?: string } = {
          oddsPipe: opPair,
          predexon: pdPair,
          _crossExternalConflict: `OddsPipe pairs PM "${opPair.polymarketTitle}" with K "${opKalshiLabel}", but Predexon pairs it with K "${pdKalshiLabel}"`,
        };
        aggregations.delete(opEntry.key);
        aggregations.delete(pdEntry.key);
        aggregations.set(`conflict${KEY_SEP}${title}`, merged);
      }
    }
  }

  private matchExternalPair(
    pair: ExternalMatchedPair,
    ourMaps: OurMaps,
  ): OurMatchRecord | null {
    // Strategy 1: ID-based matching (Predexon provides IDs)
    if (pair.polymarketId) {
      const byPm = ourMaps.byPolymarketId.get(pair.polymarketId);
      if (byPm) return byPm;
    }
    if (pair.kalshiId) {
      const byK = ourMaps.byKalshiId.get(pair.kalshiId);
      if (byK) return byK;
    }

    // Strategy 2: Fuzzy title matching (OddsPipe — no IDs)
    return this.fuzzyTitleMatch(pair, ourMaps);
  }

  private fuzzyTitleMatch(
    pair: ExternalMatchedPair,
    ourMaps: OurMaps,
  ): OurMatchRecord | null {
    let bestMatch: OurMatchRecord | null = null;
    let bestScore = 0;

    const externalPmTokens = this.tokenize(pair.polymarketTitle);
    const externalKTokens = this.tokenize(pair.kalshiTitle);

    for (const match of ourMaps.byPolymarketId.values()) {
      const ourPmTokens = this.tokenize(match.polymarketDescription ?? '');
      const ourKTokens = this.tokenize(match.kalshiDescription ?? '');

      const pmScore = this.tokenOverlap(externalPmTokens, ourPmTokens);
      const kScore = this.tokenOverlap(externalKTokens, ourKTokens);

      const combinedScore = (pmScore + kScore) / 2;
      if (combinedScore >= this.matchThreshold && combinedScore > bestScore) {
        bestScore = combinedScore;
        bestMatch = match;
      }
    }

    return bestMatch;
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 0 && !STOP_WORDS.has(t));
  }

  private tokenOverlap(tokensA: string[], tokensB: string[]): number {
    if (tokensA.length === 0 || tokensB.length === 0) return 0;
    const setB = new Set(tokensB);
    const overlap = tokensA.filter((t) => setB.has(t)).length;
    return overlap / Math.max(tokensA.length, tokensB.length);
  }

  private categorizeAll(
    aggregations: Map<string, PairAggregation>,
  ): ValidationReportEntry[] {
    const entries: ValidationReportEntry[] = [];

    for (const [, agg] of aggregations) {
      entries.push(this.categorize(agg));
    }

    return entries;
  }

  private categorize(agg: PairAggregation): ValidationReportEntry {
    const hasOur = !!agg.ourMatch;
    const hasOddsPipe = !!agg.oddsPipe;
    const hasPredexon = !!agg.predexon;

    // P-2: Check for cross-external conflict (no our match, externals disagree)
    const crossConflict = (
      agg as PairAggregation & { _crossExternalConflict?: string }
    )._crossExternalConflict;
    if (!hasOur && crossConflict) {
      return this.buildEntry('conflict', agg, crossConflict);
    }

    if (hasOur) {
      const ourKalshi = agg.ourMatch!.kalshiContractId;
      const ourKalshiDesc = agg.ourMatch!.kalshiDescription ?? '';

      // Check Predexon conflict by ID
      if (
        hasPredexon &&
        agg.predexon!.kalshiId &&
        agg.predexon!.kalshiId !== ourKalshi
      ) {
        return this.buildEntry(
          'conflict',
          agg,
          `Our ContractMatch pairs ${agg.ourMatch!.polymarketContractId} with ${ourKalshi}, but Predexon pairs it with ${agg.predexon!.kalshiId}`,
        );
      }

      // Check OddsPipe conflict by title mismatch
      if (hasOddsPipe) {
        const oddsPipeKTokens = this.tokenize(agg.oddsPipe!.kalshiTitle);
        const ourKTokens = this.tokenize(ourKalshiDesc);
        const kScore = this.tokenOverlap(oddsPipeKTokens, ourKTokens);
        if (kScore < this.matchThreshold) {
          return this.buildEntry(
            'conflict',
            agg,
            `Our ContractMatch pairs ${agg.ourMatch!.polymarketContractId} with "${ourKalshiDesc}", but OddsPipe pairs it with "${agg.oddsPipe!.kalshiTitle}"`,
          );
        }
      }

      if (hasOddsPipe || hasPredexon) {
        return this.buildEntry('confirmed', agg);
      }

      return this.buildEntry('our-only', agg);
    }

    // No our match — external-only
    if (hasOddsPipe || hasPredexon) {
      return this.buildEntry('external-only', agg);
    }

    return this.buildEntry('our-only', agg);
  }

  private buildEntry(
    category: ValidationReportEntry['category'],
    agg: PairAggregation,
    conflictDescription?: string,
  ): ValidationReportEntry {
    const entry: ValidationReportEntry = {
      category,
      isKnowledgeBaseCandidate: category === 'external-only',
      notes: '',
    };

    if (agg.ourMatch) {
      entry.ourMatch = {
        matchId: agg.ourMatch.matchId,
        polymarketContractId: agg.ourMatch.polymarketContractId,
        kalshiContractId: agg.ourMatch.kalshiContractId,
        polymarketDescription: agg.ourMatch.polymarketDescription ?? undefined,
        kalshiDescription: agg.ourMatch.kalshiDescription ?? undefined,
        confidenceScore: agg.ourMatch.confidenceScore ?? undefined,
        operatorApproved: agg.ourMatch.operatorApproved,
      };
    }

    if (agg.oddsPipe) {
      entry.oddsPipeMatch = {
        polymarketTitle: agg.oddsPipe.polymarketTitle,
        kalshiTitle: agg.oddsPipe.kalshiTitle,
        yesDiff: agg.oddsPipe.spreadData?.yesDiff,
        polyYesPrice: agg.oddsPipe.spreadData?.polyYesPrice,
        kalshiYesPrice: agg.oddsPipe.spreadData?.kalshiYesPrice,
      };
    }

    if (agg.predexon) {
      entry.predexonMatch = {
        polymarketConditionId: agg.predexon.polymarketId ?? '',
        kalshiId: agg.predexon.kalshiId ?? '',
        polymarketTitle: agg.predexon.polymarketTitle,
        kalshiTitle: agg.predexon.kalshiTitle,
        similarity: agg.predexon.similarity ?? undefined,
      };
    }

    if (conflictDescription) {
      entry.conflictDescription = conflictDescription;
    }

    return entry;
  }
}
