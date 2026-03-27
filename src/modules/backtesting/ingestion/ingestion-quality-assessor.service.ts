import { Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma.service';
import { DataQualityService } from './data-quality.service';
import type { DataQualityFlags } from '../../../common/types/historical-data.types';

interface TargetContract {
  kalshiTicker: string;
  polymarketTokenId: string;
  operatorApproved: boolean;
  resolutionTimestamp: Date | null;
}

/** Max records to query back from DB for quality assessment */
const QUALITY_SAMPLE_LIMIT = 10_000;

/** Serialize DataQualityFlags to JSON-safe value for Prisma (Date → ISO string) */
function flagsToJson(flags: DataQualityFlags): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(flags)) as Prisma.InputJsonValue;
}

function toDepthUpdateType(
  v: string | null,
): 'snapshot' | 'price_change' | null {
  if (v === 'snapshot' || v === 'price_change') return v;
  return null;
}

@Injectable()
export class IngestionQualityAssessorService {
  private readonly logger = new Logger(IngestionQualityAssessorService.name);

  /** 2 deps: leaf service assessing data quality on ingested records */
  constructor(
    private readonly prisma: PrismaService,
    private readonly dataQuality: DataQualityService,
  ) {}

  /**
   * Query ingested data from DB and run quality assessment.
   * Updates records with quality flags and emits warning events.
   */
  async runQualityAssessment(
    matchId: string,
    target: TargetContract,
    dateRange: { start: Date; end: Date },
    correlationId: string,
  ): Promise<void> {
    // Survivorship bias — use actual ContractMatch data
    const survivorFlags = this.dataQuality.assessSurvivorshipBias(matchId, {
      operatorApproved: target.operatorApproved,
      resolutionTimestamp: target.resolutionTimestamp,
    });

    // Query Kalshi prices for quality assessment
    const kalshiPrices = await this.prisma.historicalPrice.findMany({
      where: {
        contractId: target.kalshiTicker,
        platform: 'KALSHI',
        timestamp: { gte: dateRange.start, lte: dateRange.end },
      },
      orderBy: { timestamp: 'asc' },
      take: QUALITY_SAMPLE_LIMIT,
    });

    const kalshiPriceFlags =
      kalshiPrices.length > 0
        ? this.dataQuality.assessPriceQuality(
            kalshiPrices.map((p) => ({
              platform: p.platform,
              contractId: p.contractId,
              source: p.source,
              intervalMinutes: p.intervalMinutes,
              timestamp: p.timestamp,
              open: new Decimal(p.open.toString()),
              high: new Decimal(p.high.toString()),
              low: new Decimal(p.low.toString()),
              close: new Decimal(p.close.toString()),
              volume: p.volume ? new Decimal(p.volume.toString()) : null,
              openInterest: p.openInterest
                ? new Decimal(p.openInterest.toString())
                : null,
            })),
            1,
          )
        : null;

    // Query Kalshi trades for quality assessment
    const kalshiTrades = await this.prisma.historicalTrade.findMany({
      where: {
        contractId: target.kalshiTicker,
        platform: 'KALSHI',
        timestamp: { gte: dateRange.start, lte: dateRange.end },
      },
      orderBy: { timestamp: 'asc' },
      take: QUALITY_SAMPLE_LIMIT,
    });

    const kalshiTradeFlags =
      kalshiTrades.length > 0
        ? this.dataQuality.assessTradeQuality(
            kalshiTrades.map((t) => ({
              platform: t.platform,
              contractId: t.contractId,
              source: t.source,
              externalTradeId: t.externalTradeId,
              price: new Decimal(t.price.toString()),
              size: new Decimal(t.size.toString()),
              side: t.side,
              timestamp: t.timestamp,
            })),
          )
        : null;

    // Merge all flags and emit warnings if any issues found
    const allFlagSets: Array<{
      source: string;
      platform: string;
      contractId: string;
      flags: DataQualityFlags;
    }> = [];

    if (this.hasQualityIssues(survivorFlags)) {
      allFlagSets.push({
        source: 'survivorship',
        platform: 'both',
        contractId: matchId,
        flags: survivorFlags,
      });
    }

    if (kalshiPriceFlags && this.hasQualityIssues(kalshiPriceFlags)) {
      allFlagSets.push({
        source: 'KALSHI_API',
        platform: 'kalshi',
        contractId: target.kalshiTicker,
        flags: kalshiPriceFlags,
      });

      // Persist quality flags on Kalshi price records
      await this.prisma.historicalPrice.updateMany({
        where: {
          contractId: target.kalshiTicker,
          platform: 'KALSHI',
          timestamp: { gte: dateRange.start, lte: dateRange.end },
        },
        data: { qualityFlags: flagsToJson(kalshiPriceFlags) },
      });
    }

    if (kalshiTradeFlags && this.hasQualityIssues(kalshiTradeFlags)) {
      allFlagSets.push({
        source: 'KALSHI_API',
        platform: 'kalshi',
        contractId: target.kalshiTicker,
        flags: kalshiTradeFlags,
      });

      // Persist quality flags on Kalshi trade records
      await this.prisma.historicalTrade.updateMany({
        where: {
          contractId: target.kalshiTicker,
          platform: 'KALSHI',
          timestamp: { gte: dateRange.start, lte: dateRange.end },
        },
        data: { qualityFlags: flagsToJson(kalshiTradeFlags) },
      });
    }

    // Depth quality assessment — PMXT Archive (P-17: removed dead guard)
    const depths = await this.prisma.historicalDepth.findMany({
      where: {
        contractId: target.polymarketTokenId,
        source: 'PMXT_ARCHIVE',
        timestamp: { gte: dateRange.start, lte: dateRange.end },
      },
      orderBy: { timestamp: 'asc' },
      take: QUALITY_SAMPLE_LIMIT,
    });

    if (depths.length > 0) {
      const depthFlags = this.dataQuality.assessDepthQuality(
        depths.map((d) => ({
          platform: String(d.platform),
          contractId: String(d.contractId),
          source: d.source,
          bids: this.parseJsonDepthLevels(d.bids).map((b) => ({
            price: new Decimal(b.price),
            size: new Decimal(b.size),
          })),
          asks: this.parseJsonDepthLevels(d.asks).map((a) => ({
            price: new Decimal(a.price),
            size: new Decimal(a.size),
          })),
          timestamp: d.timestamp,
          updateType: toDepthUpdateType(d.updateType),
          qualityFlags: null,
        })),
      );

      if (this.hasQualityIssues(depthFlags)) {
        allFlagSets.push({
          source: 'PMXT_ARCHIVE',
          platform: 'polymarket',
          contractId: target.polymarketTokenId,
          flags: depthFlags,
        });
      }
    }

    for (const entry of allFlagSets) {
      this.dataQuality.emitQualityWarning(
        entry.source,
        entry.platform,
        entry.contractId,
        entry.flags,
        correlationId,
      );
    }

    // Freshness assessment
    try {
      const freshness = await this.dataQuality.assessFreshness(
        target.polymarketTokenId,
        ['PMXT_ARCHIVE', 'ODDSPIPE', 'KALSHI_API', 'POLYMARKET_API', 'GOLDSKY'],
      );

      if (freshness.stale.length > 0) {
        this.logger.warn({
          message: `Stale sources for ${target.polymarketTokenId}: ${freshness.stale.join(', ')}`,
          correlationId,
          matchId,
          freshness,
        });
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Freshness assessment failed for ${target.polymarketTokenId}: ${msg}`,
      );
    }

    // Cross-source deviation check (IG-1: AC#5)
    try {
      const deviation = await this.dataQuality.assessCrossSourceDeviation(
        target.polymarketTokenId,
        dateRange,
      );
      if (deviation.hasDeviation) {
        this.logger.warn({
          message: `Cross-source price deviation for ${matchId}: ${deviation.deviations.length} deviation(s) >10%`,
          correlationId,
          deviations: deviation.deviations.length,
        });
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Cross-source deviation check failed for ${target.polymarketTokenId}: ${msg}`,
      );
    }
  }

  private hasQualityIssues(flags: DataQualityFlags): boolean {
    return (
      flags.hasGaps ||
      flags.hasSuspiciousJumps ||
      flags.hasSurvivorshipBias ||
      flags.hasStaleData ||
      flags.hasLowVolume ||
      (flags.hasWideSpreads ?? false) ||
      (flags.hasCrossedBooks ?? false)
    );
  }

  /** P-16: Parse JSON depth levels with logging for invalid fallbacks */
  private parseJsonDepthLevels(
    json: Prisma.JsonValue,
  ): Array<{ price: string; size: string }> {
    if (!Array.isArray(json)) return [];
    return json.map((item) => {
      const obj =
        item && typeof item === 'object' && !Array.isArray(item)
          ? (item as Record<string, Prisma.JsonValue>)
          : {};
      const rawPrice = obj.price;
      const rawSize = obj.size;
      const price =
        typeof rawPrice === 'string' || typeof rawPrice === 'number'
          ? String(rawPrice)
          : (() => {
              this.logger.warn(
                `Invalid depth level price: ${JSON.stringify(rawPrice)}, defaulting to 0`,
              );
              return '0';
            })();
      const size =
        typeof rawSize === 'string' || typeof rawSize === 'number'
          ? String(rawSize)
          : (() => {
              this.logger.warn(
                `Invalid depth level size: ${JSON.stringify(rawSize)}, defaulting to 0`,
              );
              return '0';
            })();
      return { price, size };
    });
  }
}
