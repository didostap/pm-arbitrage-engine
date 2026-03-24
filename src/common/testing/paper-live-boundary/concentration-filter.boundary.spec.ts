/**
 * Story 10-7-6 AC-5 — Paper/Live Mode Boundary: Concentration Filter Isolation
 *
 * Verifies that paper and live concentration filter state are fully isolated.
 * Cooldown timestamps, concurrent counts, and diversity calculations are
 * tracked independently per mode (all queries scoped by isPaper).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Decimal from 'decimal.js';
import { PairConcentrationFilterService } from '../../../modules/arbitrage-detection/pair-concentration-filter.service';
import { PositionRepository } from '../../../persistence/repositories/position.repository';
import { ConfigAccessor } from '../../config/config-accessor.service';
import { PAIR_CONCENTRATION_FILTER_TOKEN } from '../../interfaces';
import type { EnrichedOpportunity } from '../../../modules/arbitrage-detection/types/enriched-opportunity.type';

function makeOpportunity(matchId: string): EnrichedOpportunity {
  return {
    dislocation: {
      pairConfig: {
        matchId,
        eventDescription: `Pair ${matchId}`,
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
    netEdge: new Decimal('0.02'),
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

describe.each([
  [true, 'paper'],
  [false, 'live'],
] as const)(
  'Concentration Filter Boundary (isPaper=%s, mode=%s)',
  (isPaper, modeName) => {
    let service: PairConcentrationFilterService;
    let positionRepo: {
      getLatestPositionDateByPairIds: ReturnType<typeof vi.fn>;
      getActivePositionCountsByPair: ReturnType<typeof vi.fn>;
    };

    beforeEach(async () => {
      positionRepo = {
        getLatestPositionDateByPairIds: vi.fn().mockResolvedValue(new Map()),
        getActivePositionCountsByPair: vi.fn().mockResolvedValue(new Map()),
      };

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
              get: vi.fn().mockResolvedValue({
                pairCooldownMinutes: 30,
                pairMaxConcurrentPositions: 2,
                pairDiversityThreshold: 5,
              }),
            },
          },
          { provide: EventEmitter2, useValue: { emit: vi.fn() } },
        ],
      }).compile();

      service = module.get<PairConcentrationFilterService>(
        PAIR_CONCENTRATION_FILTER_TOKEN,
      );
    });

    it(`${modeName}: cooldown query is scoped to isPaper=${isPaper}`, async () => {
      await service.filterOpportunities([makeOpportunity('pair-A')], isPaper);

      expect(positionRepo.getLatestPositionDateByPairIds).toHaveBeenCalledWith(
        expect.any(Array),
        isPaper,
      );
    });

    it(`${modeName}: concurrent query is scoped to isPaper=${isPaper}`, async () => {
      await service.filterOpportunities([makeOpportunity('pair-A')], isPaper);

      expect(positionRepo.getActivePositionCountsByPair).toHaveBeenCalledWith(
        isPaper,
      );
    });

    it(`${modeName}: paper cooldown does not affect ${isPaper ? 'live' : 'paper'} opportunity`, async () => {
      // Setup: position exists in current mode (cooldown active)
      const recentDate = new Date(Date.now() - 5 * 60_000);
      positionRepo.getLatestPositionDateByPairIds.mockResolvedValue(
        new Map([['pair-A', recentDate]]),
      );

      // Same pair, current mode → filtered
      const resultSameMode = await service.filterOpportunities(
        [makeOpportunity('pair-A')],
        isPaper,
      );
      expect(resultSameMode.filtered).toHaveLength(1);

      // Opposite mode → NOT filtered (repo returns independent data per mode)
      positionRepo.getLatestPositionDateByPairIds.mockResolvedValue(new Map());
      const resultOppositeMode = await service.filterOpportunities(
        [makeOpportunity('pair-A')],
        !isPaper,
      );
      expect(resultOppositeMode.passed).toHaveLength(1);
      expect(resultOppositeMode.filtered).toHaveLength(0);
    });

    it(`${modeName}: concurrent count does not affect ${isPaper ? 'live' : 'paper'} filtering`, async () => {
      // Current mode has 2 open → at limit
      positionRepo.getActivePositionCountsByPair.mockResolvedValue(
        new Map([['pair-A', 2]]),
      );

      const resultSameMode = await service.filterOpportunities(
        [makeOpportunity('pair-A')],
        isPaper,
      );
      expect(resultSameMode.filtered).toHaveLength(1);

      // Opposite mode has 0 open → passes
      positionRepo.getActivePositionCountsByPair.mockResolvedValue(new Map());
      positionRepo.getLatestPositionDateByPairIds.mockResolvedValue(new Map());
      const resultOppositeMode = await service.filterOpportunities(
        [makeOpportunity('pair-A')],
        !isPaper,
      );
      expect(resultOppositeMode.passed).toHaveLength(1);
    });

    it(`${modeName}: diversity threshold applied independently per mode`, async () => {
      // Current mode: 6 positions across 2 pairs → diversity active
      positionRepo.getActivePositionCountsByPair.mockResolvedValue(
        new Map([
          ['pair-A', 4],
          ['pair-B', 2],
        ]),
      );

      const resultSameMode = await service.filterOpportunities(
        [makeOpportunity('pair-A')],
        isPaper,
      );
      // pair-A has 4, avg=3, 4>=3 → filtered
      expect(resultSameMode.filtered).toHaveLength(1);

      // Opposite mode: no positions → diversity doesn't apply
      positionRepo.getActivePositionCountsByPair.mockResolvedValue(new Map());
      positionRepo.getLatestPositionDateByPairIds.mockResolvedValue(new Map());
      const resultOppositeMode = await service.filterOpportunities(
        [makeOpportunity('pair-A')],
        !isPaper,
      );
      expect(resultOppositeMode.passed).toHaveLength(1);
    });
  },
);
