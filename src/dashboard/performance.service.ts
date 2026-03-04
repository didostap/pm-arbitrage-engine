import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { PrismaService } from '../common/prisma.service';
import { EVENT_NAMES } from '../common/events/event-catalog';
import {
  SystemHealthError,
  SYSTEM_HEALTH_ERROR_CODES,
} from '../common/errors/system-health-error';
import type {
  WeeklySummaryDto,
  DailyPerformanceDto,
  PerformanceTrendsDto,
} from './dto/performance.dto';

interface DateRange {
  start: Date;
  end: Date;
}

@Injectable()
export class PerformanceService {
  constructor(private readonly prisma: PrismaService) {}

  async getWeeklySummary(
    weeksBack: number = 8,
    mode?: 'live' | 'paper',
  ): Promise<WeeklySummaryDto[]> {
    try {
      const ranges = this.getWeekRanges(weeksBack);
      const results: WeeklySummaryDto[] = [];

      for (const range of ranges) {
        const summary = await this.aggregateRange(range, mode);
        results.push({
          weekStart: range.start.toISOString(),
          weekEnd: range.end.toISOString(),
          ...summary,
        });
      }

      return results;
    } catch (error) {
      throw this.wrapDatabaseError('getWeeklySummary', error);
    }
  }

  async getDailySummary(
    daysBack: number = 30,
    mode?: 'live' | 'paper',
  ): Promise<DailyPerformanceDto[]> {
    try {
      const ranges = this.getDayRanges(daysBack);
      const results: DailyPerformanceDto[] = [];

      for (const range of ranges) {
        const summary = await this.aggregateRange(range, mode);
        results.push({
          date: range.start.toISOString().slice(0, 10),
          ...summary,
        });
      }

      return results;
    } catch (error) {
      throw this.wrapDatabaseError('getDailySummary', error);
    }
  }

  async getRollingAverages(
    mode?: 'live' | 'paper',
  ): Promise<PerformanceTrendsDto> {
    const weeks = await this.getWeeklySummary(8, mode);

    const latest4 = weeks.slice(0, 4);
    const previous4 = weeks.slice(4, 8);

    const nonEmptyWeeks = weeks.filter(
      (w) => w.totalTrades > 0 || w.closedPositions > 0,
    );
    const dataInsufficient = nonEmptyWeeks.length < 8;

    const rollingAverages = {
      opportunityFrequency: this.avgNumber(
        latest4.map((w) => w.opportunitiesDetected),
      ),
      edgeCaptured: this.avgDecimalString(latest4.map((w) => w.pnl)),
      slippage: this.avgDecimalString(latest4.map((w) => w.averageSlippage)),
    };

    const latestAvgPnl = new Decimal(
      this.avgDecimalString(latest4.map((w) => w.pnl)),
    );
    const previousAvgPnl = new Decimal(
      this.avgDecimalString(previous4.map((w) => w.pnl)),
    );

    let edgeTrend: 'improving' | 'stable' | 'declining' = 'stable';
    if (
      previous4.length > 0 &&
      latestAvgPnl.gt(previousAvgPnl.mul(new Decimal('1.1')))
    ) {
      edgeTrend = 'improving';
    } else if (
      previous4.length > 0 &&
      latestAvgPnl.lt(previousAvgPnl.mul(new Decimal('0.9')))
    ) {
      edgeTrend = 'declining';
    }

    const opportunityBelowBaseline = rollingAverages.opportunityFrequency < 8;

    const latestWeekSummary = weeks[0] ?? this.emptyWeeklySummary();

    return {
      rollingAverages,
      opportunityBelowBaseline,
      edgeTrend,
      latestWeekSummary,
      dataInsufficient,
    };
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private async aggregateRange(
    range: DateRange,
    mode?: 'live' | 'paper',
  ): Promise<
    Omit<WeeklySummaryDto, 'weekStart' | 'weekEnd'> & { date?: string }
  > {
    const dateFilter = { gte: range.start, lt: range.end };
    const paperFilter = this.getPaperFilter(mode);

    // Parallelize all independent DB queries for performance
    const [
      totalTrades,
      filledOrders,
      closedPositions,
      closedPositionData,
      opportunitiesDetected,
      opportunitiesFiltered,
      opportunitiesExecuted,
      manualInterventions,
    ] = await Promise.all([
      this.prisma.order.count({
        where: { status: 'FILLED', createdAt: dateFilter, ...paperFilter },
      }),
      this.prisma.order.findMany({
        where: {
          status: 'FILLED',
          fillPrice: { not: null },
          createdAt: dateFilter,
          ...paperFilter,
        },
        select: { price: true, fillPrice: true },
      }),
      this.prisma.openPosition.count({
        where: { status: 'CLOSED', updatedAt: dateFilter, ...paperFilter },
      }),
      this.prisma.openPosition.findMany({
        where: { status: 'CLOSED', updatedAt: dateFilter, ...paperFilter },
        select: { expectedEdge: true },
      }),
      this.prisma.auditLog.count({
        where: {
          eventType: EVENT_NAMES.OPPORTUNITY_IDENTIFIED,
          createdAt: dateFilter,
        },
      }),
      this.prisma.auditLog.count({
        where: {
          eventType: EVENT_NAMES.OPPORTUNITY_FILTERED,
          createdAt: dateFilter,
        },
      }),
      this.prisma.auditLog.count({
        where: { eventType: EVENT_NAMES.ORDER_FILLED, createdAt: dateFilter },
      }),
      this.prisma.riskOverrideLog.count({
        where: { approved: true, createdAt: dateFilter },
      }),
    ]);

    // Calculations using decimal.js
    const pnl = closedPositionData.reduce(
      (sum, p) => sum.plus(new Decimal(p.expectedEdge.toString())),
      new Decimal(0),
    );

    const profitableCount = closedPositionData.filter((p) =>
      new Decimal(p.expectedEdge.toString()).gt(0),
    ).length;
    const hitRate = closedPositions > 0 ? profitableCount / closedPositions : 0;

    let averageSlippage = new Decimal(0);
    if (filledOrders.length > 0) {
      const totalSlippage = filledOrders.reduce((sum, o) => {
        const slip = new Decimal(o.fillPrice!.toString())
          .minus(new Decimal(o.price.toString()))
          .abs();
        return sum.plus(slip);
      }, new Decimal(0));
      averageSlippage = totalSlippage.div(filledOrders.length);
    }

    const autonomyRatio =
      totalTrades === 0
        ? 'N/A'
        : new Decimal(totalTrades)
            .div(Math.max(manualInterventions, 1))
            .toString();

    return {
      totalTrades,
      closedPositions,
      pnl: pnl.toString(),
      hitRate,
      averageSlippage: averageSlippage.toString(),
      opportunitiesDetected,
      opportunitiesFiltered,
      opportunitiesExecuted,
      manualInterventions,
      autonomyRatio,
    };
  }

  private getPaperFilter(
    mode?: 'live' | 'paper',
  ): { isPaper: boolean } | Record<string, never> {
    if (mode === 'paper') return { isPaper: true };
    if (mode === 'live') return { isPaper: false };
    return {};
  }

  private getWeekRanges(weeksBack: number): DateRange[] {
    const now = new Date();
    // Find current week's Monday
    const currentMonday = this.getMondayUTC(now);
    const ranges: DateRange[] = [];

    for (let i = 0; i < weeksBack; i++) {
      const end = new Date(currentMonday);
      end.setUTCDate(end.getUTCDate() - i * 7);
      const start = new Date(end);
      start.setUTCDate(start.getUTCDate() - 7);
      ranges.push({ start, end });
    }

    return ranges;
  }

  private getDayRanges(daysBack: number): DateRange[] {
    const now = new Date();
    const today = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const ranges: DateRange[] = [];

    for (let i = 0; i < daysBack; i++) {
      const end = new Date(today);
      end.setUTCDate(end.getUTCDate() - i);
      const start = new Date(end);
      start.setUTCDate(start.getUTCDate() - 1);
      ranges.push({ start, end });
    }

    return ranges;
  }

  private getMondayUTC(date: Date): Date {
    const d = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
    const day = d.getUTCDay();
    const diff = day === 0 ? 6 : day - 1;
    d.setUTCDate(d.getUTCDate() - diff);
    return d;
  }

  private avgNumber(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  private avgDecimalString(values: string[]): string {
    if (values.length === 0) return '0';
    const sum = values.reduce(
      (acc, v) => acc.plus(new Decimal(v)),
      new Decimal(0),
    );
    return sum.div(values.length).toString();
  }

  private emptyWeeklySummary(): WeeklySummaryDto {
    return {
      weekStart: '',
      weekEnd: '',
      totalTrades: 0,
      closedPositions: 0,
      pnl: '0',
      hitRate: 0,
      averageSlippage: '0',
      opportunitiesDetected: 0,
      opportunitiesFiltered: 0,
      opportunitiesExecuted: 0,
      manualInterventions: 0,
      autonomyRatio: 'N/A',
    };
  }

  private wrapDatabaseError(method: string, error: unknown): SystemHealthError {
    if (error instanceof SystemHealthError) {
      return error;
    }
    return new SystemHealthError(
      SYSTEM_HEALTH_ERROR_CODES.DATABASE_FAILURE,
      `Performance aggregation failed in ${method}: ${error instanceof Error ? error.message : String(error)}`,
      'error',
      'PerformanceService',
    );
  }
}
