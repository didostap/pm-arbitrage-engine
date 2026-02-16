import { Test, TestingModule } from '@nestjs/testing';
import { DetectionService } from './detection.service';
import { ContractPairLoaderService } from '../contract-matching/contract-pair-loader.service';
import { DegradationProtocolService } from '../data-ingestion/degradation-protocol.service';
import { KalshiConnector } from '../../connectors/kalshi/kalshi.connector';
import { PolymarketConnector } from '../../connectors/polymarket/polymarket.connector';
import { PlatformId, NormalizedOrderBook } from '../../common/types';
import { ContractPairConfig } from '../contract-matching/types';
import { FinancialDecimal } from '../../common/utils';
import { vi } from 'vitest';

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
  let kalshiConnector: { getOrderBook: ReturnType<typeof vi.fn> };
  let polymarketConnector: { getOrderBook: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    contractPairLoader = { getActivePairs: vi.fn().mockReturnValue([]) };
    degradationService = { isDegraded: vi.fn().mockReturnValue(false) };
    kalshiConnector = { getOrderBook: vi.fn() };
    polymarketConnector = { getOrderBook: vi.fn() };

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
    contractPairLoader.getActivePairs.mockReturnValue([pair1, pair2]);

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
    contractPairLoader.getActivePairs.mockReturnValue(pairs);

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
    contractPairLoader.getActivePairs.mockReturnValue([makePair()]);
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
    contractPairLoader.getActivePairs.mockReturnValue([makePair()]);
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
    contractPairLoader.getActivePairs.mockReturnValue([pair1, pair2]);

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
    contractPairLoader.getActivePairs.mockReturnValue([makePair()]);

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
    contractPairLoader.getActivePairs.mockReturnValue([makePair()]);

    // Polymarket YES ask: 0.55, Kalshi NO ask: 0.42 → implied Kalshi YES = 0.58
    // grossEdge = |0.55 - (1 - 0.42)| = |0.55 - 0.58| = 0.03
    // buy 0.55 < implied sell 0.58 → arb exists
    polymarketConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.POLYMARKET, 'p', 0.5, 0.55),
    );
    kalshiConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.KALSHI, 'k', 0.4, 0.42),
    );

    const result = await service.detectDislocations();

    const scenarioA = result.dislocations.find(
      (d) => d.buyPlatformId === PlatformId.POLYMARKET,
    );
    expect(scenarioA).toBeDefined();
    expect(scenarioA!.buyPlatformId).toBe(PlatformId.POLYMARKET);
    expect(scenarioA!.sellPlatformId).toBe(PlatformId.KALSHI);
    expect(scenarioA!.grossEdge.toNumber()).toBeCloseTo(0.03, 10);
  });

  // 5.9: Identifies dislocation in Scenario B (buy Kalshi, sell Polymarket)
  it('should identify dislocation in Scenario B (buy Kalshi, sell Polymarket)', async () => {
    contractPairLoader.getActivePairs.mockReturnValue([makePair()]);

    // Kalshi YES ask: 0.40, Polymarket NO ask: 0.55 → implied Poly YES = 0.45
    // grossEdge = |0.40 - (1 - 0.55)| = |0.40 - 0.45| = 0.05
    // buy 0.40 < implied sell 0.45 → arb exists
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
    expect(scenarioB!.grossEdge.toNumber()).toBeCloseTo(0.05, 10);
  });

  // 5.10: Produces dislocation for both directions when both have positive gross edge
  it('should produce dislocations for both directions when both have positive gross edge', async () => {
    contractPairLoader.getActivePairs.mockReturnValue([makePair()]);

    // Scenario: both directions have arb
    // Poly ask: 0.30, Kalshi ask: 0.30
    // Scenario A: buy=0.30 vs implied sell=1-0.30=0.70 → grossEdge=|0.30-0.70|=0.40, buy<implied → arb
    // Scenario B: buy=0.30 vs implied sell=1-0.30=0.70 → grossEdge=|0.30-0.70|=0.40, buy<implied → arb
    polymarketConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.POLYMARKET, 'p', 0.28, 0.3),
    );
    kalshiConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.KALSHI, 'k', 0.28, 0.3),
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
    contractPairLoader.getActivePairs.mockReturnValue([makePair()]);

    // Both ask at 0.50 → grossEdge = |0.50 - (1-0.50)| = |0.50 - 0.50| = 0
    polymarketConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.POLYMARKET, 'p', 0.48, 0.5),
    );
    kalshiConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.KALSHI, 'k', 0.48, 0.5),
    );

    const result = await service.detectDislocations();

    expect(result.dislocations.length).toBe(0);
  });

  // 5.12: No dislocation when fees would eliminate edge (negative direction)
  it('should produce no dislocation when buy price > implied sell price', async () => {
    contractPairLoader.getActivePairs.mockReturnValue([makePair()]);

    // Poly ask: 0.65, Kalshi ask: 0.60
    // Scenario A: buy=0.65 vs implied sell=1-0.60=0.40 → grossEdge=|0.65-0.40|=0.25, but buy>implied → no arb
    // Scenario B: buy=0.60 vs implied sell=1-0.65=0.35 → grossEdge=|0.60-0.35|=0.25, but buy>implied → no arb
    polymarketConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.POLYMARKET, 'p', 0.63, 0.65),
    );
    kalshiConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.KALSHI, 'k', 0.58, 0.6),
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
    contractPairLoader.getActivePairs.mockReturnValue(pairs);

    // First pair: good data with arb
    kalshiConnector.getOrderBook
      .mockResolvedValueOnce(makeOrderBook(PlatformId.KALSHI, 'k1', 0.4, 0.42))
      // Second pair: fetch fails
      .mockRejectedValueOnce(new Error('fail'))
      // Third pair: good data, no arb
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
    contractPairLoader.getActivePairs.mockReturnValue([]);

    const result = await service.detectDislocations();

    expect(result.dislocations).toEqual([]);
    expect(result.pairsEvaluated).toBe(0);
    expect(result.pairsSkipped).toBe(0);
  });

  // 5.15: Correctly uses FinancialMath.calculateGrossEdge
  it('should use FinancialMath.calculateGrossEdge for price comparison', async () => {
    contractPairLoader.getActivePairs.mockReturnValue([makePair()]);

    // Poly ask: 0.55, Kalshi ask: 0.42
    // grossEdge = |0.55 - (1-0.42)| = |0.55 - 0.58| = 0.03
    polymarketConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.POLYMARKET, 'p', 0.5, 0.55),
    );
    kalshiConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.KALSHI, 'k', 0.4, 0.42),
    );

    const result = await service.detectDislocations();

    const dislocation = result.dislocations.find(
      (d) => d.buyPlatformId === PlatformId.POLYMARKET,
    );
    expect(dislocation).toBeDefined();

    // Verify FinancialMath was used (precision check)
    const expectedEdge = new FinancialDecimal(0.55)
      .minus(new FinancialDecimal(1).minus(new FinancialDecimal(0.42)))
      .abs();
    expect(dislocation!.grossEdge.toNumber()).toBe(expectedEdge.toNumber());
  });

  // M2: Verify detectedAt timestamp is present and valid
  it('should include a valid detectedAt timestamp on dislocations', async () => {
    contractPairLoader.getActivePairs.mockReturnValue([makePair()]);

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
      kalshiContractId: 'kalshi-BBB',
    });
    const pair2 = makePair({
      polymarketContractId: 'poly-CCC',
      kalshiContractId: 'kalshi-DDD',
    });
    contractPairLoader.getActivePairs.mockReturnValue([pair1, pair2]);

    kalshiConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.KALSHI, 'k', 0.5, 0.55),
    );
    polymarketConnector.getOrderBook.mockResolvedValue(
      makeOrderBook(PlatformId.POLYMARKET, 'p', 0.5, 0.55),
    );

    await service.detectDislocations();

    expect(kalshiConnector.getOrderBook).toHaveBeenCalledWith('kalshi-BBB');
    expect(kalshiConnector.getOrderBook).toHaveBeenCalledWith('kalshi-DDD');
    expect(polymarketConnector.getOrderBook).toHaveBeenCalledWith('poly-AAA');
    expect(polymarketConnector.getOrderBook).toHaveBeenCalledWith('poly-CCC');
  });

  // L1: Skip pair when asks are empty (bids present)
  it('should skip pair when asks are empty but bids exist', async () => {
    contractPairLoader.getActivePairs.mockReturnValue([makePair()]);

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
    contractPairLoader.getActivePairs.mockReturnValue([makePair()]);

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
    contractPairLoader.getActivePairs.mockReturnValue([makePair()]);

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
});
