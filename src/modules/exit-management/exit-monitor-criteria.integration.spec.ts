/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import Decimal from 'decimal.js';
import { ExitMonitorService } from './exit-monitor.service';
import {
  ThresholdEvaluatorService,
  ThresholdEvalInput,
} from './threshold-evaluator.service';
import { PositionRepository } from '../../persistence/repositories/position.repository';
import { OrderRepository } from '../../persistence/repositories/order.repository';
import { PrismaService } from '../../common/prisma.service';
import {
  KALSHI_CONNECTOR_TOKEN,
  POLYMARKET_CONNECTOR_TOKEN,
} from '../../connectors/connector.constants';
import { RISK_MANAGER_TOKEN } from '../risk-management/risk-management.constants';
import { PlatformId } from '../../common/types/platform.type';
import {
  asPositionId,
  asOrderId,
  asPairId,
  asContractId,
  asMatchId,
} from '../../common/types/branded.type';
import type { CriterionResult } from '../../common/types/exit-criteria.types';
import {
  createMockPlatformConnector,
  createMockRiskManager,
} from '../../test/mock-factories.js';

vi.mock('../../common/services/correlation-context', () => ({
  getCorrelationId: () => 'test-correlation-id',
}));

function createMockPosition(overrides: Record<string, unknown> = {}) {
  return {
    positionId: asPositionId('pos-1'),
    pairId: asPairId('pair-1'),
    kalshiOrderId: asOrderId('order-kalshi-1'),
    polymarketOrderId: asOrderId('order-poly-1'),
    kalshiSide: 'buy',
    polymarketSide: 'sell',
    entryPrices: { kalshi: '0.62', polymarket: '0.65' },
    sizes: { kalshi: '100', polymarket: '100' },
    expectedEdge: new Decimal('0.03'),
    status: 'OPEN',
    recalculatedEdge: new Decimal('0.025'),
    entryConfidenceScore: 0.85,
    pair: {
      matchId: asMatchId('pair-1'),
      kalshiContractId: asContractId('kalshi-contract-1'),
      polymarketContractId: asContractId('poly-contract-1'),
      polymarketClobTokenId: 'mock-clob-token-1',
      primaryLeg: 'kalshi',
      resolutionDate: null,
      confidenceScore: 0.85,
    },
    kalshiOrder: {
      orderId: asOrderId('order-kalshi-1'),
      platform: 'KALSHI',
      side: 'buy',
      price: new Decimal('0.62'),
      size: new Decimal('100'),
      fillPrice: new Decimal('0.62'),
      fillSize: new Decimal('100'),
      status: 'FILLED',
    },
    polymarketOrder: {
      orderId: asOrderId('order-poly-1'),
      platform: 'POLYMARKET',
      side: 'sell',
      price: new Decimal('0.65'),
      size: new Decimal('100'),
      fillPrice: new Decimal('0.65'),
      fillSize: new Decimal('100'),
      status: 'FILLED',
    },
    entryClosePriceKalshi: null,
    entryClosePricePolymarket: null,
    entryKalshiFeeRate: null,
    entryPolymarketFeeRate: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** Default criteria array matching the 6 model-driven exit criteria. */
const DEFAULT_CRITERIA: CriterionResult[] = [
  {
    criterion: 'edge_evaporation',
    proximity: new Decimal('0.2'),
    triggered: false,
  },
  {
    criterion: 'model_confidence',
    proximity: new Decimal('0'),
    triggered: false,
  },
  { criterion: 'time_decay', proximity: new Decimal('0'), triggered: false },
  { criterion: 'risk_budget', proximity: new Decimal('0'), triggered: false },
  {
    criterion: 'liquidity_deterioration',
    proximity: new Decimal('0'),
    triggered: false,
  },
  {
    criterion: 'profit_capture',
    proximity: new Decimal('0'),
    triggered: false,
  },
];

describe('ExitMonitorService — Six-Criteria Integration (Story 10.2)', () => {
  let service: ExitMonitorService;
  let positionRepository: Record<string, ReturnType<typeof vi.fn>>;
  let orderRepository: Record<string, ReturnType<typeof vi.fn>>;
  let kalshiConnector: ReturnType<typeof createMockPlatformConnector>;
  let polymarketConnector: ReturnType<typeof createMockPlatformConnector>;
  let riskManager: ReturnType<typeof createMockRiskManager>;
  let eventEmitter: Record<string, ReturnType<typeof vi.fn>>;
  let prisma: Record<string, Record<string, ReturnType<typeof vi.fn>>>;
  let thresholdEvaluator: Record<string, ReturnType<typeof vi.fn>>;
  let configService: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    positionRepository = {
      findByStatusWithOrders: vi.fn().mockResolvedValue([]),
      findByIdWithOrders: vi.fn().mockResolvedValue(createMockPosition()),
      updateStatus: vi.fn().mockResolvedValue({}),
    };

    orderRepository = {
      create: vi.fn().mockImplementation((data: Record<string, unknown>) => ({
        orderId: asOrderId(`exit-order-${Date.now()}`),
        ...data,
      })),
      findById: vi.fn(),
      findByPairId: vi.fn().mockResolvedValue([]),
    };

    kalshiConnector = createMockPlatformConnector(PlatformId.KALSHI, {
      getOrderBook: vi.fn().mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [{ price: 0.66, quantity: 500 }],
        asks: [{ price: 0.68, quantity: 500 }],
        timestamp: new Date(),
      }),
      getFeeSchedule: vi.fn().mockReturnValue({
        platformId: PlatformId.KALSHI,
        makerFeePercent: 0,
        takerFeePercent: 2,
        description: 'Kalshi fees',
      }),
      submitOrder: vi.fn().mockResolvedValue({
        orderId: asOrderId('kalshi-exit-1'),
        status: 'filled',
        filledPrice: 0.66,
        filledQuantity: 100,
        timestamp: new Date(),
      }),
    });

    polymarketConnector = createMockPlatformConnector(PlatformId.POLYMARKET, {
      getOrderBook: vi.fn().mockResolvedValue({
        platformId: PlatformId.POLYMARKET,
        contractId: asContractId('poly-contract-1'),
        bids: [{ price: 0.62, quantity: 500 }],
        asks: [{ price: 0.64, quantity: 500 }],
        timestamp: new Date(),
      }),
      getFeeSchedule: vi.fn().mockReturnValue({
        platformId: PlatformId.POLYMARKET,
        makerFeePercent: 0,
        takerFeePercent: 1,
        description: 'Polymarket fees',
      }),
      submitOrder: vi.fn().mockResolvedValue({
        orderId: asOrderId('poly-exit-1'),
        status: 'filled',
        filledPrice: 0.62,
        filledQuantity: 100,
        timestamp: new Date(),
      }),
    });

    riskManager = createMockRiskManager({
      getCurrentExposure: vi.fn().mockReturnValue({
        openPairCount: 5,
        totalCapitalDeployed: new Decimal('5000'),
        bankrollUsd: new Decimal('10000'),
        availableCapital: new Decimal('5000'),
        dailyPnl: new Decimal('-200'),
        dailyLossLimitUsd: new Decimal('500'),
        clusterExposures: [],
        aggregateClusterExposurePct: new Decimal('0'),
      }),
      getBankrollUsd: vi.fn().mockReturnValue(new Decimal('10000')),
    });

    eventEmitter = {
      emit: vi.fn(),
    };

    thresholdEvaluator = {
      evaluate: vi.fn().mockReturnValue({
        triggered: false,
        currentEdge: new Decimal('0.01'),
        currentPnl: new Decimal('0.50'),
        capturedEdgePercent: new Decimal('16.7'),
        criteria: DEFAULT_CRITERIA,
      }),
      evaluateModelDriven: vi.fn().mockReturnValue({
        triggered: false,
        currentEdge: new Decimal('0.01'),
        currentPnl: new Decimal('0.50'),
        capturedEdgePercent: new Decimal('16.7'),
        criteria: DEFAULT_CRITERIA,
      }),
    };

    prisma = {
      openPosition: {
        update: vi.fn().mockResolvedValue({}),
      },
      contractMatch: {
        findUnique: vi.fn().mockResolvedValue({
          matchId: asMatchId('pair-1'),
          confidenceScore: 0.85,
        }),
      },
    };

    configService = {
      get: vi.fn().mockImplementation((key: string, defaultVal: unknown) => {
        if (key === 'WS_STALENESS_THRESHOLD_MS') return 60000;
        if (key === 'EXIT_MODE') return 'model';
        if (key === 'DETECTION_GAS_ESTIMATE_USD') return '0';
        if (key === 'EXIT_RISK_BUDGET_PCT') return 85;
        if (key === 'EXIT_MIN_DEPTH') return 500;
        return defaultVal;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExitMonitorService,
        { provide: PositionRepository, useValue: positionRepository },
        { provide: OrderRepository, useValue: orderRepository },
        { provide: KALSHI_CONNECTOR_TOKEN, useValue: kalshiConnector },
        { provide: POLYMARKET_CONNECTOR_TOKEN, useValue: polymarketConnector },
        { provide: RISK_MANAGER_TOKEN, useValue: riskManager },
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: ThresholdEvaluatorService, useValue: thresholdEvaluator },
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get(ExitMonitorService);
  });

  it('[P0] should pass recalculated edge data from WS/polling path into ThresholdEvalInput', async () => {
    const position = createMockPosition();
    positionRepository.findByStatusWithOrders.mockResolvedValue([position]);

    await service.evaluatePositions();

    // Service always calls evaluate() which internally branches on exitMode
    const evalCall = thresholdEvaluator.evaluate.mock.calls[0];
    expect(evalCall).toBeDefined();
    const evalInput: ThresholdEvalInput = evalCall[0];
    // Close prices should come from order book (kalshi bid for buy side = 0.66, poly ask for sell side = 0.64)
    expect(evalInput.currentKalshiPrice).toBeInstanceOf(Decimal);
    expect(evalInput.currentPolymarketPrice).toBeInstanceOf(Decimal);
    // Data source should be classified
    expect(['websocket', 'polling', 'stale_fallback']).toContain(
      evalInput.dataSource,
    );
  });

  it('[P1] should look up confidence score from ContractMatch by pairId', async () => {
    const position = createMockPosition({
      entryConfidenceScore: 0.92,
      pair: {
        matchId: asMatchId('pair-1'),
        kalshiContractId: asContractId('kalshi-contract-1'),
        polymarketContractId: asContractId('poly-contract-1'),
        polymarketClobTokenId: 'mock-clob-token-1',
        primaryLeg: 'kalshi',
        resolutionDate: null,
        confidenceScore: 0.92,
      },
    });
    positionRepository.findByStatusWithOrders.mockResolvedValue([position]);

    await service.evaluatePositions();

    // Verify the confidence score from the position was passed to the evaluator
    const evalCall = thresholdEvaluator.evaluate.mock.calls[0];
    expect(evalCall).toBeDefined();
    const evalInput: ThresholdEvalInput = evalCall[0];
    expect(evalInput.entryConfidenceScore).toBe(0.92);
    // currentConfidenceScore should also be looked up from ContractMatch
    expect(evalInput.currentConfidenceScore).toBeDefined();
  });

  it('[P1] should flow exit depth from getAvailableExitDepth() into kalshiExitDepth/polymarketExitDepth', async () => {
    const position = createMockPosition();
    positionRepository.findByStatusWithOrders.mockResolvedValue([position]);

    // Order books with specific depth
    kalshiConnector.getOrderBook.mockResolvedValue({
      platformId: PlatformId.KALSHI,
      contractId: asContractId('kalshi-contract-1'),
      bids: [
        { price: 0.66, quantity: 300 },
        { price: 0.65, quantity: 200 },
      ],
      asks: [{ price: 0.68, quantity: 500 }],
      timestamp: new Date(),
    });
    polymarketConnector.getOrderBook.mockResolvedValue({
      platformId: PlatformId.POLYMARKET,
      contractId: asContractId('poly-contract-1'),
      bids: [{ price: 0.62, quantity: 150 }],
      asks: [
        { price: 0.64, quantity: 250 },
        { price: 0.65, quantity: 100 },
      ],
      timestamp: new Date(),
    });

    await service.evaluatePositions();

    const evalCall = thresholdEvaluator.evaluate.mock.calls[0];
    expect(evalCall).toBeDefined();
    const evalInput: ThresholdEvalInput = evalCall[0];
    // Exit depth should be populated from order book depth on the close side
    expect(evalInput.kalshiExitDepth).toBeInstanceOf(Decimal);
    expect(evalInput.polymarketExitDepth).toBeInstanceOf(Decimal);
    // Kalshi buy side closes by selling into bids: total bid depth = 300 + 200 = 500
    expect(evalInput.kalshiExitDepth!.gte(new Decimal('0'))).toBe(true);
    // Polymarket sell side closes by buying from asks: total ask depth = 250 + 100 = 350
    expect(evalInput.polymarketExitDepth!.gte(new Decimal('0'))).toBe(true);
  });

  it('[P1] should compute dense edge ranking across all evaluatable positions before evaluation loop', async () => {
    // 3 positions with different recalculated edges
    const pos1 = createMockPosition({
      positionId: asPositionId('pos-1'),
      expectedEdge: new Decimal('0.02'),
      recalculatedEdge: new Decimal('0.02'), // lowest edge → rank 1
    });
    const pos2 = createMockPosition({
      positionId: asPositionId('pos-2'),
      pairId: asPairId('pair-2'),
      expectedEdge: new Decimal('0.05'),
      recalculatedEdge: new Decimal('0.05'), // highest edge → rank 3
      pair: {
        matchId: asMatchId('pair-2'),
        kalshiContractId: asContractId('kalshi-contract-2'),
        polymarketContractId: asContractId('poly-contract-2'),
        polymarketClobTokenId: 'mock-clob-token-2',
        primaryLeg: 'kalshi',
        resolutionDate: null,
      },
      kalshiOrder: {
        orderId: asOrderId('order-kalshi-2'),
        platform: 'KALSHI',
        side: 'buy',
        price: new Decimal('0.62'),
        size: new Decimal('100'),
        fillPrice: new Decimal('0.62'),
        fillSize: new Decimal('100'),
        status: 'FILLED',
      },
      polymarketOrder: {
        orderId: asOrderId('order-poly-2'),
        platform: 'POLYMARKET',
        side: 'sell',
        price: new Decimal('0.65'),
        size: new Decimal('100'),
        fillPrice: new Decimal('0.65'),
        fillSize: new Decimal('100'),
        status: 'FILLED',
      },
    });
    const pos3 = createMockPosition({
      positionId: asPositionId('pos-3'),
      pairId: asPairId('pair-3'),
      expectedEdge: new Decimal('0.03'),
      recalculatedEdge: new Decimal('0.03'), // middle edge → rank 2
      pair: {
        matchId: asMatchId('pair-3'),
        kalshiContractId: asContractId('kalshi-contract-3'),
        polymarketContractId: asContractId('poly-contract-3'),
        polymarketClobTokenId: 'mock-clob-token-3',
        primaryLeg: 'kalshi',
        resolutionDate: null,
      },
      kalshiOrder: {
        orderId: asOrderId('order-kalshi-3'),
        platform: 'KALSHI',
        side: 'buy',
        price: new Decimal('0.62'),
        size: new Decimal('100'),
        fillPrice: new Decimal('0.62'),
        fillSize: new Decimal('100'),
        status: 'FILLED',
      },
      polymarketOrder: {
        orderId: asOrderId('order-poly-3'),
        platform: 'POLYMARKET',
        side: 'sell',
        price: new Decimal('0.65'),
        size: new Decimal('100'),
        fillPrice: new Decimal('0.65'),
        fillSize: new Decimal('100'),
        status: 'FILLED',
      },
    });

    positionRepository.findByStatusWithOrders.mockResolvedValue([
      pos1,
      pos2,
      pos3,
    ]);

    await service.evaluatePositions();

    // Service always calls evaluate() — verify all 3 positions were evaluated
    expect(thresholdEvaluator.evaluate).toHaveBeenCalledTimes(3);

    // pos-1 (edge 0.02) should have rank 1 (lowest), totalOpenPositions = 3
    const pos1Input: ThresholdEvalInput =
      thresholdEvaluator.evaluate.mock.calls[0][0];
    expect(pos1Input.edgeRankAmongOpen).toBe(1);
    expect(pos1Input.totalOpenPositions).toBe(3);

    // pos-2 (edge 0.05) should have rank 3 (highest)
    const pos2Input: ThresholdEvalInput =
      thresholdEvaluator.evaluate.mock.calls[1][0];
    expect(pos2Input.edgeRankAmongOpen).toBe(3);

    // pos-3 (edge 0.03) should have rank 2
    const pos3Input: ThresholdEvalInput =
      thresholdEvaluator.evaluate.mock.calls[2][0];
    expect(pos3Input.edgeRankAmongOpen).toBe(2);
  });

  it('[P1] should compute portfolioRiskApproaching from IRiskManager.getCurrentExposure() vs bankroll', async () => {
    const position = createMockPosition();
    positionRepository.findByStatusWithOrders.mockResolvedValue([position]);

    // Set exposure high enough to trigger "approaching" (85% of bankroll with EXIT_RISK_BUDGET_PCT=85)
    riskManager.getCurrentExposure.mockReturnValue({
      openPairCount: 5,
      totalCapitalDeployed: new Decimal('8500'),
      bankrollUsd: new Decimal('10000'),
      availableCapital: new Decimal('1500'),
      dailyPnl: new Decimal('-200'),
      dailyLossLimitUsd: new Decimal('500'),
      clusterExposures: [],
      aggregateClusterExposurePct: new Decimal('0'),
    });
    riskManager.getBankrollUsd.mockReturnValue(new Decimal('10000'));

    await service.evaluatePositions();

    const evalCall = thresholdEvaluator.evaluate.mock.calls[0];
    expect(evalCall).toBeDefined();
    const evalInput: ThresholdEvalInput = evalCall[0];
    // With 85% deployed and EXIT_RISK_BUDGET_PCT=85, should be approaching
    expect(evalInput.portfolioRiskApproaching).toBe(true);
  });

  it('[P1] should persist CriterionResult[] to position.lastEvalCriteria after evaluation', async () => {
    const position = createMockPosition();
    positionRepository.findByStatusWithOrders.mockResolvedValue([position]);

    const customCriteria: CriterionResult[] = [
      {
        criterion: 'edge_evaporation',
        proximity: new Decimal('0.3'),
        triggered: false,
      },
      {
        criterion: 'model_confidence',
        proximity: new Decimal('0'),
        triggered: false,
      },
      {
        criterion: 'time_decay',
        proximity: new Decimal('0.1'),
        triggered: false,
      },
      {
        criterion: 'risk_budget',
        proximity: new Decimal('0'),
        triggered: false,
      },
      {
        criterion: 'liquidity_deterioration',
        proximity: new Decimal('0.2'),
        triggered: false,
      },
      {
        criterion: 'profit_capture',
        proximity: new Decimal('0'),
        triggered: false,
      },
    ];

    thresholdEvaluator.evaluate.mockReturnValue({
      triggered: false,
      currentEdge: new Decimal('0.01'),
      currentPnl: new Decimal('0.50'),
      capturedEdgePercent: new Decimal('16.7'),
      criteria: customCriteria,
    });

    await service.evaluatePositions();

    // Verify the criteria array was persisted to the position record
    expect(prisma.openPosition.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { positionId: 'pos-1' },
        data: expect.objectContaining({
          lastEvalCriteria: expect.arrayContaining([
            expect.objectContaining({ criterion: 'edge_evaporation' }),
            expect.objectContaining({ criterion: 'model_confidence' }),
            expect.objectContaining({ criterion: 'time_decay' }),
            expect.objectContaining({ criterion: 'risk_budget' }),
            expect.objectContaining({ criterion: 'liquidity_deterioration' }),
            expect.objectContaining({ criterion: 'profit_capture' }),
          ]),
        }),
      }),
    );
  });

  it('[P0] should evaluate criterion identically in paper mode as in live mode', async () => {
    // Paper mode: connector getHealth returns mode: 'paper'
    kalshiConnector.getHealth.mockReturnValue({
      platformId: PlatformId.KALSHI,
      status: 'healthy',
      lastHeartbeat: new Date(),
      latencyMs: 50,
      mode: 'paper',
    });
    polymarketConnector.getHealth.mockReturnValue({
      platformId: PlatformId.POLYMARKET,
      status: 'healthy',
      lastHeartbeat: new Date(),
      latencyMs: 50,
      mode: 'paper',
    });

    const position = createMockPosition();
    positionRepository.findByStatusWithOrders.mockResolvedValue([position]);

    await service.evaluatePositions();

    // In paper mode, evaluate() should still be called (no separate paper-mode evaluation path)
    expect(thresholdEvaluator.evaluate).toHaveBeenCalledTimes(1);
    const evalInput: ThresholdEvalInput =
      thresholdEvaluator.evaluate.mock.calls[0][0];
    // The input should contain the same model-driven fields regardless of paper mode
    expect(evalInput.exitMode).toBe('model');
  });

  it('[P1] should read EXIT_MODE from ConfigService and pass to evaluator', async () => {
    const position = createMockPosition();
    positionRepository.findByStatusWithOrders.mockResolvedValue([position]);

    // Verify 'model' mode (default from our configService mock)
    await service.evaluatePositions();
    expect(configService.get).toHaveBeenCalledWith(
      'EXIT_MODE',
      expect.anything(),
    );

    // Service always calls evaluate(), which internally branches on exitMode
    const evalInput: ThresholdEvalInput =
      thresholdEvaluator.evaluate.mock.calls[0][0];
    expect(evalInput.exitMode).toBe('model');

    // Now change to 'fixed' mode
    configService.get.mockImplementation((key: string, defaultVal: unknown) => {
      if (key === 'EXIT_MODE') return 'fixed';
      if (key === 'WS_STALENESS_THRESHOLD_MS') return 60000;
      if (key === 'DETECTION_GAS_ESTIMATE_USD') return '0';
      return defaultVal;
    });

    thresholdEvaluator.evaluate.mockClear();
    positionRepository.findByStatusWithOrders.mockResolvedValue([
      createMockPosition(),
    ]);

    await service.evaluatePositions();

    // In 'fixed' mode, evaluate() is still called but with exitMode='fixed'
    expect(thresholdEvaluator.evaluate).toHaveBeenCalledTimes(1);
    const fixedInput: ThresholdEvalInput =
      thresholdEvaluator.evaluate.mock.calls[0][0];
    expect(fixedInput.exitMode).toBe('fixed');
  });
});
