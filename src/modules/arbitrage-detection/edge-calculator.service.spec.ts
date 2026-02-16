/* eslint-disable @typescript-eslint/no-unsafe-assignment */
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
import { ContractPairConfig } from '../contract-matching/types';
import { RawDislocation } from './types/raw-dislocation.type';

function makeOrderBook(
  platformId: PlatformId,
  contractId: string,
  bestBid: number,
  bestAsk: number,
  quantity = 100,
): NormalizedOrderBook {
  return {
    platformId,
    contractId,
    bids: bestBid > 0 ? [{ price: bestBid, quantity }] : [],
    asks: bestAsk > 0 ? [{ price: bestAsk, quantity }] : [],
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
  return {
    pairConfig: makePair(),
    buyPlatformId: PlatformId.POLYMARKET,
    sellPlatformId: PlatformId.KALSHI,
    buyPrice: new FinancialDecimal(0.52),
    sellPrice: new FinancialDecimal(0.45),
    grossEdge: new FinancialDecimal(0.03),
    buyOrderBook: makeOrderBook(
      PlatformId.POLYMARKET,
      'poly-contract-1',
      0.51,
      0.52,
    ),
    sellOrderBook: makeOrderBook(
      PlatformId.KALSHI,
      'kalshi-contract-1',
      0.44,
      0.45,
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

    const dislocation = makeDislocation({
      buyPrice: new FinancialDecimal(0.52),
      sellPrice: new FinancialDecimal(0.45),
      grossEdge: new FinancialDecimal(0.03),
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

    const dislocation = makeDislocation({
      buyPrice: new FinancialDecimal(0.52),
      sellPrice: new FinancialDecimal(0.45),
      grossEdge: new FinancialDecimal(0.03),
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

    expect(result.opportunities).toHaveLength(1);
    expect(result.opportunities[0]?.netEdge.toNumber()).toBeCloseTo(0.0081, 4);
  });

  // ========================================================================
  // Applies 1.5x threshold multiplier when platform is degraded
  // ========================================================================
  it('applies 1.5x threshold multiplier when platform is degraded', () => {
    degradationService.getEdgeThresholdMultiplier.mockReturnValue(1.5);

    // With default config: gas=0.30, positionSize=300
    // Net edge = 0.03 - (0.52*0.02) - (0.45*0.02) - (0.30/300)
    //          = 0.03 - 0.0104 - 0.009 - 0.001 = 0.0096
    // Effective threshold = 0.008 * 1.5 = 0.012
    // 0.0096 < 0.012 → filtered
    const dislocation = makeDislocation();
    const result = service.processDislocations([dislocation]);

    expect(result.filtered).toHaveLength(1);
    expect(result.opportunities).toHaveLength(0);
  });

  // ========================================================================
  // Emits OpportunityFilteredEvent for filtered dislocations
  // ========================================================================
  it('emits OpportunityFilteredEvent for filtered dislocations', () => {
    // Force below threshold
    configService.get.mockImplementation(
      (key: string, defaultValue: number) => {
        if (key === 'DETECTION_GAS_ESTIMATE_USD') return 0.135;
        if (key === 'DETECTION_POSITION_SIZE_USD') return 50;
        return defaultValue;
      },
    );

    const dislocation = makeDislocation();
    service.processDislocations([dislocation]);

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      EVENT_NAMES.OPPORTUNITY_FILTERED,
      expect.objectContaining({
        pairEventDescription: 'Will event X happen?',
        reason: 'below_threshold',
      }),
    );
  });

  // ========================================================================
  // Emits OpportunityIdentifiedEvent for passing dislocations
  // ========================================================================
  it('emits OpportunityIdentifiedEvent for passing dislocations', () => {
    // Use large spread scenario to guarantee passing
    const dislocation = makeDislocation({
      buyPrice: new FinancialDecimal(0.7),
      sellPrice: new FinancialDecimal(0.2),
      grossEdge: new FinancialDecimal(0.1),
    });

    const result = service.processDislocations([dislocation]);

    expect(result.opportunities).toHaveLength(1);
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      EVENT_NAMES.OPPORTUNITY_IDENTIFIED,
      expect.objectContaining({
        opportunity: expect.objectContaining({
          netEdge: expect.any(Decimal),
        }),
      }),
    );
  });

  // ========================================================================
  // Enriched opportunity includes fee breakdown and liquidity depth
  // ========================================================================
  it('enriched opportunity includes fee breakdown and liquidity depth', () => {
    const dislocation = makeDislocation({
      buyPrice: new FinancialDecimal(0.7),
      sellPrice: new FinancialDecimal(0.2),
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
    expect(opp?.liquidityDepth?.buyBestAskSize).toBe(100);
    expect(opp?.liquidityDepth?.sellBestAskSize).toBe(100);
    expect(opp?.liquidityDepth?.buyBestBidSize).toBe(100);
    expect(opp?.liquidityDepth?.sellBestBidSize).toBe(100);
    expect(opp?.recommendedPositionSize).toBeNull();
  });

  // ========================================================================
  // Processes multiple dislocations and returns correct summary counts
  // ========================================================================
  it('processes multiple dislocations and returns correct summary counts', () => {
    const passing = makeDislocation({
      buyPrice: new FinancialDecimal(0.7),
      sellPrice: new FinancialDecimal(0.2),
      grossEdge: new FinancialDecimal(0.1),
      pairConfig: makePair({ eventDescription: 'Passing pair' }),
    });
    const failing = makeDislocation({
      buyPrice: new FinancialDecimal(0.5),
      sellPrice: new FinancialDecimal(0.5),
      grossEdge: new FinancialDecimal(0),
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
      buyPrice: new FinancialDecimal(0.7),
      sellPrice: new FinancialDecimal(0.2),
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
      buyPrice: new FinancialDecimal(0.7),
      sellPrice: new FinancialDecimal(0.2),
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
      buyPrice: new FinancialDecimal(0.7),
      sellPrice: new FinancialDecimal(0.2),
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

    // gasFraction = 0.30/10 = 0.03 — much larger impact on small position
    const dislocation = makeDislocation({
      buyPrice: new FinancialDecimal(0.52),
      sellPrice: new FinancialDecimal(0.45),
      grossEdge: new FinancialDecimal(0.03),
    });

    const result = service.processDislocations([dislocation]);

    // Net edge will be negative due to high gas fraction
    expect(result.filtered).toHaveLength(1);
  });

  // ========================================================================
  // Negative net edge is filtered
  // ========================================================================
  it('negative net edge is filtered with reason negative_edge', () => {
    const dislocation = makeDislocation({
      buyPrice: new FinancialDecimal(0.5),
      sellPrice: new FinancialDecimal(0.5),
      grossEdge: new FinancialDecimal(0),
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
      buyPrice: new FinancialDecimal(0.7),
      sellPrice: new FinancialDecimal(0.2),
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
      buyPrice: new FinancialDecimal(0.7),
      sellPrice: new FinancialDecimal(0.2),
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
});
