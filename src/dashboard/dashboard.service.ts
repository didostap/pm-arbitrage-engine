import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Decimal from 'decimal.js';
import { parseJsonField } from '../common/schemas/parse-json-field';
import {
  entryPricesSchema,
  auditLogDetailsSchema,
} from '../common/schemas/prisma-json.schema';
import { EVENT_NAMES } from '../common/events/event-catalog';
import { DataCorruptionDetectedEvent } from '../common/events/system.events';
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
import type {
  PositionFullDetailDto,
  OrderDetailDto,
  AuditEventDto,
} from './dto/position-detail.dto';
import { PositionEnrichmentService } from './position-enrichment.service';
import type { PositionId } from '../common/types/branded.type';

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly enrichmentService: PositionEnrichmentService,
    private readonly positionRepository: PositionRepository,
    private readonly eventEmitter: EventEmitter2,
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
        riskState,
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
        this.prisma.riskState.findUnique({
          where: { singletonKey: 'default' },
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

      // Balance computation
      const bankrollStr = this.configService.get<string>('RISK_BANKROLL_USD');
      let totalBankroll: string | null = null;
      let deployedCapital: string | null = null;
      let availableCapital: string | null = null;
      let reservedCapital: string | null = null;

      if (bankrollStr) {
        totalBankroll = bankrollStr;
        const bankroll = new Decimal(bankrollStr);
        const deployed = riskState?.totalCapitalDeployed
          ? new Decimal(riskState.totalCapitalDeployed.toString())
          : new Decimal(0);
        const reserved = riskState?.reservedCapital
          ? new Decimal(riskState.reservedCapital.toString())
          : new Decimal(0);

        deployedCapital = deployed.toString();
        reservedCapital = reserved.toString();

        const available = bankroll.minus(deployed).minus(reserved);
        availableCapital = Decimal.max(available, new Decimal(0)).toString();

        if (available.isNeg()) {
          this.logger.warn({
            message: 'Available capital is negative — configuration drift',
            data: {
              bankroll: bankrollStr,
              deployed: deployedCapital,
              reserved: reservedCapital,
            },
          });
        }
      } else {
        this.logger.warn({
          message: 'BANKROLL_USD not configured — balance fields will be null',
        });
      }

      return {
        systemHealth,
        trailingPnl7d,
        executionQualityRatio,
        openPositionCount,
        activeAlertCount,
        totalBankroll,
        deployedCapital,
        availableCapital,
        reservedCapital,
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
    page: number = 1,
    limit: number = 50,
    status?: string,
    sortBy?: string,
    order?: 'asc' | 'desc',
  ): Promise<{ data: PositionSummaryDto[]; count: number }> {
    try {
      const clampedLimit = Math.min(Math.max(1, limit), 200);
      const clampedPage = Math.max(1, page);

      // Status filter: if provided and non-empty, parse comma-separated values;
      // if absent, use default open statuses (backward compatible)
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
      // status === '' means "all statuses" — statuses stays undefined

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
        );

      // Identify positions needing exit data (closed for P&L, EXIT_PARTIAL for residual sizes)
      const closedPositions = positions.filter((p) => p.status === 'CLOSED');
      const exitPartialPositions = positions.filter(
        (p) => p.status === 'EXIT_PARTIAL',
      );
      const positionsNeedingOrders = [
        ...closedPositions,
        ...exitPartialPositions,
      ];

      // Batch-fetch exit orders and exit audit events
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

        // Group orders by pairId
        for (const order of allPairOrders) {
          const existing = ordersByPairId.get(order.pairId) ?? [];
          existing.push(order as (typeof positions)[0]['kalshiOrder']);
          ordersByPairId.set(order.pairId, existing);
        }

        // Group exitType by pairId (most recent per pairId)
        const closedPairIds = new Set(closedPositions.map((p) => p.pairId));
        for (const event of exitAuditEvents) {
          const details = this.parseAuditDetails(event.details, event.id);
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

        // Check for manual closes (no EXIT_TRIGGERED event, but has filled exit orders)
        for (const pos of closedPositions) {
          if (!exitTypeByPairId.has(pos.pairId)) {
            exitTypeByPairId.set(pos.pairId, 'manual');
          }
        }
      }

      // Enrich in batches to avoid overwhelming connectors with concurrent RPC calls
      const BATCH_SIZE = 10;
      const dtos: PositionSummaryDto[] = [];

      for (let i = 0; i < positions.length; i += BATCH_SIZE) {
        const batch = positions.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(
          batch.map(async (pos) => {
            // Pass orders to enrich for EXIT_PARTIAL residual size computation
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

            // Compute realized P&L for closed positions
            let realizedPnl: string | null = null;
            let exitType: string | null = null;

            if (pos.status === 'CLOSED') {
              exitType = exitTypeByPairId.get(pos.pairId) ?? null;
              realizedPnl = this.computeRealizedPnl(
                pos,
                (ordersByPairId.get(pos.pairId) ?? []).filter(
                  (o): o is NonNullable<typeof o> => o !== null,
                ),
              );
            }

            return {
              id: pos.positionId,
              pairName:
                pos.pair.kalshiDescription ??
                pos.pair.polymarketDescription ??
                pos.pairId,
              platforms: {
                kalshi: pos.pair.kalshiContractId,
                polymarket: pos.pair.polymarketContractId,
              },
              entryPrices: this.parseJsonFieldWithEvent(
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
        pairName:
          pos.pair.kalshiDescription ??
          pos.pair.polymarketDescription ??
          pos.pairId,
        platforms: {
          kalshi: pos.pair.kalshiContractId,
          polymarket: pos.pair.polymarketContractId,
        },
        entryPrices: this.parseJsonFieldWithEvent(
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
        realizedPnl: null,
        exitType: null,
        projectedSlPnl: enrichment.data.projectedSlPnl ?? null,
        projectedTpPnl: enrichment.data.projectedTpPnl ?? null,
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

  private static readonly AUDIT_TRAIL_EVENT_WHITELIST = [
    'detection.opportunity.identified',
    'risk.budget.reserved',
    'risk.budget.committed',
    'execution.order.filled',
    'execution.order.failed',
    'execution.exit.triggered',
    'execution.single_leg.exposure',
  ];

  async getPositionDetails(
    positionId: PositionId | string,
  ): Promise<PositionFullDetailDto | null> {
    try {
      const pos = await this.prisma.openPosition.findUnique({
        where: { positionId },
        include: { pair: true, kalshiOrder: true, polymarketOrder: true },
      });

      if (!pos) return null;

      // Temporal bounding for orders within position lifecycle
      const orderWhere: Record<string, unknown> = {
        pairId: pos.pairId,
        createdAt: { gte: pos.createdAt },
      };

      // For closed positions, also bound by close timestamp
      if (pos.status === 'CLOSED') {
        orderWhere['createdAt'] = {
          gte: pos.createdAt,
          lte: pos.updatedAt,
        };
      }

      const [allOrders, auditEvents] = await Promise.all([
        this.prisma.order.findMany({
          where: orderWhere,
          orderBy: { createdAt: 'asc' },
        }),
        this.prisma.auditLog.findMany({
          where: {
            eventType: {
              in: DashboardService.AUDIT_TRAIL_EVENT_WHITELIST,
            },
            details: {
              path: ['pairId'],
              equals: pos.pairId,
            },
          },
          orderBy: { createdAt: 'asc' },
          take: 100,
        }),
      ]);

      // Pass allOrders to enrichment for EXIT_PARTIAL residual size computation
      const enrichment = await this.enrichmentService.enrich(pos, allOrders);

      const positionAuditEvents = auditEvents;

      // Map orders to DTOs
      const orders: OrderDetailDto[] = allOrders.map((o) => {
        const fillPrice = o.fillPrice?.toString() ?? null;
        const requestedPrice = o.price.toString();
        let slippage: string | null = null;
        if (fillPrice) {
          slippage = new Decimal(fillPrice)
            .minus(new Decimal(requestedPrice))
            .toFixed(8);
        }
        return {
          orderId: o.orderId,
          platform: o.platform,
          side: o.side,
          requestedPrice,
          fillPrice,
          fillSize: o.fillSize?.toString() ?? null,
          slippage,
          status: o.status,
          createdAt: o.createdAt.toISOString(),
          updatedAt: o.updatedAt.toISOString(),
        };
      });

      // Map audit events to DTOs
      const auditEventDtos: AuditEventDto[] = positionAuditEvents.map((e) => {
        // Prisma Json type resolves to JsonValue which includes `any` —
        // safe cast since audit_logs.details is always a JSON object
        const details = this.parseAuditDetails(e.details, e.id);
        return {
          id: e.id,
          eventType: e.eventType,
          timestamp: e.createdAt.toISOString(),
          summary: this.summarizeAuditEvent(e.eventType, details),
        };
      });

      // Extract entry reasoning from BUDGET_RESERVED event
      const budgetEvent = positionAuditEvents.find(
        (e) => e.eventType === 'risk.budget.reserved',
      );
      const entryReasoning = budgetEvent
        ? this.summarizeAuditEvent(
            'risk.budget.reserved',
            this.parseAuditDetails(budgetEvent.details, budgetEvent.id),
          )
        : null;

      // Exit type from audit events
      let exitType: string | null = null;
      if (pos.status === 'CLOSED' || pos.status === 'EXIT_PARTIAL') {
        const exitEvent = positionAuditEvents.find(
          (e) => e.eventType === 'execution.exit.triggered',
        );
        if (exitEvent) {
          const details = this.parseAuditDetails(
            exitEvent.details,
            exitEvent.id,
          );
          exitType = (details.type as string) ?? 'unknown';
        } else {
          exitType = 'manual';
        }
      }

      // Capital breakdown
      const capitalBreakdown = this.computeCapitalBreakdown(pos, allOrders);

      // Time held
      const timeHeld = this.computeTimeHeld(
        pos.createdAt,
        pos.status === 'CLOSED' ? pos.updatedAt : new Date(),
      );

      return {
        id: pos.positionId,
        pairName:
          pos.pair.kalshiDescription ??
          pos.pair.polymarketDescription ??
          pos.pairId,
        status: pos.status,
        isPaper: pos.isPaper,
        createdAt: pos.createdAt.toISOString(),
        updatedAt: pos.updatedAt.toISOString(),
        initialEdge: new Decimal(pos.expectedEdge.toString()).toString(),
        entryPrices: this.parseJsonFieldWithEvent(
          entryPricesSchema,
          pos.entryPrices,
          {
            model: 'OpenPosition',
            field: 'entryPrices',
            recordId: pos.positionId,
          },
        ),
        currentPrices: enrichment.data.currentPrices,
        currentEdge: enrichment.data.currentEdge,
        unrealizedPnl: enrichment.data.unrealizedPnl,
        timeHeld,
        entryReasoning,
        exitType,
        orders,
        auditEvents: auditEventDtos,
        capitalBreakdown,
      };
    } catch (error) {
      this.logger.error({
        message: 'Failed to fetch position details',
        data: {
          positionId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.DATABASE_FAILURE,
        'Failed to fetch position details',
        'warning',
        'DashboardService',
      );
    }
  }

  /** Parse AuditLog.details JSON field with Zod validation.
   *  Uses safeParse to avoid breaking dashboard reads on legacy/flexible audit data. */
  private parseAuditDetails(
    value: unknown,
    _recordId?: string,
  ): Record<string, unknown> {
    const result = auditLogDetailsSchema.safeParse(value ?? {});
    return result.success
      ? result.data
      : ((value ?? {}) as Record<string, unknown>);
  }

  private parseJsonFieldWithEvent<T>(
    schema: import('zod').ZodSchema<T>,
    value: unknown,
    context: { model: string; field: string; recordId?: string },
  ): T {
    try {
      return parseJsonField(schema, value, context);
    } catch (error) {
      const zodErrors =
        error instanceof SystemHealthError
          ? ((error.metadata?.zodErrors as import('zod').ZodIssue[]) ?? [])
          : [];
      this.eventEmitter.emit(
        EVENT_NAMES.DATA_CORRUPTION_DETECTED,
        new DataCorruptionDetectedEvent(
          context.model,
          context.field,
          context.recordId,
          value,
          zodErrors,
        ),
      );
      throw error;
    }
  }

  private summarizeAuditEvent(
    eventType: string,
    rawDetails: Record<string, unknown>,
  ): string {
    // Cast to string-valued record — audit log details are always serialized strings/numbers
    const d = rawDetails as Record<string, string | undefined>;
    switch (eventType) {
      case 'risk.budget.reserved': {
        const parts: string[] = [];
        if (d.reason) parts.push(d.reason);
        if (d.bankrollPercentage)
          parts.push(`Bankroll: ${d.bankrollPercentage}`);
        return parts.length > 0
          ? parts.join('; ')
          : 'Budget reserved for execution';
      }
      case 'risk.budget.committed':
        return 'Budget committed after successful execution';
      case 'execution.order.filled':
        return `Order filled on ${d.platform ?? 'unknown'} at ${d.fillPrice ?? 'N/A'}`;
      case 'execution.order.failed':
        return `Order failed: ${d.reason ?? d.error ?? 'unknown'}`;
      case 'execution.exit.triggered':
        return `Exit triggered: ${d.type ?? 'unknown'} threshold`;
      case 'execution.single_leg.exposure':
        return `Single-leg exposure detected${d.origin ? ` (${d.origin})` : ''}`;
      case 'detection.opportunity.identified':
        return `Opportunity identified: edge ${d.edge ?? d.netEdge ?? 'N/A'}`;
      default:
        return eventType;
    }
  }

  private computeCapitalBreakdown(
    position: {
      kalshiOrder: {
        fillPrice: { toString(): string } | null;
        fillSize: { toString(): string } | null;
      } | null;
      polymarketOrder: {
        fillPrice: { toString(): string } | null;
        fillSize: { toString(): string } | null;
      } | null;
      kalshiOrderId: string | null;
      polymarketOrderId: string | null;
      kalshiSide: string | null;
      polymarketSide: string | null;
      entryKalshiFeeRate: { toString(): string } | null;
      entryPolymarketFeeRate: { toString(): string } | null;
    },
    allOrders: Array<{
      orderId: string;
      platform: string;
      fillPrice: { toString(): string } | null;
      fillSize: { toString(): string } | null;
    }>,
  ) {
    if (
      !position.kalshiOrder?.fillPrice ||
      !position.kalshiOrder?.fillSize ||
      !position.polymarketOrder?.fillPrice ||
      !position.polymarketOrder?.fillSize
    ) {
      return {
        entryCapitalKalshi: null,
        entryCapitalPolymarket: null,
        feesKalshi: null,
        feesPolymarket: null,
        grossPnl: null,
        netPnl: null,
      };
    }

    const kalshiFillPrice = new Decimal(
      position.kalshiOrder.fillPrice.toString(),
    );
    const kalshiFillSize = new Decimal(
      position.kalshiOrder.fillSize.toString(),
    );
    const polyFillPrice = new Decimal(
      position.polymarketOrder.fillPrice.toString(),
    );
    const polyFillSize = new Decimal(
      position.polymarketOrder.fillSize.toString(),
    );

    const entryCapitalKalshi = kalshiFillPrice.mul(kalshiFillSize);
    const entryCapitalPolymarket = polyFillPrice.mul(polyFillSize);

    const kalshiFeeRate = position.entryKalshiFeeRate
      ? new Decimal(position.entryKalshiFeeRate.toString())
      : new Decimal(0);
    const polyFeeRate = position.entryPolymarketFeeRate
      ? new Decimal(position.entryPolymarketFeeRate.toString())
      : new Decimal(0);

    // Compute fees and P&L from exit orders
    const entryOrderIds = new Set<string>();
    if (position.kalshiOrderId) entryOrderIds.add(position.kalshiOrderId);
    if (position.polymarketOrderId)
      entryOrderIds.add(position.polymarketOrderId);

    const exitOrders = allOrders.filter(
      (o) => !entryOrderIds.has(o.orderId) && o.fillPrice && o.fillSize,
    );

    let feesKalshi = new Decimal(0);
    let feesPolymarket = new Decimal(0);
    let grossPnl = new Decimal(0);

    for (const o of exitOrders) {
      const fp = new Decimal(o.fillPrice!.toString());
      const fs = new Decimal(o.fillSize!.toString());
      if (o.platform === 'KALSHI') {
        feesKalshi = feesKalshi.plus(fp.mul(fs).mul(kalshiFeeRate));
        // Per-leg P&L: buy side = (exit - entry) * size, sell side = (entry - exit) * size
        const legPnl =
          position.kalshiSide === 'buy'
            ? fp.minus(kalshiFillPrice).mul(fs)
            : kalshiFillPrice.minus(fp).mul(fs);
        grossPnl = grossPnl.plus(legPnl);
      } else if (o.platform === 'POLYMARKET') {
        feesPolymarket = feesPolymarket.plus(fp.mul(fs).mul(polyFeeRate));
        const legPnl =
          position.polymarketSide === 'buy'
            ? fp.minus(polyFillPrice).mul(fs)
            : polyFillPrice.minus(fp).mul(fs);
        grossPnl = grossPnl.plus(legPnl);
      }
    }

    const totalFees = feesKalshi.plus(feesPolymarket);
    const netPnl = grossPnl.minus(totalFees);

    const hasExitOrders = exitOrders.length > 0;

    return {
      entryCapitalKalshi: entryCapitalKalshi.toFixed(8),
      entryCapitalPolymarket: entryCapitalPolymarket.toFixed(8),
      feesKalshi: feesKalshi.toFixed(8),
      feesPolymarket: feesPolymarket.toFixed(8),
      grossPnl: hasExitOrders ? grossPnl.toFixed(8) : null,
      netPnl: hasExitOrders ? netPnl.toFixed(8) : null,
    };
  }

  private computeTimeHeld(start: Date, end: Date): string {
    const diffMs = end.getTime() - start.getTime();
    const totalMinutes = Math.floor(diffMs / 60000);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;

    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`);
    return parts.join(' ');
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

  /**
   * Computes realized P&L for a closed position from entry and exit order fills.
   * Per-leg P&L: Buy side: (exitFillPrice - entryFillPrice) * fillSize
   *              Sell side: (entryFillPrice - exitFillPrice) * fillSize
   * Minus exit fees per platform.
   */
  private computeRealizedPnl(
    position: {
      kalshiOrderId: string | null;
      polymarketOrderId: string | null;
      kalshiSide: string | null;
      polymarketSide: string | null;
      kalshiOrder: {
        fillPrice: { toString(): string } | null;
        fillSize: { toString(): string } | null;
      } | null;
      polymarketOrder: {
        fillPrice: { toString(): string } | null;
        fillSize: { toString(): string } | null;
      } | null;
      entryKalshiFeeRate: { toString(): string } | null;
      entryPolymarketFeeRate: { toString(): string } | null;
    },
    allPairOrders: Array<{
      orderId: string;
      platform: string;
      fillPrice: { toString(): string } | null;
      fillSize: { toString(): string } | null;
    }>,
  ): string | null {
    if (
      !position.kalshiOrder?.fillPrice ||
      !position.kalshiOrder?.fillSize ||
      !position.polymarketOrder?.fillPrice ||
      !position.polymarketOrder?.fillSize
    ) {
      return null;
    }

    const entryOrderIds = new Set<string>();
    if (position.kalshiOrderId) entryOrderIds.add(position.kalshiOrderId);
    if (position.polymarketOrderId)
      entryOrderIds.add(position.polymarketOrderId);

    const exitOrders = allPairOrders.filter(
      (o) => !entryOrderIds.has(o.orderId) && o.fillPrice && o.fillSize,
    );

    if (exitOrders.length === 0) return null;

    const kalshiEntryPrice = new Decimal(
      position.kalshiOrder.fillPrice.toString(),
    );
    const polymarketEntryPrice = new Decimal(
      position.polymarketOrder.fillPrice.toString(),
    );

    let totalPnl = new Decimal(0);

    for (const exitOrder of exitOrders) {
      const exitFillPrice = new Decimal(exitOrder.fillPrice!.toString());
      const exitFillSize = new Decimal(exitOrder.fillSize!.toString());

      if (exitOrder.platform === 'KALSHI') {
        const legPnl =
          position.kalshiSide === 'buy'
            ? exitFillPrice.minus(kalshiEntryPrice).mul(exitFillSize)
            : kalshiEntryPrice.minus(exitFillPrice).mul(exitFillSize);
        totalPnl = totalPnl.plus(legPnl);

        const feeRate = position.entryKalshiFeeRate
          ? new Decimal(position.entryKalshiFeeRate.toString())
          : new Decimal(0);
        totalPnl = totalPnl.minus(exitFillPrice.mul(exitFillSize).mul(feeRate));
      } else if (exitOrder.platform === 'POLYMARKET') {
        const legPnl =
          position.polymarketSide === 'buy'
            ? exitFillPrice.minus(polymarketEntryPrice).mul(exitFillSize)
            : polymarketEntryPrice.minus(exitFillPrice).mul(exitFillSize);
        totalPnl = totalPnl.plus(legPnl);

        const feeRate = position.entryPolymarketFeeRate
          ? new Decimal(position.entryPolymarketFeeRate.toString())
          : new Decimal(0);
        totalPnl = totalPnl.minus(exitFillPrice.mul(exitFillSize).mul(feeRate));
      }
    }

    return totalPnl.toFixed(8);
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
