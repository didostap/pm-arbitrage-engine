import { Injectable, Logger } from '@nestjs/common';
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
import { PrismaService } from '../common/prisma.service';
import type {
  PositionFullDetailDto,
  OrderDetailDto,
  AuditEventDto,
} from './dto/position-detail.dto';
import { PositionEnrichmentService } from './position-enrichment.service';
import type { PositionId } from '../common/types/branded.type';
import { DashboardCapitalService } from './dashboard-capital.service';

/**
 * Handles position detail assembly, audit trail parsing, and execution metadata mapping.
 * Extracted from DashboardService (Story 10-8-4).
 *
 * Constructor deps: 4 (PrismaService, PositionEnrichmentService, EventEmitter2,
 * DashboardCapitalService). Under 5 limit.
 */
@Injectable()
export class DashboardAuditService {
  private readonly logger = new Logger(DashboardAuditService.name);

  static readonly AUDIT_TRAIL_EVENT_WHITELIST = [
    'detection.opportunity.identified',
    'risk.budget.reserved',
    'risk.budget.committed',
    'execution.order.filled',
    'execution.order.failed',
    'execution.exit.triggered',
    'execution.single_leg.exposure',
  ];

  constructor(
    private readonly prisma: PrismaService,
    private readonly enrichmentService: PositionEnrichmentService,
    private readonly eventEmitter: EventEmitter2,
    private readonly capitalService: DashboardCapitalService,
  ) {}

  async getPositionDetails(
    positionId: PositionId | string,
  ): Promise<PositionFullDetailDto | null> {
    try {
      const pos = await this.prisma.openPosition.findUnique({
        where: { positionId },
        include: { pair: true, kalshiOrder: true, polymarketOrder: true },
      });

      if (!pos) return null;

      const orderWhere: Record<string, unknown> = {
        pairId: pos.pairId,
        createdAt: { gte: pos.createdAt },
      };

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
              in: DashboardAuditService.AUDIT_TRAIL_EVENT_WHITELIST,
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

      const enrichment = await this.enrichmentService.enrich(pos, allOrders);

      const positionAuditEvents = auditEvents;

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

      const auditEventDtos: AuditEventDto[] = positionAuditEvents.map((e) => {
        const details = this.parseAuditDetails(e.details, e.id);
        return {
          id: e.id,
          eventType: e.eventType,
          timestamp: e.createdAt.toISOString(),
          summary: this.summarizeAuditEvent(e.eventType, details),
          details: details ?? null,
        };
      });

      const budgetEvent = positionAuditEvents.find(
        (e) => e.eventType === 'risk.budget.reserved',
      );
      const entryReasoning = budgetEvent
        ? this.summarizeAuditEvent(
            'risk.budget.reserved',
            this.parseAuditDetails(budgetEvent.details, budgetEvent.id),
          )
        : null;

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

      const capitalBreakdown = this.capitalService.computeCapitalBreakdown(
        pos,
        allOrders,
      );

      const timeHeld = this.capitalService.computeTimeHeld(
        pos.createdAt,
        pos.status === 'CLOSED' ? pos.updatedAt : new Date(),
      );

      return {
        id: pos.positionId,
        pairId: pos.pairId,
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
        realizedPnl:
          pos.realizedPnl !== null && pos.realizedPnl !== undefined
            ? new Decimal(pos.realizedPnl.toString()).toFixed(8)
            : pos.status === 'CLOSED'
              ? this.capitalService.computeRealizedPnl(pos, allOrders)
              : null,
        timeHeld,
        entryReasoning,
        exitType,
        orders,
        auditEvents: auditEventDtos,
        capitalBreakdown,
        recalculatedEdge: enrichment.data.recalculatedEdge ?? null,
        edgeDelta: enrichment.data.edgeDelta ?? null,
        lastRecalculatedAt: enrichment.data.lastRecalculatedAt ?? null,
        dataSource: enrichment.data.dataSource ?? null,
        dataFreshnessMs: enrichment.data.dataFreshnessMs ?? null,
        exitMode: enrichment.data.exitMode ?? null,
        exitCriteria: enrichment.data.exitCriteria ?? null,
        closestCriterion: enrichment.data.closestCriterion ?? null,
        closestProximity: enrichment.data.closestProximity ?? null,
        ...this.mapExecutionMetadata(pos.executionMetadata),
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
        'DashboardAuditService',
      );
    }
  }

  mapExecutionMetadata(metadata: unknown): Record<string, unknown> {
    if (!metadata || typeof metadata !== 'object') {
      return {
        executionPrimaryLeg: null,
        executionSequencingReason: null,
        executionKalshiLatencyMs: null,
        executionPolymarketLatencyMs: null,
        executionIdealCount: null,
        executionMatchedCount: null,
        executionKalshiDataSource: null,
        executionPolymarketDataSource: null,
        executionDivergenceDetected: null,
      };
    }
    const m = metadata as Record<string, unknown>;
    return {
      executionPrimaryLeg: (m.primaryLeg as string) ?? null,
      executionSequencingReason: (m.sequencingReason as string) ?? null,
      executionKalshiLatencyMs: (m.kalshiLatencyMs as number) ?? null,
      executionPolymarketLatencyMs: (m.polymarketLatencyMs as number) ?? null,
      executionIdealCount: (m.idealCount as number) ?? null,
      executionMatchedCount: (m.matchedCount as number) ?? null,
      executionKalshiDataSource: (m.kalshiDataSource as string) ?? null,
      executionPolymarketDataSource: (m.polymarketDataSource as string) ?? null,
      executionDivergenceDetected: (m.divergenceDetected as boolean) ?? null,
    };
  }

  parseAuditDetails(
    value: unknown,
    _recordId?: string,
  ): Record<string, unknown> {
    const result = auditLogDetailsSchema.safeParse(value ?? {});
    return result.success
      ? result.data
      : ((value ?? {}) as Record<string, unknown>);
  }

  parseJsonFieldWithEvent<T>(
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

  summarizeAuditEvent(
    eventType: string,
    rawDetails: Record<string, unknown>,
  ): string {
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
}
