import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma.service.js';
import {
  SCORING_STRATEGY_TOKEN,
  type IScoringStrategy,
} from '../../common/interfaces/scoring-strategy.interface.js';
import type { ContractSummary } from '../../common/interfaces/contract-catalog-provider.interface.js';
import Decimal from 'decimal.js';
import { PlatformId } from '../../common/types/platform.type.js';
import type { IPlatformConnector } from '../../common/interfaces/platform-connector.interface.js';
import { asContractId } from '../../common/types/branded.type.js';
import { LLM_ALIGNMENT_THRESHOLD } from '../../common/constants/matching-thresholds.js';
import { CatalogSyncService } from './catalog-sync.service.js';
import { OutcomeDirectionValidator } from './outcome-direction-validator.js';
import { ClusterClassifierService } from './cluster-classifier.service.js';

export interface AuditReport {
  total: number;
  flagged: number;
  skipped: number;
  backfilled: number;
  tokensCorrected: number;
  ufcRejected: number;
  clustersReclassified: number;
}

const UFC_MISMATCH_PREFIXES = ['339a6d3e', '85b96578', 'ec7aa3cb'];
const MAX_LLM_RETRIES = 3;

@Injectable()
export class AuditRevalidationService {
  private readonly logger = new Logger(AuditRevalidationService.name);
  private readonly batchSize: number;
  private readonly batchDelayMs: number;
  private readonly complementaryTolerance: string;

  constructor(
    @Inject(SCORING_STRATEGY_TOKEN)
    private readonly scoringStrategy: IScoringStrategy,
    private readonly prisma: PrismaService,
    private readonly catalogSync: CatalogSyncService,
    private readonly directionValidator: OutcomeDirectionValidator,
    private readonly configService: ConfigService,
    private readonly clusterClassifier: ClusterClassifierService,
    @Optional()
    @Inject('IPlatformConnector:Kalshi')
    private readonly kalshiConnector?: IPlatformConnector,
    @Optional()
    @Inject('IPlatformConnector:Polymarket')
    private readonly polyConnector?: IPlatformConnector,
  ) {
    this.batchSize = Number(
      this.configService.get<number>('AUDIT_LLM_BATCH_SIZE', 10),
    );
    this.batchDelayMs = Number(
      this.configService.get<number>('AUDIT_LLM_DELAY_MS', 1000),
    );
    this.complementaryTolerance = this.configService.get<string>(
      'AUDIT_COMPLEMENTARY_TOLERANCE',
      '0.05',
    );
  }

  async runAudit(): Promise<AuditReport> {
    const report: AuditReport = {
      total: 0,
      flagged: 0,
      skipped: 0,
      backfilled: 0,
      tokensCorrected: 0,
      ufcRejected: 0,
      clustersReclassified: 0,
    };

    // Phase A: Reject confirmed UFC mis-matches
    report.ufcRejected = await this.rejectUfcMismatches();

    // Fetch live catalog data (best effort — expired contracts won't be found)
    const { polyLookup, kalshiLookup } = await this.buildCatalogLookups();

    // Phase B: Full revalidation audit
    const matches = await this.prisma.contractMatch.findMany({
      where: { operatorApproved: true },
    });

    report.total = matches.length;
    this.logger.log({
      message: 'Starting revalidation audit',
      data: {
        totalMatches: matches.length,
        batchSize: this.batchSize,
        polyContracts: polyLookup.size,
        kalshiContracts: kalshiLookup.size,
      },
    });

    for (let i = 0; i < matches.length; i += this.batchSize) {
      const batch = matches.slice(i, i + this.batchSize);

      for (const match of batch) {
        const polyContract = polyLookup.get(match.polymarketContractId);
        const kalshiContract = kalshiLookup.get(match.kalshiContractId);

        if (polyContract && kalshiContract) {
          // Preferred path: use direction validator with fresh catalog data
          await this.auditWithCatalog(
            match,
            polyContract,
            kalshiContract,
            report,
          );
        } else {
          // Fallback: LLM description scoring for expired/delisted contracts
          await this.auditWithLlm(match, report);
        }
      }

      if (i + this.batchSize < matches.length && this.batchDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.batchDelayMs));
      }
    }

    // Phase C: Cluster reclassification (purge corrupted tag mappings, re-classify via LLM)
    report.clustersReclassified = await this.reclassifyClusters();

    this.logger.log({ message: 'Audit complete', data: report });
    return report;
  }

  private async buildCatalogLookups(): Promise<{
    polyLookup: Map<string, ContractSummary>;
    kalshiLookup: Map<string, ContractSummary>;
  }> {
    const polyLookup = new Map<string, ContractSummary>();
    const kalshiLookup = new Map<string, ContractSummary>();

    try {
      const catalogs = await this.catalogSync.syncCatalogs();
      for (const c of catalogs.get(PlatformId.POLYMARKET) ?? []) {
        polyLookup.set(c.contractId, c);
      }
      for (const c of catalogs.get(PlatformId.KALSHI) ?? []) {
        kalshiLookup.set(c.contractId, c);
      }
      this.logger.log({
        message: 'Catalog data loaded for audit',
        data: {
          polyContracts: polyLookup.size,
          kalshiContracts: kalshiLookup.size,
        },
      });
    } catch (error) {
      this.logger.warn({
        message: 'Catalog sync failed — will use LLM fallback for all matches',
        data: { error: error instanceof Error ? error.message : String(error) },
      });
    }

    return { polyLookup, kalshiLookup };
  }

  private async auditWithCatalog(
    match: {
      matchId: string;
      polymarketContractId: string;
      kalshiContractId: string;
      polymarketClobTokenId: string | null;
      polymarketOutcomeLabel: string | null;
      kalshiOutcomeLabel: string | null;
    },
    polyContract: ContractSummary,
    kalshiContract: ContractSummary,
    report: AuditReport,
  ): Promise<void> {
    const result = await this.directionValidator.validateDirection(
      polyContract,
      kalshiContract,
    );

    const updateData: Record<string, unknown> = {};
    let isFlagged = false;

    if (result.aligned === false) {
      // Direction mismatch — flag it
      updateData.operatorApproved = false;
      updateData.operatorRationale = `Audit: direction mismatch — ${result.reason}`;
      isFlagged = true;
      report.flagged++;
    } else if (result.correctedTokenId) {
      // Self-corrected — swap token
      updateData.polymarketClobTokenId = result.correctedTokenId;
      updateData.polymarketOutcomeLabel = result.correctedLabel ?? null;
      report.tokensCorrected++;
      this.logger.log({
        message: 'Token corrected',
        data: {
          matchId: match.matchId,
          oldToken: match.polymarketClobTokenId,
          newToken: result.correctedTokenId,
          reason: result.reason,
        },
      });
    }

    // Complementary price check (only if not already flagged by direction check)
    if (!isFlagged) {
      const complementary = await this.checkComplementaryPricing(match);
      if (complementary?.isComplementary) {
        updateData.operatorApproved = false;
        updateData.operatorRationale = `Audit: complementary pricing (ask sum: ${complementary.sum} ≈ 1.00) suggests opposite-outcome match`;
        report.flagged++;
      }
    }

    // Backfill outcome labels from catalog data
    if (!match.polymarketOutcomeLabel && polyContract.outcomeLabel) {
      updateData.polymarketOutcomeLabel =
        updateData.polymarketOutcomeLabel ?? polyContract.outcomeLabel;
      report.backfilled++;
    }
    if (!match.kalshiOutcomeLabel && kalshiContract.outcomeLabel) {
      updateData.kalshiOutcomeLabel = kalshiContract.outcomeLabel;
      if (match.polymarketOutcomeLabel || !polyContract.outcomeLabel) {
        report.backfilled++;
      }
    }

    if (Object.keys(updateData).length > 0) {
      await this.prisma.contractMatch.update({
        where: { matchId: match.matchId },
        data: updateData,
      });
    }
  }

  private async auditWithLlm(
    match: {
      matchId: string;
      polymarketDescription: string | null;
      kalshiDescription: string | null;
      polymarketOutcomeLabel: string | null;
      kalshiOutcomeLabel: string | null;
    },
    report: AuditReport,
  ): Promise<void> {
    const polyDesc = match.polymarketDescription ?? '';
    const kalshiDesc = match.kalshiDescription ?? '';

    if (!polyDesc || !kalshiDesc) {
      report.skipped++;
      return;
    }

    let score: number | null = null;
    let reasoning = '';
    for (let attempt = 0; attempt < MAX_LLM_RETRIES; attempt++) {
      try {
        const result = await this.scoringStrategy.scoreMatch(
          polyDesc,
          kalshiDesc,
        );
        score = result.score;
        reasoning = result.reasoning;
        break;
      } catch (error) {
        this.logger.warn({
          message: `LLM audit attempt ${attempt + 1}/${MAX_LLM_RETRIES} failed`,
          data: {
            matchId: match.matchId,
            error: error instanceof Error ? error.message : String(error),
          },
        });
        if (attempt === MAX_LLM_RETRIES - 1) {
          report.skipped++;
          return;
        }
        // Exponential backoff: 1s, 2s, 4s
        await new Promise((resolve) =>
          setTimeout(resolve, Math.pow(2, attempt) * 1000),
        );
      }
    }

    if (score === null) {
      report.skipped++;
      return;
    }

    if (score < LLM_ALIGNMENT_THRESHOLD) {
      await this.prisma.contractMatch.update({
        where: { matchId: match.matchId },
        data: {
          operatorApproved: false,
          operatorRationale: `Audit flagged (LLM): score ${score} < ${LLM_ALIGNMENT_THRESHOLD}. ${reasoning}`,
        },
      });
      report.flagged++;
    }
  }

  private async checkComplementaryPricing(match: {
    polymarketClobTokenId: string | null;
    kalshiContractId: string;
  }): Promise<{ isComplementary: boolean; sum: string } | null> {
    if (
      !this.polyConnector ||
      !this.kalshiConnector ||
      !match.polymarketClobTokenId
    ) {
      return null;
    }

    try {
      const [polyBook, kalshiBook] = await Promise.all([
        this.polyConnector.getOrderBook(
          asContractId(match.polymarketClobTokenId),
        ),
        this.kalshiConnector.getOrderBook(asContractId(match.kalshiContractId)),
      ]);

      if (polyBook.asks.length === 0 || kalshiBook.asks.length === 0) {
        return null;
      }

      const polyBestAsk = new Decimal(polyBook.asks[0]!.price);
      const kalshiBestAsk = new Decimal(kalshiBook.asks[0]!.price);
      const sum = polyBestAsk.plus(kalshiBestAsk);
      const tolerance = new Decimal(this.complementaryTolerance);

      return {
        isComplementary: sum.minus(1).abs().lte(tolerance),
        sum: sum.toFixed(4),
      };
    } catch (error) {
      this.logger.warn({
        message: 'Order book fetch failed during complementary check',
        data: {
          kalshiContractId: match.kalshiContractId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return null;
    }
  }

  private async reclassifyClusters(): Promise<number> {
    // Step 1: Purge corrupted tag mappings
    const { count: deletedMappings } =
      await this.prisma.clusterTagMapping.deleteMany({});
    this.logger.log({
      message: 'Purged corrupted cluster tag mappings',
      data: { deletedMappings },
    });

    // Step 2: Reclassify all approved matches via LLM
    const matches = await this.prisma.contractMatch.findMany({
      where: { operatorApproved: true },
      select: {
        matchId: true,
        clusterId: true,
        polymarketRawCategory: true,
        kalshiRawCategory: true,
        polymarketDescription: true,
        kalshiDescription: true,
      },
    });

    let reclassified = 0;

    for (let i = 0; i < matches.length; i += this.batchSize) {
      const batch = matches.slice(i, i + this.batchSize);

      for (const match of batch) {
        try {
          const assignment = await this.clusterClassifier.classifyMatch(
            match.polymarketRawCategory,
            match.kalshiRawCategory,
            match.polymarketDescription ?? '',
            match.kalshiDescription ?? '',
          );

          const newClusterId = assignment.clusterId as string;
          if (newClusterId !== match.clusterId) {
            await this.prisma.contractMatch.update({
              where: { matchId: match.matchId },
              data: { clusterId: newClusterId },
            });
            reclassified++;
          }
        } catch (error) {
          this.logger.warn({
            message: 'Cluster reclassification failed for match',
            data: {
              matchId: match.matchId,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
      }

      if (i + this.batchSize < matches.length && this.batchDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.batchDelayMs));
      }
    }

    this.logger.log({
      message: 'Cluster reclassification complete',
      data: { totalMatches: matches.length, reclassified },
    });

    return reclassified;
  }

  private async rejectUfcMismatches(): Promise<number> {
    const allApproved = await this.prisma.contractMatch.findMany({
      where: { operatorApproved: true },
      select: { matchId: true, operatorApproved: true },
    });

    const ufcMatches = allApproved.filter((m) =>
      UFC_MISMATCH_PREFIXES.some((prefix) => m.matchId.startsWith(prefix)),
    );

    for (const match of ufcMatches) {
      await this.prisma.contractMatch.update({
        where: { matchId: match.matchId },
        data: {
          operatorApproved: false,
          operatorRationale:
            'Rejected by audit: confirmed direction mismatch (UFC head-to-head)',
          lastAnnualizedReturn: null,
          lastNetEdge: null,
        },
      });

      this.logger.warn({
        message: 'Rejected UFC mis-match',
        data: { matchId: match.matchId },
      });
    }

    return ufcMatches.length;
  }
}
