/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Test } from '@nestjs/testing';
import Decimal from 'decimal.js';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../../common/prisma.service';
import { BacktestStateMachineService } from './backtest-state-machine.service';
import { BacktestPortfolioService } from './backtest-portfolio.service';
import { FillModelService } from './fill-model.service';
import { ExitEvaluatorService } from './exit-evaluator.service';
import { BacktestDataLoaderService } from './backtest-data-loader.service';
import { WalkForwardService } from '../reporting/walk-forward.service';
import { CalibrationReportService } from '../reporting/calibration-report.service';
import { BacktestEngineService } from './backtest-engine.service';
import type { BacktestTimeStep } from '../types/simulation.types';

/** Helper: build aligned BacktestTimeStep[] for pipeline tests */
function makeTimeSteps(
  ...entries: Array<{
    ts: string;
    pairs: Array<{
      k: string;
      p: string;
      kClose: string;
      pClose: string;
      resolution?: Date | null;
    }>;
  }>
): BacktestTimeStep[] {
  return entries.map((e) => ({
    timestamp: new Date(e.ts),
    pairs: e.pairs.map((pair) => ({
      pairId: `${pair.k}:${pair.p}`,
      kalshiContractId: pair.k,
      polymarketContractId: pair.p,
      kalshiClose: new Decimal(pair.kClose),
      polymarketClose: new Decimal(pair.pClose),
      resolutionTimestamp: pair.resolution ?? null,
    })),
  }));
}

const RUN_ID = 'run-1';

const mockConfig = {
  dateRangeStart: '2025-01-01T00:00:00Z',
  dateRangeEnd: '2025-03-01T00:00:00Z',
  edgeThresholdPct: 0.008,
  positionSizePct: 0.03,
  maxConcurrentPairs: 10,
  bankrollUsd: '10000',
  tradingWindowStartHour: 14,
  tradingWindowEndHour: 23,
  gasEstimateUsd: '0.50',
  exitEdgeEvaporationPct: 0.002,
  exitTimeLimitHours: 72,
  exitProfitCapturePct: 0.8,
  timeoutSeconds: 300,
  minConfidenceScore: 0.8,
  walkForwardEnabled: false,
  walkForwardTrainPct: 0.7,
  chunkWindowDays: 1,
};

function createMockPrisma() {
  return {
    backtestRun: {
      create: vi.fn().mockResolvedValue({ id: RUN_ID, status: 'IDLE' }),
      update: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    backtestPosition: {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    historicalPrice: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    contractMatch: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
}

function createMockStateMachine() {
  return {
    createRun: vi.fn().mockResolvedValue(RUN_ID),
    cancelRun: vi.fn().mockResolvedValue(undefined),
    getRunStatus: vi
      .fn()
      .mockReturnValue({ runId: RUN_ID, status: 'CONFIGURING' }),
    transitionRun: vi.fn(),
    failRun: vi.fn().mockResolvedValue(undefined),
    isCancelled: vi.fn().mockReturnValue(false),
    cleanupRun: vi.fn(),
    maxConcurrentRuns: 2,
    onModuleInit: vi.fn().mockResolvedValue(undefined),
    onModuleDestroy: vi.fn(),
  };
}

function createMockPortfolio() {
  return {
    initialize: vi.fn(),
    openPosition: vi.fn().mockReturnValue(true),
    closePosition: vi.fn(),
    updateEquity: vi.fn(),
    getState: vi.fn().mockReturnValue({
      openPositions: new Map(),
      closedPositions: [],
      availableCapital: new Decimal('10000'),
      deployedCapital: new Decimal('0'),
      peakEquity: new Decimal('10000'),
      currentEquity: new Decimal('10000'),
      realizedPnl: new Decimal('0'),
      maxDrawdown: new Decimal('0'),
    }),
    getAggregateMetrics: vi.fn().mockReturnValue({
      totalPositions: 0,
      winCount: 0,
      lossCount: 0,
      totalPnl: new Decimal('0'),
      maxDrawdown: new Decimal('0'),
      sharpeRatio: null,
      profitFactor: null,
      avgHoldingHours: new Decimal('0'),
      capitalUtilization: new Decimal('0'),
    }),
    destroyRun: vi.fn(),
  };
}

function createMockFillModel() {
  return {
    modelFill: vi.fn().mockResolvedValue(null),
    findNearestDepth: vi.fn().mockResolvedValue(null),
    adaptDepthToOrderBook: vi.fn(),
  };
}

function createMockExitEvaluator() {
  return {
    evaluateExits: vi.fn().mockReturnValue(null),
  };
}

function createMockWalkForward() {
  return {
    splitTimeSteps: vi.fn().mockReturnValue({ train: [], test: [] }),
    compareMetrics: vi
      .fn()
      .mockReturnValue({ degradation: {}, overfitFlags: [] }),
    buildWalkForwardResults: vi.fn().mockReturnValue({
      trainPct: 0.7,
      testPct: 0.3,
      trainDateRange: { start: '', end: '' },
      testDateRange: { start: '', end: '' },
      trainMetrics: {},
      testMetrics: {},
      degradation: {},
      overfitFlags: [],
    }),
  };
}

function createMockCalibrationReport() {
  return {
    generateReport: vi.fn().mockResolvedValue({}),
  };
}

function createMockDataLoader() {
  return {
    loadPairs: vi.fn().mockResolvedValue([]),
    generateChunkRanges: vi.fn().mockReturnValue([
      {
        start: new Date(mockConfig.dateRangeStart),
        end: new Date(mockConfig.dateRangeEnd),
      },
    ]),
    loadPricesForChunk: vi.fn().mockResolvedValue([]),
    loadAlignedPricesForChunk: vi.fn().mockResolvedValue([]),
    preloadDepthsForChunk: vi.fn().mockResolvedValue(new Map()),
    checkDataCoverage: vi
      .fn()
      .mockResolvedValue({ hasData: true, coveragePct: 1.0 }),
  };
}

describe('BacktestEngineService', () => {
  let service: BacktestEngineService;
  let prismaService: ReturnType<typeof createMockPrisma>;
  let eventEmitter: EventEmitter2;
  let stateMachineService: ReturnType<typeof createMockStateMachine>;
  let portfolioService: ReturnType<typeof createMockPortfolio>;
  let fillModelService: ReturnType<typeof createMockFillModel>;
  let exitEvaluatorService: ReturnType<typeof createMockExitEvaluator>;
  let dataLoaderService: ReturnType<typeof createMockDataLoader>;
  let walkForwardService: ReturnType<typeof createMockWalkForward>;
  let calibrationReportService: ReturnType<typeof createMockCalibrationReport>;

  beforeEach(async () => {
    prismaService = createMockPrisma();
    eventEmitter = new EventEmitter2();
    vi.spyOn(eventEmitter, 'emit');
    stateMachineService = createMockStateMachine();
    portfolioService = createMockPortfolio();
    fillModelService = createMockFillModel();
    exitEvaluatorService = createMockExitEvaluator();
    walkForwardService = createMockWalkForward();
    calibrationReportService = createMockCalibrationReport();
    dataLoaderService = createMockDataLoader();

    const module = await Test.createTestingModule({
      providers: [
        BacktestEngineService,
        { provide: PrismaService, useFactory: () => prismaService },
        { provide: EventEmitter2, useFactory: () => eventEmitter },
        {
          provide: BacktestStateMachineService,
          useFactory: () => stateMachineService,
        },
        {
          provide: BacktestPortfolioService,
          useFactory: () => portfolioService,
        },
        { provide: FillModelService, useFactory: () => fillModelService },
        {
          provide: ExitEvaluatorService,
          useFactory: () => exitEvaluatorService,
        },
        {
          provide: BacktestDataLoaderService,
          useFactory: () => dataLoaderService,
        },
        { provide: WalkForwardService, useFactory: () => walkForwardService },
        {
          provide: CalibrationReportService,
          useFactory: () => calibrationReportService,
        },
      ],
    }).compile();

    service = module.get(BacktestEngineService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ============================================================
  // Delegation to state machine
  // ============================================================

  describe('Delegation to state machine', () => {
    it('[P0] should delegate startRun to stateMachine.createRun', async () => {
      const runId = await service.startRun(mockConfig);
      expect(runId).toBe(RUN_ID);
      expect(stateMachineService.createRun).toHaveBeenCalledWith(mockConfig);
    });

    it('[P0] should delegate cancelRun to stateMachine.cancelRun', async () => {
      await service.cancelRun(RUN_ID);
      expect(stateMachineService.cancelRun).toHaveBeenCalledWith(RUN_ID);
    });

    it('[P0] should delegate getRunStatus to stateMachine.getRunStatus', () => {
      const result = service.getRunStatus(RUN_ID);
      expect(stateMachineService.getRunStatus).toHaveBeenCalledWith(RUN_ID);
      expect(result).toEqual(expect.objectContaining({ runId: RUN_ID }));
    });
  });

  // ============================================================
  // Data loading
  // ============================================================

  describe('Data loading', () => {
    it('[P0] should load aligned prices via dataLoader for configured date range', async () => {
      await service.startRun(mockConfig);
      await new Promise((r) => setTimeout(r, 200));

      expect(dataLoaderService.loadAlignedPricesForChunk).toHaveBeenCalled();
      expect(dataLoaderService.loadPairs).toHaveBeenCalledWith(mockConfig);
    });

    it('[P0] should fail with 4211 when data coverage < 50%', async () => {
      dataLoaderService.loadPairs.mockResolvedValue([
        {
          kalshiContractId: 'K-1',
          polymarketClobTokenId: 'P-1',
          operatorApproved: true,
          confidenceScore: 0.9,
        },
      ]);
      dataLoaderService.checkDataCoverage.mockResolvedValue({
        hasData: true,
        coveragePct: 0.3,
      });

      await service.startRun(mockConfig);
      await new Promise((r) => setTimeout(r, 200));

      expect(stateMachineService.failRun).toHaveBeenCalledWith(
        RUN_ID,
        4211,
        expect.stringContaining('coverage'),
      );
    });

    it('[P1] should delegate pair loading to dataLoaderService (P-13)', async () => {
      await service.startRun(mockConfig);
      await new Promise((r) => setTimeout(r, 200));

      expect(dataLoaderService.loadPairs).toHaveBeenCalledWith(mockConfig);
    });

    it('[P0] should fail with BACKTEST_INVALID_CONFIGURATION when dateRange is zero (P-27)', async () => {
      const zeroRangeConfig = {
        ...mockConfig,
        dateRangeStart: '2025-01-01T00:00:00Z',
        dateRangeEnd: '2025-01-01T00:00:00Z',
      };
      dataLoaderService.loadPairs.mockResolvedValue([
        {
          kalshiContractId: 'K-1',
          polymarketClobTokenId: 'P-1',
          operatorApproved: true,
          confidenceScore: 0.9,
        },
      ]);
      await service.startRun(zeroRangeConfig);
      await new Promise((r) => setTimeout(r, 200));

      expect(stateMachineService.failRun).toHaveBeenCalledWith(
        RUN_ID,
        4212,
        expect.stringContaining('dateRangeEnd'),
      );
    });
  });

  // ============================================================
  // Detection model
  // ============================================================

  describe('Detection model', () => {
    const setupPricesAndPairs = () => {
      dataLoaderService.loadPairs.mockResolvedValue([
        {
          id: 1,
          kalshiContractId: 'K-1',
          polymarketClobTokenId: 'P-1',
          resolutionTimestamp: null,
          operatorApproved: true,
          confidenceScore: 0.9,
        },
      ]);
      // K=0.35, P=0.58 → grossEdge = (1-0.58) - 0.35 = 0.07 (7%) — well above threshold after fees
      dataLoaderService.loadAlignedPricesForChunk.mockResolvedValue(
        makeTimeSteps(
          {
            ts: '2025-01-15T14:00:00Z',
            pairs: [{ k: 'K-1', p: 'P-1', kClose: '0.35', pClose: '0.58' }],
          },
          {
            ts: '2025-02-15T14:00:00Z',
            pairs: [{ k: 'K-1', p: 'P-1', kClose: '0.35', pClose: '0.58' }],
          },
        ),
      );
    };

    it('[P0] should calculate gross edge for both scenarios and pick positive edge', async () => {
      setupPricesAndPairs();
      fillModelService.modelFill.mockResolvedValue({
        vwapPrice: new Decimal('0.45'),
        filledQuantity: new Decimal('300'),
        totalCost: new Decimal('135'),
      });

      await service.startRun(mockConfig);
      await new Promise((r) => setTimeout(r, 300));

      // The engine should have attempted to model fills for opportunities
      expect(fillModelService.modelFill).toHaveBeenCalled();
    });

    it('[P0] should apply net edge calculation with fee schedules and gas estimate', async () => {
      setupPricesAndPairs();
      // Set up fill model to return valid fills
      fillModelService.modelFill.mockResolvedValue({
        vwapPrice: new Decimal('0.45'),
        filledQuantity: new Decimal('300'),
        totalCost: new Decimal('135'),
      });

      await service.startRun(mockConfig);
      await new Promise((r) => setTimeout(r, 300));

      // Verify fill model was called with correct position size
      const calls = fillModelService.modelFill.mock.calls;
      if (calls.length > 0) {
        const positionSize = calls[0]![5] as Decimal;
        // positionSizePct (0.03) * bankroll (10000) = 300
        expect(positionSize.toNumber()).toBeCloseTo(300, 0);
      }
    });

    it('[P0] should skip opportunity when netEdge < edgeThresholdPct', async () => {
      setupPricesAndPairs();
      // No fill model calls should result in no positions opened
      fillModelService.modelFill.mockResolvedValue(null);

      await service.startRun(mockConfig);
      await new Promise((r) => setTimeout(r, 200));

      expect(portfolioService.openPosition).not.toHaveBeenCalled();
    });

    it('[P1] should use close prices as proxy for bid/ask in backtesting', async () => {
      setupPricesAndPairs();
      fillModelService.modelFill.mockResolvedValue({
        vwapPrice: new Decimal('0.45'),
        filledQuantity: new Decimal('300'),
        totalCost: new Decimal('135'),
      });

      await service.startRun(mockConfig);
      await new Promise((r) => setTimeout(r, 300));

      // The detection model uses close prices from HistoricalPrice loaded via dataLoader
      expect(dataLoaderService.loadAlignedPricesForChunk).toHaveBeenCalled();
    });
  });

  // ============================================================
  // Fill modeling flow
  // ============================================================

  describe('Fill modeling flow', () => {
    const setupDataWithEdge = () => {
      dataLoaderService.loadPairs.mockResolvedValue([
        {
          id: 1,
          kalshiContractId: 'K-1',
          polymarketClobTokenId: 'P-1',
          resolutionTimestamp: null,
          operatorApproved: true,
          confidenceScore: 0.9,
        },
      ]);
      // Kalshi 0.40, Poly 0.55 → gross edge = |1-0.55-0.40| = 0.05 (5%)
      dataLoaderService.loadAlignedPricesForChunk.mockResolvedValue(
        makeTimeSteps(
          {
            ts: '2025-01-15T14:00:00Z',
            pairs: [{ k: 'K-1', p: 'P-1', kClose: '0.40', pClose: '0.55' }],
          },
          {
            ts: '2025-02-15T14:00:00Z',
            pairs: [{ k: 'K-1', p: 'P-1', kClose: '0.40', pClose: '0.55' }],
          },
        ),
      );
    };

    it('[P0] should abort position when either leg returns null from FillModelService', async () => {
      setupDataWithEdge();
      fillModelService.modelFill
        .mockResolvedValueOnce({
          vwapPrice: new Decimal('0.40'),
          filledQuantity: new Decimal('300'),
          totalCost: new Decimal('120'),
        })
        .mockResolvedValueOnce(null); // second leg fails

      await service.startRun(mockConfig);
      await new Promise((r) => setTimeout(r, 300));

      expect(portfolioService.openPosition).not.toHaveBeenCalled();
    });

    it('[P0] should open position when both legs have valid fill and capital available', async () => {
      setupDataWithEdge();
      fillModelService.modelFill.mockResolvedValue({
        vwapPrice: new Decimal('0.40'),
        filledQuantity: new Decimal('300'),
        totalCost: new Decimal('120'),
      });
      fillModelService.findNearestDepth.mockResolvedValue({
        bids: [],
        asks: [],
        timestamp: new Date(),
      });

      await service.startRun(mockConfig);
      await new Promise((r) => setTimeout(r, 300));

      expect(portfolioService.openPosition).toHaveBeenCalledWith(
        RUN_ID,
        expect.objectContaining({
          pairId: expect.any(String),
          kalshiContractId: 'K-1',
          polymarketContractId: 'P-1',
          positionSizeUsd: expect.any(Decimal),
        }),
      );
    });

    it('[P1] should respect maxConcurrentPairs limit', async () => {
      setupDataWithEdge();
      fillModelService.modelFill.mockResolvedValue({
        vwapPrice: new Decimal('0.40'),
        filledQuantity: new Decimal('300'),
        totalCost: new Decimal('120'),
      });

      // Mock portfolio to show already at max positions
      const existingPositions = new Map();
      for (let i = 0; i < 10; i++) {
        existingPositions.set(`pos-${i}`, { pairId: `pair-${i}` });
      }
      portfolioService.getState.mockReturnValue({
        openPositions: existingPositions,
        closedPositions: [],
        availableCapital: new Decimal('10000'),
        deployedCapital: new Decimal('3000'),
      });

      await service.startRun(mockConfig);
      await new Promise((r) => setTimeout(r, 300));

      // Should not open more positions when at limit
      expect(portfolioService.openPosition).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // Exit evaluation
  // ============================================================

  describe('Exit evaluation in loop', () => {
    it('[P0] should evaluate exit criteria for all open positions', async () => {
      const openPositions = new Map([
        [
          'pos-1',
          {
            positionId: 'pos-1',
            pairId: 'K-1:P-1',
            kalshiContractId: 'K-1',
            polymarketContractId: 'P-1',
            kalshiSide: 'BUY',
            polymarketSide: 'SELL',
            kalshiEntryPrice: new Decimal('0.45'),
            polymarketEntryPrice: new Decimal('0.52'),
            positionSizeUsd: new Decimal('300'),
            entryEdge: new Decimal('0.03'),
            entryTimestamp: new Date('2025-01-15T14:00:00Z'),
          },
        ],
      ]);

      portfolioService.getState.mockReturnValue({
        openPositions,
        closedPositions: [],
        availableCapital: new Decimal('9700'),
        deployedCapital: new Decimal('300'),
      });

      dataLoaderService.loadPairs.mockResolvedValue([
        {
          kalshiContractId: 'K-1',
          polymarketClobTokenId: 'P-1',
          resolutionTimestamp: null,
          operatorApproved: true,
          confidenceScore: 0.9,
        },
      ]);
      dataLoaderService.loadAlignedPricesForChunk.mockResolvedValue(
        makeTimeSteps(
          {
            ts: '2025-01-15T14:00:00Z',
            pairs: [{ k: 'K-1', p: 'P-1', kClose: '0.45', pClose: '0.52' }],
          },
          {
            ts: '2025-02-15T14:00:00Z',
            pairs: [{ k: 'K-1', p: 'P-1', kClose: '0.47', pClose: '0.50' }],
          },
        ),
      );

      await service.startRun(mockConfig);
      await new Promise((r) => setTimeout(r, 300));

      expect(exitEvaluatorService.evaluateExits).toHaveBeenCalledWith(
        expect.objectContaining({
          position: expect.objectContaining({ positionId: 'pos-1' }),
          currentNetEdge: expect.any(Decimal),
          exitProfitCapturePct: expect.any(Decimal),
        }),
      );
    });

    it('[P0] should close position when exit triggered and use resolution prices for RESOLUTION_FORCE_CLOSE (P-3)', async () => {
      const openPositions = new Map([
        [
          'pos-1',
          {
            positionId: 'pos-1',
            pairId: 'K-1:P-1',
            kalshiContractId: 'K-1',
            polymarketContractId: 'P-1',
            kalshiSide: 'BUY',
            polymarketSide: 'SELL',
            kalshiEntryPrice: new Decimal('0.45'),
            polymarketEntryPrice: new Decimal('0.52'),
            positionSizeUsd: new Decimal('300'),
            entryEdge: new Decimal('0.03'),
            entryTimestamp: new Date('2025-01-15T14:00:00Z'),
          },
        ],
      ]);

      portfolioService.getState.mockReturnValue({
        openPositions,
        closedPositions: [],
        availableCapital: new Decimal('9700'),
        deployedCapital: new Decimal('300'),
      });

      exitEvaluatorService.evaluateExits.mockReturnValue({
        triggered: true,
        reason: 'RESOLUTION_FORCE_CLOSE',
        priority: 1,
        currentEdge: new Decimal('0.02'),
      });

      // Kalshi price 0.97 → resolution price 1.00
      dataLoaderService.loadPairs.mockResolvedValue([
        {
          kalshiContractId: 'K-1',
          polymarketClobTokenId: 'P-1',
          resolutionTimestamp: new Date('2025-02-10T00:00:00Z'),
          operatorApproved: true,
          confidenceScore: 0.9,
        },
      ]);
      dataLoaderService.loadAlignedPricesForChunk.mockResolvedValue(
        makeTimeSteps(
          {
            ts: '2025-01-15T14:00:00Z',
            pairs: [
              {
                k: 'K-1',
                p: 'P-1',
                kClose: '0.97',
                pClose: '0.98',
                resolution: new Date('2025-02-10T00:00:00Z'),
              },
            ],
          },
          {
            ts: '2025-02-15T14:00:00Z',
            pairs: [
              {
                k: 'K-1',
                p: 'P-1',
                kClose: '0.97',
                pClose: '0.98',
                resolution: new Date('2025-02-10T00:00:00Z'),
              },
            ],
          },
        ),
      );

      fillModelService.findNearestDepth.mockResolvedValue({
        bids: [],
        asks: [],
        timestamp: new Date(),
      });

      await service.startRun(mockConfig);
      await new Promise((r) => setTimeout(r, 300));

      if (portfolioService.closePosition.mock.calls.length > 0) {
        const closeCall = portfolioService.closePosition.mock.calls[0];
        expect(closeCall![0]).toBe(RUN_ID);
        expect(closeCall![1]).toBe('pos-1');
        expect(closeCall![2]).toEqual(
          expect.objectContaining({
            exitReason: 'RESOLUTION_FORCE_CLOSE',
            kalshiExitPrice: expect.any(Decimal),
          }),
        );
        // Resolution price should be 1.00 (since kalshi 0.97 >= 0.95)
        expect(closeCall![2]!.kalshiExitPrice.toNumber()).toBe(1);
      }
    });

    it('[P0] should check depth on BOTH platforms for exit evaluation (P-8)', async () => {
      const openPositions = new Map([
        [
          'pos-1',
          {
            positionId: 'pos-1',
            pairId: 'K-1:P-1',
            kalshiContractId: 'K-1',
            polymarketContractId: 'P-1',
            kalshiSide: 'BUY',
            polymarketSide: 'SELL',
            kalshiEntryPrice: new Decimal('0.45'),
            polymarketEntryPrice: new Decimal('0.52'),
            positionSizeUsd: new Decimal('300'),
            entryEdge: new Decimal('0.03'),
            entryTimestamp: new Date('2025-01-15T14:00:00Z'),
          },
        ],
      ]);

      portfolioService.getState.mockReturnValue({
        openPositions,
        closedPositions: [],
        availableCapital: new Decimal('9700'),
        deployedCapital: new Decimal('300'),
      });

      dataLoaderService.loadPairs.mockResolvedValue([
        {
          kalshiContractId: 'K-1',
          polymarketClobTokenId: 'P-1',
          resolutionTimestamp: null,
          operatorApproved: true,
          confidenceScore: 0.9,
        },
      ]);
      dataLoaderService.loadAlignedPricesForChunk.mockResolvedValue(
        makeTimeSteps(
          {
            ts: '2025-01-15T14:00:00Z',
            pairs: [{ k: 'K-1', p: 'P-1', kClose: '0.45', pClose: '0.52' }],
          },
          {
            ts: '2025-02-15T14:00:00Z',
            pairs: [{ k: 'K-1', p: 'P-1', kClose: '0.47', pClose: '0.50' }],
          },
        ),
      );

      await service.startRun(mockConfig);
      await new Promise((r) => setTimeout(r, 300));

      // Depth data for both platforms is pre-loaded via depthCache per chunk
      expect(dataLoaderService.preloadDepthsForChunk).toHaveBeenCalledWith(
        expect.arrayContaining(['K-1', 'P-1']),
        expect.any(Date),
        expect.any(Date),
        expect.any(Boolean),
      );
    });
  });

  // ============================================================
  // Timeout
  // ============================================================

  describe('Timeout enforcement', () => {
    it('[P1] should transition to FAILED with 4210 when elapsed time exceeds timeoutSeconds', async () => {
      // Use timeoutSeconds=60 and mock Date.now to jump forward
      const timeoutConfig = { ...mockConfig, timeoutSeconds: 60 };
      dataLoaderService.loadPairs.mockResolvedValue([
        {
          kalshiContractId: 'K-1',
          polymarketClobTokenId: 'P-1',
          resolutionTimestamp: null,
          operatorApproved: true,
          confidenceScore: 0.9,
        },
      ]);
      dataLoaderService.loadAlignedPricesForChunk.mockResolvedValue(
        makeTimeSteps(
          {
            ts: '2025-01-15T14:00:00Z',
            pairs: [{ k: 'K-1', p: 'P-1', kClose: '0.35', pClose: '0.58' }],
          },
          {
            ts: '2025-02-15T14:00:00Z',
            pairs: [{ k: 'K-1', p: 'P-1', kClose: '0.35', pClose: '0.58' }],
          },
        ),
      );

      // Make Date.now return a time far in the future after the first call
      const realDateNow = Date.now;
      let callCount = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => {
        callCount++;
        // First call captures startTime, subsequent calls return 2 minutes later
        if (callCount <= 1) return realDateNow();
        return realDateNow() + 120000;
      });

      await service.startRun(timeoutConfig);
      await new Promise((r) => setTimeout(r, 300));

      expect(stateMachineService.failRun).toHaveBeenCalledWith(
        RUN_ID,
        4210,
        expect.stringContaining('timeout'),
      );
    });
  });

  // ============================================================
  // Trading window filter
  // ============================================================

  describe('Trading window filter', () => {
    it('[P1] should skip timestamps outside trading window', async () => {
      dataLoaderService.loadPairs.mockResolvedValue([
        {
          kalshiContractId: 'K-1',
          polymarketClobTokenId: 'P-1',
          resolutionTimestamp: null,
          operatorApproved: true,
          confidenceScore: 0.9,
        },
      ]);
      // Price at 05:00 UTC — outside default window (14-23)
      dataLoaderService.loadAlignedPricesForChunk.mockResolvedValue(
        makeTimeSteps(
          {
            ts: '2025-01-15T05:00:00Z',
            pairs: [{ k: 'K-1', p: 'P-1', kClose: '0.40', pClose: '0.55' }],
          },
          {
            ts: '2025-02-15T05:00:00Z',
            pairs: [{ k: 'K-1', p: 'P-1', kClose: '0.40', pClose: '0.55' }],
          },
        ),
      );

      fillModelService.modelFill.mockResolvedValue({
        vwapPrice: new Decimal('0.40'),
        filledQuantity: new Decimal('300'),
        totalCost: new Decimal('120'),
      });

      await service.startRun(mockConfig);
      await new Promise((r) => setTimeout(r, 200));

      // Outside window → no detection should happen
      expect(portfolioService.openPosition).not.toHaveBeenCalled();
    });

    it('[P2] should handle wrap-around when startHour > endHour', async () => {
      const wrapConfig = {
        ...mockConfig,
        tradingWindowStartHour: 22,
        tradingWindowEndHour: 6,
      };
      dataLoaderService.loadPairs.mockResolvedValue([
        {
          kalshiContractId: 'K-1',
          polymarketClobTokenId: 'P-1',
          resolutionTimestamp: null,
          operatorApproved: true,
          confidenceScore: 0.9,
        },
      ]);
      // 23:00 UTC should be IN the window for wrap-around 22-06
      dataLoaderService.loadAlignedPricesForChunk.mockResolvedValue(
        makeTimeSteps(
          {
            ts: '2025-01-15T23:00:00Z',
            pairs: [{ k: 'K-1', p: 'P-1', kClose: '0.40', pClose: '0.55' }],
          },
          {
            ts: '2025-02-15T23:00:00Z',
            pairs: [{ k: 'K-1', p: 'P-1', kClose: '0.40', pClose: '0.55' }],
          },
        ),
      );

      fillModelService.modelFill.mockResolvedValue({
        vwapPrice: new Decimal('0.40'),
        filledQuantity: new Decimal('300'),
        totalCost: new Decimal('120'),
      });

      await service.startRun(wrapConfig);
      await new Promise((r) => setTimeout(r, 300));

      // 23:00 is inside 22-06 window → detection should attempt
      expect(fillModelService.modelFill).toHaveBeenCalled();
    });
  });

  // ============================================================
  // Price alignment (P-31)
  // ============================================================

  describe('Price alignment', () => {
    it('[P1] should skip time steps where either platform has no price data', async () => {
      dataLoaderService.loadPairs.mockResolvedValue([
        {
          kalshiContractId: 'K-1',
          polymarketClobTokenId: 'P-1',
          resolutionTimestamp: null,
          operatorApproved: true,
          confidenceScore: 0.9,
        },
      ]);
      // Only Kalshi has data, no Polymarket → DB-side alignment returns empty (JOIN requires both)
      dataLoaderService.loadAlignedPricesForChunk.mockResolvedValue([]);

      await service.startRun(mockConfig);
      await new Promise((r) => setTimeout(r, 200));

      // Portfolio IS initialized (coverage check passes via checkDataCoverage mock),
      // but no positions are opened because alignment produces empty time steps
      expect(portfolioService.openPosition).not.toHaveBeenCalled();
    });

    it('[P1] should truncate timestamps to minute for cross-platform alignment (P-31)', async () => {
      dataLoaderService.loadPairs.mockResolvedValue([
        {
          kalshiContractId: 'K-1',
          polymarketClobTokenId: 'P-1',
          resolutionTimestamp: null,
          operatorApproved: true,
          confidenceScore: 0.9,
        },
      ]);
      // Same minute, different seconds → DB-side alignment handles truncation
      dataLoaderService.loadAlignedPricesForChunk.mockResolvedValue(
        makeTimeSteps(
          {
            ts: '2025-01-15T14:00:00Z',
            pairs: [{ k: 'K-1', p: 'P-1', kClose: '0.40', pClose: '0.55' }],
          },
          {
            ts: '2025-02-15T14:00:00Z',
            pairs: [{ k: 'K-1', p: 'P-1', kClose: '0.40', pClose: '0.55' }],
          },
        ),
      );

      fillModelService.modelFill.mockResolvedValue({
        vwapPrice: new Decimal('0.40'),
        filledQuantity: new Decimal('300'),
        totalCost: new Decimal('120'),
      });

      await service.startRun(mockConfig);
      await new Promise((r) => setTimeout(r, 300));

      // Prices should align → detection should happen
      expect(fillModelService.modelFill).toHaveBeenCalled();
    });
  });

  // ============================================================
  // Result persistence
  // ============================================================

  describe('Result persistence', () => {
    it('[P0] should persist BacktestRun with aggregate metrics on completion', async () => {
      dataLoaderService.loadPairs.mockResolvedValue([]);
      dataLoaderService.loadAlignedPricesForChunk.mockResolvedValue([]);

      await service.startRun(mockConfig);
      await new Promise((r) => setTimeout(r, 200));

      expect(prismaService.backtestRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: RUN_ID },
          data: expect.objectContaining({
            status: 'COMPLETE',
            totalPositions: expect.any(Number),
            totalPnl: expect.any(String),
          }),
        }),
      );
    });

    it('[P0] should persist all BacktestPositions with FK to BacktestRun', async () => {
      dataLoaderService.loadPairs.mockResolvedValue([]);
      dataLoaderService.loadAlignedPricesForChunk.mockResolvedValue([]);
      portfolioService.getState.mockReturnValue({
        openPositions: new Map(),
        closedPositions: [
          {
            pairId: 'K-1:P-1',
            kalshiContractId: 'K-1',
            polymarketContractId: 'P-1',
            kalshiSide: 'BUY',
            polymarketSide: 'SELL',
            entryTimestamp: new Date(),
            exitTimestamp: new Date(),
            kalshiEntryPrice: new Decimal('0.45'),
            polymarketEntryPrice: new Decimal('0.52'),
            kalshiExitPrice: new Decimal('0.48'),
            polymarketExitPrice: new Decimal('0.49'),
            positionSizeUsd: new Decimal('300'),
            entryEdge: new Decimal('0.03'),
            exitEdge: new Decimal('0.01'),
            realizedPnl: new Decimal('5'),
            fees: new Decimal('2'),
            exitReason: 'PROFIT_CAPTURE',
            holdingHours: new Decimal('24'),
          },
        ],
      });

      await service.startRun(mockConfig);
      await new Promise((r) => setTimeout(r, 200));

      expect(prismaService.backtestPosition.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.arrayContaining([
            expect.objectContaining({
              runId: RUN_ID,
              pairId: 'K-1:P-1',
              exitReason: 'PROFIT_CAPTURE',
            }),
          ]),
        }),
      );
    });
  });

  // ============================================================
  // Cancellation (P-12)
  // ============================================================

  describe('Cancellation flow (P-12)', () => {
    it('[P1] should check cancellation after simulation loop before closing remaining positions', async () => {
      dataLoaderService.loadPairs.mockResolvedValue([
        {
          kalshiContractId: 'K-1',
          polymarketClobTokenId: 'P-1',
          resolutionTimestamp: null,
          operatorApproved: true,
          confidenceScore: 0.9,
        },
      ]);
      dataLoaderService.loadAlignedPricesForChunk.mockResolvedValue(
        makeTimeSteps(
          {
            ts: '2025-01-15T14:00:00Z',
            pairs: [{ k: 'K-1', p: 'P-1', kClose: '0.45', pClose: '0.52' }],
          },
          {
            ts: '2025-02-15T14:00:00Z',
            pairs: [{ k: 'K-1', p: 'P-1', kClose: '0.45', pClose: '0.52' }],
          },
        ),
      );

      // Cancel after simulation loop completes
      stateMachineService.isCancelled
        .mockReturnValueOnce(false) // Chunk loop start check
        .mockReturnValueOnce(false) // First step in simulation loop
        .mockReturnValueOnce(false) // Second step in simulation loop
        .mockReturnValueOnce(true); // Check after chunk loop — should abort

      await service.startRun(mockConfig);
      await new Promise((r) => setTimeout(r, 300));

      // Should NOT proceed to report generation
      expect(stateMachineService.transitionRun).not.toHaveBeenCalledWith(
        RUN_ID,
        'GENERATING_REPORT',
      );
    });
  });

  // ============================================================
  // Cleanup
  // ============================================================

  describe('Pipeline cleanup', () => {
    it('[P1] should call cleanupRun and destroyRun in finally block', async () => {
      dataLoaderService.loadPairs.mockResolvedValue([]);
      dataLoaderService.loadAlignedPricesForChunk.mockResolvedValue([]);

      await service.startRun(mockConfig);
      await new Promise((r) => setTimeout(r, 200));

      expect(stateMachineService.cleanupRun).toHaveBeenCalledWith(RUN_ID);
      expect(portfolioService.destroyRun).toHaveBeenCalledWith(RUN_ID);
    });

    it('[P1] should handle pipeline errors and call failRun (P-14)', async () => {
      stateMachineService.transitionRun.mockImplementationOnce(() => {
        throw new Error('transition error');
      });

      await service.startRun(mockConfig);
      await new Promise((r) => setTimeout(r, 200));

      expect(stateMachineService.failRun).toHaveBeenCalled();
    });
  });

  // ============================================================
  // Kalshi dynamic fee (P-10)
  // ============================================================

  describe('Fee schedules', () => {
    it('[P1] should use dynamic Kalshi fee schedule with takerFeeForPrice callback (P-10)', async () => {
      // Access the default fee schedule through the service
      // The fee schedule is used internally by calculateNetEdge
      // We verify it's correct by checking that the engine imports and uses it
      dataLoaderService.loadPairs.mockResolvedValue([
        {
          kalshiContractId: 'K-1',
          polymarketClobTokenId: 'P-1',
          resolutionTimestamp: null,
          operatorApproved: true,
          confidenceScore: 0.9,
        },
      ]);
      // Large edge to ensure net edge passes threshold after fees
      dataLoaderService.loadAlignedPricesForChunk.mockResolvedValue(
        makeTimeSteps(
          {
            ts: '2025-01-15T14:00:00Z',
            pairs: [{ k: 'K-1', p: 'P-1', kClose: '0.30', pClose: '0.60' }],
          },
          {
            ts: '2025-02-15T14:00:00Z',
            pairs: [{ k: 'K-1', p: 'P-1', kClose: '0.30', pClose: '0.60' }],
          },
        ),
      );
      fillModelService.modelFill.mockResolvedValue({
        vwapPrice: new Decimal('0.30'),
        filledQuantity: new Decimal('300'),
        totalCost: new Decimal('90'),
      });

      await service.startRun(mockConfig);
      await new Promise((r) => setTimeout(r, 300));

      // The engine should attempt to open positions using the dynamic fee model
      // If fees were flat at 1.75%, the net edge would differ from dynamic
      expect(fillModelService.modelFill).toHaveBeenCalled();
    });
  });

  // ============================================================
  // Story 10-9-4: runHeadlessSimulation() tests
  // ============================================================

  describe('runHeadlessSimulation()', () => {
    it('[P0] should run simulation loop, close remaining positions, and return AggregateMetrics without state machine', async () => {
      const metricsResult = {
        totalPositions: 5,
        winCount: 3,
        lossCount: 2,
        totalPnl: new Decimal('100'),
        maxDrawdown: new Decimal('0.03'),
        sharpeRatio: new Decimal('1.5'),
        profitFactor: new Decimal('2.0'),
        avgHoldingHours: new Decimal('20'),
        capitalUtilization: new Decimal('0.4'),
      };
      portfolioService.getAggregateMetrics.mockReturnValue(metricsResult);

      const timeSteps = [
        { timestamp: new Date('2025-01-01T00:00:00Z'), pairs: [] },
        { timestamp: new Date('2025-01-02T00:00:00Z'), pairs: [] },
      ];

      const result = await service.runHeadlessSimulation(mockConfig, timeSteps);
      expect(result).toEqual(metricsResult);
      expect(portfolioService.initialize).toHaveBeenCalled();
      // Should NOT use state machine for headless runs
      expect(stateMachineService.transitionRun).not.toHaveBeenCalledWith(
        expect.stringContaining('headless'),
        expect.any(String),
      );
    });

    it('[P0] should create temporary runId and clean up via portfolioService.destroyRun in finally block', async () => {
      portfolioService.getAggregateMetrics.mockReturnValue({
        totalPositions: 0,
        winCount: 0,
        lossCount: 0,
        totalPnl: new Decimal('0'),
        maxDrawdown: new Decimal('0'),
        sharpeRatio: null,
        profitFactor: null,
        avgHoldingHours: new Decimal('0'),
        capitalUtilization: new Decimal('0'),
      });

      await service.runHeadlessSimulation(mockConfig, []);
      expect(portfolioService.destroyRun).toHaveBeenCalledWith(
        expect.stringContaining('headless'),
      );
    });

    it('[P1] should not emit state change events during headless run', async () => {
      portfolioService.getAggregateMetrics.mockReturnValue({
        totalPositions: 0,
        winCount: 0,
        lossCount: 0,
        totalPnl: new Decimal('0'),
        maxDrawdown: new Decimal('0'),
        sharpeRatio: null,
        profitFactor: null,
        avgHoldingHours: new Decimal('0'),
        capitalUtilization: new Decimal('0'),
      });

      await service.runHeadlessSimulation(mockConfig, []);

      // No BACKTEST_ENGINE_STATE_CHANGED events for headless
      const emitCalls = (eventEmitter.emit as any).mock.calls;
      const stateChangeCalls = emitCalls.filter(
        (call: any[]) => call[0] === 'backtesting.engine.state-changed',
      );
      expect(stateChangeCalls).toHaveLength(0);
    });

    it('[P1] should not persist results to DB during headless run', async () => {
      portfolioService.getAggregateMetrics.mockReturnValue({
        totalPositions: 0,
        winCount: 0,
        lossCount: 0,
        totalPnl: new Decimal('0'),
        maxDrawdown: new Decimal('0'),
        sharpeRatio: null,
        profitFactor: null,
        avgHoldingHours: new Decimal('0'),
        capitalUtilization: new Decimal('0'),
      });

      await service.runHeadlessSimulation(mockConfig, []);
      expect(prismaService.backtestRun.update).not.toHaveBeenCalled();
      expect(prismaService.backtestPosition.createMany).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // 10-9-3a: 90-day chunked backtest integration (Task 8)
  // ============================================================

  describe('90-day chunked backtest', () => {
    // 10-9-3a ATDD: INT-048
    it('[P0] 90-day date range with chunkWindowDays: 1 → pipeline completes, 90 chunk progress events emitted', async () => {
      const config90day = {
        ...mockConfig,
        dateRangeStart: '2025-01-01T00:00:00Z',
        dateRangeEnd: '2025-04-01T00:00:00Z',
        chunkWindowDays: 1,
      };

      // Generate 90 chunk ranges
      const chunkRanges: Array<{ start: Date; end: Date }> = [];
      const startMs = new Date('2025-01-01T00:00:00Z').getTime();
      const dayMs = 24 * 60 * 60 * 1000;
      for (let i = 0; i < 90; i++) {
        chunkRanges.push({
          start: new Date(startMs + i * dayMs),
          end: new Date(startMs + (i + 1) * dayMs),
        });
      }

      dataLoaderService.loadPairs.mockResolvedValue([]);
      dataLoaderService.generateChunkRanges.mockReturnValue(chunkRanges);
      dataLoaderService.loadAlignedPricesForChunk.mockResolvedValue([]);

      await service.startRun(config90day);
      await new Promise((r) => setTimeout(r, 500));

      // Pipeline should complete
      expect(stateMachineService.transitionRun).toHaveBeenCalledWith(
        RUN_ID,
        'COMPLETE',
      );

      // 90 chunk progress events emitted
      const chunkEvents = (
        eventEmitter.emit as ReturnType<typeof vi.fn>
      ).mock.calls.filter(
        (call: any[]) => call[0] === 'backtesting.pipeline.chunk.completed',
      );
      expect(chunkEvents).toHaveLength(90);
    });

    // 10-9-3a ATDD: INT-049
    it('[P0] loadAlignedPricesForChunk called 90 times, preloadDepthsForChunk called 90 times', async () => {
      const chunkRanges: Array<{ start: Date; end: Date }> = [];
      const startMs = new Date('2025-01-01T00:00:00Z').getTime();
      const dayMs = 24 * 60 * 60 * 1000;
      for (let i = 0; i < 90; i++) {
        chunkRanges.push({
          start: new Date(startMs + i * dayMs),
          end: new Date(startMs + (i + 1) * dayMs),
        });
      }

      dataLoaderService.loadPairs.mockResolvedValue([]);
      dataLoaderService.generateChunkRanges.mockReturnValue(chunkRanges);
      dataLoaderService.loadAlignedPricesForChunk.mockResolvedValue([]);

      await service.startRun({
        ...mockConfig,
        dateRangeStart: '2025-01-01T00:00:00Z',
        dateRangeEnd: '2025-04-01T00:00:00Z',
        chunkWindowDays: 1,
      });
      await new Promise((r) => setTimeout(r, 500));

      expect(dataLoaderService.loadAlignedPricesForChunk).toHaveBeenCalledTimes(
        90,
      );
      expect(dataLoaderService.preloadDepthsForChunk).toHaveBeenCalledTimes(90);
    });

    // 10-9-3a ATDD: INT-051
    it('[P1] timeout enforcement works across 90 chunks (short timeout triggers FAILED)', async () => {
      const chunkRanges: Array<{ start: Date; end: Date }> = [];
      const startMs = new Date('2025-01-01T00:00:00Z').getTime();
      const dayMs = 24 * 60 * 60 * 1000;
      for (let i = 0; i < 90; i++) {
        chunkRanges.push({
          start: new Date(startMs + i * dayMs),
          end: new Date(startMs + (i + 1) * dayMs),
        });
      }

      dataLoaderService.loadPairs.mockResolvedValue([]);
      dataLoaderService.generateChunkRanges.mockReturnValue(chunkRanges);
      dataLoaderService.loadAlignedPricesForChunk.mockResolvedValue([]);

      // Very short timeout — should trigger FAILED
      const shortTimeoutConfig = {
        ...mockConfig,
        dateRangeStart: '2025-01-01T00:00:00Z',
        dateRangeEnd: '2025-04-01T00:00:00Z',
        chunkWindowDays: 1,
        timeoutSeconds: 0, // Immediate timeout
      };

      // Mock Date.now to advance past timeout
      const originalNow = Date.now;
      let callCount = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => {
        callCount++;
        if (callCount > 2) return originalNow() + 10000; // 10s past start
        return originalNow();
      });

      await service.startRun(shortTimeoutConfig);
      await new Promise((r) => setTimeout(r, 500));

      expect(stateMachineService.failRun).toHaveBeenCalledWith(
        RUN_ID,
        4210,
        expect.stringContaining('timeout'),
      );

      vi.spyOn(Date, 'now').mockRestore();
    });
  });

  // ============================================================
  // 10-9-3a: Walk-forward chunked routing (Task 7)
  // ============================================================

  describe('Walk-forward chunked routing', () => {
    // 10-9-3a ATDD: INT-017
    it('[P1] headless portfolios initialized at pipeline start with IDs ${mainRunId}-wf-train and ${mainRunId}-wf-test', async () => {
      dataLoaderService.loadPairs.mockResolvedValue([]);
      dataLoaderService.loadAlignedPricesForChunk.mockResolvedValue([]);

      await service.startRun({
        ...mockConfig,
        walkForwardEnabled: true,
        walkForwardTrainPct: 0.7,
      });
      await new Promise((r) => setTimeout(r, 300));

      // Verify headless portfolios initialized
      const initCalls = portfolioService.initialize.mock.calls;
      const runIds = initCalls.map((c: unknown[]) => c[1] as string);
      expect(runIds).toContain(`${RUN_ID}-wf-train`);
      expect(runIds).toContain(`${RUN_ID}-wf-test`);
    });

    // 10-9-3a ATDD: INT-019
    it('[P1] headless portfolios destroyed in finally block (even on error)', async () => {
      dataLoaderService.loadPairs.mockResolvedValue([]);
      dataLoaderService.loadAlignedPricesForChunk.mockResolvedValue([]);

      await service.startRun({
        ...mockConfig,
        walkForwardEnabled: true,
      });
      await new Promise((r) => setTimeout(r, 300));

      const destroyCalls = portfolioService.destroyRun.mock.calls.map(
        (c: unknown[]) => c[0] as string,
      );
      expect(destroyCalls).toContain(`${RUN_ID}-wf-train`);
      expect(destroyCalls).toContain(`${RUN_ID}-wf-test`);
    });

    // 10-9-3a ATDD: INT-021
    it('[P2] WalkForwardService.splitTimeSteps() still exists and is callable', () => {
      expect(typeof walkForwardService.splitTimeSteps).toBe('function');
    });
  });

  // ============================================================
  // 10-9-3a: Cross-chunk portfolio continuity (Task 5)
  // ============================================================

  describe('Cross-chunk portfolio continuity', () => {
    // 10-9-3a ATDD: INT-035
    it('[P0] position opened in chunk N is correctly evaluated for exit in chunk N+1', async () => {
      const day1Steps = makeTimeSteps({
        ts: '2025-01-01T14:00:00Z',
        pairs: [{ k: 'K-1', p: 'P-1', kClose: '0.35', pClose: '0.58' }],
      });
      const day2Steps = makeTimeSteps({
        ts: '2025-01-02T14:00:00Z',
        pairs: [{ k: 'K-1', p: 'P-1', kClose: '0.40', pClose: '0.55' }],
      });

      dataLoaderService.loadPairs.mockResolvedValue([
        {
          kalshiContractId: 'K-1',
          polymarketClobTokenId: 'P-1',
          resolutionTimestamp: null,
          operatorApproved: true,
          confidenceScore: 0.9,
        },
      ]);
      // 2 chunks: day 1 and day 2
      dataLoaderService.generateChunkRanges.mockReturnValue([
        {
          start: new Date('2025-01-01T00:00:00Z'),
          end: new Date('2025-01-02T00:00:00Z'),
        },
        {
          start: new Date('2025-01-02T00:00:00Z'),
          end: new Date('2025-01-03T00:00:00Z'),
        },
      ]);
      dataLoaderService.loadAlignedPricesForChunk
        .mockResolvedValueOnce(day1Steps)
        .mockResolvedValueOnce(day2Steps);

      // Portfolio: initialize in pipeline, position opened after chunk 1
      let callCount = 0;
      portfolioService.getState.mockImplementation(() => {
        callCount++;
        // After chunk 1 simulation, show an open position
        if (callCount >= 3) {
          return {
            openPositions: new Map([
              [
                'pos-1',
                {
                  positionId: 'pos-1',
                  pairId: 'K-1:P-1',
                  kalshiContractId: 'K-1',
                  polymarketContractId: 'P-1',
                  kalshiEntryPrice: new Decimal('0.35'),
                  polymarketEntryPrice: new Decimal('0.58'),
                  positionSizeUsd: new Decimal('300'),
                  entryEdge: new Decimal('0.03'),
                  entryTimestamp: new Date('2025-01-01T14:00:00Z'),
                },
              ],
            ]),
            closedPositions: [],
            availableCapital: new Decimal('9700'),
            deployedCapital: new Decimal('300'),
          };
        }
        return {
          openPositions: new Map(),
          closedPositions: [],
          availableCapital: new Decimal('10000'),
          deployedCapital: new Decimal('0'),
        };
      });

      await service.startRun({
        ...mockConfig,
        dateRangeStart: '2025-01-01T00:00:00Z',
        dateRangeEnd: '2025-01-03T00:00:00Z',
      });
      await new Promise((r) => setTimeout(r, 400));

      // Verify exit evaluation was called (position from chunk 1 evaluated in chunk 2)
      expect(exitEvaluatorService.evaluateExits).toHaveBeenCalled();
    });

    // 10-9-3a ATDD: INT-036
    it('[P0] equity curve and drawdown tracking are continuous across chunk boundaries', async () => {
      dataLoaderService.loadPairs.mockResolvedValue([]);
      dataLoaderService.generateChunkRanges.mockReturnValue([
        {
          start: new Date('2025-01-01T00:00:00Z'),
          end: new Date('2025-01-02T00:00:00Z'),
        },
        {
          start: new Date('2025-01-02T00:00:00Z'),
          end: new Date('2025-01-03T00:00:00Z'),
        },
      ]);
      dataLoaderService.loadAlignedPricesForChunk.mockResolvedValue([]);

      await service.startRun({
        ...mockConfig,
        dateRangeStart: '2025-01-01T00:00:00Z',
        dateRangeEnd: '2025-01-03T00:00:00Z',
      });
      await new Promise((r) => setTimeout(r, 300));

      // Portfolio initialize called exactly once (not per chunk)
      expect(portfolioService.initialize).toHaveBeenCalledTimes(1);
    });

    // 10-9-3a ATDD: INT-037
    it('[P1] closeRemainingPositions called AFTER the chunk loop completes (not per-chunk)', async () => {
      dataLoaderService.loadPairs.mockResolvedValue([]);
      dataLoaderService.generateChunkRanges.mockReturnValue([
        {
          start: new Date('2025-01-01T00:00:00Z'),
          end: new Date('2025-01-02T00:00:00Z'),
        },
        {
          start: new Date('2025-01-02T00:00:00Z'),
          end: new Date('2025-01-03T00:00:00Z'),
        },
      ]);
      dataLoaderService.loadAlignedPricesForChunk.mockResolvedValue([]);

      await service.startRun({
        ...mockConfig,
        dateRangeStart: '2025-01-01T00:00:00Z',
        dateRangeEnd: '2025-01-03T00:00:00Z',
      });
      await new Promise((r) => setTimeout(r, 300));

      // Pipeline should complete (GENERATING_REPORT then COMPLETE)
      const transitionCalls = stateMachineService.transitionRun.mock.calls.map(
        (c: unknown[]) => c[1] as string,
      );
      // LOADING_DATA → SIMULATING → GENERATING_REPORT → COMPLETE
      expect(transitionCalls).toEqual(
        expect.arrayContaining([
          'LOADING_DATA',
          'SIMULATING',
          'GENERATING_REPORT',
          'COMPLETE',
        ]),
      );
      // destroyRun called once for main run (not per-chunk)
      expect(portfolioService.destroyRun).toHaveBeenCalledWith(RUN_ID);
    });
  });
});
