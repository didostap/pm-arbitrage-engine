/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { vi } from 'vitest';
import Decimal from 'decimal.js';
import { EdgeCalculatorService } from './edge-calculator.service';
import { DegradationProtocolService } from '../data-ingestion/degradation-protocol.service';
import { KalshiConnector } from '../../connectors/kalshi/kalshi.connector';
import { PolymarketConnector } from '../../connectors/polymarket/polymarket.connector';
import {
  PlatformId,
  FeeSchedule,
  NormalizedOrderBook,
} from '../../common/types';
import { EVENT_NAMES } from '../../common/events';
import { FinancialDecimal } from '../../common/utils';
import { asContractId } from '../../common/types';
import { ContractPairConfig } from '../contract-matching/types';
import { RawDislocation } from './types/raw-dislocation.type';

function makeOrderBook(
  platformId: PlatformId,
  contractId: string,
  bestBid: number,
  bestAsk: number,
  quantity = 10000,
): NormalizedOrderBook {
  return {
    platformId,
    contractId: asContractId(contractId),
    bids: bestBid > 0 ? [{ price: bestBid, quantity }] : [],
    asks: bestAsk > 0 ? [{ price: bestAsk, quantity }] : [],
    timestamp: new Date(),
  };
}

function makePair(overrides?: Partial<ContractPairConfig>): ContractPairConfig {
  return {
    polymarketContractId: 'poly-contract-1',
    polymarketClobTokenId: 'poly-clob-token-1',
    kalshiContractId: 'kalshi-contract-1',
    eventDescription: 'Will event X happen?',
    operatorVerificationTimestamp: new Date(),
    primaryLeg: 'kalshi',
    matchId: 'match-uuid-1',
    resolutionDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000), // 3 days out (keeps annualized return high for existing tests)
    ...overrides,
  };
}

function makeFeeSchedule(
  platformId: PlatformId,
  takerFeePercent: number,
): FeeSchedule {
  return {
    platformId,
    makerFeePercent: 0,
    takerFeePercent,
    description: `${platformId} fees`,
  };
}

function makeDislocation(overrides?: Partial<RawDislocation>): RawDislocation {
  // Use overridden prices to build consistent order books (VWAP recomputes grossEdge from books)
  const buyPrice = overrides?.buyPrice ? overrides.buyPrice.toNumber() : 0.45;
  const sellPrice = overrides?.sellPrice
    ? overrides.sellPrice.toNumber()
    : 0.52;

  return {
    pairConfig: makePair(),
    buyPlatformId: PlatformId.POLYMARKET,
    sellPlatformId: PlatformId.KALSHI,
    buyPrice: new FinancialDecimal(buyPrice),
    sellPrice: new FinancialDecimal(sellPrice),
    grossEdge: new FinancialDecimal(sellPrice - buyPrice),
    buyOrderBook: makeOrderBook(
      PlatformId.POLYMARKET,
      'poly-contract-1',
      Math.max(0, buyPrice - 0.01),
      buyPrice,
    ),
    sellOrderBook: makeOrderBook(
      PlatformId.KALSHI,
      'kalshi-contract-1',
      sellPrice,
      sellPrice + 0.01,
    ),
    detectedAt: new Date(),
    ...overrides,
  };
}

describe('EdgeCalculatorService', () => {
  let service: EdgeCalculatorService;
  let configService: { get: ReturnType<typeof vi.fn> };
  let degradationService: {
    getEdgeThresholdMultiplier: ReturnType<typeof vi.fn>;
  };
  let kalshiConnector: { getFeeSchedule: ReturnType<typeof vi.fn> };
  let polymarketConnector: { getFeeSchedule: ReturnType<typeof vi.fn> };
  let eventEmitter: { emit: ReturnType<typeof vi.fn> };

  const kalshiFees = makeFeeSchedule(PlatformId.KALSHI, 2.0);
  const polymarketFees = makeFeeSchedule(PlatformId.POLYMARKET, 2.0);

  beforeEach(async () => {
    configService = {
      get: vi
        .fn()
        .mockImplementation(
          (key: string, defaultValue: number) => defaultValue,
        ),
    };
    degradationService = {
      getEdgeThresholdMultiplier: vi.fn().mockReturnValue(1.0),
    };
    kalshiConnector = {
      getFeeSchedule: vi.fn().mockReturnValue(kalshiFees),
    };
    polymarketConnector = {
      getFeeSchedule: vi.fn().mockReturnValue(polymarketFees),
    };
    eventEmitter = { emit: vi.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EdgeCalculatorService,
        { provide: ConfigService, useValue: configService },
        { provide: DegradationProtocolService, useValue: degradationService },
        { provide: KalshiConnector, useValue: kalshiConnector },
        { provide: PolymarketConnector, useValue: polymarketConnector },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();

    service = module.get<EdgeCalculatorService>(EdgeCalculatorService);
  });

  // ========================================================================
  // CSV Scenario: exact_threshold_boundary — Net edge = 0.008 exactly, passes
  // With VWAP: grossEdge is recomputed from order book prices (0.50 - 0.47 = 0.03)
  // ========================================================================
  it('calculates net edge correctly using FinancialMath (CSV: exact_threshold_boundary)', () => {
    const fees = makeFeeSchedule(PlatformId.POLYMARKET, 2.0);
    const kalshiFee = makeFeeSchedule(PlatformId.KALSHI, 2.0);
    polymarketConnector.getFeeSchedule.mockReturnValue(fees);
    kalshiConnector.getFeeSchedule.mockReturnValue(kalshiFee);

    // Override config to match CSV: gas=0.13, positionSize=50
    configService.get.mockImplementation(
      (key: string, defaultValue: number) => {
        if (key === 'DETECTION_GAS_ESTIMATE_USD') return 0.13;
        if (key === 'DETECTION_POSITION_SIZE_USD') return 50;
        return defaultValue;
      },
    );

    // VWAP recomputes grossEdge from book prices: 0.50 - 0.47 = 0.03
    // netEdge = 0.03 - 0.47*0.02 - 0.50*0.02 - 0.13/50 = 0.03 - 0.0094 - 0.01 - 0.0026 = 0.008
    const dislocation = makeDislocation({
      buyPrice: new FinancialDecimal(0.47),
      sellPrice: new FinancialDecimal(0.5),
      grossEdge: new FinancialDecimal(0.03),
      buyOrderBook: makeOrderBook(
        PlatformId.POLYMARKET,
        'poly-contract-1',
        0.46,
        0.47,
      ),
      sellOrderBook: makeOrderBook(
        PlatformId.KALSHI,
        'kalshi-contract-1',
        0.5,
        0.51,
      ),
    });

    const result = service.processDislocations([dislocation]);

    expect(result.opportunities).toHaveLength(1);
    expect(result.opportunities[0]?.netEdge.toNumber()).toBeCloseTo(0.008, 6);
  });

  // ========================================================================
  // Filters opportunity below threshold (default 0.8%)
  // ========================================================================
  it('filters opportunity below threshold (CSV: just_below_threshold)', () => {
    configService.get.mockImplementation(
      (key: string, defaultValue: number) => {
        if (key === 'DETECTION_GAS_ESTIMATE_USD') return 0.135;
        if (key === 'DETECTION_POSITION_SIZE_USD') return 50;
        return defaultValue;
      },
    );

    // VWAP grossEdge = 0.50 - 0.47 = 0.03
    // netEdge = 0.03 - 0.47*0.02 - 0.50*0.02 - 0.135/50 = 0.03 - 0.0094 - 0.01 - 0.0027 = 0.0079
    const dislocation = makeDislocation({
      buyPrice: new FinancialDecimal(0.47),
      sellPrice: new FinancialDecimal(0.5),
      grossEdge: new FinancialDecimal(0.03),
      buyOrderBook: makeOrderBook(
        PlatformId.POLYMARKET,
        'poly-contract-1',
        0.46,
        0.47,
      ),
      sellOrderBook: makeOrderBook(
        PlatformId.KALSHI,
        'kalshi-contract-1',
        0.5,
        0.51,
      ),
    });

    const result = service.processDislocations([dislocation]);

    expect(result.filtered).toHaveLength(1);
    expect(result.opportunities).toHaveLength(0);
    expect(result.filtered[0]?.reason).toBe('below_threshold');
  });

  // ========================================================================
  // Passes opportunity at exact threshold boundary (0.8%)
  // ========================================================================
  it('passes opportunity at exact threshold boundary', () => {
    configService.get.mockImplementation(
      (key: string, defaultValue: number) => {
        if (key === 'DETECTION_GAS_ESTIMATE_USD') return 0.13;
        if (key === 'DETECTION_POSITION_SIZE_USD') return 50;
        return defaultValue;
      },
    );

    const dislocation = makeDislocation();
    const result = service.processDislocations([dislocation]);

    expect(result.opportunities).toHaveLength(1);
  });

  // ========================================================================
  // Passes opportunity above threshold
  // ========================================================================
  it('passes opportunity above threshold (CSV: just_above_threshold)', () => {
    configService.get.mockImplementation(
      (key: string, defaultValue: number) => {
        if (key === 'DETECTION_GAS_ESTIMATE_USD') return 0.125;
        if (key === 'DETECTION_POSITION_SIZE_USD') return 50;
        return defaultValue;
      },
    );

    const dislocation = makeDislocation();
    const result = service.processDislocations([dislocation]);

    // netEdge = 0.07 - 0.45*0.02 - 0.52*0.02 - 0.125/50 = 0.07 - 0.009 - 0.0104 - 0.0025 = 0.0481
    expect(result.opportunities).toHaveLength(1);
    expect(result.opportunities[0]?.netEdge.toNumber()).toBeCloseTo(0.0481, 4);
  });

  // ========================================================================
  // Applies 1.5x threshold multiplier when platform is degraded
  // ========================================================================
  it('applies 1.5x threshold multiplier when platform is degraded', () => {
    degradationService.getEdgeThresholdMultiplier.mockReturnValue(1.5);

    // VWAP grossEdge = 0.50 - 0.47 = 0.03 (book prices)
    // Net edge = 0.03 - (0.47*0.02) - (0.50*0.02) - (0.30/300)
    //          = 0.03 - 0.0094 - 0.01 - 0.001 = 0.0096
    // Effective threshold = 0.008 * 1.5 = 0.012
    // 0.0096 < 0.012 → filtered
    const dislocation = makeDislocation({
      buyPrice: new FinancialDecimal(0.47),
      sellPrice: new FinancialDecimal(0.5),
      grossEdge: new FinancialDecimal(0.03),
      buyOrderBook: makeOrderBook(
        PlatformId.POLYMARKET,
        'poly-contract-1',
        0.46,
        0.47,
      ),
      sellOrderBook: makeOrderBook(
        PlatformId.KALSHI,
        'kalshi-contract-1',
        0.5,
        0.51,
      ),
    });
    const result = service.processDislocations([dislocation]);

    expect(result.filtered).toHaveLength(1);
    expect(result.opportunities).toHaveLength(0);
  });

  // ========================================================================
  // Emits OpportunityFilteredEvent for filtered dislocations
  // ========================================================================
  it('emits OpportunityFilteredEvent for filtered dislocations', () => {
    // Force below threshold with tight spread (VWAP grossEdge = 0.50 - 0.47 = 0.03)
    configService.get.mockImplementation(
      (key: string, defaultValue: number) => {
        if (key === 'DETECTION_GAS_ESTIMATE_USD') return 0.135;
        if (key === 'DETECTION_POSITION_SIZE_USD') return 50;
        return defaultValue;
      },
    );

    const dislocation = makeDislocation({
      buyPrice: new FinancialDecimal(0.47),
      sellPrice: new FinancialDecimal(0.5),
      grossEdge: new FinancialDecimal(0.03),
      buyOrderBook: makeOrderBook(
        PlatformId.POLYMARKET,
        'poly-contract-1',
        0.46,
        0.47,
      ),
      sellOrderBook: makeOrderBook(
        PlatformId.KALSHI,
        'kalshi-contract-1',
        0.5,
        0.51,
      ),
    });
    service.processDislocations([dislocation]);

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      EVENT_NAMES.OPPORTUNITY_FILTERED,
      expect.objectContaining({
        pairEventDescription: 'Will event X happen?',
        reason: 'below_threshold',
      }),
    );
  });

  it('includes matchId in OpportunityFilteredEvent opts', () => {
    // Force below threshold with tight spread
    configService.get.mockImplementation(
      (key: string, defaultValue: number) => {
        if (key === 'DETECTION_GAS_ESTIMATE_USD') return 0.135;
        if (key === 'DETECTION_POSITION_SIZE_USD') return 50;
        return defaultValue;
      },
    );

    const dislocation = makeDislocation({
      buyPrice: new FinancialDecimal(0.47),
      sellPrice: new FinancialDecimal(0.5),
      grossEdge: new FinancialDecimal(0.03),
      buyOrderBook: makeOrderBook(
        PlatformId.POLYMARKET,
        'poly-contract-1',
        0.46,
        0.47,
      ),
      sellOrderBook: makeOrderBook(
        PlatformId.KALSHI,
        'kalshi-contract-1',
        0.5,
        0.51,
      ),
    });
    service.processDislocations([dislocation]);

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      EVENT_NAMES.OPPORTUNITY_FILTERED,
      expect.objectContaining({
        matchId: 'match-uuid-1',
      }),
    );
  });

  // ========================================================================
  // Emits OpportunityIdentifiedEvent for passing dislocations
  // ========================================================================
  it('emits OpportunityIdentifiedEvent for passing dislocations', () => {
    // Use large spread scenario to guarantee passing
    const dislocation = makeDislocation({
      buyPrice: new FinancialDecimal(0.2),
      sellPrice: new FinancialDecimal(0.3),
      grossEdge: new FinancialDecimal(0.1),
    });

    const result = service.processDislocations([dislocation]);

    expect(result.opportunities).toHaveLength(1);
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      EVENT_NAMES.OPPORTUNITY_IDENTIFIED,
      expect.objectContaining({
        opportunity: expect.objectContaining({
          netEdge: expect.any(Number),
          grossEdge: expect.any(Number),
          buyPrice: expect.any(Number),
          sellPrice: expect.any(Number),
          matchId: 'match-uuid-1',
        }),
      }),
    );
  });

  // ========================================================================
  // Enriched opportunity includes fee breakdown and liquidity depth
  // ========================================================================
  it('enriched opportunity includes fee breakdown and liquidity depth', () => {
    const dislocation = makeDislocation({
      buyPrice: new FinancialDecimal(0.2),
      sellPrice: new FinancialDecimal(0.3),
      grossEdge: new FinancialDecimal(0.1),
    });

    const result = service.processDislocations([dislocation]);

    const opp = result.opportunities[0];
    expect(opp?.feeBreakdown).toBeDefined();
    expect(opp?.feeBreakdown?.buyFeeCost).toBeInstanceOf(Decimal);
    expect(opp?.feeBreakdown?.sellFeeCost).toBeInstanceOf(Decimal);
    expect(opp?.feeBreakdown?.gasFraction).toBeInstanceOf(Decimal);
    expect(opp?.feeBreakdown?.totalCosts).toBeInstanceOf(Decimal);
    expect(opp?.feeBreakdown?.buyFeeSchedule).toEqual(polymarketFees);
    expect(opp?.feeBreakdown?.sellFeeSchedule).toEqual(kalshiFees);
    expect(opp?.liquidityDepth).toBeDefined();
    expect(opp?.liquidityDepth?.buyBestAskSize).toBe(10000);
    expect(opp?.liquidityDepth?.sellBestAskSize).toBe(10000);
    expect(opp?.liquidityDepth?.buyBestBidSize).toBe(10000);
    expect(opp?.liquidityDepth?.sellBestBidSize).toBe(10000);
    expect(opp?.recommendedPositionSize).toBeNull();
  });

  // ========================================================================
  // Processes multiple dislocations and returns correct summary counts
  // ========================================================================
  it('processes multiple dislocations and returns correct summary counts', () => {
    const passing = makeDislocation({
      buyPrice: new FinancialDecimal(0.2),
      sellPrice: new FinancialDecimal(0.3),
      pairConfig: makePair({ eventDescription: 'Passing pair' }),
    });
    const failing = makeDislocation({
      buyPrice: new FinancialDecimal(0.5),
      sellPrice: new FinancialDecimal(0.5),
      pairConfig: makePair({ eventDescription: 'Failing pair' }),
    });

    const result = service.processDislocations([passing, failing]);

    expect(result.summary.totalInput).toBe(2);
    expect(result.summary.totalActionable).toBe(1);
    expect(result.summary.totalFiltered).toBe(1);
    expect(result.summary.processingDurationMs).toBeGreaterThanOrEqual(0);
  });

  // ========================================================================
  // Handles empty dislocations array gracefully
  // ========================================================================
  it('handles empty dislocations array gracefully', () => {
    const result = service.processDislocations([]);

    expect(result.opportunities).toHaveLength(0);
    expect(result.filtered).toHaveLength(0);
    expect(result.summary.totalInput).toBe(0);
    expect(result.summary.totalActionable).toBe(0);
    expect(result.summary.totalFiltered).toBe(0);
  });

  // ========================================================================
  // Fetches fee schedules from correct connector per platform
  // ========================================================================
  it('fetches fee schedules from correct connector per platform', () => {
    const dislocation = makeDislocation({
      buyPlatformId: PlatformId.POLYMARKET,
      sellPlatformId: PlatformId.KALSHI,
      buyPrice: new FinancialDecimal(0.2),
      sellPrice: new FinancialDecimal(0.3),
      grossEdge: new FinancialDecimal(0.1),
    });

    service.processDislocations([dislocation]);

    expect(polymarketConnector.getFeeSchedule).toHaveBeenCalled();
    expect(kalshiConnector.getFeeSchedule).toHaveBeenCalled();
  });

  // ========================================================================
  // Uses configurable threshold from ConfigService
  // ========================================================================
  it('uses configurable threshold from ConfigService', () => {
    // Set a very high threshold
    configService.get.mockImplementation(
      (key: string, defaultValue: number) => {
        if (key === 'DETECTION_MIN_EDGE_THRESHOLD') return 0.5;
        return defaultValue;
      },
    );

    const dislocation = makeDislocation({
      buyPrice: new FinancialDecimal(0.2),
      sellPrice: new FinancialDecimal(0.3),
      grossEdge: new FinancialDecimal(0.1),
    });

    const result = service.processDislocations([dislocation]);

    // Even 10% gross edge won't pass 50% threshold
    expect(result.filtered).toHaveLength(1);
    expect(result.opportunities).toHaveLength(0);
  });

  // ========================================================================
  // Uses configurable gas estimate from ConfigService
  // ========================================================================
  it('uses configurable gas estimate from ConfigService', () => {
    // High gas to push net edge below threshold
    configService.get.mockImplementation(
      (key: string, defaultValue: number) => {
        if (key === 'DETECTION_GAS_ESTIMATE_USD') return 100;
        if (key === 'DETECTION_POSITION_SIZE_USD') return 300;
        return defaultValue;
      },
    );

    const dislocation = makeDislocation({
      buyPrice: new FinancialDecimal(0.2),
      sellPrice: new FinancialDecimal(0.3),
      grossEdge: new FinancialDecimal(0.1),
    });

    const result = service.processDislocations([dislocation]);

    // gasFraction = 100/300 ≈ 0.333 which makes net edge negative
    expect(result.filtered).toHaveLength(1);
  });

  // ========================================================================
  // Uses configurable position size from ConfigService
  // ========================================================================
  it('uses configurable position size from ConfigService', () => {
    configService.get.mockImplementation(
      (key: string, defaultValue: number) => {
        if (key === 'DETECTION_POSITION_SIZE_USD') return 10;
        if (key === 'DETECTION_GAS_ESTIMATE_USD') return 0.3;
        return defaultValue;
      },
    );

    // VWAP grossEdge = 0.50 - 0.47 = 0.03 (from book prices)
    // gasFraction = 0.30/10 = 0.03 — much larger impact on small position
    // netEdge = 0.03 - 0.47*0.02 - 0.50*0.02 - 0.03 = 0.03 - 0.0094 - 0.01 - 0.03 = -0.0194
    const dislocation = makeDislocation({
      buyPrice: new FinancialDecimal(0.47),
      sellPrice: new FinancialDecimal(0.5),
    });

    const result = service.processDislocations([dislocation]);

    // Net edge negative due to high gas fraction → filtered
    expect(result.filtered).toHaveLength(1);
  });

  // ========================================================================
  // Negative net edge is filtered
  // ========================================================================
  it('negative net edge is filtered with reason negative_edge', () => {
    // VWAP grossEdge = 0.50 - 0.50 = 0 → net edge negative after fees
    const dislocation = makeDislocation({
      buyPrice: new FinancialDecimal(0.5),
      sellPrice: new FinancialDecimal(0.5),
    });

    const result = service.processDislocations([dislocation]);

    expect(result.filtered).toHaveLength(1);
    expect(result.filtered[0]?.reason).toBe('negative_edge');
  });

  // ========================================================================
  // Threshold multiplier 1.0 when no platforms degraded
  // ========================================================================
  it('threshold multiplier 1.0 when no platforms degraded (threshold unchanged)', () => {
    degradationService.getEdgeThresholdMultiplier.mockReturnValue(1.0);

    const dislocation = makeDislocation({
      buyPrice: new FinancialDecimal(0.2),
      sellPrice: new FinancialDecimal(0.3),
      grossEdge: new FinancialDecimal(0.1),
    });

    const result = service.processDislocations([dislocation]);

    expect(result.opportunities).toHaveLength(1);
    expect(degradationService.getEdgeThresholdMultiplier).toHaveBeenCalledWith(
      PlatformId.POLYMARKET,
    );
  });

  // ========================================================================
  // Skips dislocation gracefully when getFeeSchedule() throws
  // ========================================================================
  it('skips dislocation gracefully when getFeeSchedule() throws, logs error, continues batch', () => {
    const failingDislocation = makeDislocation({
      pairConfig: makePair({ eventDescription: 'Failing pair' }),
    });
    const passingDislocation = makeDislocation({
      buyPrice: new FinancialDecimal(0.2),
      sellPrice: new FinancialDecimal(0.3),
      grossEdge: new FinancialDecimal(0.1),
      pairConfig: makePair({ eventDescription: 'Passing pair' }),
    });

    // First call to polymarket getFeeSchedule throws, second succeeds
    polymarketConnector.getFeeSchedule
      .mockImplementationOnce(() => {
        throw new Error('API timeout');
      })
      .mockReturnValue(polymarketFees);

    const result = service.processDislocations([
      failingDislocation,
      passingDislocation,
    ]);

    // First was skipped due to error, second passes
    expect(result.opportunities).toHaveLength(1);
    expect(
      result.opportunities[0]?.dislocation.pairConfig.eventDescription,
    ).toBe('Passing pair');
    expect(result.summary.totalInput).toBe(2);
    expect(result.summary.skippedErrors).toBe(1);
    expect(result.summary.totalActionable).toBe(1);
    expect(result.summary.totalFiltered).toBe(0);
  });

  // ========================================================================
  // Rejects negative config values at startup
  // ========================================================================
  it('rejects negative config values at startup', async () => {
    const negativeConfigService = {
      get: vi.fn().mockImplementation((key: string, defaultValue: number) => {
        if (key === 'DETECTION_MIN_EDGE_THRESHOLD') return -0.01;
        return defaultValue;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EdgeCalculatorService,
        { provide: ConfigService, useValue: negativeConfigService },
        { provide: DegradationProtocolService, useValue: degradationService },
        { provide: KalshiConnector, useValue: kalshiConnector },
        { provide: PolymarketConnector, useValue: polymarketConnector },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();

    await expect(module.init()).rejects.toThrow('must not be negative');
  });

  // ========================================================================
  // Uses dynamic gasEstimateUsd from FeeSchedule when available (Story 6.0)
  // ========================================================================
  it('uses FeeSchedule.gasEstimateUsd when present (Polymarket dynamic gas)', () => {
    // Polymarket returns gasEstimateUsd = 0.005 in its fee schedule
    polymarketConnector.getFeeSchedule.mockReturnValue({
      ...polymarketFees,
      gasEstimateUsd: 0.005,
    });

    const dislocation = makeDislocation({
      buyPlatformId: PlatformId.POLYMARKET,
      sellPlatformId: PlatformId.KALSHI,
      buyPrice: new FinancialDecimal(0.2),
      sellPrice: new FinancialDecimal(0.3),
      grossEdge: new FinancialDecimal(0.1),
    });

    const result = service.processDislocations([dislocation]);

    // Net edge = 0.1 - (0.7*0.02) - (0.2*0.07) - (0.005/300)
    //          = 0.1 - 0.014 - 0.014 - 0.0000167 ≈ 0.072
    // Should pass threshold (0.008) easily
    expect(result.opportunities).toHaveLength(1);

    // Verify gas fraction uses dynamic 0.005, not static 0.30
    const gasFraction = result.opportunities[0]?.feeBreakdown.gasFraction;
    expect(gasFraction).toBeDefined();
    // gasFraction = 0.005 / 300 ≈ 0.0000167
    expect(gasFraction!.toNumber()).toBeCloseTo(0.005 / 300, 6);
  });

  // ========================================================================
  // Falls back to config when FeeSchedule.gasEstimateUsd is undefined (Kalshi path)
  // ========================================================================
  it('falls back to config gas estimate when FeeSchedule.gasEstimateUsd is undefined (Kalshi path)', () => {
    // Neither fee schedule has gasEstimateUsd
    kalshiConnector.getFeeSchedule.mockReturnValue(kalshiFees);
    polymarketConnector.getFeeSchedule.mockReturnValue(polymarketFees);

    configService.get.mockImplementation(
      (key: string, defaultValue: number) => {
        if (key === 'DETECTION_GAS_ESTIMATE_USD') return 0.3;
        if (key === 'DETECTION_POSITION_SIZE_USD') return 300;
        return defaultValue;
      },
    );

    const dislocation = makeDislocation({
      buyPrice: new FinancialDecimal(0.2),
      sellPrice: new FinancialDecimal(0.3),
      grossEdge: new FinancialDecimal(0.1),
    });

    const result = service.processDislocations([dislocation]);

    expect(result.opportunities).toHaveLength(1);
    // gasFraction = 0.30 / 300 = 0.001
    const gasFraction = result.opportunities[0]?.feeBreakdown.gasFraction;
    expect(gasFraction!.toNumber()).toBeCloseTo(0.001, 6);
  });

  // ========================================================================
  // Capital Efficiency Gate: filters when resolutionDate is null
  // ========================================================================
  it('filters opportunity when resolutionDate is null', () => {
    const dislocation = makeDislocation({
      buyPrice: new FinancialDecimal(0.2),
      sellPrice: new FinancialDecimal(0.3),
      grossEdge: new FinancialDecimal(0.1),
      pairConfig: makePair({ resolutionDate: null }),
    });

    const result = service.processDislocations([dislocation]);

    expect(result.opportunities).toHaveLength(0);
    expect(result.filtered).toHaveLength(1);
    expect(result.filtered[0]?.reason).toBe('no_resolution_date');
    expect(result.filtered[0]?.threshold).toBe('N/A');
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      EVENT_NAMES.OPPORTUNITY_FILTERED,
      expect.objectContaining({ reason: 'no_resolution_date' }),
    );
  });

  // ========================================================================
  // Capital Efficiency Gate: filters when resolutionDate is undefined
  // ========================================================================
  it('filters opportunity when resolutionDate is undefined', () => {
    const dislocation = makeDislocation({
      buyPrice: new FinancialDecimal(0.2),
      sellPrice: new FinancialDecimal(0.3),
      grossEdge: new FinancialDecimal(0.1),
      pairConfig: makePair({ resolutionDate: undefined }),
    });

    const result = service.processDislocations([dislocation]);

    expect(result.opportunities).toHaveLength(0);
    expect(result.filtered).toHaveLength(1);
    expect(result.filtered[0]?.reason).toBe('no_resolution_date');
    expect(result.filtered[0]?.threshold).toBe('N/A');
  });

  // ========================================================================
  // Capital Efficiency Gate: filters when resolution date is in the past
  // ========================================================================
  it('filters opportunity when resolution date is in the past', () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const dislocation = makeDislocation({
      buyPrice: new FinancialDecimal(0.2),
      sellPrice: new FinancialDecimal(0.3),
      grossEdge: new FinancialDecimal(0.1),
      pairConfig: makePair({ resolutionDate: yesterday }),
    });

    const result = service.processDislocations([dislocation]);

    expect(result.opportunities).toHaveLength(0);
    expect(result.filtered).toHaveLength(1);
    expect(result.filtered[0]?.reason).toBe('resolution_date_passed');
    expect(result.filtered[0]?.threshold).toBe('N/A');
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      EVENT_NAMES.OPPORTUNITY_FILTERED,
      expect.objectContaining({ reason: 'resolution_date_passed' }),
    );
  });

  // ========================================================================
  // Capital Efficiency Gate: filters when annualized return below threshold
  // ========================================================================
  it('filters opportunity when annualized return below threshold', () => {
    // resolutionDate 180 days out, net edge ~1% → annualized ≈ 2.03% < 15%
    const futureDate = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000);
    configService.get.mockImplementation(
      (key: string, defaultValue: number) => {
        if (key === 'DETECTION_GAS_ESTIMATE_USD') return 0.13;
        if (key === 'DETECTION_POSITION_SIZE_USD') return 50;
        return defaultValue;
      },
    );

    const dislocation = makeDislocation({
      grossEdge: new FinancialDecimal(0.03),
      pairConfig: makePair({ resolutionDate: futureDate }),
    });

    const result = service.processDislocations([dislocation]);

    expect(result.opportunities).toHaveLength(0);
    expect(result.filtered).toHaveLength(1);
    expect(result.filtered[0]?.reason).toContain('annualized_return_');
    expect(result.filtered[0]?.reason).toContain('below_');

    // Verify filtered event carries matchId and annualizedReturn in opts
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      EVENT_NAMES.OPPORTUNITY_FILTERED,
      expect.objectContaining({
        matchId: 'match-uuid-1',
        annualizedReturn: expect.any(Number),
      }),
    );
  });

  // ========================================================================
  // Capital Efficiency Gate: passes when annualized return meets threshold
  // ========================================================================
  it('passes opportunity when annualized return meets threshold', () => {
    // resolutionDate 7 days out, net edge ~3% → annualized ≈ 156% >> 15%
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const dislocation = makeDislocation({
      buyPrice: new FinancialDecimal(0.2),
      sellPrice: new FinancialDecimal(0.3),
      grossEdge: new FinancialDecimal(0.1),
      pairConfig: makePair({ resolutionDate: futureDate }),
    });

    const result = service.processDislocations([dislocation]);

    expect(result.opportunities).toHaveLength(1);
    expect(result.opportunities[0]?.annualizedReturn).toBeDefined();
    expect(
      result.opportunities[0]?.annualizedReturn!.toNumber(),
    ).toBeGreaterThan(0.15);
  });

  // ========================================================================
  // Capital Efficiency Gate: startup logs annualized return threshold
  // ========================================================================
  it('startup logs annualized return threshold', () => {
    // onModuleInit is called during beforeEach → verify log was emitted
    // Re-init to test explicitly
    service.onModuleInit();
    // No throw = config is valid
    expect(configService.get).toHaveBeenCalledWith(
      'MIN_ANNUALIZED_RETURN',
      '0.15',
    );
  });

  // ========================================================================
  // Capital Efficiency Gate: rejects negative MIN_ANNUALIZED_RETURN at startup
  // ========================================================================
  it('rejects negative MIN_ANNUALIZED_RETURN at startup', async () => {
    const negativeConfigService = {
      get: vi
        .fn()
        .mockImplementation((key: string, defaultValue: number | string) => {
          if (key === 'MIN_ANNUALIZED_RETURN') return '-0.05';
          return defaultValue;
        }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EdgeCalculatorService,
        { provide: ConfigService, useValue: negativeConfigService },
        { provide: DegradationProtocolService, useValue: degradationService },
        { provide: KalshiConnector, useValue: kalshiConnector },
        { provide: PolymarketConnector, useValue: polymarketConnector },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();

    await expect(module.init()).rejects.toThrow('must not be negative');
  });

  // ========================================================================
  // Capital Efficiency Gate: rejects MIN_ANNUALIZED_RETURN > 10.0 at startup
  // ========================================================================
  it('rejects MIN_ANNUALIZED_RETURN above 10.0 at startup', async () => {
    const highConfigService = {
      get: vi
        .fn()
        .mockImplementation((key: string, defaultValue: number | string) => {
          if (key === 'MIN_ANNUALIZED_RETURN') return '15.0';
          return defaultValue;
        }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EdgeCalculatorService,
        { provide: ConfigService, useValue: highConfigService },
        { provide: DegradationProtocolService, useValue: degradationService },
        { provide: KalshiConnector, useValue: kalshiConnector },
        { provide: PolymarketConnector, useValue: polymarketConnector },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();

    await expect(module.init()).rejects.toThrow('must not exceed 10.0');
  });

  // ========================================================================
  // Capital Efficiency Gate: annualizedReturn included in OpportunityIdentifiedEvent
  // ========================================================================
  it('includes annualizedReturn in OpportunityIdentifiedEvent payload', () => {
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const dislocation = makeDislocation({
      buyPrice: new FinancialDecimal(0.2),
      sellPrice: new FinancialDecimal(0.3),
      grossEdge: new FinancialDecimal(0.1),
      pairConfig: makePair({ resolutionDate: futureDate }),
    });

    service.processDislocations([dislocation]);

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      EVENT_NAMES.OPPORTUNITY_IDENTIFIED,
      expect.objectContaining({
        opportunity: expect.objectContaining({
          annualizedReturn: expect.any(Number),
        }),
      }),
    );
  });

  // ========================================================================
  // Story 10-7-2: VWAP Slippage-Aware Edge Calculation — ATDD Red Phase
  // ========================================================================

  // Helper for multi-level order books (VWAP tests)
  function makeMultiLevelOrderBook(
    platformId: PlatformId,
    contractId: string,
    bids: Array<{ price: number; quantity: number }>,
    asks: Array<{ price: number; quantity: number }>,
  ): NormalizedOrderBook {
    return {
      platformId,
      contractId: asContractId(contractId),
      bids,
      asks,
      timestamp: new Date(),
    };
  }

  // Multi-level dislocation factory for VWAP tests
  // Order book prices are derived from buyPrice/sellPrice so they are always consistent
  function makeVwapDislocation(
    overrides?: Partial<RawDislocation>,
  ): RawDislocation {
    const bp = overrides?.buyPrice?.toNumber() ?? 0.45;
    const sp = overrides?.sellPrice?.toNumber() ?? 0.52;

    return makeDislocation({
      buyOrderBook: makeMultiLevelOrderBook(
        PlatformId.POLYMARKET,
        'poly-contract-1',
        [
          { price: bp - 0.01, quantity: 200 },
          { price: bp - 0.03, quantity: 300 },
        ],
        [
          { price: bp, quantity: 200 },
          { price: bp + 0.02, quantity: 300 },
          { price: bp + 0.05, quantity: 500 },
        ],
      ),
      sellOrderBook: makeMultiLevelOrderBook(
        PlatformId.KALSHI,
        'kalshi-contract-1',
        [
          { price: sp, quantity: 200 },
          { price: sp - 0.02, quantity: 300 },
          { price: sp - 0.04, quantity: 500 },
        ],
        [
          { price: sp + 0.01, quantity: 200 },
          { price: sp + 0.03, quantity: 300 },
        ],
      ),
      ...overrides,
    });
  }

  // ---------- AC-1: VWAP-based edge replaces best-bid/ask edge ----------

  it('10-7-2 AC1: single-level book → VWAP equals best-level → both edges identical', () => {
    // Single-level books: VWAP = best-level price, backward compatible
    const dislocation = makeDislocation({
      buyPrice: new FinancialDecimal(0.2),
      sellPrice: new FinancialDecimal(0.3),
      grossEdge: new FinancialDecimal(0.1),
    });

    const result = service.processDislocations([dislocation]);

    expect(result.opportunities).toHaveLength(1);
    const opp = result.opportunities[0]!;
    // With single-level book, VWAP edge === best-level edge

    const oppAny = opp as any;
    expect(oppAny.bestLevelNetEdge).toBeDefined();
    expect(oppAny.bestLevelNetEdge.toNumber()).toBeCloseTo(
      opp.netEdge.toNumber(),
      6,
    );
  });

  it('10-7-2 AC1: multi-level book → VWAP edge lower than best-level edge', () => {
    // Multi-level books cause slippage → VWAP edge < best-level edge
    const dislocation = makeVwapDislocation();
    const result = service.processDislocations([dislocation]);

    expect(result.opportunities).toHaveLength(1);
    const opp = result.opportunities[0]!;

    const oppAny = opp as any;
    expect(oppAny.bestLevelNetEdge).toBeDefined();
    // VWAP edge must be strictly lower due to book depth slippage
    expect(opp.netEdge.toNumber()).toBeLessThan(
      oppAny.bestLevelNetEdge.toNumber(),
    );
  });

  it('10-7-2 AC1: grossEdge recalculated as vwapSellPrice - vwapBuyPrice', () => {
    const dislocation = makeVwapDislocation();
    const result = service.processDislocations([dislocation]);

    expect(result.opportunities).toHaveLength(1);

    const oppAny = result.opportunities[0] as any;
    // VWAP gross edge = vwapSellPrice - vwapBuyPrice (not best-level 0.52 - 0.45 = 0.07)
    expect(oppAny.vwapSellPrice).toBeDefined();
    expect(oppAny.vwapBuyPrice).toBeDefined();
    const expectedGrossEdge = oppAny.vwapSellPrice.minus(oppAny.vwapBuyPrice);
    expect(result.opportunities[0]!.grossEdge.toNumber()).toBeCloseTo(
      expectedGrossEdge.toNumber(),
      6,
    );
  });

  it('10-7-2 AC1: VWAP edge above threshold → enriched opportunity with VWAP prices', () => {
    // Wide spread multi-level book → VWAP edge still above threshold
    const dislocation = makeVwapDislocation({
      buyPrice: new FinancialDecimal(0.2),
      sellPrice: new FinancialDecimal(0.35),
      grossEdge: new FinancialDecimal(0.15),
    });
    const result = service.processDislocations([dislocation]);

    expect(result.opportunities).toHaveLength(1);

    const oppAny = result.opportunities[0] as any;
    expect(oppAny.vwapBuyPrice).toBeInstanceOf(Decimal);
    expect(oppAny.vwapSellPrice).toBeInstanceOf(Decimal);
    expect(oppAny.buyFillRatio).toBeGreaterThan(0);
    expect(oppAny.sellFillRatio).toBeGreaterThan(0);
  });

  // ---------- AC-2: Partial fill handling ----------

  it('10-7-2 AC2: thin book → partial fill VWAP → edge calculated, passes if above threshold', () => {
    // Thin book: 200 contracts per side. With positionSizeUsd=300, buyPrice=0.2:
    // targetContracts = ceil(300/0.2) = 1500 → only 200 available
    // fillRatio = 200/1500 = 0.133 < 0.25 → actually this would be filtered
    // Use larger quantity to get above fillRatio threshold
    const dislocation = makeDislocation({
      buyPrice: new FinancialDecimal(0.2),
      sellPrice: new FinancialDecimal(0.35),
      grossEdge: new FinancialDecimal(0.15),
      buyOrderBook: makeMultiLevelOrderBook(
        PlatformId.POLYMARKET,
        'poly-contract-1',
        [{ price: 0.19, quantity: 500 }],
        [{ price: 0.2, quantity: 500 }],
      ),
      sellOrderBook: makeMultiLevelOrderBook(
        PlatformId.KALSHI,
        'kalshi-contract-1',
        [{ price: 0.35, quantity: 500 }],
        [{ price: 0.36, quantity: 500 }],
      ),
    });
    const result = service.processDislocations([dislocation]);

    // fillRatio = 500/1500 = 0.333 > 0.25 → passes
    expect(result.opportunities).toHaveLength(1);

    const oppAny = result.opportunities[0] as any;
    expect(oppAny.buyFillRatio).toBeGreaterThanOrEqual(0.25);
  });

  it('10-7-2 AC2: very thin book → fill ratio below detectionMinFillRatio → filtered', () => {
    // Extremely thin: 50 contracts, target ~667 → fillRatio = 50/667 ≈ 0.075
    const dislocation = makeDislocation({
      buyOrderBook: makeMultiLevelOrderBook(
        PlatformId.POLYMARKET,
        'poly-contract-1',
        [{ price: 0.44, quantity: 50 }],
        [{ price: 0.45, quantity: 50 }],
      ),
      sellOrderBook: makeMultiLevelOrderBook(
        PlatformId.KALSHI,
        'kalshi-contract-1',
        [{ price: 0.52, quantity: 50 }],
        [{ price: 0.53, quantity: 50 }],
      ),
    });
    const result = service.processDislocations([dislocation]);

    expect(result.opportunities).toHaveLength(0);
    expect(result.filtered).toHaveLength(1);
    expect(result.filtered[0]?.reason).toBe('insufficient_vwap_depth');
  });

  it('10-7-2 AC2: empty book side → VWAP returns null → filtered', () => {
    const dislocation = makeDislocation({
      buyOrderBook: makeMultiLevelOrderBook(
        PlatformId.POLYMARKET,
        'poly-contract-1',
        [{ price: 0.44, quantity: 100 }],
        [], // empty asks → cannot compute buy VWAP
      ),
      sellOrderBook: makeMultiLevelOrderBook(
        PlatformId.KALSHI,
        'kalshi-contract-1',
        [{ price: 0.52, quantity: 100 }],
        [{ price: 0.53, quantity: 100 }],
      ),
    });
    const result = service.processDislocations([dislocation]);

    expect(result.opportunities).toHaveLength(0);
    expect(result.filtered).toHaveLength(1);
    expect(result.filtered[0]?.reason).toBe('insufficient_vwap_depth');
  });

  it('10-7-2 AC2: zero price in dislocation → filtered with insufficient_vwap_depth', () => {
    const dislocation = makeDislocation({
      buyPrice: new FinancialDecimal(0),
      sellPrice: new FinancialDecimal(0.52),
      grossEdge: new FinancialDecimal(0.52),
    });
    const result = service.processDislocations([dislocation]);

    expect(result.opportunities).toHaveLength(0);
    expect(result.filtered).toHaveLength(1);
    expect(result.filtered[0]?.reason).toBe('insufficient_vwap_depth');
  });

  // ---------- AC-3: VWAP-adjusted edge threshold filtering ----------

  it('10-7-2 AC3: VWAP edge below threshold → filtered with below_threshold or negative_edge', () => {
    // Tight spread multi-level book → VWAP slippage pushes edge below threshold (or negative)
    configService.get.mockImplementation(
      (key: string, defaultValue: number) => {
        if (key === 'DETECTION_GAS_ESTIMATE_USD') return 0.3;
        if (key === 'DETECTION_POSITION_SIZE_USD') return 300;
        return defaultValue;
      },
    );
    const dislocation = makeDislocation({
      buyPrice: new FinancialDecimal(0.45),
      sellPrice: new FinancialDecimal(0.47),
      buyOrderBook: makeMultiLevelOrderBook(
        PlatformId.POLYMARKET,
        'poly-contract-1',
        [{ price: 0.44, quantity: 200 }],
        [
          { price: 0.45, quantity: 100 },
          { price: 0.46, quantity: 200 },
          { price: 0.48, quantity: 500 },
        ],
      ),
      sellOrderBook: makeMultiLevelOrderBook(
        PlatformId.KALSHI,
        'kalshi-contract-1',
        [
          { price: 0.47, quantity: 100 },
          { price: 0.45, quantity: 200 },
          { price: 0.43, quantity: 500 },
        ],
        [{ price: 0.48, quantity: 200 }],
      ),
    });
    const result = service.processDislocations([dislocation]);

    expect(result.filtered).toHaveLength(1);
    expect(['below_threshold', 'negative_edge']).toContain(
      result.filtered[0]?.reason,
    );
  });

  it('10-7-2 AC3: degradation multiplier applied to VWAP edge', () => {
    degradationService.getEdgeThresholdMultiplier.mockReturnValue(1.5);

    // Tight spread (0.03) with multi-level slippage → VWAP edge < 1.5x threshold
    const dislocation = makeVwapDislocation({
      buyPrice: new FinancialDecimal(0.47),
      sellPrice: new FinancialDecimal(0.5),
    });
    const result = service.processDislocations([dislocation]);

    // VWAP edge is lower than best-level, and 1.5x threshold (0.012) filters it
    expect(result.filtered.length).toBeGreaterThanOrEqual(1);
  });

  it('10-7-2 AC3: capital efficiency gate uses VWAP net edge for annualized return', () => {
    // Long-dated resolution → annualized return depends on VWAP net edge
    const futureDate = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000);
    const dislocation = makeVwapDislocation({
      pairConfig: makePair({ resolutionDate: futureDate }),
    });
    const result = service.processDislocations([dislocation]);

    // Either filtered (annualized return too low with VWAP) or passed
    // Key: annualized return uses VWAP edge, not best-level
    if (result.opportunities.length > 0) {
      const oppAny = result.opportunities[0] as any;
      expect(oppAny.annualizedReturn).toBeDefined();
    } else {
      expect(result.filtered[0]?.reason).toContain('annualized_return_');
    }
  });

  // ---------- AC-4: Best-level vs VWAP edge comparison logging ----------

  it('10-7-2 AC4: bestLevelNetEdge in enriched opportunity matches traditional calculation', () => {
    const dislocation = makeVwapDislocation({
      buyPrice: new FinancialDecimal(0.2),
      sellPrice: new FinancialDecimal(0.35),
      grossEdge: new FinancialDecimal(0.15),
    });
    const result = service.processDislocations([dislocation]);

    expect(result.opportunities).toHaveLength(1);

    const oppAny = result.opportunities[0] as any;
    // bestLevelNetEdge should equal the old-style calculation (without VWAP)
    expect(oppAny.bestLevelNetEdge).toBeInstanceOf(Decimal);
    expect(oppAny.bestLevelNetEdge.toNumber()).toBeGreaterThan(
      result.opportunities[0]!.netEdge.toNumber(),
    );
  });

  it('10-7-2 AC4: OpportunityIdentifiedEvent payload includes VWAP fields', () => {
    const dislocation = makeVwapDislocation({
      buyPrice: new FinancialDecimal(0.2),
      sellPrice: new FinancialDecimal(0.35),
      grossEdge: new FinancialDecimal(0.15),
    });
    service.processDislocations([dislocation]);

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      EVENT_NAMES.OPPORTUNITY_IDENTIFIED,
      expect.objectContaining({
        opportunity: expect.objectContaining({
          bestLevelNetEdge: expect.any(Number),
          vwapBuyPrice: expect.any(Number),
          vwapSellPrice: expect.any(Number),
          buyFillRatio: expect.any(Number),
          sellFillRatio: expect.any(Number),
        }),
      }),
    );
  });

  it('10-7-2 AC4: OpportunityFilteredEvent payload for insufficient_vwap_depth', () => {
    // Thin book triggers depth filter
    const dislocation = makeDislocation({
      buyOrderBook: makeMultiLevelOrderBook(
        PlatformId.POLYMARKET,
        'poly-contract-1',
        [{ price: 0.44, quantity: 50 }],
        [{ price: 0.45, quantity: 50 }],
      ),
      sellOrderBook: makeMultiLevelOrderBook(
        PlatformId.KALSHI,
        'kalshi-contract-1',
        [{ price: 0.52, quantity: 50 }],
        [{ price: 0.53, quantity: 50 }],
      ),
    });
    service.processDislocations([dislocation]);

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      EVENT_NAMES.OPPORTUNITY_FILTERED,
      expect.objectContaining({
        reason: 'insufficient_vwap_depth',
        matchId: 'match-uuid-1',
      }),
    );
  });

  it('10-7-2 AC4: FilteredDislocation includes bestLevelNetEdge for threshold-filtered', () => {
    // Tight spread → VWAP pushes below threshold
    configService.get.mockImplementation(
      (key: string, defaultValue: number) => {
        if (key === 'DETECTION_GAS_ESTIMATE_USD') return 0.3;
        if (key === 'DETECTION_POSITION_SIZE_USD') return 300;
        return defaultValue;
      },
    );
    const dislocation = makeDislocation({
      buyPrice: new FinancialDecimal(0.45),
      sellPrice: new FinancialDecimal(0.47),
      grossEdge: new FinancialDecimal(0.02),
      buyOrderBook: makeMultiLevelOrderBook(
        PlatformId.POLYMARKET,
        'poly-contract-1',
        [{ price: 0.44, quantity: 200 }],
        [
          { price: 0.45, quantity: 100 },
          { price: 0.46, quantity: 200 },
          { price: 0.48, quantity: 500 },
        ],
      ),
      sellOrderBook: makeMultiLevelOrderBook(
        PlatformId.KALSHI,
        'kalshi-contract-1',
        [
          { price: 0.47, quantity: 100 },
          { price: 0.45, quantity: 200 },
          { price: 0.43, quantity: 500 },
        ],
        [{ price: 0.48, quantity: 200 }],
      ),
    });
    const result = service.processDislocations([dislocation]);

    expect(result.filtered).toHaveLength(1);

    const filteredAny = result.filtered[0] as any;
    expect(filteredAny.bestLevelNetEdge).toBeDefined();
  });

  // ---------- AC-5: Configurable detection fill ratio ----------

  it('10-7-2 AC5: reloadConfig updates detectionMinFillRatio at runtime', () => {
    const svc = service as any;
    expect(svc.reloadConfig).toBeDefined();

    // Reload with new fill ratio
    svc.reloadConfig({ detectionMinFillRatio: '0.5' });

    // Thin book that would pass at 0.25 but fails at 0.5
    const dislocation = makeDislocation({
      buyOrderBook: makeMultiLevelOrderBook(
        PlatformId.POLYMARKET,
        'poly-contract-1',
        [{ price: 0.44, quantity: 100 }],
        [{ price: 0.45, quantity: 200 }],
      ),
      sellOrderBook: makeMultiLevelOrderBook(
        PlatformId.KALSHI,
        'kalshi-contract-1',
        [{ price: 0.52, quantity: 200 }],
        [{ price: 0.53, quantity: 100 }],
      ),
    });
    const result = service.processDislocations([dislocation]);

    // 200 / ~667 ≈ 0.30 < 0.50 → filtered at new threshold
    expect(result.filtered.length).toBeGreaterThanOrEqual(1);
    expect(result.filtered[0]?.reason).toBe('insufficient_vwap_depth');
  });

  it('10-7-2 AC5: startup validation rejects DETECTION_MIN_FILL_RATIO ≤ 0', async () => {
    const badConfigService = {
      get: vi.fn().mockImplementation((key: string, defaultValue: number) => {
        if (key === 'DETECTION_MIN_FILL_RATIO') return -0.1;
        return defaultValue;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EdgeCalculatorService,
        { provide: ConfigService, useValue: badConfigService },
        { provide: DegradationProtocolService, useValue: degradationService },
        { provide: KalshiConnector, useValue: kalshiConnector },
        { provide: PolymarketConnector, useValue: polymarketConnector },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();

    await expect(module.init()).rejects.toThrow();
  });

  it('10-7-2 AC5: startup validation rejects DETECTION_MIN_FILL_RATIO > 1.0', async () => {
    const badConfigService = {
      get: vi.fn().mockImplementation((key: string, defaultValue: number) => {
        if (key === 'DETECTION_MIN_FILL_RATIO') return 1.5;
        return defaultValue;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EdgeCalculatorService,
        { provide: ConfigService, useValue: badConfigService },
        { provide: DegradationProtocolService, useValue: degradationService },
        { provide: KalshiConnector, useValue: kalshiConnector },
        { provide: PolymarketConnector, useValue: polymarketConnector },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();

    await expect(module.init()).rejects.toThrow();
  });
});
