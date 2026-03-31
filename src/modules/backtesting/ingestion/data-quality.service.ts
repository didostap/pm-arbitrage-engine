import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Decimal from 'decimal.js';
import type { ContractMatch, HistoricalDataSource } from '@prisma/client';
import { PrismaService } from '../../../common/prisma.service';
import { EVENT_NAMES } from '../../../common/events/event-catalog';
import { BacktestDataQualityWarningEvent } from '../../../common/events/backtesting.events';
import type {
  NormalizedPrice,
  NormalizedTrade,
  NormalizedHistoricalDepth,
} from '../types/normalized-historical.types';
import type { DataQualityFlags } from '../../../common/types/historical-data.types';

const GAP_MULTIPLIER = 5;
const JUMP_THRESHOLD = new Decimal('0.2'); // >20%
const STALE_HOURS = 24;
const LOW_TRADE_THRESHOLD = 5; // per hour
const DEPTH_GAP_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours
const WIDE_SPREAD_THRESHOLD = new Decimal('0.05'); // 5% relative spread
const IMBALANCE_THRESHOLD = new Decimal('0.1'); // 10%
const FRESHNESS_STALE_HOURS = 48;
const MAX_DETAIL_ENTRIES = 50;
const CROSS_SOURCE_SAMPLE_LIMIT = 10_000;

@Injectable()
export class DataQualityService {
  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly prisma: PrismaService,
  ) {}

  assessPriceQuality(
    prices: NormalizedPrice[],
    intervalMinutes: number,
  ): DataQualityFlags {
    const flags: DataQualityFlags = {
      hasGaps: false,
      hasSuspiciousJumps: false,
      hasSurvivorshipBias: false,
      hasStaleData: false,
      hasLowVolume: false,
      gapDetails: [],
      jumpDetails: [],
    };

    if (prices.length === 0) return flags;

    // P14: Sort by timestamp to ensure correct gap/jump detection
    const sorted = [...prices].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );

    const gapThresholdMs = intervalMinutes * 60 * 1000 * GAP_MULTIPLIER;

    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const curr = sorted[i]!;
      const gap = curr.timestamp.getTime() - prev.timestamp.getTime();

      // Gap detection
      if (gap > gapThresholdMs) {
        flags.hasGaps = true;
        flags.gapDetails.push({
          from: prev.timestamp,
          to: curr.timestamp,
        });
      }

      // P15: Price jump detection using Decimal arithmetic (never native JS operators)
      if (!prev.close.isZero()) {
        const delta = curr.close.minus(prev.close).abs().div(prev.close);
        if (delta.greaterThan(JUMP_THRESHOLD)) {
          flags.hasSuspiciousJumps = true;
          flags.jumpDetails.push({
            index: i,
            priceDelta: delta.toNumber(),
          });
        }
      }
    }

    // Cap detail arrays to prevent unbounded JSON growth
    if (flags.gapDetails.length > MAX_DETAIL_ENTRIES) {
      flags.gapDetails = flags.gapDetails.slice(0, MAX_DETAIL_ENTRIES);
    }
    if (flags.jumpDetails.length > MAX_DETAIL_ENTRIES) {
      flags.jumpDetails = flags.jumpDetails.slice(0, MAX_DETAIL_ENTRIES);
    }

    // Stale data detection
    const latest = sorted[sorted.length - 1]!.timestamp;
    const hoursBehind = (Date.now() - latest.getTime()) / (1000 * 60 * 60);
    if (hoursBehind > STALE_HOURS) {
      flags.hasStaleData = true;
    }

    // Low volume detection
    const allNullOrZero = sorted.every(
      (p) => p.volume === null || p.volume === undefined || p.volume.isZero(),
    );
    if (allNullOrZero) {
      flags.hasLowVolume = true;
    }

    return flags;
  }

  assessTradeQuality(trades: NormalizedTrade[]): DataQualityFlags {
    const flags: DataQualityFlags = {
      hasGaps: false,
      hasSuspiciousJumps: false,
      hasSurvivorshipBias: false,
      hasStaleData: false,
      hasLowVolume: false,
      gapDetails: [],
      jumpDetails: [],
    };

    if (trades.length === 0) return flags;

    // P14: Sort by timestamp to ensure correct gap detection
    const sorted = [...trades].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );

    // Gap detection: >1 hour between consecutive trades
    const tradeGapThresholdMs = 60 * 60 * 1000;
    for (let i = 1; i < sorted.length; i++) {
      const gap =
        sorted[i]!.timestamp.getTime() - sorted[i - 1]!.timestamp.getTime();
      if (gap > tradeGapThresholdMs) {
        flags.hasGaps = true;
        flags.gapDetails.push({
          from: sorted[i - 1]!.timestamp,
          to: sorted[i]!.timestamp,
        });
      }
    }

    // Cap detail arrays to prevent unbounded JSON growth
    if (flags.gapDetails.length > MAX_DETAIL_ENTRIES) {
      flags.gapDetails = flags.gapDetails.slice(0, MAX_DETAIL_ENTRIES);
    }

    // Low volume: check if any 1-hour window has < 5 trades
    if (sorted.length > 0) {
      const startMs = sorted[0]!.timestamp.getTime();
      const endMs = sorted[sorted.length - 1]!.timestamp.getTime();
      const totalSpanMs = endMs - startMs;

      if (totalSpanMs === 0) {
        if (sorted.length < LOW_TRADE_THRESHOLD) {
          flags.hasLowVolume = true;
        }
      } else {
        // P21: Slide through 1-hour windows — use strict < to avoid ghost window at boundary
        const hourMs = 60 * 60 * 1000;
        let windowStart = startMs;
        while (windowStart < endMs) {
          const windowEnd = windowStart + hourMs;
          const count = sorted.filter(
            (t) =>
              t.timestamp.getTime() >= windowStart &&
              t.timestamp.getTime() < windowEnd,
          ).length;
          if (count < LOW_TRADE_THRESHOLD) {
            flags.hasLowVolume = true;
            break;
          }
          windowStart += hourMs;
        }
      }
    }

    return flags;
  }

  assessSurvivorshipBias(
    _contractId: string,
    match: Pick<ContractMatch, 'operatorApproved' | 'resolutionTimestamp'>,
  ): DataQualityFlags {
    const flags: DataQualityFlags = {
      hasGaps: false,
      hasSuspiciousJumps: false,
      hasSurvivorshipBias: false,
      hasStaleData: false,
      hasLowVolume: false,
      gapDetails: [],
      jumpDetails: [],
    };

    if (match.resolutionTimestamp) {
      flags.hasSurvivorshipBias = true;
    }

    if (!match.operatorApproved) {
      flags.hasSurvivorshipBias = true;
    }

    return flags;
  }

  assessDepthQuality(depths: NormalizedHistoricalDepth[]): DataQualityFlags {
    const flags: DataQualityFlags = {
      hasGaps: false,
      hasSuspiciousJumps: false,
      hasSurvivorshipBias: false,
      hasStaleData: false,
      hasLowVolume: false,
      gapDetails: [],
      jumpDetails: [],
      hasWideSpreads: false,
      spreadDetails: [],
      hasCrossedBooks: false,
    };

    if (depths.length === 0) return flags;

    // Sort by timestamp
    const sorted = [...depths].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );

    // Gap detection: >2 hours between consecutive snapshots
    for (let i = 1; i < sorted.length; i++) {
      const gap =
        sorted[i]!.timestamp.getTime() - sorted[i - 1]!.timestamp.getTime();
      if (gap > DEPTH_GAP_THRESHOLD_MS) {
        flags.hasGaps = true;
        flags.gapDetails.push({
          from: sorted[i - 1]!.timestamp,
          to: sorted[i]!.timestamp,
        });
      }
    }

    for (const depth of sorted) {
      // Empty book detection
      if (depth.bids.length === 0 || depth.asks.length === 0) {
        flags.hasGaps = true;
        continue;
      }

      // P-10: Find actual best bid (max) and best ask (min) — order not guaranteed
      const bestBid = depth.bids.reduce(
        (max, b) => Decimal.max(max, b.price),
        depth.bids[0]!.price,
      );
      const bestAsk = depth.asks.reduce(
        (min, a) => Decimal.min(min, a.price),
        depth.asks[0]!.price,
      );

      // P-11: Crossed book detection (best bid >= best ask)
      const spread = bestAsk.minus(bestBid);
      if (spread.isNegative() || spread.isZero()) {
        flags.hasCrossedBooks = true;
      }

      // BS-1: Relative spread detection (spread / midpoint > 5%)
      const midpoint = bestBid.plus(bestAsk).div(2);
      const relativeSpread = midpoint.isZero() ? spread : spread.div(midpoint);
      if (relativeSpread.greaterThan(WIDE_SPREAD_THRESHOLD)) {
        flags.hasWideSpreads = true;
        flags.spreadDetails!.push({
          timestamp: depth.timestamp,
          spreadBps: relativeSpread.mul(10000).toNumber(),
        });
      }

      // Imbalance detection: total bid size < 10% of total ask size (or vice versa)
      const totalBidSize = depth.bids.reduce(
        (sum, b) => sum.plus(b.size),
        new Decimal(0),
      );
      const totalAskSize = depth.asks.reduce(
        (sum, a) => sum.plus(a.size),
        new Decimal(0),
      );

      if (
        !totalAskSize.isZero() &&
        totalBidSize.div(totalAskSize).lessThan(IMBALANCE_THRESHOLD)
      ) {
        flags.hasLowVolume = true;
      }
      if (
        !totalBidSize.isZero() &&
        totalAskSize.div(totalBidSize).lessThan(IMBALANCE_THRESHOLD)
      ) {
        flags.hasLowVolume = true;
      }
    }

    // Cap detail arrays to prevent unbounded JSON growth
    if (flags.gapDetails.length > MAX_DETAIL_ENTRIES) {
      flags.gapDetails = flags.gapDetails.slice(0, MAX_DETAIL_ENTRIES);
    }
    if (
      flags.spreadDetails &&
      flags.spreadDetails.length > MAX_DETAIL_ENTRIES
    ) {
      flags.spreadDetails = flags.spreadDetails.slice(0, MAX_DETAIL_ENTRIES);
    }

    return flags;
  }

  async assessFreshness(
    contractId: string,
    sources: string[],
  ): Promise<{
    timestamps: Record<string, Date>;
    stale: string[];
  }> {
    const timestamps: Record<string, Date> = {};
    const stale: string[] = [];
    const now = Date.now();
    const staleThresholdMs = FRESHNESS_STALE_HOURS * 60 * 60 * 1000;

    // Query depth sources
    const depthSources = sources.filter((s) => ['PMXT_ARCHIVE'].includes(s));
    if (depthSources.length > 0) {
      const depthResults = await this.prisma.historicalDepth.groupBy({
        by: ['source'],
        where: {
          contractId,
          source: { in: depthSources as HistoricalDataSource[] },
        },
        _max: { timestamp: true },
      });

      for (const row of depthResults) {
        if (row._max.timestamp) {
          timestamps[row.source] = row._max.timestamp;
          if (now - row._max.timestamp.getTime() > staleThresholdMs) {
            stale.push(row.source);
          }
        }
      }
    }

    // Query price sources
    const priceSources = sources.filter((s) => !depthSources.includes(s));
    if (priceSources.length > 0) {
      const priceResults = await this.prisma.historicalPrice.groupBy({
        by: ['source'],
        where: {
          contractId,
          source: { in: priceSources as HistoricalDataSource[] },
        },
        _max: { timestamp: true },
      });

      for (const row of priceResults) {
        if (row._max.timestamp) {
          timestamps[row.source] = row._max.timestamp;
          if (now - row._max.timestamp.getTime() > staleThresholdMs) {
            stale.push(row.source);
          }
        }
      }
    }

    return { timestamps, stale };
  }

  /** IG-1 / AC#5: Compare OddsPipe prices against Polymarket API prices */
  async assessCrossSourceDeviation(
    contractId: string,
    dateRange: { start: Date; end: Date },
  ): Promise<{
    hasDeviation: boolean;
    deviations: Array<{
      timestamp: Date;
      source1: string;
      source2: string;
      price1: Decimal;
      price2: Decimal;
      deviationPct: number;
    }>;
  }> {
    const DEVIATION_THRESHOLD = new Decimal('0.10'); // 10%
    const HOUR_MS = 60 * 60 * 1000;

    const prices = await this.prisma.historicalPrice.findMany({
      where: {
        contractId,
        source: {
          in: ['ODDSPIPE', 'POLYMARKET_API'] as HistoricalDataSource[],
        },
        timestamp: { gte: dateRange.start, lte: dateRange.end },
      },
      orderBy: { timestamp: 'asc' },
      select: { source: true, timestamp: true, close: true },
      take: CROSS_SOURCE_SAMPLE_LIMIT,
    });

    const oddspipePrices = prices.filter((p) => p.source === 'ODDSPIPE');
    const polyPrices = prices.filter((p) => p.source === 'POLYMARKET_API');

    const deviations: Array<{
      timestamp: Date;
      source1: string;
      source2: string;
      price1: Decimal;
      price2: Decimal;
      deviationPct: number;
    }> = [];

    for (const op of oddspipePrices) {
      const opTime = op.timestamp.getTime();
      const match = polyPrices.find(
        (pp) => Math.abs(pp.timestamp.getTime() - opTime) < HOUR_MS,
      );
      if (!match) continue;

      const opClose = new Decimal(op.close.toString());
      const matchClose = new Decimal(match.close.toString());
      if (opClose.isZero()) continue;

      const deviation = matchClose.minus(opClose).abs().div(opClose);
      if (deviation.greaterThan(DEVIATION_THRESHOLD)) {
        deviations.push({
          timestamp: op.timestamp,
          source1: 'ODDSPIPE',
          source2: 'POLYMARKET_API',
          price1: opClose,
          price2: matchClose,
          deviationPct: deviation.mul(100).toNumber(),
        });
      }
    }

    return { hasDeviation: deviations.length > 0, deviations };
  }

  emitQualityWarning(
    source: string,
    platform: string,
    contractId: string,
    flags: DataQualityFlags,
    correlationId?: string,
  ): void {
    const message = this.buildWarningMessage(flags);
    this.eventEmitter.emit(
      EVENT_NAMES.BACKTEST_DATA_QUALITY_WARNING,
      new BacktestDataQualityWarningEvent({
        source,
        platform,
        contractId,
        flags,
        message,
        correlationId,
      }),
    );
  }

  private buildWarningMessage(flags: DataQualityFlags): string {
    const issues: string[] = [];
    if (flags.hasGaps) issues.push(`${flags.gapDetails.length} gap(s)`);
    if (flags.hasSuspiciousJumps)
      issues.push(`${flags.jumpDetails.length} jump(s)`);
    if (flags.hasSurvivorshipBias) issues.push('survivorship bias');
    if (flags.hasStaleData) issues.push('stale data');
    if (flags.hasLowVolume) issues.push('low volume');
    if (flags.hasWideSpreads)
      issues.push(`${flags.spreadDetails?.length ?? 0} wide spread(s)`);
    if (flags.hasCrossedBooks) issues.push('crossed book(s)');
    return issues.join(', ');
  }
}
