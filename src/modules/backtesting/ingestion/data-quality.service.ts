import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Decimal from 'decimal.js';
import type { ContractMatch } from '@prisma/client';
import { EVENT_NAMES } from '../../../common/events/event-catalog';
import { BacktestDataQualityWarningEvent } from '../../../common/events/backtesting.events';
import type {
  NormalizedPrice,
  NormalizedTrade,
} from '../types/normalized-historical.types';
import type { DataQualityFlags } from '../../../common/types/historical-data.types';

const GAP_MULTIPLIER = 5;
const JUMP_THRESHOLD = new Decimal('0.2'); // >20%
const STALE_HOURS = 24;
const LOW_TRADE_THRESHOLD = 5; // per hour

@Injectable()
export class DataQualityService {
  constructor(private readonly eventEmitter: EventEmitter2) {}

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
    return issues.join(', ');
  }
}
