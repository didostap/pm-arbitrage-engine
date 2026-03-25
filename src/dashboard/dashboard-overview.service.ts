import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Decimal from 'decimal.js';
import { computeModeCapital } from './dashboard-capital.utils';
import {
  SystemHealthError,
  SYSTEM_HEALTH_ERROR_CODES,
} from '../common/errors/system-health-error';
import { PrismaService } from '../common/prisma.service';
import { PositionRepository } from '../persistence/repositories/position.repository';
import type { DashboardOverviewDto } from './dto/dashboard-overview.dto';
import type { PlatformHealthDto } from './dto/platform-health.dto';
import type { AlertSummaryDto } from './dto/alert-summary.dto';
import type { IRiskManager } from '../common/interfaces/risk-manager.interface';
import { RISK_MANAGER_TOKEN } from '../modules/risk-management/risk-management.module';
import { DataIngestionService } from '../modules/data-ingestion/data-ingestion.service';
import { DataDivergenceService } from '../modules/data-ingestion/data-divergence.service';
import { PlatformHealthService } from '../modules/data-ingestion/platform-health.service';
import { PlatformId } from '../common/types/platform.type';
import { ShadowComparisonService } from '../modules/exit-management/shadow-comparison.service';

/**
 * Handles overview, health, alerts, and shadow comparison queries.
 * Extracted from DashboardService (Story 10-8-4).
 *
 * Constructor deps: 8 (PrismaService, PositionRepository, IRiskManager,
 * DataIngestionService, DataDivergenceService, PlatformHealthService,
 * ShadowComparisonService, ConfigService).
 * Exceeds 7-dep target — justified: getOverview is a read-heavy aggregation
 * point assembling data from 7+ sources. Precedent: ExitMonitorService at 9 deps.
 */
@Injectable()
export class DashboardOverviewService {
  private readonly logger = new Logger(DashboardOverviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly positionRepository: PositionRepository,
    @Inject(RISK_MANAGER_TOKEN)
    private readonly riskManager: IRiskManager,
    private readonly dataIngestionService: DataIngestionService,
    private readonly divergenceService: DataDivergenceService,
    private readonly healthService: PlatformHealthService,
    private readonly shadowComparisonService: ShadowComparisonService,
    private readonly configService: ConfigService,
  ) {}

  async getOverview(): Promise<DashboardOverviewDto> {
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const [
        healthLogs,
        openPositionCount,
        trailingPnl7d,
        totalOrders,
        filledOrders,
        activeAlertCount,
        riskStates,
      ] = await Promise.all([
        this.getLatestHealthLogs(),
        this.prisma.openPosition.count({
          where: {
            status: { in: ['OPEN', 'SINGLE_LEG_EXPOSED', 'EXIT_PARTIAL'] },
          },
        }),
        this.positionRepository.sumClosedPnlByDateRange(
          sevenDaysAgo,
          new Date(),
          false,
        ),
        this.prisma.order.count(),
        this.prisma.order.count({ where: { status: 'FILLED' } }),
        this.prisma.openPosition.count({
          where: { status: 'SINGLE_LEG_EXPOSED' },
        }),
        this.prisma.riskState.findMany({
          where: { singletonKey: 'default' },
        }),
      ]);

      const systemHealth = this.computeCompositeHealth(healthLogs);
      const executionQualityRatio =
        totalOrders > 0
          ? new Decimal(filledOrders)
              .div(totalOrders)
              .toDecimalPlaces(2, Decimal.ROUND_DOWN)
              .toNumber()
          : 0;

      const bankrollConfig = await this.riskManager.getBankrollConfig();
      const liveBankrollStr = bankrollConfig.bankrollUsd;
      const paperBankrollStr =
        bankrollConfig.paperBankrollUsd ?? bankrollConfig.bankrollUsd;
      let capitalOverview: DashboardOverviewDto['capitalOverview'] = null;

      if (liveBankrollStr && Number(liveBankrollStr) > 0) {
        const liveState = riskStates.find((r) => r.mode === 'live');
        const paperState = riskStates.find((r) => r.mode === 'paper');

        capitalOverview = {
          live: computeModeCapital(liveBankrollStr, liveState),
          paper: computeModeCapital(paperBankrollStr, paperState),
        };
      } else {
        this.logger.warn({
          message:
            'Bankroll is zero or not configured — balance fields will be null',
        });
      }

      const tradingHalted = this.riskManager.isTradingHalted();
      const haltReasons = tradingHalted
        ? this.riskManager.getActiveHaltReasons()
        : [];

      return {
        systemHealth,
        trailingPnl7d,
        executionQualityRatio,
        openPositionCount,
        activeAlertCount,
        tradingHalted,
        haltReasons,
        capitalOverview,
        totalBankroll: capitalOverview?.live?.bankroll ?? null,
        deployedCapital: capitalOverview?.live?.deployed ?? null,
        availableCapital: capitalOverview?.live?.available ?? null,
        reservedCapital: capitalOverview?.live?.reserved ?? null,
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
        'DashboardOverviewService',
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
        const platformId =
          platformKey === 'KALSHI' ? PlatformId.KALSHI : PlatformId.POLYMARKET;
        const wsTimestamp =
          this.healthService.getWsLastMessageTimestamp(platformId);
        return {
          platformId: log.platform.toLowerCase(),
          status: log.status as
            | 'healthy'
            | 'degraded'
            | 'disconnected'
            | 'initializing',
          apiConnected: log.status !== 'disconnected',
          dataFresh: log.status === 'healthy',
          lastUpdate: log.created_at.toISOString(),
          mode: configuredMode === 'paper' ? 'paper' : 'live',
          wsSubscriptionCount:
            this.dataIngestionService.getActiveSubscriptionCount(platformId),
          divergenceStatus:
            this.divergenceService.getDivergenceStatus(platformId),
          wsLastMessageTimestamp: wsTimestamp
            ? wsTimestamp.toISOString()
            : null,
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
        'DashboardOverviewService',
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
        'DashboardOverviewService',
      );
    }
  }

  getShadowComparisons(): unknown[] {
    const entries = this.shadowComparisonService.getClosedPositionEntries();
    return entries.map((e) => ({
      positionId: e.positionId,
      pairId: e.pairId,
      pnlDelta: e.pnlDelta.toFixed(8),
      modelExitTimestamp: e.modelExitTimestamp.toISOString(),
      fixedWouldHaveExitedAt: e.fixedWouldHaveExitedAt.toISOString(),
      triggerCriterion: e.triggerCriterion ?? null,
    }));
  }

  getShadowSummary(): unknown {
    const summary = this.shadowComparisonService.generateDailySummary();
    const closedEntries =
      this.shadowComparisonService.getClosedPositionEntries();

    let closedPnlDelta = new Decimal(0);
    for (const entry of closedEntries) {
      closedPnlDelta = closedPnlDelta.plus(entry.pnlDelta);
    }

    return {
      totalEvaluations: summary.totalComparisons,
      fixedTriggerCycles: summary.fixedTriggerCount,
      modelTriggerCycles: summary.modelTriggerCount,
      perCyclePnlDelta: summary.cumulativePnlDelta.toFixed(8),
      closedPositionPnlDelta: closedPnlDelta.toFixed(8),
      closedPositionCount: closedEntries.length,
      byCriterion: summary.triggerCountByCriterion,
    };
  }

  computeCompositeHealth(
    logs: Array<{ status: string }>,
  ): 'healthy' | 'degraded' | 'critical' {
    if (logs.length === 0) return 'critical';
    if (logs.some((l) => l.status === 'disconnected')) return 'critical';
    if (logs.some((l) => l.status === 'degraded')) return 'degraded';
    return 'healthy';
  }

  private async getLatestHealthLogs() {
    return this.prisma.platformHealthLog.findMany({
      orderBy: { created_at: 'desc' },
      distinct: ['platform'],
      take: 2,
    });
  }
}
