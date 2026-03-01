import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Decimal from 'decimal.js';
// TODO: Replace PrismaService with dedicated repositories (OrderRepository,
// PositionRepository, PlatformHealthLogRepository) to fix architecture violation.
// Dashboard queries are read-only aggregations that don't fit neatly into existing
// repositories, so keeping PrismaService for now.
import { PrismaService } from '../common/prisma.service';
import {
  SystemHealthError,
  SYSTEM_HEALTH_ERROR_CODES,
} from '../common/errors/system-health-error';
import type { DashboardOverviewDto } from './dto/dashboard-overview.dto';
import type { PlatformHealthDto } from './dto/platform-health.dto';
import type { PositionSummaryDto } from './dto/position-summary.dto';
import type { AlertSummaryDto } from './dto/alert-summary.dto';

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async getOverview(): Promise<DashboardOverviewDto> {
    try {
      const [
        healthLogs,
        openPositionCount,
        pnlAggregate,
        totalOrders,
        filledOrders,
        activeAlertCount,
      ] = await Promise.all([
        this.getLatestHealthLogs(),
        this.prisma.openPosition.count({
          where: {
            status: { in: ['OPEN', 'SINGLE_LEG_EXPOSED', 'EXIT_PARTIAL'] },
          },
        }),
        this.prisma.openPosition.aggregate({
          where: {
            status: 'CLOSED',
            updatedAt: {
              gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
            },
          },
          _sum: { expectedEdge: true },
        }),
        this.prisma.order.count(),
        this.prisma.order.count({ where: { status: 'FILLED' } }),
        this.prisma.openPosition.count({
          where: { status: 'SINGLE_LEG_EXPOSED' },
        }),
      ]);

      const systemHealth = this.computeCompositeHealth(healthLogs);
      const trailingPnl7d = pnlAggregate._sum.expectedEdge
        ? new Decimal(pnlAggregate._sum.expectedEdge.toString()).toString()
        : '0';
      const executionQualityRatio =
        totalOrders > 0
          ? new Decimal(filledOrders)
              .div(totalOrders)
              .toDecimalPlaces(2, Decimal.ROUND_DOWN)
              .toNumber()
          : 0;

      return {
        systemHealth,
        trailingPnl7d,
        executionQualityRatio,
        openPositionCount,
        activeAlertCount,
      };
    } catch (error) {
      this.logger.error({
        message: 'Failed to fetch dashboard overview',
        data: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.DATABASE_FAILURE,
        'Failed to fetch dashboard overview',
        'warning',
        'DashboardService',
      );
    }
  }

  async getHealth(): Promise<PlatformHealthDto[]> {
    try {
      const logs = await this.getLatestHealthLogs();
      return logs.map((log) => {
        const platformKey = log.platform.toUpperCase();
        const configuredMode = this.configService.get<string>(
          `PLATFORM_MODE_${platformKey}`,
          'live',
        );
        return {
          platformId: log.platform.toLowerCase(),
          status: log.status as 'healthy' | 'degraded' | 'disconnected',
          apiConnected: log.status !== 'disconnected',
          dataFresh: log.status === 'healthy',
          lastUpdate: log.created_at.toISOString(),
          mode: configuredMode === 'paper' ? 'paper' : 'live',
        };
      });
    } catch (error) {
      this.logger.error({
        message: 'Failed to fetch platform health',
        data: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.DATABASE_FAILURE,
        'Failed to fetch platform health',
        'warning',
        'DashboardService',
      );
    }
  }

  async getPositions(
    mode?: 'live' | 'paper' | 'all',
  ): Promise<PositionSummaryDto[]> {
    try {
      const where: Record<string, unknown> = {
        status: { in: ['OPEN', 'SINGLE_LEG_EXPOSED', 'EXIT_PARTIAL'] },
      };

      if (mode === 'live') where['isPaper'] = false;
      else if (mode === 'paper') where['isPaper'] = true;

      const positions = await this.prisma.openPosition.findMany({
        where,
        include: { pair: true },
        orderBy: { updatedAt: 'desc' },
      });

      return positions.map((pos) => ({
        id: pos.positionId,
        pairName:
          (pos.pair as { kalshiDescription?: string })?.kalshiDescription ??
          (pos.pair as { polymarketDescription?: string })
            ?.polymarketDescription ??
          pos.pairId,
        platforms: {
          kalshi:
            (pos.pair as { kalshiContractId?: string })?.kalshiContractId ??
            'kalshi',
          polymarket:
            (pos.pair as { polymarketContractId?: string })
              ?.polymarketContractId ?? 'polymarket',
        },
        entryPrices: pos.entryPrices as Record<string, string>,
        currentPrices: null,
        initialEdge: new Decimal(pos.expectedEdge.toString()).toString(),
        currentEdge: null,
        unrealizedPnl: null,
        exitProximity: null,
        isPaper: pos.isPaper,
        status: pos.status,
      }));
    } catch (error) {
      this.logger.error({
        message: 'Failed to fetch positions',
        data: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.DATABASE_FAILURE,
        'Failed to fetch positions',
        'warning',
        'DashboardService',
      );
    }
  }

  async getAlerts(): Promise<AlertSummaryDto[]> {
    try {
      const singleLegPositions = await this.prisma.openPosition.findMany({
        where: { status: 'SINGLE_LEG_EXPOSED' },
        include: { pair: true },
        orderBy: { updatedAt: 'desc' },
      });

      return singleLegPositions.map((pos) => ({
        id: pos.positionId,
        type: 'single_leg_exposure',
        severity: 'critical',
        message: `Single-leg exposure on position ${pos.positionId} (pair: ${pos.pairId})`,
        timestamp: pos.updatedAt.toISOString(),
        acknowledged: false,
      }));
    } catch (error) {
      this.logger.error({
        message: 'Failed to fetch alerts',
        data: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.DATABASE_FAILURE,
        'Failed to fetch alerts',
        'warning',
        'DashboardService',
      );
    }
  }

  private async getLatestHealthLogs() {
    return this.prisma.platformHealthLog.findMany({
      orderBy: { created_at: 'desc' },
      distinct: ['platform'],
      take: 2,
    });
  }

  private computeCompositeHealth(
    logs: Array<{ status: string }>,
  ): 'healthy' | 'degraded' | 'critical' {
    if (logs.length === 0) return 'critical';
    if (logs.some((l) => l.status === 'disconnected')) return 'critical';
    if (logs.some((l) => l.status === 'degraded')) return 'degraded';
    return 'healthy';
  }
}
