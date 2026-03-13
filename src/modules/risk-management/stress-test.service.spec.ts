import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Decimal from 'decimal.js';
import { StressTestService } from './stress-test.service';
import { RISK_MANAGER_TOKEN } from './risk-management.constants';
import { PrismaService } from '../../common/prisma.service';
import { EVENT_NAMES } from '../../common/events/event-catalog';
import { FinancialDecimal } from '../../common/utils/financial-math';

describe('StressTestService', () => {
  let service: StressTestService;
  let mockPrisma: {
    openPosition: { findMany: ReturnType<typeof vi.fn> };
    orderBookSnapshot: { findMany: ReturnType<typeof vi.fn> };
    stressTestRun: {
      create: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
    };
  };
  let mockConfigService: { get: ReturnType<typeof vi.fn> };
  let mockEventEmitter: { emit: ReturnType<typeof vi.fn> };
  let mockRiskManager: {
    getCurrentExposure: ReturnType<typeof vi.fn>;
  };

  const configDefaults: Record<string, unknown> = {
    STRESS_TEST_SCENARIOS: 50,
    STRESS_TEST_DEFAULT_DAILY_VOL: '0.03',
    STRESS_TEST_MIN_SNAPSHOTS: 30,
    RISK_MAX_POSITION_PCT: '0.03',
    RISK_MAX_OPEN_PAIRS: 10,
  };

  function makePosition(overrides: Record<string, unknown> = {}) {
    return {
      positionId: 'pos-1',
      pairId: 'pair-1',
      polymarketSide: 'BUY',
      kalshiSide: 'SELL',
      entryPrices: { polymarket: '0.55', kalshi: '0.48' },
      sizes: { polymarket: '150', kalshi: '150' },
      expectedEdge: new Decimal('0.02'),
      status: 'OPEN',
      isPaper: false,
      pair: {
        matchId: 'pair-1',
        polymarketContractId: 'poly-c1',
        kalshiContractId: 'kalshi-c1',
        clusterId: 'cluster-1',
      },
      polymarketOrder: {
        orderId: 'o1',
        contractId: 'poly-c1',
        platform: 'POLYMARKET',
      },
      kalshiOrder: {
        orderId: 'o2',
        contractId: 'kalshi-c1',
        platform: 'KALSHI',
      },
      ...overrides,
    };
  }

  beforeEach(async () => {
    vi.clearAllMocks();

    mockPrisma = {
      openPosition: { findMany: vi.fn().mockResolvedValue([]) },
      orderBookSnapshot: { findMany: vi.fn().mockResolvedValue([]) },
      stressTestRun: {
        create: vi.fn().mockResolvedValue({ id: 'run-1' }),
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };

    mockConfigService = {
      get: vi.fn((key: string) => configDefaults[key]),
    };

    mockEventEmitter = { emit: vi.fn() };

    mockRiskManager = {
      getCurrentExposure: vi.fn().mockReturnValue({
        bankrollUsd: new FinancialDecimal('10000'),
        totalCapitalDeployed: new FinancialDecimal('3000'),
        openPairCount: 5,
        availableCapital: new FinancialDecimal('7000'),
        dailyPnl: new FinancialDecimal('0'),
        dailyLossLimitUsd: new FinancialDecimal('500'),
        clusterExposures: [
          {
            clusterId: 'cluster-1',
            clusterName: 'Politics',
            exposureUsd: new FinancialDecimal('1500'),
            exposurePct: new FinancialDecimal('0.15'),
            pairCount: 3,
          },
        ],
        aggregateClusterExposurePct: new FinancialDecimal('0.15'),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StressTestService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: EventEmitter2, useValue: mockEventEmitter },
        { provide: RISK_MANAGER_TOKEN, useValue: mockRiskManager },
      ],
    }).compile();

    service = module.get<StressTestService>(StressTestService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('runSimulation', () => {
    it('should return neutral result when no open positions exist', async () => {
      mockPrisma.openPosition.findMany.mockResolvedValue([]);

      const result = await service.runSimulation('operator');

      expect(result.numPositions).toBe(0);
      expect(result.var95.toNumber()).toBe(0);
      expect(result.var99.toNumber()).toBe(0);
      expect(result.worstCaseLoss.toNumber()).toBe(0);
      expect(result.drawdown15PctProbability.toNumber()).toBe(0);
      expect(result.drawdown20PctProbability.toNumber()).toBe(0);
      expect(result.drawdown25PctProbability.toNumber()).toBe(0);
      expect(result.alertEmitted).toBe(false);
      expect(result.suggestions).toEqual([]);
    });

    it('should still persist StressTestRun when no positions exist', async () => {
      mockPrisma.openPosition.findMany.mockResolvedValue([]);

      await service.runSimulation('operator');

      expect(mockPrisma.stressTestRun.create).toHaveBeenCalledOnce();
    });

    it('should emit STRESS_TEST_COMPLETED event on every run', async () => {
      mockPrisma.openPosition.findMany.mockResolvedValue([]);

      await service.runSimulation('operator');

      const completedCall = mockEventEmitter.emit.mock.calls.find(
        (c: unknown[]) => c[0] === EVENT_NAMES.STRESS_TEST_COMPLETED,
      ) as unknown[] | undefined;
      expect(completedCall).toBeDefined();
      expect(completedCall![1]).toMatchObject({
        numPositions: 0,
      });
    });

    it('should run configured number of scenarios', async () => {
      const position = makePosition();
      mockPrisma.openPosition.findMany.mockResolvedValue([position]);

      const result = await service.runSimulation('operator');

      // 50 random + synthetic scenarios
      expect(result.numScenarios).toBeGreaterThanOrEqual(50);
    });

    it('should calculate drawdown probabilities from simulated P&L distribution', async () => {
      const position = makePosition();
      mockPrisma.openPosition.findMany.mockResolvedValue([position]);

      const result = await service.runSimulation('operator');

      // Probabilities should be between 0 and 1
      expect(result.drawdown15PctProbability.toNumber()).toBeGreaterThanOrEqual(
        0,
      );
      expect(result.drawdown15PctProbability.toNumber()).toBeLessThanOrEqual(1);
      expect(result.drawdown20PctProbability.toNumber()).toBeGreaterThanOrEqual(
        0,
      );
      expect(result.drawdown20PctProbability.toNumber()).toBeLessThanOrEqual(1);
      expect(result.drawdown25PctProbability.toNumber()).toBeGreaterThanOrEqual(
        0,
      );
      expect(result.drawdown25PctProbability.toNumber()).toBeLessThanOrEqual(1);
    });

    it('should calculate VaR at 95% and 99% confidence levels', async () => {
      const position = makePosition();
      mockPrisma.openPosition.findMany.mockResolvedValue([position]);

      const result = await service.runSimulation('operator');

      // VaR should be non-negative (represents potential loss)
      expect(result.var95.toNumber()).toBeGreaterThanOrEqual(0);
      expect(result.var99.toNumber()).toBeGreaterThanOrEqual(0);
      // VaR99 >= VaR95 (99% confidence is stricter)
      expect(result.var99.toNumber()).toBeGreaterThanOrEqual(
        result.var95.toNumber(),
      );
    });

    it('should report worst-case loss across all scenarios', async () => {
      const position = makePosition();
      mockPrisma.openPosition.findMany.mockResolvedValue([position]);

      const result = await service.runSimulation('operator');

      // Worst case should be >= VaR99
      expect(result.worstCaseLoss.toNumber()).toBeGreaterThanOrEqual(
        result.var99.toNumber(),
      );
    });

    it('should use historical volatility when sufficient snapshots exist', async () => {
      const position = makePosition();
      mockPrisma.openPosition.findMany.mockResolvedValue([position]);

      // Create 35 snapshots (above STRESS_TEST_MIN_SNAPSHOTS=30)
      const snapshots = Array.from({ length: 35 }, (_, i) => ({
        platform: 'POLYMARKET',
        contract_id: 'poly-c1',
        bids: [{ price: 0.5 + i * 0.001, quantity: 100 }],
        asks: [{ price: 0.52 + i * 0.001, quantity: 100 }],
        created_at: new Date(Date.now() - (35 - i) * 3600_000),
      }));
      mockPrisma.orderBookSnapshot.findMany.mockResolvedValue(snapshots);

      const result = await service.runSimulation('operator');

      // Should have volatility entries with 'historical' source
      const histVols = result.scenarioDetails.volatilities.filter(
        (v) => v.source === 'historical',
      );
      expect(histVols.length).toBeGreaterThan(0);
    });

    it('should fall back to default daily vol when insufficient history', async () => {
      const position = makePosition();
      mockPrisma.openPosition.findMany.mockResolvedValue([position]);
      mockPrisma.orderBookSnapshot.findMany.mockResolvedValue([]);

      const result = await service.runSimulation('operator');

      // All volatilities should use 'default' source
      const defaultVols = result.scenarioDetails.volatilities.filter(
        (v) => v.source === 'default',
      );
      expect(defaultVols.length).toBeGreaterThan(0);
    });

    it('should apply correlated shocks to positions in same cluster', async () => {
      const pos1 = makePosition({
        positionId: 'pos-1',
        pairId: 'pair-1',
        pair: {
          matchId: 'pair-1',
          polymarketContractId: 'poly-c1',
          kalshiContractId: 'kalshi-c1',
          clusterId: 'cluster-1',
        },
      });
      const pos2 = makePosition({
        positionId: 'pos-2',
        pairId: 'pair-2',
        pair: {
          matchId: 'pair-2',
          polymarketContractId: 'poly-c2',
          kalshiContractId: 'kalshi-c2',
          clusterId: 'cluster-1',
        },
        polymarketOrder: {
          orderId: 'o3',
          contractId: 'poly-c2',
          platform: 'POLYMARKET',
        },
        kalshiOrder: {
          orderId: 'o4',
          contractId: 'kalshi-c2',
          platform: 'KALSHI',
        },
      });

      mockPrisma.openPosition.findMany.mockResolvedValue([pos1, pos2]);

      const result = await service.runSimulation('operator');

      // Both positions should be simulated
      expect(result.numPositions).toBe(2);
      // Result should be valid (no NaN)
      expect(result.var95.isFinite()).toBe(true);
    });

    it('should include correlation-1 synthetic scenario (all clusters adverse)', async () => {
      const position = makePosition();
      mockPrisma.openPosition.findMany.mockResolvedValue([position]);

      const result = await service.runSimulation('operator');

      const syntheticNames = result.scenarioDetails.syntheticResults.map(
        (s) => s.name,
      );
      expect(syntheticNames).toContain('correlation-1-stress');
    });

    it('should apply synthetic adverse shocks per-position directionally (buy=down, sell=up)', async () => {
      // Position: poly BUY (loses on price down), kalshi SELL (loses on price up)
      const position = makePosition({
        polymarketSide: 'BUY',
        kalshiSide: 'SELL',
      });
      mockPrisma.openPosition.findMany.mockResolvedValue([position]);

      const result = await service.runSimulation('operator');

      // Correlation-1 stress should produce a loss (negative P&L)
      const corrStress = result.scenarioDetails.syntheticResults.find(
        (s) => s.name === 'correlation-1-stress',
      );
      expect(corrStress).toBeDefined();
      expect(parseFloat(corrStress!.portfolioPnl)).toBeLessThan(0);
    });

    it('should clamp prices to [0, 1] after shock', async () => {
      // Position with extreme entry prices near boundaries
      const position = makePosition({
        entryPrices: { polymarket: '0.98', kalshi: '0.02' },
      });
      mockPrisma.openPosition.findMany.mockResolvedValue([position]);

      // Should not throw
      const result = await service.runSimulation('operator');
      expect(result.var95.isFinite()).toBe(true);
    });

    it('should parse position sizes from sizes JSON as USD values', async () => {
      const position = makePosition({
        sizes: { polymarket: '200', kalshi: '200' },
      });
      mockPrisma.openPosition.findMany.mockResolvedValue([position]);

      const result = await service.runSimulation('operator');

      expect(result.numPositions).toBe(1);
      expect(result.var95.isFinite()).toBe(true);
    });

    it('should use decimal.js for all financial math', async () => {
      const position = makePosition();
      mockPrisma.openPosition.findMany.mockResolvedValue([position]);

      const result = await service.runSimulation('operator');

      expect(result.var95).toBeInstanceOf(Decimal);
      expect(result.var99).toBeInstanceOf(Decimal);
      expect(result.worstCaseLoss).toBeInstanceOf(Decimal);
      expect(result.bankrollUsd).toBeInstanceOf(Decimal);
      expect(result.drawdown15PctProbability).toBeInstanceOf(Decimal);
      expect(result.drawdown20PctProbability).toBeInstanceOf(Decimal);
      expect(result.drawdown25PctProbability).toBeInstanceOf(Decimal);
    });

    it('should persist StressTestRun to database', async () => {
      const position = makePosition();
      mockPrisma.openPosition.findMany.mockResolvedValue([position]);

      await service.runSimulation('operator');

      expect(mockPrisma.stressTestRun.create).toHaveBeenCalledOnce();
      const createArg = mockPrisma.stressTestRun.create.mock.calls[0]![0] as {
        data: { triggeredBy: string; numPositions: number };
      };
      expect(createArg.data).toMatchObject({
        triggeredBy: 'operator',
        numPositions: 1,
      });
    });

    it('should return neutral result when bankroll is zero', async () => {
      mockRiskManager.getCurrentExposure.mockReturnValue({
        bankrollUsd: new FinancialDecimal('0'),
        totalCapitalDeployed: new FinancialDecimal('0'),
        openPairCount: 0,
        availableCapital: new FinancialDecimal('0'),
        dailyPnl: new FinancialDecimal('0'),
        dailyLossLimitUsd: new FinancialDecimal('0'),
        clusterExposures: [],
        aggregateClusterExposurePct: new FinancialDecimal('0'),
      });
      const position = makePosition();
      mockPrisma.openPosition.findMany.mockResolvedValue([position]);

      const result = await service.runSimulation('operator');

      expect(result.var95.toNumber()).toBe(0);
      expect(result.numPositions).toBe(0);
    });

    it('should include scenario details with percentiles', async () => {
      const position = makePosition();
      mockPrisma.openPosition.findMany.mockResolvedValue([position]);

      const result = await service.runSimulation('operator');

      expect(result.scenarioDetails.percentiles).toBeDefined();
      expect(result.scenarioDetails.percentiles['p5']).toBeDefined();
      expect(result.scenarioDetails.percentiles['p95']).toBeDefined();
    });
  });

  describe('alert logic', () => {
    it('should emit STRESS_TEST_ALERT when >20% drawdown probability > 5%', async () => {
      // Deterministic random for reproducible results
      vi.spyOn(Math, 'random').mockReturnValue(0.999);

      // Lower bankroll so paired-position losses produce >20% drawdown
      mockRiskManager.getCurrentExposure.mockReturnValue({
        bankrollUsd: new FinancialDecimal('2000'),
        totalCapitalDeployed: new FinancialDecimal('3000'),
        openPairCount: 8,
        availableCapital: new FinancialDecimal('0'),
        dailyPnl: new FinancialDecimal('0'),
        dailyLossLimitUsd: new FinancialDecimal('500'),
        clusterExposures: [
          {
            clusterId: 'cluster-1',
            clusterName: 'Politics',
            exposureUsd: new FinancialDecimal('3000'),
            exposurePct: new FinancialDecimal('1.50'),
            pairCount: 8,
          },
        ],
        aggregateClusterExposurePct: new FinancialDecimal('1.50'),
      });

      // Per-test config override (no shared state mutation)
      mockConfigService.get.mockImplementation(
        (key: string) =>
          ({
            ...configDefaults,
            STRESS_TEST_DEFAULT_DAILY_VOL: '0.25',
            STRESS_TEST_SCENARIOS: 100,
          })[key],
      );

      const positions = Array.from({ length: 8 }, (_, i) =>
        makePosition({
          positionId: `pos-${i}`,
          pairId: `pair-${i}`,
          sizes: { polymarket: '1000', kalshi: '1000' },
          pair: {
            matchId: `pair-${i}`,
            polymarketContractId: `poly-c${i}`,
            kalshiContractId: `kalshi-c${i}`,
            clusterId: 'cluster-1',
          },
          polymarketOrder: {
            orderId: `o${i * 2}`,
            contractId: `poly-c${i}`,
            platform: 'POLYMARKET',
          },
          kalshiOrder: {
            orderId: `o${i * 2 + 1}`,
            contractId: `kalshi-c${i}`,
            platform: 'KALSHI',
          },
        }),
      );
      mockPrisma.openPosition.findMany.mockResolvedValue(positions);

      const result = await service.runSimulation('operator');

      expect(result.alertEmitted).toBe(true);
      expect(
        result.drawdown20PctProbability.greaterThan(new Decimal('0.05')),
      ).toBe(true);

      const alertCall = mockEventEmitter.emit.mock.calls.find(
        (c: unknown[]) => c[0] === EVENT_NAMES.STRESS_TEST_ALERT,
      ) as unknown[] | undefined;
      expect(alertCall).toBeDefined();
      const alertPayload = alertCall![1] as { suggestions: string[] };
      expect(Array.isArray(alertPayload.suggestions)).toBe(true);
      expect(result.suggestions.length).toBeGreaterThan(0);
    });

    it('should NOT emit alert when >20% drawdown probability <= 5%', async () => {
      // Deterministic random: probit(0.5) = 0, all shocks are zero
      vi.spyOn(Math, 'random').mockReturnValue(0.5);

      const position = makePosition({
        sizes: { polymarket: '10', kalshi: '10' },
      });
      mockPrisma.openPosition.findMany.mockResolvedValue([position]);

      const result = await service.runSimulation('operator');

      expect(result.alertEmitted).toBe(false);
      expect(
        result.drawdown20PctProbability.lessThanOrEqualTo(new Decimal('0.05')),
      ).toBe(true);
      const alertCalls = mockEventEmitter.emit.mock.calls.filter(
        (call) => call[0] === EVENT_NAMES.STRESS_TEST_ALERT,
      );
      expect(alertCalls.length).toBe(0);
    });
  });

  describe('cron handler', () => {
    it('should trigger simulation via weekly cron', async () => {
      mockPrisma.openPosition.findMany.mockResolvedValue([]);

      await service.handleWeeklyCron();

      expect(mockPrisma.stressTestRun.create).toHaveBeenCalledOnce();
      const createArg = mockPrisma.stressTestRun.create.mock.calls[0]![0] as {
        data: { triggeredBy: string };
      };
      expect(createArg.data.triggeredBy).toBe('cron');
    });

    it('should wrap cron execution in withCorrelationId', async () => {
      mockPrisma.openPosition.findMany.mockResolvedValue([]);

      await service.handleWeeklyCron();

      const completedCall = mockEventEmitter.emit.mock.calls.find(
        (c: unknown[]) => c[0] === EVENT_NAMES.STRESS_TEST_COMPLETED,
      ) as unknown[] | undefined;
      expect(completedCall).toBeDefined();
      const event = completedCall![1] as { correlationId: string };
      expect(event.correlationId).toBeDefined();
      expect(typeof event.correlationId).toBe('string');
      expect(event.correlationId.length).toBeGreaterThan(0);
    });
  });

  describe('synthetic scenarios', () => {
    it('should include single-cluster blowup scenarios', async () => {
      const position = makePosition();
      mockPrisma.openPosition.findMany.mockResolvedValue([position]);

      const result = await service.runSimulation('operator');

      const syntheticNames = result.scenarioDetails.syntheticResults.map(
        (s) => s.name,
      );
      expect(syntheticNames.some((n) => n.startsWith('cluster-blowup-'))).toBe(
        true,
      );
    });

    it('should include liquidity gap scenario', async () => {
      const position = makePosition();
      mockPrisma.openPosition.findMany.mockResolvedValue([position]);

      const result = await service.runSimulation('operator');

      const syntheticNames = result.scenarioDetails.syntheticResults.map(
        (s) => s.name,
      );
      expect(syntheticNames).toContain('liquidity-gap');
    });
  });
});
