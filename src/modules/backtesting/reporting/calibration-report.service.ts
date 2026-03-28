import { Injectable, Logger } from '@nestjs/common';
import { Platform, Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../../common/prisma.service';
import {
  SystemHealthError,
  SYSTEM_HEALTH_ERROR_CODES,
} from '../../../common/errors/system-health-error';
import { EVENT_NAMES } from '../../../common/events/event-catalog';
import { BacktestReportGeneratedEvent } from '../../../common/events/backtesting.events';
import {
  KNOWN_LIMITATIONS,
  REPORT_DECIMAL_PRECISION,
} from '../types/calibration-report.types';
import type {
  CalibrationReport,
  BootstrapCIResult,
  DataQualitySummary,
  SummaryMetrics,
  CoverageGapEntry,
} from '../types/calibration-report.types';
import {
  calculateProfitFactor,
  calculateSharpeRatio,
} from '../utils/metrics-calculation.utils';

interface PositionForBootstrap {
  realizedPnl: Decimal;
  exitTimestamp: Date;
  positionSizeUsd: Decimal;
}

@Injectable()
export class CalibrationReportService {
  private readonly logger = new Logger(CalibrationReportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async generateReport(runId: string): Promise<CalibrationReport> {
    const run = await this.prisma.backtestRun.findUnique({
      where: { id: runId },
    });

    if (!run) {
      throw new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.BACKTEST_REPORT_ERROR,
        `BacktestRun ${runId} not found`,
        'error',
        'backtest-reporting',
      );
    }

    if (run.status !== 'COMPLETE') {
      throw new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.BACKTEST_REPORT_ERROR,
        `BacktestRun ${runId} has status ${run.status}, expected COMPLETE`,
        'error',
        'backtest-reporting',
      );
    }

    const positions = await this.prisma.backtestPosition.findMany({
      where: { runId },
    });

    const summaryMetrics = this.buildSummaryMetrics(run, positions);
    const bootstrapPositions = this.toBootstrapPositions(positions);
    const config = run.config as Record<string, unknown> | null;
    if (!config?.bankrollUsd) {
      throw new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.BACKTEST_REPORT_ERROR,
        `BacktestRun ${runId} config missing bankrollUsd`,
        'error',
        'backtest-reporting',
      );
    }
    const bankrollStr =
      typeof config.bankrollUsd === 'string'
        ? config.bankrollUsd
        : `${config.bankrollUsd as number}`;
    const bankroll = new Decimal(bankrollStr);
    if (bankroll.lte(0)) {
      throw new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.BACKTEST_REPORT_ERROR,
        `BacktestRun ${runId} has invalid bankrollUsd: ${bankrollStr}`,
        'error',
        'backtest-reporting',
      );
    }
    const confidenceIntervals = this.bootstrapConfidenceIntervals(
      bootstrapPositions,
      1000,
      bankroll,
    );
    const dataQualitySummary = await this.buildDataQualitySummary(run);

    const report: CalibrationReport = {
      summaryMetrics,
      confidenceIntervals,
      knownLimitations: KNOWN_LIMITATIONS,
      dataQualitySummary,
      generatedAt: new Date().toISOString(),
    };

    await this.prisma.backtestRun.update({
      where: { id: runId },
      data: { report: report as unknown as Prisma.InputJsonValue },
    });

    this.eventEmitter.emit(
      EVENT_NAMES.BACKTEST_REPORT_GENERATED,
      new BacktestReportGeneratedEvent({
        runId,
        summary: {
          totalTrades: summaryMetrics.totalTrades,
          profitFactor: summaryMetrics.profitFactor,
          netPnl: summaryMetrics.netPnl,
          sharpeRatio: summaryMetrics.sharpeRatio,
        },
      }),
    );

    return report;
  }

  bootstrapConfidenceIntervals(
    positions: PositionForBootstrap[],
    iterations: number,
    bankroll?: Decimal,
  ): BootstrapCIResult {
    if (positions.length < 2) {
      return {
        iterations,
        confidence: 0.95,
        profitFactor: null,
        sharpeRatio: null,
      };
    }

    if (positions.length < 10) {
      this.logger.warn(
        `Bootstrap with ${positions.length} positions may be unreliable`,
      );
    }

    const effectiveBankroll =
      bankroll ??
      positions
        .reduce(
          (max, p) => (p.positionSizeUsd.gt(max) ? p.positionSizeUsd : max),
          new Decimal(0),
        )
        .mul(10);

    const pfResults = this.runBootstrap(
      positions,
      (sample) => calculateProfitFactor(sample),
      iterations,
    );

    const sharpeResults = this.runBootstrap(
      positions,
      (sample) =>
        calculateSharpeRatio(
          effectiveBankroll,
          sample.filter((p) => p.exitTimestamp != null) as {
            realizedPnl: Decimal;
            exitTimestamp: Date;
          }[],
        ),
      iterations,
    );

    return {
      iterations,
      confidence: 0.95,
      profitFactor: this.computeCI(pfResults, iterations),
      sharpeRatio: this.computeCI(sharpeResults, iterations),
    };
  }

  private runBootstrap(
    positions: PositionForBootstrap[],
    metricFn: (sample: PositionForBootstrap[]) => Decimal | null,
    iterations: number,
  ): Decimal[] {
    const results: Decimal[] = [];
    for (let i = 0; i < iterations; i++) {
      const sample = Array.from(
        { length: positions.length },
        () => positions[Math.floor(Math.random() * positions.length)]!,
      );
      const metric = metricFn(sample);
      if (metric !== null) results.push(metric);
    }
    return results;
  }

  private computeCI(
    results: Decimal[],
    iterations: number,
  ): { lower: string; upper: string } | null {
    if (results.length < iterations * 0.5) return null;
    results.sort((a, b) => a.cmp(b));
    const lowerIdx = Math.floor(results.length * 0.025);
    const upperIdx = Math.floor(results.length * 0.975);
    return {
      lower: results[lowerIdx]!.toFixed(REPORT_DECIMAL_PRECISION),
      upper: results[upperIdx]!.toFixed(REPORT_DECIMAL_PRECISION),
    };
  }

  private buildSummaryMetrics(
    run: {
      profitFactor: { toString(): string } | null;
      totalPnl: { toString(): string } | null;
      maxDrawdown: { toString(): string } | null;
      sharpeRatio: { toString(): string } | null;
    },
    positions: {
      realizedPnl: { toString(): string } | null;
      positionSizeUsd: { toString(): string };
      entryEdge: { toString(): string };
    }[],
  ): SummaryMetrics {
    const totalTrades = positions.length;
    let winCount = 0;
    let edgeCapturedSum = new Decimal(0);
    let edgeCapturedCount = 0;

    for (const pos of positions) {
      const pnl = new Decimal(pos.realizedPnl?.toString() ?? '0');
      if (pnl.gt(0)) winCount++;

      const posSize = new Decimal(pos.positionSizeUsd.toString());
      const entryEdge = new Decimal(pos.entryEdge.toString());
      if (posSize.gt(0) && entryEdge.gt(0)) {
        const returnPct = pnl.div(posSize);
        const edgeRatio = returnPct.div(entryEdge);
        edgeCapturedSum = edgeCapturedSum.plus(edgeRatio);
        edgeCapturedCount++;
      }
    }

    const winRate =
      totalTrades > 0 ? new Decimal(winCount).div(totalTrades).toNumber() : 0;
    const avgEdgeCapturedVsExpected =
      edgeCapturedCount > 0
        ? edgeCapturedSum
            .div(edgeCapturedCount)
            .toFixed(REPORT_DECIMAL_PRECISION)
        : '0';

    return {
      totalTrades,
      profitFactor: run.profitFactor
        ? new Decimal(run.profitFactor.toString()).toFixed(
            REPORT_DECIMAL_PRECISION,
          )
        : null,
      netPnl: new Decimal(run.totalPnl?.toString() ?? '0').toFixed(
        REPORT_DECIMAL_PRECISION,
      ),
      maxDrawdown: new Decimal(run.maxDrawdown?.toString() ?? '0').toFixed(
        REPORT_DECIMAL_PRECISION,
      ),
      sharpeRatio: run.sharpeRatio
        ? new Decimal(run.sharpeRatio.toString()).toFixed(
            REPORT_DECIMAL_PRECISION,
          )
        : null,
      winRate,
      avgEdgeCapturedVsExpected,
    };
  }

  private toBootstrapPositions(
    positions: {
      realizedPnl: { toString(): string } | null;
      positionSizeUsd: { toString(): string };
      exitTimestamp: Date | null;
    }[],
  ): PositionForBootstrap[] {
    return positions
      .filter((p) => p.exitTimestamp != null && p.realizedPnl != null)
      .map((p) => ({
        realizedPnl: new Decimal(p.realizedPnl!.toString()),
        exitTimestamp: new Date(p.exitTimestamp!),
        positionSizeUsd: new Decimal(p.positionSizeUsd.toString()),
      }));
  }

  private async buildDataQualitySummary(run: {
    dateRangeStart: Date;
    dateRangeEnd: Date;
  }): Promise<DataQualitySummary> {
    const pairCount = await this.prisma.contractMatch.count({
      where: { operatorApproved: true },
    });

    const groupedPrices = await this.prisma.historicalPrice.groupBy({
      by: ['platform', 'contractId'],
      _count: { id: true },
      where: {
        timestamp: {
          gte: run.dateRangeStart,
          lte: run.dateRangeEnd,
        },
      },
    });

    const totalDataPoints = groupedPrices.reduce(
      (sum: number, g: { _count?: { id?: number } }) =>
        sum + (g._count?.id ?? 0),
      0,
    );

    const coverageGaps = await this.detectCoverageGaps(
      run.dateRangeStart,
      run.dateRangeEnd,
      groupedPrices,
    );

    return {
      pairCount,
      totalDataPoints,
      coverageGaps,
      excludedPeriods: [],
      dateRange: {
        start: run.dateRangeStart.toISOString(),
        end: run.dateRangeEnd.toISOString(),
      },
    };
  }

  private async detectCoverageGaps(
    dateRangeStart: Date,
    dateRangeEnd: Date,
    groupedPrices: { platform: Platform; contractId: string }[],
  ): Promise<CoverageGapEntry[]> {
    const gaps: CoverageGapEntry[] = [];
    const ONE_HOUR_MS = 60 * 60 * 1000;
    const GAP_THRESHOLD_MS = 2 * ONE_HOUR_MS; // >2h gap

    for (const group of groupedPrices) {
      const prices = await this.prisma.historicalPrice.findMany({
        where: {
          platform: group.platform,
          contractId: group.contractId,
          timestamp: { gte: dateRangeStart, lte: dateRangeEnd },
        },
        orderBy: { timestamp: 'asc' },
        select: { timestamp: true },
      });

      let gapCount = 0;
      let totalGapMinutes = 0;

      for (let i = 1; i < prices.length; i++) {
        const diff =
          prices[i]!.timestamp.getTime() - prices[i - 1]!.timestamp.getTime();
        if (diff > GAP_THRESHOLD_MS) {
          gapCount++;
          totalGapMinutes += diff / (60 * 1000);
        }
      }

      if (gapCount > 0) {
        gaps.push({
          platform: group.platform,
          contractId: group.contractId,
          gapCount,
          totalGapMinutes,
        });
      }
    }

    return gaps;
  }
}
