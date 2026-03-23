/**
 * Story 10-5.5 — Paper/Live Mode Boundary Tests: Reconciliation Module
 *
 * Verifies that recalculateRiskBudget iterates both modes independently
 * and that the reconciliation status endpoint returns only live positions.
 *
 * TDD RED PHASE — all tests use it()
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Decimal from 'decimal.js';
import type { IRiskManager } from '../../../common/interfaces/risk-manager.interface';
import type { IPlatformConnector } from '../../../common/interfaces/platform-connector.interface';
import { StartupReconciliationService } from '../../../reconciliation/startup-reconciliation.service';
import { ReconciliationController } from '../../../reconciliation/reconciliation.controller';
import { PlatformId } from '../../../common/types/platform.type';

// ──────────────────────────────────────────────────────────────
// Mock helpers
// ──────────────────────────────────────────────────────────────

function createMockPositionRepository() {
  return {
    findActivePositions: vi.fn().mockResolvedValue([]),
    findByStatus: vi.fn().mockResolvedValue([]),
    findById: vi.fn(),
    updateWithOrder: vi.fn(),
  };
}

function createMockRiskManager(): IRiskManager {
  return {
    recalculateFromPositions: vi.fn().mockResolvedValue(undefined),
    resumeTrading: vi.fn(),
    haltTrading: vi.fn(),
    closePosition: vi.fn(),
    isTradingHalted: vi.fn().mockReturnValue(false),
    getActiveHaltReasons: vi.fn().mockReturnValue([]),
    getBankrollConfig: vi.fn(),
    reloadBankroll: vi.fn(),
  } as unknown as IRiskManager;
}

function createMockConnector(platformId: PlatformId): IPlatformConnector {
  return {
    getHealth: vi.fn().mockReturnValue({
      platformId,
      status: 'healthy',
      lastHeartbeat: new Date(),
      latencyMs: 50,
      mode: 'live',
    }),
    getPlatformId: vi.fn().mockReturnValue(platformId),
    getOrder: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  } as unknown as IPlatformConnector;
}

// ──────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────

describe('Paper/Live Boundary — Reconciliation', () => {
  let positionRepository: ReturnType<typeof createMockPositionRepository>;
  let riskManager: IRiskManager;
  let kalshiConnector: IPlatformConnector;
  let polymarketConnector: IPlatformConnector;
  let eventEmitter: { emit: ReturnType<typeof vi.fn> };
  let orderRepository: { findPendingOrders: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    positionRepository = createMockPositionRepository();
    riskManager = createMockRiskManager();
    kalshiConnector = createMockConnector(PlatformId.KALSHI);
    polymarketConnector = createMockConnector(PlatformId.POLYMARKET);
    eventEmitter = { emit: vi.fn() };
    orderRepository = { findPendingOrders: vi.fn().mockResolvedValue([]) };
  });

  it('[P1] recalculateRiskBudget iterates both modes [false, true] independently', async () => {
    // ARRANGE: Create service with mocked dependencies
    const service = new StartupReconciliationService(
      {} as any, // PrismaService
      kalshiConnector,
      polymarketConnector,
      eventEmitter as any,
      riskManager,
      positionRepository as any,
      orderRepository as any,
    );

    // Set up position repository to return different positions per mode
    const livePositions = [
      {
        positionId: 'pos-live-1',
        pairId: 'pair-1',
        status: 'OPEN',
        isPaper: false,
        kalshiOrder: { fillPrice: 0.5, fillSize: 10, side: 'buy' },
        polymarketOrder: { fillPrice: 0.52, fillSize: 10, side: 'sell' },
        kalshiSide: 'buy',
        polymarketSide: 'sell',
      },
    ];
    const paperPositions = [
      {
        positionId: 'pos-paper-1',
        pairId: 'pair-2',
        status: 'OPEN',
        isPaper: true,
        kalshiOrder: { fillPrice: 0.4, fillSize: 5, side: 'buy' },
        polymarketOrder: { fillPrice: 0.42, fillSize: 5, side: 'sell' },
        kalshiSide: 'buy',
        polymarketSide: 'sell',
      },
    ];

    positionRepository.findActivePositions.mockImplementation(
      (isPaper: boolean) =>
        Promise.resolve(isPaper ? paperPositions : livePositions),
    );

    // ACT: Run reconcile() which calls recalculateRiskBudget internally
    await service.reconcile();

    // ASSERT: recalculateFromPositions called TWICE — once for live (mode='live'),
    // once for paper (mode='paper')
    const recalcCalls = (
      riskManager.recalculateFromPositions as ReturnType<typeof vi.fn>
    ).mock.calls;
    expect(recalcCalls).toHaveLength(2);

    // First call: live mode (isPaper=false)
    expect(recalcCalls[0]![2]).toBe('live');
    // Live has 1 OPEN position
    expect(recalcCalls[0]![0]).toBe(1);

    // Second call: paper mode (isPaper=true)
    expect(recalcCalls[1]![2]).toBe('paper');
    // Paper has 1 OPEN position
    expect(recalcCalls[1]![0]).toBe(1);

    // ASSERT: Capital values are computed independently (different fill prices)
    const liveCapital = recalcCalls[0]![1] as Decimal;
    const paperCapital = recalcCalls[1]![1] as Decimal;
    expect(liveCapital.toString()).not.toBe(paperCapital.toString());
  });

  it('[P1] reconciliation status endpoint returns only live positions (isPaper=false hardcode)', async () => {
    // ARRANGE: Create the controller with mocked service and repository
    const reconciliationService = {
      getLastRunResult: vi.fn().mockReturnValue(null),
      lastRunAt: null,
    };

    // The controller passes explicit isPaper=false — only live positions need reconciliation
    const mockLiveReconPositions = [
      {
        positionId: 'pos-live-recon-1',
        isPaper: false,
        status: 'RECONCILIATION_REQUIRED',
      },
    ];
    const mockPaperReconPositions = [
      {
        positionId: 'pos-paper-recon-1',
        isPaper: true,
        status: 'RECONCILIATION_REQUIRED',
      },
    ];

    // Mock with NO default — mirrors the real repository signature (isPaper: boolean, required)
    positionRepository.findByStatus.mockImplementation(
      (status: string, isPaper: boolean) =>
        Promise.resolve(
          isPaper
            ? mockPaperReconPositions.filter((p) => p.status === status)
            : mockLiveReconPositions.filter((p) => p.status === status),
        ),
    );

    const controller = new ReconciliationController(
      reconciliationService as any,
      positionRepository as any,
    );

    // ACT: Call status endpoint
    const result = await controller.status();

    // ASSERT: Only live (isPaper=false) positions are counted
    expect(result.data.outstandingDiscrepancies).toBe(1);

    // ASSERT: findByStatus was called with explicit isPaper=false (required, no default)
    expect(positionRepository.findByStatus).toHaveBeenCalledWith(
      'RECONCILIATION_REQUIRED',
      false,
    );
  });
});
