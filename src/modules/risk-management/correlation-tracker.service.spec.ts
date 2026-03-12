import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Decimal from 'decimal.js';
import { CorrelationTrackerService } from './correlation-tracker.service.js';
import { PrismaService } from '../../common/prisma.service.js';
import { EVENT_NAMES } from '../../common/events/event-catalog.js';

describe('CorrelationTrackerService', () => {
  let service: CorrelationTrackerService;
  let prisma: {
    openPosition: { findMany: ReturnType<typeof vi.fn> };
    correlationCluster: { findMany: ReturnType<typeof vi.fn> };
  };
  let eventEmitter: { emit: ReturnType<typeof vi.fn> };
  let configService: { get: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    prisma = {
      openPosition: { findMany: vi.fn().mockResolvedValue([]) },
      correlationCluster: { findMany: vi.fn().mockResolvedValue([]) },
    };
    eventEmitter = { emit: vi.fn() };
    configService = {
      get: vi.fn().mockImplementation((key: string, defaultVal?: unknown) => {
        const map: Record<string, unknown> = {
          RISK_BANKROLL_USD: '10000',
          RISK_CLUSTER_HARD_LIMIT_PCT: '0.15',
          RISK_CLUSTER_SOFT_LIMIT_PCT: '0.12',
        };
        return map[key] ?? defaultVal;
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        CorrelationTrackerService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get(CorrelationTrackerService);
  });

  describe('recalculateClusterExposure', () => {
    it('should calculate exposure from position sizes and entry prices using decimal.js', async () => {
      prisma.openPosition.findMany.mockResolvedValue([
        {
          positionId: 'pos-1',
          sizes: { polymarket: '100', kalshi: '50' },
          entryPrices: { polymarket: '0.60', kalshi: '0.45' },
          pair: {
            clusterId: 'cluster-1',
            cluster: { id: 'cluster-1', name: 'Economics' },
          },
        },
      ]);

      await service.recalculateClusterExposure();

      const exposures = service.getClusterExposures();
      expect(exposures).toHaveLength(1);
      const econ = exposures[0]!;
      // 100 * 0.60 + 50 * 0.45 = 60 + 22.5 = 82.5
      expect(econ.exposureUsd.eq(new Decimal('82.5'))).toBe(true);
      expect(econ.clusterName).toBe('Economics');
      expect(econ.pairCount).toBe(1);
      // 82.5 / 10000 = 0.825%
      expect(econ.exposurePct.eq(new Decimal('0.00825'))).toBe(true);
    });

    it('should sum multiple positions in the same cluster', async () => {
      prisma.openPosition.findMany.mockResolvedValue([
        {
          positionId: 'pos-1',
          sizes: { polymarket: '100', kalshi: '50' },
          entryPrices: { polymarket: '0.60', kalshi: '0.45' },
          pair: {
            clusterId: 'cluster-1',
            cluster: { id: 'cluster-1', name: 'Economics' },
          },
        },
        {
          positionId: 'pos-2',
          sizes: { polymarket: '200', kalshi: '100' },
          entryPrices: { polymarket: '0.55', kalshi: '0.50' },
          pair: {
            clusterId: 'cluster-1',
            cluster: { id: 'cluster-1', name: 'Economics' },
          },
        },
      ]);

      await service.recalculateClusterExposure();

      const exposures = service.getClusterExposures();
      expect(exposures).toHaveLength(1);
      // pos-1: 100*0.60 + 50*0.45 = 82.5
      // pos-2: 200*0.55 + 100*0.50 = 160
      // total: 242.5
      expect(exposures[0]!.exposureUsd.eq(new Decimal('242.5'))).toBe(true);
      expect(exposures[0]!.pairCount).toBe(2);
    });

    it('should separate exposures by cluster', async () => {
      prisma.openPosition.findMany.mockResolvedValue([
        {
          positionId: 'pos-1',
          sizes: { polymarket: '100', kalshi: '50' },
          entryPrices: { polymarket: '0.60', kalshi: '0.45' },
          pair: {
            clusterId: 'cluster-1',
            cluster: { id: 'cluster-1', name: 'Economics' },
          },
        },
        {
          positionId: 'pos-2',
          sizes: { polymarket: '200', kalshi: '100' },
          entryPrices: { polymarket: '0.55', kalshi: '0.50' },
          pair: {
            clusterId: 'cluster-2',
            cluster: { id: 'cluster-2', name: 'Politics' },
          },
        },
      ]);

      await service.recalculateClusterExposure();

      const exposures = service.getClusterExposures();
      expect(exposures).toHaveLength(2);
    });

    it('should skip positions with null clusterId', async () => {
      prisma.openPosition.findMany.mockResolvedValue([
        {
          positionId: 'pos-1',
          sizes: { polymarket: '100', kalshi: '50' },
          entryPrices: { polymarket: '0.60', kalshi: '0.45' },
          pair: { clusterId: null, cluster: null },
        },
      ]);

      await service.recalculateClusterExposure();

      const exposures = service.getClusterExposures();
      expect(exposures).toHaveLength(0);
    });

    it('should emit limit_approached when exposure exceeds soft limit', async () => {
      // 12% of 10000 = 1200 soft limit
      prisma.openPosition.findMany.mockResolvedValue([
        {
          positionId: 'pos-1',
          sizes: { polymarket: '1000', kalshi: '1000' },
          entryPrices: { polymarket: '0.70', kalshi: '0.60' },
          pair: {
            clusterId: 'cluster-1',
            cluster: { id: 'cluster-1', name: 'Economics' },
          },
        },
      ]);
      // 1000*0.70 + 1000*0.60 = 1300 → 13% > 12% soft limit

      await service.recalculateClusterExposure();

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.CLUSTER_LIMIT_APPROACHED,
        expect.objectContaining({
          clusterName: 'Economics',
        }),
      );
    });

    it('should NOT emit limit_approached when exposure is below soft limit', async () => {
      prisma.openPosition.findMany.mockResolvedValue([
        {
          positionId: 'pos-1',
          sizes: { polymarket: '100', kalshi: '50' },
          entryPrices: { polymarket: '0.60', kalshi: '0.45' },
          pair: {
            clusterId: 'cluster-1',
            cluster: { id: 'cluster-1', name: 'Economics' },
          },
        },
      ]);
      // 82.5 / 10000 = 0.825% — well below 12%

      await service.recalculateClusterExposure();

      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('getClusterExposures', () => {
    it('should return empty array initially', () => {
      const exposures = service.getClusterExposures();
      expect(exposures).toEqual([]);
    });
  });

  describe('getAggregateExposurePct', () => {
    it('should return zero initially', () => {
      expect(service.getAggregateExposurePct().eq(new Decimal(0))).toBe(true);
    });

    it('should sum all cluster exposure percentages', async () => {
      prisma.openPosition.findMany.mockResolvedValue([
        {
          positionId: 'pos-1',
          sizes: { polymarket: '100', kalshi: '50' },
          entryPrices: { polymarket: '0.60', kalshi: '0.45' },
          pair: {
            clusterId: 'cluster-1',
            cluster: { id: 'cluster-1', name: 'Economics' },
          },
        },
        {
          positionId: 'pos-2',
          sizes: { polymarket: '200', kalshi: '100' },
          entryPrices: { polymarket: '0.55', kalshi: '0.50' },
          pair: {
            clusterId: 'cluster-2',
            cluster: { id: 'cluster-2', name: 'Politics' },
          },
        },
      ]);

      await service.recalculateClusterExposure();

      const aggregate = service.getAggregateExposurePct();
      // pos-1: 82.5 / 10000 = 0.00825
      // pos-2: 160 / 10000 = 0.016
      // total: 0.02425
      expect(aggregate.eq(new Decimal('0.02425'))).toBe(true);
    });
  });
});
