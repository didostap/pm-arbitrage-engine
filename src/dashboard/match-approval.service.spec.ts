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
    kalshiContractId: 'kalshi-456',
    polymarketDescription: 'Will X happen?',
    kalshiDescription: 'Will X happen by date?',
    operatorApproved: false,
    operatorApprovalTimestamp: null,
    operatorRationale: null,
    primaryLeg: 'KALSHI',
    resolutionDate: null,
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
});
