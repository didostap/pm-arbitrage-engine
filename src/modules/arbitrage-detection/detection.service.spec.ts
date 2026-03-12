import { Test, TestingModule } from '@nestjs/testing';
import { DetectionService } from './detection.service';
import { ContractPairLoaderService } from '../contract-matching/contract-pair-loader.service';
import { DegradationProtocolService } from '../data-ingestion/degradation-protocol.service';
import { PlatformHealthService } from '../data-ingestion/platform-health.service';
import { KalshiConnector } from '../../connectors/kalshi/kalshi.connector';
import { PolymarketConnector } from '../../connectors/polymarket/polymarket.connector';
import { PlatformId, NormalizedOrderBook } from '../../common/types';
import { ContractPairConfig } from '../contract-matching/types';
import { FinancialDecimal } from '../../common/utils';
import { vi } from 'vitest';
import { createMockPlatformConnector } from '../../test/mock-factories.js';

function makeOrderBook(
  platformId: PlatformId,
  contractId: string,
  bestBid: number,
  bestAsk: number,
): NormalizedOrderBook {
  return {
    platformId,
    contractId,
    bids: bestBid > 0 ? [{ price: bestBid, quantity: 100 }] : [],
    asks: bestAsk > 0 ? [{ price: bestAsk, quantity: 100 }] : [],
    timestamp: new Date(),
  };
}

function makePair(overrides?: Partial<ContractPairConfig>): ContractPairConfig {
  return {
    polymarketContractId: 'poly-contract-1',
    polymarketClobTokenId: 'mock-clob-token-1',
    kalshiContractId: 'kalshi-contract-1',
    eventDescription: 'Will event X happen?',
    operatorVerificationTimestamp: new Date(),
    primaryLeg: 'kalshi',
    ...overrides,
  };
}

describe('DetectionService', () => {
  let service: DetectionService;
  let contractPairLoader: { getActivePairs: ReturnType<typeof vi.fn> };
  let degradationService: { isDegraded: ReturnType<typeof vi.fn> };
  let healthService: {
    getOrderbookStaleness: ReturnType<typeof vi.fn>;
  };
  let kalshiConnector: ReturnType<typeof createMockPlatformConnector>;
  let polymarketConnector: ReturnType<typeof createMockPlatformConnector>;

  beforeEach(async () => {
    contractPairLoader = { getActivePairs: vi.fn().mockReturnValue([]) };
    degradationService = { isDegraded: vi.fn().mockReturnValue(false) };
    healthService = {
      getOrderbookStaleness: vi.fn().mockReturnValue({ stale: false }),
    };
    kalshiConnector = createMockPlatformConnector(PlatformId.KALSHI);
    polymarketConnector = createMockPlatformConnector(PlatformId.POLYMARKET);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DetectionService,
        {
          provide: ContractPairLoaderService,
          useValue: contractPairLoader,
        },
        {
          provide: DegradationProtocolService,
          useValue: degradationService,
        },
        {
          provide: PlatformHealthService,
          useValue: healthService,
        },
        { provide: KalshiConnector, useValue: kalshiConnector },
        { provide: PolymarketConnector, useValue: polymarketConnector },
      ],
    }).compile();

    service = module.get<DetectionService>(DetectionService);
  });

  // 5.2: Evaluates all active pairs and returns results
  it('should evaluate all active pairs and return results', async () => {
    const pair1 = makePair({ eventDescription: 'Event 1' });
    const pair2 = makePair({
      eventDescription: 'Event 2',
      polymarketContractId: 'poly-2',
      kalshiContractId: 'kalshi-2',
    });
    contractPairLoader.getActivePairs.mockResolvedValue([pair1, pair2]);

    kalshiConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.KALSHI, 'kalshi-contract-1', 0.5, 0.55),
    );
    polymarketConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.POLYMARKET, 'poly-contract-1', 0.5, 0.55),
    );

    const result = await service.detectDislocations();

    expect(result.pairsEvaluated).toBe(2);
    expect(result.pairsSkipped).toBe(0);
    expect(result.cycleDurationMs).toBeGreaterThanOrEqual(0);
    expect(result.dislocations).toBeDefined();
  });

  // 5.3: Completes within 1 second with 30 pairs
  it('should complete within 1 second with 30 pairs', async () => {
    const pairs = Array.from({ length: 30 }, (_, i) =>
      makePair({
        eventDescription: `Event ${i}`,
        polymarketContractId: `poly-${i}`,
        kalshiContractId: `kalshi-${i}`,
      }),
    );
    contractPairLoader.getActivePairs.mockResolvedValue(pairs);

    kalshiConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.KALSHI, 'k', 0.5, 0.55),
    );
    polymarketConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.POLYMARKET, 'p', 0.5, 0.55),
    );

    const start = Date.now();
    const result = await service.detectDislocations();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000);
    expect(result.pairsEvaluated).toBe(30);
  });

  // 5.4: Skips pairs when Kalshi is degraded
  it('should skip pairs when Kalshi is degraded', async () => {
    contractPairLoader.getActivePairs.mockResolvedValue([makePair()]);
    degradationService.isDegraded.mockImplementation(
      (id: PlatformId) => id === PlatformId.KALSHI,
    );

    const result = await service.detectDislocations();

    expect(result.pairsSkipped).toBe(1);
    expect(result.pairsEvaluated).toBe(0);
    expect(kalshiConnector.getOrderBook).not.toHaveBeenCalled();
  });

  // 5.5: Skips pairs when Polymarket is degraded
  it('should skip pairs when Polymarket is degraded', async () => {
    contractPairLoader.getActivePairs.mockResolvedValue([makePair()]);
    degradationService.isDegraded.mockImplementation(
      (id: PlatformId) => id === PlatformId.POLYMARKET,
    );

    const result = await service.detectDislocations();

    expect(result.pairsSkipped).toBe(1);
    expect(result.pairsEvaluated).toBe(0);
    expect(polymarketConnector.getOrderBook).not.toHaveBeenCalled();
  });

  // 5.6: Skips pair (not entire cycle) when order book fetch fails
  it('should skip pair when order book fetch fails without stopping cycle', async () => {
    const pair1 = makePair({ eventDescription: 'Event 1' });
    const pair2 = makePair({
      eventDescription: 'Event 2',
      polymarketContractId: 'poly-2',
      kalshiContractId: 'kalshi-2',
    });
    contractPairLoader.getActivePairs.mockResolvedValue([pair1, pair2]);

    // First pair: Kalshi fails
    kalshiConnector.getOrderBook
      .mockRejectedValueOnce(new Error('API timeout'))
      .mockResolvedValueOnce(
        makeOrderBook(PlatformId.KALSHI, 'kalshi-2', 0.5, 0.55),
      );
    polymarketConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.POLYMARKET, 'poly-2', 0.5, 0.55),
    );

    const result = await service.detectDislocations();

    expect(result.pairsSkipped).toBe(1);
    expect(result.pairsEvaluated).toBe(1);
  });

  // 5.7: Skips pair when bids or asks are empty
  it('should skip pair when bids or asks are empty', async () => {
    contractPairLoader.getActivePairs.mockResolvedValue([makePair()]);

    kalshiConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.KALSHI, 'k', 0, 0.55), // no bids
    );
    polymarketConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.POLYMARKET, 'p', 0.5, 0.55),
    );

    const result = await service.detectDislocations();

    expect(result.pairsSkipped).toBe(1);
    expect(result.pairsEvaluated).toBe(0);
  });

  // 5.8: Identifies dislocation in Scenario A (buy Polymarket, sell Kalshi)
  it('should identify dislocation in Scenario A (buy Polymarket, sell Kalshi)', async () => {
    contractPairLoader.getActivePairs.mockResolvedValue([makePair()]);

    // Buy Poly at ask=0.40, Sell Kalshi at bid=0.55 (executable sell price)
    // grossEdge = 0.55 - 0.40 = 0.15 (positive → arb exists)
    polymarketConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.POLYMARKET, 'p', 0.38, 0.4),
    );
    kalshiConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.KALSHI, 'k', 0.55, 0.57),
    );

    const result = await service.detectDislocations();

    const scenarioA = result.dislocations.find(
      (d) => d.buyPlatformId === PlatformId.POLYMARKET,
    );
    expect(scenarioA).toBeDefined();
    expect(scenarioA!.buyPlatformId).toBe(PlatformId.POLYMARKET);
    expect(scenarioA!.sellPlatformId).toBe(PlatformId.KALSHI);
    expect(scenarioA!.grossEdge.toNumber()).toBeCloseTo(0.15, 10);
  });

  // 5.9: Identifies dislocation in Scenario B (buy Kalshi, sell Polymarket)
  it('should identify dislocation in Scenario B (buy Kalshi, sell Polymarket)', async () => {
    contractPairLoader.getActivePairs.mockResolvedValue([makePair()]);

    // Buy Kalshi at ask=0.40, Sell Poly at bid=0.53 (executable sell price)
    // grossEdge = 0.53 - 0.40 = 0.13 (positive → arb exists)
    kalshiConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.KALSHI, 'k', 0.38, 0.4),
    );
    polymarketConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.POLYMARKET, 'p', 0.53, 0.55),
    );

    const result = await service.detectDislocations();

    const scenarioB = result.dislocations.find(
      (d) => d.buyPlatformId === PlatformId.KALSHI,
    );
    expect(scenarioB).toBeDefined();
    expect(scenarioB!.buyPlatformId).toBe(PlatformId.KALSHI);
    expect(scenarioB!.sellPlatformId).toBe(PlatformId.POLYMARKET);
    expect(scenarioB!.grossEdge.toNumber()).toBeCloseTo(0.13, 10);
  });

  // 5.10: Produces dislocation for both directions when both have positive gross edge
  it('should produce dislocations for both directions when both have positive gross edge', async () => {
    contractPairLoader.getActivePairs.mockResolvedValue([makePair()]);

    // Scenario: both directions have arb (wide bid-ask spreads on both platforms)
    // Poly bid=0.55, ask=0.40 — Kalshi bid=0.55, ask=0.40
    // Scenario A: buy Poly ask=0.40, sell Kalshi bid=0.55 → grossEdge = 0.55-0.40 = 0.15 → arb
    // Scenario B: buy Kalshi ask=0.40, sell Poly bid=0.55 → grossEdge = 0.55-0.40 = 0.15 → arb
    polymarketConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.POLYMARKET, 'p', 0.55, 0.4),
    );
    kalshiConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.KALSHI, 'k', 0.55, 0.4),
    );

    const result = await service.detectDislocations();

    expect(result.dislocations.length).toBe(2);
    expect(
      result.dislocations.some(
        (d) => d.buyPlatformId === PlatformId.POLYMARKET,
      ),
    ).toBe(true);
    expect(
      result.dislocations.some((d) => d.buyPlatformId === PlatformId.KALSHI),
    ).toBe(true);
  });

  // 5.11: No dislocation when prices are identical (gross edge = 0)
  it('should produce no dislocation when prices are identical', async () => {
    contractPairLoader.getActivePairs.mockResolvedValue([makePair()]);

    // Both bid=0.50, ask=0.50 → buy at ask=0.50, sell at bid=0.50
    // grossEdge = 0.50 - 0.50 = 0 (no arb)
    polymarketConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.POLYMARKET, 'p', 0.5, 0.5),
    );
    kalshiConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.KALSHI, 'k', 0.5, 0.5),
    );

    const result = await service.detectDislocations();

    expect(result.dislocations.length).toBe(0);
  });

  // 5.12: No dislocation when sellBid < buyAsk in both directions (negative grossEdge)
  it('should produce no dislocation when sell price < buy price in both directions', async () => {
    contractPairLoader.getActivePairs.mockResolvedValue([makePair()]);

    // Poly bid=0.58, ask=0.65; Kalshi bid=0.55, ask=0.62
    // Scenario A: buy Poly ask=0.65, sell Kalshi bid=0.55 → grossEdge = 0.55-0.65 = -0.10 → no arb
    // Scenario B: buy Kalshi ask=0.62, sell Poly bid=0.58 → grossEdge = 0.58-0.62 = -0.04 → no arb
    polymarketConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.POLYMARKET, 'p', 0.58, 0.65),
    );
    kalshiConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.KALSHI, 'k', 0.55, 0.62),
    );

    const result = await service.detectDislocations();

    expect(result.dislocations.length).toBe(0);
  });

  // 5.13: Detection result includes correct counts
  it('should include correct counts in detection result', async () => {
    const pairs = [
      makePair({ eventDescription: 'Event 1' }),
      makePair({
        eventDescription: 'Event 2',
        polymarketContractId: 'poly-2',
        kalshiContractId: 'kalshi-2',
      }),
      makePair({
        eventDescription: 'Event 3',
        polymarketContractId: 'poly-3',
        kalshiContractId: 'kalshi-3',
      }),
    ];
    contractPairLoader.getActivePairs.mockResolvedValue(pairs);

    // First pair: good data with arb (Scenario B: buy Kalshi@0.42, sell Poly@0.50 → edge=0.08)
    kalshiConnector.getOrderBook
      .mockResolvedValueOnce(makeOrderBook(PlatformId.KALSHI, 'k1', 0.4, 0.42))
      // Second pair: fetch fails
      .mockRejectedValueOnce(new Error('fail'))
      // Third pair: good data, no arb (both sides: sell bid < buy ask)
      .mockResolvedValueOnce(makeOrderBook(PlatformId.KALSHI, 'k3', 0.48, 0.5));

    polymarketConnector.getOrderBook
      .mockResolvedValueOnce(
        makeOrderBook(PlatformId.POLYMARKET, 'p1', 0.5, 0.55),
      )
      .mockResolvedValueOnce(
        makeOrderBook(PlatformId.POLYMARKET, 'p3', 0.48, 0.5),
      );

    const result = await service.detectDislocations();

    expect(result.pairsEvaluated).toBe(2);
    expect(result.pairsSkipped).toBe(1);
    expect(result.dislocations.length).toBeGreaterThanOrEqual(1);
    expect(result.cycleDurationMs).toBeGreaterThanOrEqual(0);
  });

  // 5.14: Returns empty dislocations when no active pairs exist
  it('should return empty dislocations when no active pairs', async () => {
    contractPairLoader.getActivePairs.mockResolvedValue([]);

    const result = await service.detectDislocations();

    expect(result.dislocations).toEqual([]);
    expect(result.pairsEvaluated).toBe(0);
    expect(result.pairsSkipped).toBe(0);
  });

  // 5.15: Correctly uses FinancialMath.calculateGrossEdge
  it('should use FinancialMath.calculateGrossEdge for price comparison', async () => {
    contractPairLoader.getActivePairs.mockResolvedValue([makePair()]);

    // Buy Poly at ask=0.40, Sell Kalshi at bid=0.55
    // grossEdge = 0.55 - 0.40 = 0.15 (positive → arb)
    polymarketConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.POLYMARKET, 'p', 0.38, 0.4),
    );
    kalshiConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.KALSHI, 'k', 0.55, 0.57),
    );

    const result = await service.detectDislocations();

    const dislocation = result.dislocations.find(
      (d) => d.buyPlatformId === PlatformId.POLYMARKET,
    );
    expect(dislocation).toBeDefined();

    // Verify FinancialMath was used (precision check) — sell uses bid (0.55)
    const expectedEdge = new FinancialDecimal(0.55).minus(
      new FinancialDecimal(0.4),
    );
    expect(dislocation!.grossEdge.toNumber()).toBe(expectedEdge.toNumber());
  });

  // M2: Verify detectedAt timestamp is present and valid
  it('should include a valid detectedAt timestamp on dislocations', async () => {
    contractPairLoader.getActivePairs.mockResolvedValue([makePair()]);

    polymarketConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.POLYMARKET, 'p', 0.5, 0.55),
    );
    kalshiConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.KALSHI, 'k', 0.4, 0.42),
    );

    const before = new Date();
    const result = await service.detectDislocations();
    const after = new Date();

    expect(result.dislocations.length).toBeGreaterThan(0);
    for (const d of result.dislocations) {
      expect(d.detectedAt).toBeInstanceOf(Date);
      expect(d.detectedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(d.detectedAt.getTime()).toBeLessThanOrEqual(after.getTime());
    }
  });

  // M3: Verify connectors are called with correct contract IDs per pair
  it('should call connectors with correct contract IDs for each pair', async () => {
    const pair1 = makePair({
      polymarketContractId: 'poly-AAA',
      polymarketClobTokenId: 'clob-AAA',
      kalshiContractId: 'kalshi-BBB',
    });
    const pair2 = makePair({
      polymarketContractId: 'poly-CCC',
      polymarketClobTokenId: 'clob-CCC',
      kalshiContractId: 'kalshi-DDD',
    });
    contractPairLoader.getActivePairs.mockResolvedValue([pair1, pair2]);

    kalshiConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.KALSHI, 'k', 0.5, 0.55),
    );
    polymarketConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.POLYMARKET, 'p', 0.5, 0.55),
    );

    await service.detectDislocations();

    expect(kalshiConnector.getOrderBook).toHaveBeenCalledWith('kalshi-BBB');
    expect(kalshiConnector.getOrderBook).toHaveBeenCalledWith('kalshi-DDD');
    expect(polymarketConnector.getOrderBook).toHaveBeenCalledWith('clob-AAA');
    expect(polymarketConnector.getOrderBook).toHaveBeenCalledWith('clob-CCC');
  });

  // 6.5.5a: Sell leg must use best bid (executable sell price), not best ask
  it('should use best bid for sell leg in Scenario A (buy Polymarket, sell Kalshi)', async () => {
    contractPairLoader.getActivePairs.mockResolvedValue([makePair()]);

    // Wide spread: Kalshi bid=0.55, Kalshi ask=0.62
    // Sell Kalshi → receive bid (0.55), NOT ask (0.62)
    // grossEdge = 0.55 - 0.35 = 0.20
    polymarketConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.POLYMARKET, 'p', 0.33, 0.35),
    );
    kalshiConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.KALSHI, 'k', 0.55, 0.62),
    );

    const result = await service.detectDislocations();

    const scenarioA = result.dislocations.find(
      (d) => d.buyPlatformId === PlatformId.POLYMARKET,
    );
    expect(scenarioA).toBeDefined();
    // sellPrice must be the bid (0.55), not the ask (0.62)
    expect(scenarioA!.sellPrice.toNumber()).toBe(0.55);
    // grossEdge = 0.55 - 0.35 = 0.20
    expect(scenarioA!.grossEdge.toNumber()).toBeCloseTo(0.2, 10);
  });

  it('should use best bid for sell leg in Scenario B (buy Kalshi, sell Polymarket)', async () => {
    contractPairLoader.getActivePairs.mockResolvedValue([makePair()]);

    // Wide spread: Poly bid=0.48, Poly ask=0.55
    // Sell Polymarket → receive bid (0.48), NOT ask (0.55)
    // grossEdge = 0.48 - 0.40 = 0.08
    kalshiConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.KALSHI, 'k', 0.38, 0.4),
    );
    polymarketConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.POLYMARKET, 'p', 0.48, 0.55),
    );

    const result = await service.detectDislocations();

    const scenarioB = result.dislocations.find(
      (d) => d.buyPlatformId === PlatformId.KALSHI,
    );
    expect(scenarioB).toBeDefined();
    // sellPrice must be the bid (0.48), not the ask (0.55)
    expect(scenarioB!.sellPrice.toNumber()).toBe(0.48);
    // grossEdge = 0.48 - 0.40 = 0.08
    expect(scenarioB!.grossEdge.toNumber()).toBeCloseTo(0.08, 10);
  });

  // REGRESSION: Rejects pair when both platforms agree unlikely (false positive under old formula)
  it('should reject pair when both platforms agree event is unlikely', async () => {
    contractPairLoader.getActivePairs.mockResolvedValue([makePair()]);

    // Both platforms price event as unlikely with overlapping spreads
    // Scenario A: buy Poly@0.04, sell Kalshi@0.01 → grossEdge = 0.01-0.04 = -0.03 → no arb
    // Scenario B: buy Kalshi@0.03, sell Poly@0.02 → grossEdge = 0.02-0.03 = -0.01 → no arb
    // Old formula: |0.04 - (1-0.01)| = 0.95 → FALSE POSITIVE
    polymarketConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.POLYMARKET, 'p', 0.02, 0.04),
    );
    kalshiConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.KALSHI, 'k', 0.01, 0.03),
    );

    const result = await service.detectDislocations();

    expect(result.dislocations.length).toBe(0);
  });

  // REGRESSION: Rejects pair when both platforms agree likely (false positive under old formula)
  it('should reject pair when both platforms agree event is likely', async () => {
    contractPairLoader.getActivePairs.mockResolvedValue([makePair()]);

    // Both platforms price event as likely: Poly ask=0.92, Kalshi bid=0.88
    // Scenario A: buy Poly@0.92, sell Kalshi@0.88 → grossEdge = 0.88-0.92 = -0.04 → no arb
    // Old formula would have produced positive edge via complement math
    polymarketConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.POLYMARKET, 'p', 0.9, 0.92),
    );
    kalshiConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.KALSHI, 'k', 0.88, 0.9),
    );

    const result = await service.detectDislocations();

    expect(result.dislocations.length).toBe(0);
  });

  // L1: Skip pair when asks are empty (bids present)
  it('should skip pair when asks are empty but bids exist', async () => {
    contractPairLoader.getActivePairs.mockResolvedValue([makePair()]);

    kalshiConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.KALSHI, 'k', 0.5, 0), // has bids, no asks
    );
    polymarketConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.POLYMARKET, 'p', 0.5, 0.55),
    );

    const result = await service.detectDislocations();

    expect(result.pairsSkipped).toBe(1);
    expect(result.pairsEvaluated).toBe(0);
  });

  // L1b: Skip pair when Polymarket has empty order book
  it('should skip pair when Polymarket has no market depth', async () => {
    contractPairLoader.getActivePairs.mockResolvedValue([makePair()]);

    kalshiConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.KALSHI, 'k', 0.5, 0.55),
    );
    polymarketConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.POLYMARKET, 'p', 0, 0), // no bids, no asks
    );

    const result = await service.detectDislocations();

    expect(result.pairsSkipped).toBe(1);
    expect(result.pairsEvaluated).toBe(0);
  });

  // 5.6 extra: Polymarket order book fetch fails
  it('should skip pair when Polymarket order book fetch fails', async () => {
    contractPairLoader.getActivePairs.mockResolvedValue([makePair()]);

    kalshiConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.KALSHI, 'k', 0.5, 0.55),
    );
    polymarketConnector.getOrderBook.mockRejectedValue(
      new Error('Poly API down'),
    );

    const result = await service.detectDislocations();

    expect(result.pairsSkipped).toBe(1);
    expect(result.pairsEvaluated).toBe(0);
  });

  // Story 9.1b: Orderbook staleness suppression
  it('should skip pairs when Kalshi orderbook is stale', async () => {
    contractPairLoader.getActivePairs.mockResolvedValue([makePair()]);
    healthService.getOrderbookStaleness.mockImplementation((id: PlatformId) =>
      id === PlatformId.KALSHI
        ? { stale: true, stalenessMs: 95000 }
        : { stale: false },
    );

    const result = await service.detectDislocations();

    expect(result.pairsSkipped).toBe(1);
    expect(result.pairsEvaluated).toBe(0);
    expect(kalshiConnector.getOrderBook).not.toHaveBeenCalled();
  });

  it('should skip pairs when Polymarket orderbook is stale', async () => {
    contractPairLoader.getActivePairs.mockResolvedValue([makePair()]);
    healthService.getOrderbookStaleness.mockImplementation((id: PlatformId) =>
      id === PlatformId.POLYMARKET
        ? { stale: true, stalenessMs: 120000 }
        : { stale: false },
    );

    const result = await service.detectDislocations();

    expect(result.pairsSkipped).toBe(1);
    expect(result.pairsEvaluated).toBe(0);
    expect(polymarketConnector.getOrderBook).not.toHaveBeenCalled();
  });

  it('should not skip pairs when orderbook is fresh', async () => {
    contractPairLoader.getActivePairs.mockResolvedValue([makePair()]);
    healthService.getOrderbookStaleness.mockReturnValue({ stale: false });

    kalshiConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.KALSHI, 'k', 0.5, 0.55),
    );
    polymarketConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.POLYMARKET, 'p', 0.5, 0.55),
    );

    const result = await service.detectDislocations();

    expect(result.pairsSkipped).toBe(0);
    expect(result.pairsEvaluated).toBe(1);
  });
});
