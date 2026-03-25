import { Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';
import { entryPricesSchema } from '../common/schemas/prisma-json.schema';
import {
  SystemHealthError,
  SYSTEM_HEALTH_ERROR_CODES,
} from '../common/errors/system-health-error';
// TODO: Replace remaining PrismaService usage with dedicated repositories
// (OrderRepository, PlatformHealthLogRepository) to fix architecture violation.
// PositionRepository now used for getPositions — PrismaService still needed for
// other aggregation queries.
import { PrismaService } from '../common/prisma.service';
import { PositionRepository } from '../persistence/repositories/position.repository';
import type { DashboardOverviewDto } from './dto/dashboard-overview.dto';
import type { PlatformHealthDto } from './dto/platform-health.dto';
import type { PositionSummaryDto } from './dto/position-summary.dto';
import type { AlertSummaryDto } from './dto/alert-summary.dto';
import type { PositionFullDetailDto } from './dto/position-detail.dto';
import { PositionEnrichmentService } from './position-enrichment.service';
import type { PositionId } from '../common/types/branded.type';
import type { BankrollConfigDto } from './dto/bankroll-config.dto';
import { DashboardOverviewService } from './dashboard-overview.service';
import { DashboardCapitalService } from './dashboard-capital.service';
import { DashboardAuditService } from './dashboard-audit.service';

/**
 * Facade: delegates to OverviewService, CapitalService, AuditService.
 * Owns getPositions + getPositionById directly (Story 10-8-4).
 * Constructor deps: 6 — justified: getPositions needs repo, enrichment, prisma + 3 sub-services.
 * Precedent: RiskManagerService 6 deps, ExitMonitorService 9 deps.
 */
@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    private readonly overviewService: DashboardOverviewService,
    private readonly capitalService: DashboardCapitalService,
    private readonly auditService: DashboardAuditService,
    private readonly positionRepository: PositionRepository,
    private readonly enrichmentService: PositionEnrichmentService,
    private readonly prisma: PrismaService,
  ) {}

  // ── Delegated to DashboardOverviewService ───────────────────────────

  getOverview(): Promise<DashboardOverviewDto> {
    return this.overviewService.getOverview();
  }

  getHealth(): Promise<PlatformHealthDto[]> {
    return this.overviewService.getHealth();
  }

  getAlerts(): Promise<AlertSummaryDto[]> {
    return this.overviewService.getAlerts();
  }

  getShadowComparisons(): unknown[] {
    return this.overviewService.getShadowComparisons();
  }

  getShadowSummary(): unknown {
    return this.overviewService.getShadowSummary();
  }

  // ── Delegated to DashboardCapitalService ────────────────────────────

  getBankrollConfig(): Promise<BankrollConfigDto> {
    return this.capitalService.getBankrollConfig();
  }

  updateBankroll(bankrollUsd: string): Promise<BankrollConfigDto> {
    return this.capitalService.updateBankroll(bankrollUsd);
  }

  // ── Delegated to DashboardAuditService ──────────────────────────────

  getPositionDetails(
    positionId: PositionId | string,
  ): Promise<PositionFullDetailDto | null> {
    return this.auditService.getPositionDetails(positionId);
  }

  // ── Owned: getPositions ─────────────────────────────────────────────

  async getPositions(
    mode?: 'live' | 'paper' | 'all',
    page: number = 1,
    limit: number = 50,
    status?: string,
    sortBy?: string,
    order?: 'asc' | 'desc',
    matchId?: string,
  ): Promise<{ data: PositionSummaryDto[]; count: number }> {
    try {
      const clampedLimit = Math.min(Math.max(1, limit), 200);
      const clampedPage = Math.max(1, page);

      const validStatuses = [
        'OPEN',
        'SINGLE_LEG_EXPOSED',
        'EXIT_PARTIAL',
        'CLOSED',
        'RECONCILIATION_REQUIRED',
      ];
      let statuses: string[] | undefined;
      if (status !== undefined && status !== '') {
        statuses = status
          .split(',')
          .map((s) => s.trim())
          .filter((s) => validStatuses.includes(s));
        if (statuses.length === 0) statuses = undefined;
      } else if (status === undefined) {
        statuses = ['OPEN', 'SINGLE_LEG_EXPOSED', 'EXIT_PARTIAL'];
      }

      const isPaper =
        mode === 'live' ? false : mode === 'paper' ? true : undefined;

      const { data: positions, count } =
        await this.positionRepository.findManyWithFilters(
          statuses,
          isPaper,
          clampedPage,
          clampedLimit,
          sortBy,
          order,
          matchId,
        );

      const closedPositions = positions.filter((p) => p.status === 'CLOSED');
      const exitPartialPositions = positions.filter(
        (p) => p.status === 'EXIT_PARTIAL',
      );
      const positionsNeedingOrders = [
        ...closedPositions,
        ...exitPartialPositions,
      ];

      const ordersByPairId = new Map<
        string,
        (typeof positions)[0]['kalshiOrder'][]
      >();
      const exitTypeByPairId = new Map<string, string>();

      if (positionsNeedingOrders.length > 0) {
        const pairIds = positionsNeedingOrders.map((p) => p.pairId);

        const [allPairOrders, exitAuditEvents] = await Promise.all([
          this.prisma.order.findMany({
            where: { pairId: { in: pairIds } },
            orderBy: { createdAt: 'asc' },
          }),
          this.prisma.auditLog.findMany({
            where: {
              eventType: 'execution.exit.triggered',
              createdAt: {
                gte: new Date(
                  Math.min(
                    ...positionsNeedingOrders.map((p) => p.createdAt.getTime()),
                  ),
                ),
              },
            },
            orderBy: { createdAt: 'desc' },
          }),
        ]);

        for (const o of allPairOrders) {
          const existing = ordersByPairId.get(o.pairId) ?? [];
          existing.push(o as (typeof positions)[0]['kalshiOrder']);
          ordersByPairId.set(o.pairId, existing);
        }

        const closedPairIds = new Set(closedPositions.map((p) => p.pairId));
        for (const event of exitAuditEvents) {
          const details = this.auditService.parseAuditDetails(
            event.details,
            event.id,
          );
          const pairId = details?.pairId as string | undefined;
          if (
            pairId &&
            closedPairIds.has(pairId) &&
            !exitTypeByPairId.has(pairId)
          ) {
            exitTypeByPairId.set(
              pairId,
              (details?.type as string) ?? 'unknown',
            );
          }
        }

        for (const pos of closedPositions) {
          if (!exitTypeByPairId.has(pos.pairId)) {
            exitTypeByPairId.set(pos.pairId, 'manual');
          }
        }
      }

      const BATCH_SIZE = 10;
      const dtos: PositionSummaryDto[] = [];

      for (let i = 0; i < positions.length; i += BATCH_SIZE) {
        const batch = positions.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(
          batch.map(async (pos) => {
            const pairOrders = ordersByPairId.get(pos.pairId);
            const enrichment = await this.enrichmentService.enrich(
              pos,
              pairOrders
                ? pairOrders.filter(
                    (o): o is NonNullable<typeof o> => o !== null,
                  )
                : undefined,
            );

            if (
              enrichment.status === 'failed' ||
              enrichment.status === 'partial'
            ) {
              this.logger.warn({
                message: `Position enrichment ${enrichment.status}`,
                data: {
                  positionId: pos.positionId,
                  errors: enrichment.errors,
                },
              });
            }

            let realizedPnl: string | null = null;
            let exitType: string | null = null;

            if (pos.status === 'CLOSED') {
              exitType = exitTypeByPairId.get(pos.pairId) ?? null;
              if (pos.realizedPnl !== null && pos.realizedPnl !== undefined) {
                realizedPnl = new Decimal(pos.realizedPnl.toString()).toFixed(
                  8,
                );
              } else {
                realizedPnl = this.capitalService.computeRealizedPnl(
                  pos,
                  (ordersByPairId.get(pos.pairId) ?? []).filter(
                    (o): o is NonNullable<typeof o> => o !== null,
                  ),
                );
              }
            }

            return {
              id: pos.positionId,
              pairId: pos.pairId,
              pairName:
                pos.pair.kalshiDescription ??
                pos.pair.polymarketDescription ??
                pos.pairId,
              platforms: {
                kalshi: pos.pair.kalshiContractId,
                polymarket: pos.pair.polymarketContractId,
              },
              entryPrices: this.auditService.parseJsonFieldWithEvent(
                entryPricesSchema,
                pos.entryPrices,
                {
                  model: 'OpenPosition',
                  field: 'entryPrices',
                  recordId: pos.positionId,
                },
              ),
              currentPrices: enrichment.data.currentPrices,
              initialEdge: new Decimal(pos.expectedEdge.toString()).toString(),
              currentEdge: enrichment.data.currentEdge,
              unrealizedPnl: enrichment.data.unrealizedPnl,
              exitProximity: enrichment.data.exitProximity,
              resolutionDate: enrichment.data.resolutionDate,
              timeToResolution: enrichment.data.timeToResolution,
              isPaper: pos.isPaper,
              status: pos.status,
              realizedPnl,
              exitType,
              projectedSlPnl: enrichment.data.projectedSlPnl ?? null,
              projectedTpPnl: enrichment.data.projectedTpPnl ?? null,
              recalculatedEdge: enrichment.data.recalculatedEdge ?? null,
              edgeDelta: enrichment.data.edgeDelta ?? null,
              lastRecalculatedAt: enrichment.data.lastRecalculatedAt ?? null,
              dataSource: enrichment.data.dataSource ?? null,
            };
          }),
        );
        dtos.push(...batchResults);
      }

      return { data: dtos, count };
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

  // ── Owned: getPositionById ──────────────────────────────────────────

  async getPositionById(
    positionId: PositionId | string,
  ): Promise<PositionSummaryDto | null> {
    try {
      const pos = await this.prisma.openPosition.findUnique({
        where: { positionId },
        include: { pair: true, kalshiOrder: true, polymarketOrder: true },
      });

      if (!pos) return null;

      const enrichment = await this.enrichmentService.enrich(pos);

      return {
        id: pos.positionId,
        pairId: pos.pairId,
        pairName:
          pos.pair.kalshiDescription ??
          pos.pair.polymarketDescription ??
          pos.pairId,
        platforms: {
          kalshi: pos.pair.kalshiContractId,
          polymarket: pos.pair.polymarketContractId,
        },
        entryPrices: this.auditService.parseJsonFieldWithEvent(
          entryPricesSchema,
          pos.entryPrices,
          {
            model: 'OpenPosition',
            field: 'entryPrices',
            recordId: pos.positionId,
          },
        ),
        currentPrices: enrichment.data.currentPrices,
        initialEdge: new Decimal(pos.expectedEdge.toString()).toString(),
        currentEdge: enrichment.data.currentEdge,
        unrealizedPnl: enrichment.data.unrealizedPnl,
        exitProximity: enrichment.data.exitProximity,
        resolutionDate: enrichment.data.resolutionDate,
        timeToResolution: enrichment.data.timeToResolution,
        isPaper: pos.isPaper,
        status: pos.status,
        realizedPnl:
          pos.realizedPnl !== null && pos.realizedPnl !== undefined
            ? new Decimal(pos.realizedPnl.toString()).toFixed(8)
            : null,
        exitType: null,
        projectedSlPnl: enrichment.data.projectedSlPnl ?? null,
        projectedTpPnl: enrichment.data.projectedTpPnl ?? null,
        recalculatedEdge: enrichment.data.recalculatedEdge ?? null,
        edgeDelta: enrichment.data.edgeDelta ?? null,
        lastRecalculatedAt: enrichment.data.lastRecalculatedAt ?? null,
        dataSource: enrichment.data.dataSource ?? null,
      };
    } catch (error) {
      this.logger.error({
        message: 'Failed to fetch position by ID',
        data: {
          positionId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.DATABASE_FAILURE,
        'Failed to fetch position',
        'warning',
        'DashboardService',
      );
    }
  }
}
