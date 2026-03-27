import { describe, it, expect, vi } from 'vitest';
import { IngestionQualityAssessorService } from './ingestion-quality-assessor.service';

function createMockPrisma() {
  return {
    historicalPrice: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    historicalTrade: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    historicalDepth: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  } as any;
}

function createEmptyFlags() {
  return {
    hasGaps: false,
    hasSuspiciousJumps: false,
    hasSurvivorshipBias: false,
    hasStaleData: false,
    hasLowVolume: false,
    gapDetails: [],
    jumpDetails: [],
  };
}

function createMockDataQuality() {
  return {
    assessPriceQuality: vi.fn().mockReturnValue(createEmptyFlags()),
    assessTradeQuality: vi.fn().mockReturnValue(createEmptyFlags()),
    assessDepthQuality: vi.fn().mockReturnValue(createEmptyFlags()),
    assessSurvivorshipBias: vi.fn().mockReturnValue(createEmptyFlags()),
    assessFreshness: vi.fn().mockResolvedValue({ timestamps: {}, stale: [] }),
    assessCrossSourceDeviation: vi
      .fn()
      .mockResolvedValue({ hasDeviation: false, deviations: [] }),
    emitQualityWarning: vi.fn(),
  } as any;
}

function createService(prismaOverride?: any, dataQualityOverride?: any) {
  const prisma = prismaOverride ?? createMockPrisma();
  const dataQuality = dataQualityOverride ?? createMockDataQuality();
  return {
    service: new IngestionQualityAssessorService(prisma, dataQuality),
    prisma,
    dataQuality,
  };
}

const TARGET = {
  kalshiTicker: 'K1',
  polymarketTokenId: '0x1',
  operatorApproved: true,
  resolutionTimestamp: null,
};

const DATE_RANGE = {
  start: new Date('2025-01-01'),
  end: new Date('2025-03-01'),
};

describe('IngestionQualityAssessorService', () => {
  describe('runQualityAssessment', () => {
    it('[P1] should run depth quality assessment for PMXT ingested data', async () => {
      const mockPrisma = createMockPrisma();
      mockPrisma.historicalDepth.findMany.mockResolvedValue([
        {
          platform: 'POLYMARKET',
          contractId: '0x1',
          source: 'PMXT_ARCHIVE',
          bids: [{ price: '0.55', size: '100' }],
          asks: [{ price: '0.60', size: '80' }],
          timestamp: new Date('2025-01-01T00:00:00Z'),
          updateType: 'snapshot',
        },
      ]);

      const { service, dataQuality } = createService(mockPrisma);
      await service.runQualityAssessment('m1', TARGET, DATE_RANGE, 'corr-1');

      expect(dataQuality.assessDepthQuality).toHaveBeenCalled();
    });

    it('[P1] should call assessFreshness at end of run', async () => {
      const { service, dataQuality } = createService();
      await service.runQualityAssessment('m1', TARGET, DATE_RANGE, 'corr-1');

      expect(dataQuality.assessFreshness).toHaveBeenCalled();
    });

    it('[P1] should call assessCrossSourceDeviation for AC#5', async () => {
      const { service, dataQuality } = createService();
      await service.runQualityAssessment('m1', TARGET, DATE_RANGE, 'corr-1');

      expect(dataQuality.assessCrossSourceDeviation).toHaveBeenCalledWith(
        '0x1',
        DATE_RANGE,
      );
    });

    it('[P1] should emit quality warnings when issues detected', async () => {
      const mockPrisma = createMockPrisma();
      const dataQuality = createMockDataQuality();
      dataQuality.assessSurvivorshipBias.mockReturnValue({
        ...createEmptyFlags(),
        hasSurvivorshipBias: true,
      });

      const { service } = createService(mockPrisma, dataQuality);
      await service.runQualityAssessment('m1', TARGET, DATE_RANGE, 'corr-1');

      expect(dataQuality.emitQualityWarning).toHaveBeenCalledWith(
        'survivorship',
        'both',
        'm1',
        expect.objectContaining({ hasSurvivorshipBias: true }),
        'corr-1',
      );
    });

    it('[P-17] should assess depth quality without dead guard', async () => {
      const mockPrisma = createMockPrisma();
      mockPrisma.historicalDepth.findMany.mockResolvedValue([
        {
          platform: 'POLYMARKET',
          contractId: '0x1',
          source: 'PMXT_ARCHIVE',
          bids: [{ price: '0.50', size: '100' }],
          asks: [{ price: '0.55', size: '80' }],
          timestamp: new Date('2025-01-15T00:00:00Z'),
          updateType: 'snapshot',
        },
      ]);

      const { service, dataQuality } = createService(mockPrisma);
      await service.runQualityAssessment('m1', TARGET, DATE_RANGE, 'corr-1');

      // Depth assessment runs unconditionally (dead guard removed)
      expect(mockPrisma.historicalDepth.findMany).toHaveBeenCalled();
      expect(dataQuality.assessDepthQuality).toHaveBeenCalled();
    });

    it('[P1] should include hasCrossedBooks in quality issue detection', async () => {
      const dataQuality = createMockDataQuality();
      dataQuality.assessSurvivorshipBias.mockReturnValue({
        ...createEmptyFlags(),
        hasCrossedBooks: true,
      });

      const { service } = createService(undefined, dataQuality);
      await service.runQualityAssessment('m1', TARGET, DATE_RANGE, 'corr-1');

      expect(dataQuality.emitQualityWarning).toHaveBeenCalled();
    });

    it('[P1] should continue when cross-source deviation check fails', async () => {
      const dataQuality = createMockDataQuality();
      dataQuality.assessCrossSourceDeviation.mockRejectedValue(
        new Error('DB query failed'),
      );

      const { service } = createService(undefined, dataQuality);
      // Should not throw
      await service.runQualityAssessment('m1', TARGET, DATE_RANGE, 'corr-1');

      expect(dataQuality.assessFreshness).toHaveBeenCalled();
    });
  });

  describe('parseJsonDepthLevels (P-16)', () => {
    it('[P1] should parse valid depth levels from JSON', async () => {
      const mockPrisma = createMockPrisma();
      mockPrisma.historicalDepth.findMany.mockResolvedValue([
        {
          platform: 'POLYMARKET',
          contractId: '0x1',
          source: 'PMXT_ARCHIVE',
          bids: [{ price: '0.50', size: '100' }],
          asks: [{ price: '0.55', size: '80' }],
          timestamp: new Date('2025-01-01'),
          updateType: 'snapshot',
        },
      ]);

      const dataQuality = createMockDataQuality();
      const { service } = createService(mockPrisma, dataQuality);
      await service.runQualityAssessment('m1', TARGET, DATE_RANGE, 'corr-1');

      const callArg = dataQuality.assessDepthQuality.mock.calls[0]![0];
      expect(callArg[0].bids[0]).toEqual(
        expect.objectContaining({ price: expect.any(Object) }),
      );
    });
  });
});
