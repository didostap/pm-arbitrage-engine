import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MatchApprovalService } from './match-approval.service';
import { PrismaService } from '../common/prisma.service';
import {
  SystemHealthError,
  SYSTEM_HEALTH_ERROR_CODES,
} from '../common/errors/system-health-error';
import { EVENT_NAMES } from '../common/events';

function buildMockMatch(overrides: Record<string, unknown> = {}) {
  return {
    matchId: 'match-1',
    polymarketContractId: 'poly-123',
    polymarketClobTokenId: null,
    kalshiContractId: 'kalshi-456',
    polymarketDescription: 'Will X happen?',
    kalshiDescription: 'Will X happen by date?',
    polymarketRawCategory: null,
    kalshiRawCategory: null,
    operatorApproved: false,
    operatorApprovalTimestamp: null,
    operatorRationale: null,
    confidenceScore: null,
    polymarketResolution: null,
    kalshiResolution: null,
    resolutionTimestamp: null,
    resolutionDiverged: null,
    divergenceNotes: null,
    firstTradedTimestamp: null,
    totalCyclesTraded: 0,
    primaryLeg: null,
    resolutionDate: null,
    resolutionCriteriaHash: null,
    lastAnnualizedReturn: null,
    lastNetEdge: null,
    lastComputedAt: null,
    clusterId: null,
    cluster: null,
    createdAt: new Date('2026-03-01'),
    updatedAt: new Date('2026-03-01'),
    ...overrides,
  };
}

describe('MatchApprovalService', () => {
  let service: MatchApprovalService;
  let prisma: {
    contractMatch: {
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    openPosition: {
      count: ReturnType<typeof vi.fn>;
      groupBy: ReturnType<typeof vi.fn>;
    };
    correlationCluster: {
      findMany: ReturnType<typeof vi.fn>;
    };
  };
  let emitter: { emit: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    prisma = {
      contractMatch: {
        findMany: vi.fn(),
        count: vi.fn(),
        findUnique: vi.fn(),
        updateMany: vi.fn(),
        update: vi.fn(),
      },
      openPosition: {
        count: vi.fn().mockResolvedValue(0),
        groupBy: vi.fn().mockResolvedValue([]),
      },
      correlationCluster: {
        findMany: vi.fn(),
      },
    };
    emitter = { emit: vi.fn() };

    service = new MatchApprovalService(
      prisma as unknown as PrismaService,
      emitter as unknown as EventEmitter2,
    );
  });

  describe('listMatches', () => {
    it('should list all matches with no filter', async () => {
      const matches = [buildMockMatch()];
      prisma.contractMatch.findMany.mockResolvedValue(matches);
      prisma.contractMatch.count.mockResolvedValue(1);

      const result = await service.listMatches('all', 1, 20);

      expect(result.data).toHaveLength(1);
      expect(result.count).toBe(1);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
      expect(prisma.contractMatch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {},
          skip: 0,
          take: 20,
        }),
      );
    });

    it('should filter pending matches (operatorApproved=false AND operatorRationale=null)', async () => {
      prisma.contractMatch.findMany.mockResolvedValue([]);
      prisma.contractMatch.count.mockResolvedValue(0);

      await service.listMatches('pending', 1, 20);

      expect(prisma.contractMatch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { operatorApproved: false, operatorRationale: null },
        }),
      );
    });

    it('should filter approved matches (operatorApproved=true)', async () => {
      prisma.contractMatch.findMany.mockResolvedValue([]);
      prisma.contractMatch.count.mockResolvedValue(0);

      await service.listMatches('approved', 1, 20);

      expect(prisma.contractMatch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { operatorApproved: true },
        }),
      );
    });

    it('should filter rejected matches (operatorApproved=false AND operatorRationale NOT null)', async () => {
      prisma.contractMatch.findMany.mockResolvedValue([]);
      prisma.contractMatch.count.mockResolvedValue(0);

      await service.listMatches('rejected', 1, 20);

      expect(prisma.contractMatch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { operatorApproved: false, operatorRationale: { not: null } },
        }),
      );
    });

    it('should paginate correctly (page 2, limit 10)', async () => {
      prisma.contractMatch.findMany.mockResolvedValue([]);
      prisma.contractMatch.count.mockResolvedValue(15);

      const result = await service.listMatches('all', 2, 10);

      expect(prisma.contractMatch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 10,
          take: 10,
        }),
      );
      expect(result.page).toBe(2);
      expect(result.limit).toBe(10);
    });

    it('should map match to MatchSummaryDto with null confidenceScore when DB field is null', async () => {
      const match = buildMockMatch({
        operatorApproved: true,
        operatorRationale: 'looks good',
      });
      prisma.contractMatch.findMany.mockResolvedValue([match]);
      prisma.contractMatch.count.mockResolvedValue(1);

      const result = await service.listMatches('all', 1, 20);
      const dto = result.data[0]!;

      expect(dto.matchId).toBe('match-1');
      expect(dto.polymarketContractId).toBe('poly-123');
      expect(dto.kalshiContractId).toBe('kalshi-456');
      expect(dto.confidenceScore).toBeNull();
      expect(dto.createdAt).toBeDefined();
    });

    it('should forward confidenceScore from DB when present', async () => {
      const match = buildMockMatch({
        operatorApproved: true,
        operatorRationale: 'looks good',
        confidenceScore: 87.3,
      });
      prisma.contractMatch.findMany.mockResolvedValue([match]);
      prisma.contractMatch.count.mockResolvedValue(1);

      const result = await service.listMatches('all', 1, 20);
      const dto = result.data[0]!;

      expect(dto.confidenceScore).toBe(87.3);
    });

    it('should map resolution fields to MatchSummaryDto', async () => {
      const match = buildMockMatch({
        polymarketResolution: 'yes',
        kalshiResolution: 'yes',
        resolutionTimestamp: new Date('2026-03-10'),
        resolutionDiverged: false,
        divergenceNotes: null,
      });
      prisma.contractMatch.findMany.mockResolvedValue([match]);
      prisma.contractMatch.count.mockResolvedValue(1);

      const result = await service.listMatches('all', 1, 20);
      const dto = result.data[0]!;

      expect(dto.polymarketResolution).toBe('yes');
      expect(dto.kalshiResolution).toBe('yes');
      expect(dto.resolutionTimestamp).toBe('2026-03-10T00:00:00.000Z');
      expect(dto.resolutionDiverged).toBe(false);
      expect(dto.divergenceNotes).toBeNull();
    });

    it('should map null resolution fields to null', async () => {
      const match = buildMockMatch();
      prisma.contractMatch.findMany.mockResolvedValue([match]);
      prisma.contractMatch.count.mockResolvedValue(1);

      const result = await service.listMatches('all', 1, 20);
      const dto = result.data[0]!;

      expect(dto.polymarketResolution).toBeNull();
      expect(dto.kalshiResolution).toBeNull();
      expect(dto.resolutionTimestamp).toBeNull();
      expect(dto.resolutionDiverged).toBeNull();
      expect(dto.divergenceNotes).toBeNull();
    });

    it('should map 8 new fields (categories, trading, resolution, cluster) to DTO', async () => {
      const match = buildMockMatch({
        polymarketRawCategory: 'politics',
        kalshiRawCategory: 'Politics',
        firstTradedTimestamp: new Date('2026-03-05'),
        totalCyclesTraded: 42,
        primaryLeg: 'kalshi',
        resolutionDate: new Date('2026-06-01'),
        resolutionCriteriaHash: 'abc123',
        cluster: {
          id: 'cluster-1',
          name: 'US Politics',
          slug: 'us-politics',
          description: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
      prisma.contractMatch.findMany.mockResolvedValue([match]);
      prisma.contractMatch.count.mockResolvedValue(1);

      const result = await service.listMatches('all', 1, 20);
      const dto = result.data[0]!;

      expect(dto.polymarketRawCategory).toBe('politics');
      expect(dto.kalshiRawCategory).toBe('Politics');
      expect(dto.firstTradedTimestamp).toBe('2026-03-05T00:00:00.000Z');
      expect(dto.totalCyclesTraded).toBe(42);
      expect(dto.primaryLeg).toBe('kalshi');
      expect(dto.resolutionDate).toBe('2026-06-01T00:00:00.000Z');
      expect(dto.resolutionCriteriaHash).toBe('abc123');
      expect(dto.cluster).toEqual({
        id: 'cluster-1',
        name: 'US Politics',
        slug: 'us-politics',
      });
    });

    it('should map null cluster to null in DTO', async () => {
      const match = buildMockMatch({ cluster: null });
      prisma.contractMatch.findMany.mockResolvedValue([match]);
      prisma.contractMatch.count.mockResolvedValue(1);

      const result = await service.listMatches('all', 1, 20);
      const dto = result.data[0]!;

      expect(dto.cluster).toBeNull();
      expect(dto.polymarketRawCategory).toBeNull();
      expect(dto.firstTradedTimestamp).toBeNull();
      expect(dto.totalCyclesTraded).toBe(0);
      expect(dto.primaryLeg).toBeNull();
      expect(dto.resolutionDate).toBeNull();
      expect(dto.resolutionCriteriaHash).toBeNull();
    });

    it('should filter by resolution=resolved', async () => {
      prisma.contractMatch.findMany.mockResolvedValue([]);
      prisma.contractMatch.count.mockResolvedValue(0);

      await service.listMatches('all', 1, 20, 'resolved');

      expect(prisma.contractMatch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { resolutionTimestamp: { not: null } },
        }),
      );
    });

    it('should filter by resolution=unresolved', async () => {
      prisma.contractMatch.findMany.mockResolvedValue([]);
      prisma.contractMatch.count.mockResolvedValue(0);

      await service.listMatches('all', 1, 20, 'unresolved');

      expect(prisma.contractMatch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { resolutionTimestamp: null },
        }),
      );
    });

    it('should filter by resolution=diverged', async () => {
      prisma.contractMatch.findMany.mockResolvedValue([]);
      prisma.contractMatch.count.mockResolvedValue(0);

      await service.listMatches('all', 1, 20, 'diverged');

      expect(prisma.contractMatch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { resolutionDiverged: true },
        }),
      );
    });

    it('should filter by clusterId when provided', async () => {
      prisma.contractMatch.findMany.mockResolvedValue([]);
      prisma.contractMatch.count.mockResolvedValue(0);

      await service.listMatches('all', 1, 20, undefined, 'cluster-abc');

      expect(prisma.contractMatch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { clusterId: 'cluster-abc' },
        }),
      );
    });

    it('should not include clusterId in where when not provided', async () => {
      prisma.contractMatch.findMany.mockResolvedValue([]);
      prisma.contractMatch.count.mockResolvedValue(0);

      await service.listMatches('all', 1, 20);

      expect(prisma.contractMatch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {},
        }),
      );
    });

    it('should combine status and clusterId filters', async () => {
      prisma.contractMatch.findMany.mockResolvedValue([]);
      prisma.contractMatch.count.mockResolvedValue(0);

      await service.listMatches('approved', 1, 20, undefined, 'cluster-xyz');

      expect(prisma.contractMatch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { operatorApproved: true, clusterId: 'cluster-xyz' },
        }),
      );
    });

    it('should map APR Decimal fields to number in toSummaryDto', async () => {
      const match = buildMockMatch({
        lastAnnualizedReturn: { toNumber: () => 0.42 },
        lastNetEdge: { toNumber: () => 0.025 },
        lastComputedAt: new Date('2026-03-13T10:00:00Z'),
      });
      prisma.contractMatch.findMany.mockResolvedValue([match]);
      prisma.contractMatch.count.mockResolvedValue(1);

      const result = await service.listMatches('all', 1, 20);
      const dto = result.data[0]!;

      expect(dto.lastAnnualizedReturn).toBe(0.42);
      expect(dto.lastNetEdge).toBe(0.025);
      expect(dto.lastComputedAt).toBe('2026-03-13T10:00:00.000Z');
    });

    it('should map null APR fields to null in toSummaryDto', async () => {
      const match = buildMockMatch();
      prisma.contractMatch.findMany.mockResolvedValue([match]);
      prisma.contractMatch.count.mockResolvedValue(1);

      const result = await service.listMatches('all', 1, 20);
      const dto = result.data[0]!;

      expect(dto.lastAnnualizedReturn).toBeNull();
      expect(dto.lastNetEdge).toBeNull();
      expect(dto.lastComputedAt).toBeNull();
    });

    it('should use default orderBy when no sortBy provided', async () => {
      prisma.contractMatch.findMany.mockResolvedValue([]);
      prisma.contractMatch.count.mockResolvedValue(0);

      await service.listMatches('all', 1, 20);

      expect(prisma.contractMatch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ operatorApproved: 'asc' }, { createdAt: 'desc' }],
        }),
      );
    });

    it('should use dynamic orderBy with nulls last when sortBy provided', async () => {
      prisma.contractMatch.findMany.mockResolvedValue([]);
      prisma.contractMatch.count.mockResolvedValue(0);

      await service.listMatches(
        'all',
        1,
        20,
        undefined,
        undefined,
        'lastAnnualizedReturn' as never,
        'desc' as never,
      );

      expect(prisma.contractMatch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ lastAnnualizedReturn: { sort: 'desc', nulls: 'last' } }],
        }),
      );
    });

    it('should default to desc order when sortBy provided without order', async () => {
      prisma.contractMatch.findMany.mockResolvedValue([]);
      prisma.contractMatch.count.mockResolvedValue(0);

      await service.listMatches(
        'all',
        1,
        20,
        undefined,
        undefined,
        'lastNetEdge' as never,
      );

      expect(prisma.contractMatch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ lastNetEdge: { sort: 'desc', nulls: 'last' } }],
        }),
      );
    });

    it('should combine status and resolution filters', async () => {
      prisma.contractMatch.findMany.mockResolvedValue([]);
      prisma.contractMatch.count.mockResolvedValue(0);

      await service.listMatches('approved', 1, 20, 'diverged');

      expect(prisma.contractMatch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { operatorApproved: true, resolutionDiverged: true },
        }),
      );
    });

    it('should return batched position counts for all matches in page', async () => {
      const matches = [
        buildMockMatch({ matchId: 'match-1' }),
        buildMockMatch({ matchId: 'match-2' }),
      ];
      prisma.contractMatch.findMany.mockResolvedValue(matches);
      prisma.contractMatch.count.mockResolvedValue(2);
      prisma.openPosition.groupBy
        .mockResolvedValueOnce([
          { pairId: 'match-1', _count: 5 },
          { pairId: 'match-2', _count: 3 },
        ])
        .mockResolvedValueOnce([{ pairId: 'match-1', _count: 2 }]);

      const result = await service.listMatches('all', 1, 20);

      expect(result.data[0]!.positionCount).toBe(5);
      expect(result.data[0]!.activePositionCount).toBe(2);
      expect(result.data[1]!.positionCount).toBe(3);
      expect(result.data[1]!.activePositionCount).toBe(0);
    });

    it('should return 0 counts when no matches have positions', async () => {
      const matches = [buildMockMatch()];
      prisma.contractMatch.findMany.mockResolvedValue(matches);
      prisma.contractMatch.count.mockResolvedValue(1);
      prisma.openPosition.groupBy
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await service.listMatches('all', 1, 20);

      expect(result.data[0]!.positionCount).toBe(0);
      expect(result.data[0]!.activePositionCount).toBe(0);
    });

    it('should skip groupBy queries when no matches on page', async () => {
      prisma.contractMatch.findMany.mockResolvedValue([]);
      prisma.contractMatch.count.mockResolvedValue(0);

      await service.listMatches('all', 1, 20);

      expect(prisma.openPosition.groupBy).not.toHaveBeenCalled();
    });
  });

  describe('getMatchById', () => {
    it('should return match by ID', async () => {
      prisma.contractMatch.findUnique.mockResolvedValue(buildMockMatch());

      const result = await service.getMatchById('match-1');

      expect(result.matchId).toBe('match-1');
      expect(result.confidenceScore).toBeNull();
    });

    it('should throw SystemHealthError 4007 when not found', async () => {
      prisma.contractMatch.findUnique.mockResolvedValue(null);

      await expect(service.getMatchById('nonexistent')).rejects.toThrow(
        SystemHealthError,
      );
      await expect(service.getMatchById('nonexistent')).rejects.toMatchObject({
        code: SYSTEM_HEALTH_ERROR_CODES.NOT_FOUND,
      });
    });

    it('should return positionCount and activePositionCount', async () => {
      prisma.contractMatch.findUnique.mockResolvedValue(buildMockMatch());
      prisma.openPosition.count
        .mockResolvedValueOnce(5) // total
        .mockResolvedValueOnce(2); // active

      const result = await service.getMatchById('match-1');

      expect(result.positionCount).toBe(5);
      expect(result.activePositionCount).toBe(2);
    });

    it('should return 0 counts when match has no positions', async () => {
      prisma.contractMatch.findUnique.mockResolvedValue(buildMockMatch());
      prisma.openPosition.count
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0);

      const result = await service.getMatchById('match-1');

      expect(result.positionCount).toBe(0);
      expect(result.activePositionCount).toBe(0);
    });

    it('should query active count with correct statuses (OPEN, SINGLE_LEG_EXPOSED, EXIT_PARTIAL)', async () => {
      prisma.contractMatch.findUnique.mockResolvedValue(buildMockMatch());
      prisma.openPosition.count
        .mockResolvedValueOnce(3)
        .mockResolvedValueOnce(1);

      await service.getMatchById('match-1');

      expect(prisma.openPosition.count).toHaveBeenCalledWith({
        where: {
          pairId: 'match-1',
          status: { in: ['OPEN', 'SINGLE_LEG_EXPOSED', 'EXIT_PARTIAL'] },
        },
      });
    });
  });

  describe('approveMatch', () => {
    it('should approve match, update DB fields, and emit event', async () => {
      prisma.contractMatch.updateMany.mockResolvedValue({ count: 1 });
      const approvedMatch = buildMockMatch({
        operatorApproved: true,
        operatorRationale: 'Good match',
        operatorApprovalTimestamp: new Date(),
      });
      prisma.contractMatch.findUnique.mockResolvedValue(approvedMatch);

      const result = await service.approveMatch('match-1', 'Good match');

      expect(prisma.contractMatch.updateMany).toHaveBeenCalledWith({
        where: { matchId: 'match-1', operatorApproved: false },
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        data: expect.objectContaining({
          operatorApproved: true,
          operatorRationale: 'Good match',
        }),
      });
      expect(result.matchId).toBe('match-1');
      expect(emitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.MATCH_APPROVED,
        expect.objectContaining({
          matchId: 'match-1',
          operatorRationale: 'Good match',
        }),
      );
    });

    it('should throw 409 (code 4008) when match is already approved', async () => {
      prisma.contractMatch.updateMany.mockResolvedValue({ count: 0 });
      prisma.contractMatch.findUnique.mockResolvedValue(
        buildMockMatch({ operatorApproved: true }),
      );

      await expect(service.approveMatch('match-1', 'retry')).rejects.toThrow(
        SystemHealthError,
      );
      await expect(
        service.approveMatch('match-1', 'retry'),
      ).rejects.toMatchObject({
        code: SYSTEM_HEALTH_ERROR_CODES.MATCH_ALREADY_APPROVED,
      });
    });

    it('should throw 404 (code 4007) when match not found', async () => {
      prisma.contractMatch.updateMany.mockResolvedValue({ count: 0 });
      prisma.contractMatch.findUnique.mockResolvedValue(null);

      await expect(
        service.approveMatch('nonexistent', 'reason'),
      ).rejects.toThrow(SystemHealthError);
      await expect(
        service.approveMatch('nonexistent', 'reason'),
      ).rejects.toMatchObject({
        code: SYSTEM_HEALTH_ERROR_CODES.NOT_FOUND,
      });
    });

    it('should allow re-approve after reject', async () => {
      // Match was rejected (operatorApproved=false, operatorRationale set)
      prisma.contractMatch.updateMany.mockResolvedValue({ count: 1 });
      const reApproved = buildMockMatch({
        operatorApproved: true,
        operatorRationale: 'Changed my mind',
        operatorApprovalTimestamp: new Date(),
      });
      prisma.contractMatch.findUnique.mockResolvedValue(reApproved);

      const result = await service.approveMatch('match-1', 'Changed my mind');

      expect(result.matchId).toBe('match-1');
      expect(emitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.MATCH_APPROVED,
        expect.anything(),
      );
    });
  });

  describe('rejectMatch', () => {
    it('should reject match, update DB, and emit event', async () => {
      prisma.contractMatch.findUnique.mockResolvedValue(buildMockMatch());
      prisma.contractMatch.update.mockResolvedValue(
        buildMockMatch({
          operatorRationale: 'Not matching',
          operatorApprovalTimestamp: new Date(),
        }),
      );

      const result = await service.rejectMatch('match-1', 'Not matching');

      expect(prisma.contractMatch.update).toHaveBeenCalledWith({
        where: { matchId: 'match-1' },
        include: { cluster: true },
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        data: expect.objectContaining({
          operatorApproved: false,
          operatorRationale: 'Not matching',
        }),
      });
      expect(result.matchId).toBe('match-1');
      expect(emitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.MATCH_REJECTED,
        expect.objectContaining({
          matchId: 'match-1',
          operatorRationale: 'Not matching',
        }),
      );
    });

    it('should throw 404 when match not found', async () => {
      prisma.contractMatch.findUnique.mockResolvedValue(null);

      await expect(
        service.rejectMatch('nonexistent', 'reason'),
      ).rejects.toThrow(SystemHealthError);
      await expect(
        service.rejectMatch('nonexistent', 'reason'),
      ).rejects.toMatchObject({
        code: SYSTEM_HEALTH_ERROR_CODES.NOT_FOUND,
      });
    });

    it('should allow re-reject with new rationale (idempotent overwrite)', async () => {
      const alreadyRejected = buildMockMatch({
        operatorRationale: 'Old reason',
        operatorApprovalTimestamp: new Date(),
      });
      prisma.contractMatch.findUnique.mockResolvedValue(alreadyRejected);
      prisma.contractMatch.update.mockResolvedValue(
        buildMockMatch({
          operatorRationale: 'New reason',
          operatorApprovalTimestamp: new Date(),
        }),
      );

      const result = await service.rejectMatch('match-1', 'New reason');

      expect(result.matchId).toBe('match-1');
      expect(emitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.MATCH_REJECTED,
        expect.objectContaining({ operatorRationale: 'New reason' }),
      );
    });

    it('should block reject-after-approved (must re-approve first)', async () => {
      prisma.contractMatch.findUnique.mockResolvedValue(
        buildMockMatch({
          operatorApproved: true,
          operatorRationale: 'was approved',
        }),
      );

      await expect(service.rejectMatch('match-1', 'reject it')).rejects.toThrow(
        SystemHealthError,
      );
      await expect(
        service.rejectMatch('match-1', 'reject it'),
      ).rejects.toMatchObject({
        code: SYSTEM_HEALTH_ERROR_CODES.MATCH_ALREADY_APPROVED,
      });
    });
  });

  describe('listClusters', () => {
    it('should return all clusters sorted by name', async () => {
      const clusters = [
        {
          id: 'c1',
          name: 'Crypto',
          slug: 'crypto',
          description: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 'c2',
          name: 'Politics',
          slug: 'politics',
          description: 'US politics',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];
      prisma.correlationCluster.findMany.mockResolvedValue(clusters);

      const result = await service.listClusters();

      expect(result).toEqual([
        { id: 'c1', name: 'Crypto', slug: 'crypto' },
        { id: 'c2', name: 'Politics', slug: 'politics' },
      ]);
      expect(prisma.correlationCluster.findMany).toHaveBeenCalledWith({
        orderBy: { name: 'asc' },
      });
    });

    it('should return empty array when no clusters exist', async () => {
      prisma.correlationCluster.findMany.mockResolvedValue([]);

      const result = await service.listClusters();

      expect(result).toEqual([]);
    });
  });
});
