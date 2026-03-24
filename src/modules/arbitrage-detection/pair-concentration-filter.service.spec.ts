import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Decimal from 'decimal.js';
import { PairConcentrationFilterService } from './pair-concentration-filter.service';
import { PositionRepository } from '../../persistence/repositories/position.repository';
import { ConfigAccessor } from '../../common/config/config-accessor.service';
import { PAIR_CONCENTRATION_FILTER_TOKEN } from '../../common/interfaces';
import { EVENT_NAMES } from '../../common/events/event-catalog';
import type { EnrichedOpportunity } from './types/enriched-opportunity.type';

function makeOpportunity(
  matchId: string,
  netEdge = new Decimal('0.02'),
  eventDescription = `Test pair ${matchId}`,
): EnrichedOpportunity {
  return {
    dislocation: {
      pairConfig: {
        matchId,
        eventDescription,
        polymarketContractId: `poly-${matchId}`,
        polymarketClobTokenId: `clob-${matchId}`,
        kalshiContractId: `kalshi-${matchId}`,
        operatorVerificationTimestamp: new Date(),
        primaryLeg: 'kalshi',
      },
      buyPlatformId: 'kalshi',
      sellPlatformId: 'polymarket',
      buyPrice: new Decimal('0.45'),
      sellPrice: new Decimal('0.55'),
      grossEdge: new Decimal('0.10'),
      buyOrderBook: { bids: [], asks: [], timestamp: new Date() },
      sellOrderBook: { bids: [], asks: [], timestamp: new Date() },
      detectedAt: new Date(),
    },
    netEdge,
    grossEdge: new Decimal('0.10'),
    bestLevelNetEdge: new Decimal('0.02'),
    vwapBuyPrice: new Decimal('0.45'),
    vwapSellPrice: new Decimal('0.55'),
    buyFillRatio: 1.0,
    sellFillRatio: 1.0,
    feeBreakdown: {
      buyFeeCost: new Decimal('0'),
      sellFeeCost: new Decimal('0'),
      gasFraction: new Decimal('0'),
      totalCosts: new Decimal('0'),
      buyFeeSchedule: {
        makerRate: new Decimal('0'),
        takerRate: new Decimal('0'),
      },
      sellFeeSchedule: {
        makerRate: new Decimal('0'),
        takerRate: new Decimal('0'),
      },
    },
    liquidityDepth: {
      buyBestAskSize: 100,
      sellBestAskSize: 100,
      buyBestBidSize: 100,
      sellBestBidSize: 100,
      buyTotalDepth: 500,
      sellTotalDepth: 500,
    },
    recommendedPositionSize: null,
    annualizedReturn: new Decimal('0.50'),
    enrichedAt: new Date(),
  } as EnrichedOpportunity;
}

describe('PairConcentrationFilterService', () => {
  let service: PairConcentrationFilterService;
  let positionRepo: {
    getLatestPositionDateByPairIds: ReturnType<typeof vi.fn>;
    getActivePositionCountsByPair: ReturnType<typeof vi.fn>;
  };
  let mockEffectiveConfig: {
    pairCooldownMinutes: number;
    pairMaxConcurrentPositions: number;
    pairDiversityThreshold: number;
  };
  let eventEmitter: { emit: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    positionRepo = {
      getLatestPositionDateByPairIds: vi.fn().mockResolvedValue(new Map()),
      getActivePositionCountsByPair: vi.fn().mockResolvedValue(new Map()),
    };
    mockEffectiveConfig = {
      pairCooldownMinutes: 30,
      pairMaxConcurrentPositions: 2,
      pairDiversityThreshold: 5,
    };
    eventEmitter = { emit: vi.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: PAIR_CONCENTRATION_FILTER_TOKEN,
          useClass: PairConcentrationFilterService,
        },
        { provide: PositionRepository, useValue: positionRepo },
        {
          provide: ConfigAccessor,
          useValue: {
            get: vi
              .fn()
              .mockImplementation(() => Promise.resolve(mockEffectiveConfig)),
          },
        },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();

    service = module.get<PairConcentrationFilterService>(
      PAIR_CONCENTRATION_FILTER_TOKEN,
    );
  });

  it('should pass all opportunities when no position history exists', async () => {
    const opps = [makeOpportunity('pair-A')];
    const result = await service.filterOpportunities(opps, true);
    expect(result.passed).toHaveLength(1);
    expect(result.filtered).toHaveLength(0);
  });

  it('should return empty passed/filtered for empty input', async () => {
    const result = await service.filterOpportunities([], true);
    expect(result.passed).toHaveLength(0);
    expect(result.filtered).toHaveLength(0);
  });

  // --- Cooldown tests ---
  describe('cooldown filter', () => {
    it('should block opportunity within cooldown window', async () => {
      const recentDate = new Date(Date.now() - 10 * 60_000); // 10 min ago
      positionRepo.getLatestPositionDateByPairIds.mockResolvedValue(
        new Map([['pair-A', recentDate]]),
      );

      const result = await service.filterOpportunities(
        [makeOpportunity('pair-A')],
        true,
      );

      expect(result.passed).toHaveLength(0);
      expect(result.filtered).toHaveLength(1);
      expect(result.filtered[0].reason).toBe('pair_cooldown_active');
    });

    it('should allow opportunity after cooldown expires', async () => {
      const oldDate = new Date(Date.now() - 60 * 60_000); // 60 min ago
      positionRepo.getLatestPositionDateByPairIds.mockResolvedValue(
        new Map([['pair-A', oldDate]]),
      );

      const result = await service.filterOpportunities(
        [makeOpportunity('pair-A')],
        true,
      );

      expect(result.passed).toHaveLength(1);
      expect(result.filtered).toHaveLength(0);
    });

    it('should allow when no prior position exists for pair', async () => {
      positionRepo.getLatestPositionDateByPairIds.mockResolvedValue(new Map());

      const result = await service.filterOpportunities(
        [makeOpportunity('pair-A')],
        true,
      );

      expect(result.passed).toHaveLength(1);
    });

    it('should be disabled when config=0', async () => {
      mockEffectiveConfig.pairCooldownMinutes = 0;

      const recentDate = new Date(Date.now() - 1 * 60_000); // 1 min ago
      positionRepo.getLatestPositionDateByPairIds.mockResolvedValue(
        new Map([['pair-A', recentDate]]),
      );

      const result = await service.filterOpportunities(
        [makeOpportunity('pair-A')],
        true,
      );

      expect(result.passed).toHaveLength(1);
    });
  });

  // --- Concurrent filter tests ---
  describe('concurrent filter', () => {
    beforeEach(() => {
      // Disable diversity to isolate concurrent checks
      mockEffectiveConfig.pairDiversityThreshold = 0;
    });

    it('should block at limit', async () => {
      positionRepo.getActivePositionCountsByPair.mockResolvedValue(
        new Map([['pair-A', 2]]),
      );

      const result = await service.filterOpportunities(
        [makeOpportunity('pair-A')],
        true,
      );

      expect(result.filtered).toHaveLength(1);
      expect(result.filtered[0].reason).toBe('pair_max_concurrent_reached');
    });

    it('should allow below limit', async () => {
      positionRepo.getActivePositionCountsByPair.mockResolvedValue(
        new Map([['pair-A', 1]]),
      );

      const result = await service.filterOpportunities(
        [makeOpportunity('pair-A')],
        true,
      );

      expect(result.passed).toHaveLength(1);
    });

    it('should be disabled when config=0', async () => {
      mockEffectiveConfig.pairMaxConcurrentPositions = 0;
      mockEffectiveConfig.pairDiversityThreshold = 0;

      positionRepo.getActivePositionCountsByPair.mockResolvedValue(
        new Map([['pair-A', 100]]),
      );

      const result = await service.filterOpportunities(
        [makeOpportunity('pair-A')],
        true,
      );

      expect(result.passed).toHaveLength(1);
    });
  });

  // --- Diversity filter tests ---
  describe('diversity filter', () => {
    beforeEach(() => {
      // Disable concurrent to isolate diversity checks
      mockEffectiveConfig.pairMaxConcurrentPositions = 0;
    });

    it('should block above-average pair when total >= threshold', async () => {
      // 5 total positions: A=3, B=2. Average=2.5. A(3>=2.5) blocked, B(2<2.5) allowed.
      positionRepo.getActivePositionCountsByPair.mockResolvedValue(
        new Map([
          ['pair-A', 3],
          ['pair-B', 2],
        ]),
      );

      const result = await service.filterOpportunities(
        [makeOpportunity('pair-A'), makeOpportunity('pair-B')],
        true,
      );

      expect(result.passed).toHaveLength(1);
      expect(result.passed[0].dislocation.pairConfig.matchId).toBe('pair-B');
      expect(result.filtered).toHaveLength(1);
      expect(result.filtered[0].reason).toBe(
        'pair_above_average_concentration',
      );
      expect(
        result.filtered[0].opportunity.dislocation.pairConfig.matchId,
      ).toBe('pair-A');
    });

    it('should allow all when total < threshold', async () => {
      mockEffectiveConfig.pairMaxConcurrentPositions = 0;
      mockEffectiveConfig.pairDiversityThreshold = 5;

      positionRepo.getActivePositionCountsByPair.mockResolvedValue(
        new Map([
          ['pair-A', 2],
          ['pair-B', 2],
        ]),
      );

      const result = await service.filterOpportunities(
        [makeOpportunity('pair-A'), makeOpportunity('pair-B')],
        true,
      );

      // Total = 4, threshold = 5 → diversity does not apply
      expect(result.passed).toHaveLength(2);
    });

    it('should handle new pair (count=0) correctly', async () => {
      // Pair-C has no open positions, diversity should allow it
      positionRepo.getActivePositionCountsByPair.mockResolvedValue(
        new Map([
          ['pair-A', 3],
          ['pair-B', 3],
        ]),
      );

      const result = await service.filterOpportunities(
        [makeOpportunity('pair-C')],
        true,
      );

      // Total=6, threshold=5, pair-C count=0, average=6/2=3, 0 < 3 → allowed
      expect(result.passed).toHaveLength(1);
    });

    it('should be disabled when config=0', async () => {
      mockEffectiveConfig.pairMaxConcurrentPositions = 0;
      mockEffectiveConfig.pairDiversityThreshold = 0;

      positionRepo.getActivePositionCountsByPair.mockResolvedValue(
        new Map([['pair-A', 100]]),
      );

      const result = await service.filterOpportunities(
        [makeOpportunity('pair-A')],
        true,
      );

      expect(result.passed).toHaveLength(1);
    });
  });

  // --- Config via ConfigAccessor ---
  it('should read config from ConfigAccessor on each call (hot-reload via cache)', async () => {
    mockEffectiveConfig.pairCooldownMinutes = 0;

    const recentDate = new Date(Date.now() - 1 * 60_000);
    positionRepo.getLatestPositionDateByPairIds.mockResolvedValue(
      new Map([['pair-A', recentDate]]),
    );

    const result = await service.filterOpportunities(
      [makeOpportunity('pair-A')],
      true,
    );

    expect(result.passed).toHaveLength(1);
  });

  // --- Mode isolation ---
  it('should pass isPaper to repository methods', async () => {
    await service.filterOpportunities([makeOpportunity('pair-A')], true);
    expect(positionRepo.getLatestPositionDateByPairIds).toHaveBeenCalledWith(
      expect.any(Array),
      true,
    );
    expect(positionRepo.getActivePositionCountsByPair).toHaveBeenCalledWith(
      true,
    );

    await service.filterOpportunities([makeOpportunity('pair-A')], false);
    expect(positionRepo.getLatestPositionDateByPairIds).toHaveBeenCalledWith(
      expect.any(Array),
      false,
    );
    expect(positionRepo.getActivePositionCountsByPair).toHaveBeenCalledWith(
      false,
    );
  });

  // --- Event emission ---
  it('should emit OpportunityFilteredEvent with correct payload for each filtered opportunity', async () => {
    const recentDate = new Date(Date.now() - 5 * 60_000);
    positionRepo.getLatestPositionDateByPairIds.mockResolvedValue(
      new Map([['pair-A', recentDate]]),
    );

    await service.filterOpportunities([makeOpportunity('pair-A')], true);

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      EVENT_NAMES.OPPORTUNITY_CONCENTRATION_FILTERED,
      expect.objectContaining({
        reason: 'pair_cooldown_active',
        matchId: 'pair-A',
        pairEventDescription: 'Test pair pair-A',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        netEdge: expect.any(Decimal),
      }),
    );
  });

  // --- Multiple opportunities ---
  it('should batch-filter multiple opportunities independently', async () => {
    const recentDate = new Date(Date.now() - 5 * 60_000);
    positionRepo.getLatestPositionDateByPairIds.mockResolvedValue(
      new Map([['pair-A', recentDate]]),
    );
    positionRepo.getActivePositionCountsByPair.mockResolvedValue(new Map());

    const result = await service.filterOpportunities(
      [makeOpportunity('pair-A'), makeOpportunity('pair-B')],
      true,
    );

    expect(result.passed).toHaveLength(1);
    expect(result.passed[0].dislocation.pairConfig.matchId).toBe('pair-B');
    expect(result.filtered).toHaveLength(1);
    expect(result.filtered[0].opportunity.dislocation.pairConfig.matchId).toBe(
      'pair-A',
    );
  });

  // --- In-batch concurrent tracking (Finding #4) ---
  it('should block second same-pair opportunity in batch via in-batch tracking', async () => {
    // pair-A has 1 open, max=2. First opp passes (1<2), second blocked (1+1>=2)
    mockEffectiveConfig.pairCooldownMinutes = 0;
    mockEffectiveConfig.pairDiversityThreshold = 0;
    mockEffectiveConfig.pairMaxConcurrentPositions = 2;

    positionRepo.getActivePositionCountsByPair.mockResolvedValue(
      new Map([['pair-A', 1]]),
    );

    const result = await service.filterOpportunities(
      [makeOpportunity('pair-A'), makeOpportunity('pair-A')],
      true,
    );

    expect(result.passed).toHaveLength(1);
    expect(result.filtered).toHaveLength(1);
    expect(result.filtered[0].reason).toBe('pair_max_concurrent_reached');
  });

  // --- Fail-open ---
  it('should return all opportunities as passed on repository error (fail-open)', async () => {
    positionRepo.getLatestPositionDateByPairIds.mockRejectedValue(
      new Error('DB timeout'),
    );

    const opps = [makeOpportunity('pair-A'), makeOpportunity('pair-B')];
    const result = await service.filterOpportunities(opps, true);

    expect(result.passed).toHaveLength(2);
    expect(result.filtered).toHaveLength(0);
  });

  it('should fail-open when second query fails (partial failure)', async () => {
    positionRepo.getLatestPositionDateByPairIds.mockResolvedValue(new Map());
    positionRepo.getActivePositionCountsByPair.mockRejectedValue(
      new Error('connection reset'),
    );

    const result = await service.filterOpportunities(
      [makeOpportunity('pair-A')],
      true,
    );

    expect(result.passed).toHaveLength(1);
    expect(result.filtered).toHaveLength(0);
  });

  it('should emit SystemHealthError event on repository error', async () => {
    positionRepo.getLatestPositionDateByPairIds.mockRejectedValue(
      new Error('DB timeout'),
    );

    await service.filterOpportunities([makeOpportunity('pair-A')], true);

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      EVENT_NAMES.SYSTEM_HEALTH_CRITICAL,
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        code: expect.any(Number),
      }),
    );
  });
});
