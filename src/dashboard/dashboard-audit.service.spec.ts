import { describe, it, expect, vi, beforeEach } from 'vitest';
import Decimal from 'decimal.js';
import { DashboardAuditService } from './dashboard-audit.service';
import { PrismaService } from '../common/prisma.service';
import { PositionEnrichmentService } from './position-enrichment.service';
import { DashboardCapitalService } from './dashboard-capital.service';

function createMockPrisma() {
  return {
    openPosition: {
      findUnique: vi.fn(),
    },
    order: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    auditLog: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  } as unknown as PrismaService;
}

function createMockEnrichmentService() {
  return {
    enrich: vi.fn().mockResolvedValue({
      status: 'enriched',
      data: {
        currentPrices: { kalshi: '0.60', polymarket: '0.40' },
        currentEdge: '0.08000000',
        unrealizedPnl: '8.00000000',
        exitProximity: null,
        resolutionDate: null,
        timeToResolution: null,
        recalculatedEdge: null,
        edgeDelta: null,
        lastRecalculatedAt: null,
        dataSource: null,
        dataFreshnessMs: null,
        exitMode: null,
        exitCriteria: null,
        closestCriterion: null,
        closestProximity: null,
      },
    }),
  } as unknown as PositionEnrichmentService;
}

function createMockEventEmitter() {
  return {
    emit: vi.fn(),
  };
}

function createMockCapitalService() {
  return {
    computeCapitalBreakdown: vi.fn().mockReturnValue({
      entryCapitalKalshi: '22.50000000',
      entryCapitalPolymarket: '22.50000000',
      feesKalshi: '0.00000000',
      feesPolymarket: '0.00000000',
      grossPnl: null,
      netPnl: null,
    }),
    computeRealizedPnl: vi.fn().mockReturnValue(null),
    computeTimeHeld: vi.fn().mockReturnValue('2d 5h 30m'),
  } as unknown as DashboardCapitalService;
}

describe('DashboardAuditService', () => {
  let service: DashboardAuditService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let enrichmentService: ReturnType<typeof createMockEnrichmentService>;
  let eventEmitter: ReturnType<typeof createMockEventEmitter>;
  let capitalService: ReturnType<typeof createMockCapitalService>;

  beforeEach(() => {
    prisma = createMockPrisma();
    enrichmentService = createMockEnrichmentService();
    eventEmitter = createMockEventEmitter();
    capitalService = createMockCapitalService();

    service = new DashboardAuditService(
      prisma,
      enrichmentService as any,
      eventEmitter as any,
      capitalService as any,
    );
  });

  describe('getPositionDetails', () => {
    const mockPosition = {
      positionId: 'pos-1',
      pairId: 'pair-1',
      status: 'OPEN',
      isPaper: false,
      expectedEdge: new Decimal('0.012'),
      entryPrices: { kalshi: '0.55', polymarket: '0.45' },
      createdAt: new Date('2026-03-01T10:00:00Z'),
      updatedAt: new Date('2026-03-01T12:00:00Z'),
      executionMetadata: null,
      realizedPnl: null,
      kalshiOrder: {
        orderId: 'order-k-1',
        fillPrice: new Decimal('0.55'),
        fillSize: new Decimal('100'),
      },
      polymarketOrder: {
        orderId: 'order-p-1',
        fillPrice: new Decimal('0.45'),
        fillSize: new Decimal('100'),
      },
      kalshiOrderId: 'order-k-1',
      polymarketOrderId: 'order-p-1',
      kalshiSide: 'buy',
      polymarketSide: 'sell',
      entryKalshiFeeRate: null,
      entryPolymarketFeeRate: null,
      pair: {
        kalshiContractId: 'k-contract',
        polymarketContractId: 'p-contract',
        kalshiDescription: 'Kalshi Yes',
        polymarketDescription: 'Poly Yes',
      },
    };

    it('should assemble full position detail with orders and audit events', async () => {
      (
        prisma.openPosition.findUnique as ReturnType<typeof vi.fn>
      ).mockResolvedValue(mockPosition);

      const result = await service.getPositionDetails('pos-1');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('pos-1');
      expect(result!.pairId).toBe('pair-1');
      expect(result!.initialEdge).toBe('0.012');
      expect(result!.capitalBreakdown).toBeDefined();
      expect(result!.timeHeld).toBe('2d 5h 30m');
    });

    it('should return null for non-existent position', async () => {
      (
        prisma.openPosition.findUnique as ReturnType<typeof vi.fn>
      ).mockResolvedValue(null);

      const result = await service.getPositionDetails('pos-nonexistent');
      expect(result).toBeNull();
    });

    it('should bound orders by position lifecycle timestamps', async () => {
      const closedPos = {
        ...mockPosition,
        status: 'CLOSED',
        realizedPnl: new Decimal('5.0'),
      };
      (
        prisma.openPosition.findUnique as ReturnType<typeof vi.fn>
      ).mockResolvedValue(closedPos);

      await service.getPositionDetails('pos-1');

      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            pairId: 'pair-1',
            createdAt: {
              gte: closedPos.createdAt,
              lte: closedPos.updatedAt,
            },
          }),
        }),
      );
    });

    it('should extract entry reasoning from BUDGET_RESERVED audit event', async () => {
      (
        prisma.openPosition.findUnique as ReturnType<typeof vi.fn>
      ).mockResolvedValue(mockPosition);
      (prisma.auditLog.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: 'audit-1',
          eventType: 'risk.budget.reserved',
          createdAt: new Date('2026-03-01T10:00:00Z'),
          details: { reason: 'Edge above threshold', bankrollPercentage: '3%' },
        },
      ]);

      const result = await service.getPositionDetails('pos-1');
      expect(result!.entryReasoning).toContain('Edge above threshold');
    });
  });

  describe('mapExecutionMetadata', () => {
    it('should map JSON metadata to flat DTO fields', () => {
      const result = service.mapExecutionMetadata({
        primaryLeg: 'kalshi',
        sequencingReason: 'latency',
        kalshiLatencyMs: 50,
        polymarketLatencyMs: 120,
        idealCount: 10,
        matchedCount: 8,
        kalshiDataSource: 'rest',
        polymarketDataSource: 'ws',
        divergenceDetected: false,
      });

      expect(result).toEqual({
        executionPrimaryLeg: 'kalshi',
        executionSequencingReason: 'latency',
        executionKalshiLatencyMs: 50,
        executionPolymarketLatencyMs: 120,
        executionIdealCount: 10,
        executionMatchedCount: 8,
        executionKalshiDataSource: 'rest',
        executionPolymarketDataSource: 'ws',
        executionDivergenceDetected: false,
      });
    });

    it('should return nulls for null/non-object metadata', () => {
      const result = service.mapExecutionMetadata(null);
      expect(result.executionPrimaryLeg).toBeNull();
      expect(result.executionKalshiLatencyMs).toBeNull();
    });
  });

  describe('parseAuditDetails', () => {
    it('should parse valid audit details', () => {
      const result = service.parseAuditDetails({ key: 'value' });
      expect(result).toEqual({ key: 'value' });
    });

    it('should return raw value on parse failure', () => {
      const result = service.parseAuditDetails(null);
      expect(result).toEqual({});
    });
  });

  describe('summarizeAuditEvent', () => {
    it('should summarize risk.budget.reserved event', () => {
      const result = service.summarizeAuditEvent('risk.budget.reserved', {
        reason: 'Edge above threshold',
        bankrollPercentage: '3%',
      });
      expect(result).toContain('Edge above threshold');
      expect(result).toContain('3%');
    });

    it('should summarize execution.order.filled event', () => {
      const result = service.summarizeAuditEvent('execution.order.filled', {
        platform: 'KALSHI',
        fillPrice: '0.55',
      });
      expect(result).toContain('KALSHI');
      expect(result).toContain('0.55');
    });

    it('should summarize execution.exit.triggered event', () => {
      const result = service.summarizeAuditEvent('execution.exit.triggered', {
        type: 'stop_loss',
      });
      expect(result).toContain('stop_loss');
    });

    it('should return eventType for unknown events', () => {
      const result = service.summarizeAuditEvent('unknown.event', {});
      expect(result).toBe('unknown.event');
    });

    it('should summarize detection.opportunity.identified event', () => {
      const result = service.summarizeAuditEvent(
        'detection.opportunity.identified',
        { edge: '0.015' },
      );
      expect(result).toContain('0.015');
    });

    it('should summarize execution.single_leg.exposure event', () => {
      const result = service.summarizeAuditEvent(
        'execution.single_leg.exposure',
        { origin: 'timeout' },
      );
      expect(result).toContain('timeout');
    });

    it('should summarize execution.order.failed event', () => {
      const result = service.summarizeAuditEvent('execution.order.failed', {
        reason: 'insufficient_funds',
      });
      expect(result).toContain('insufficient_funds');
    });
  });

  describe('AUDIT_TRAIL_EVENT_WHITELIST', () => {
    it('should contain expected event types', () => {
      expect(DashboardAuditService.AUDIT_TRAIL_EVENT_WHITELIST).toContain(
        'detection.opportunity.identified',
      );
      expect(DashboardAuditService.AUDIT_TRAIL_EVENT_WHITELIST).toContain(
        'execution.order.filled',
      );
      expect(DashboardAuditService.AUDIT_TRAIL_EVENT_WHITELIST).toContain(
        'execution.exit.triggered',
      );
      expect(DashboardAuditService.AUDIT_TRAIL_EVENT_WHITELIST).toHaveLength(7);
    });
  });
});
