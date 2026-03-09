import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { KnowledgeBaseService } from './knowledge-base.service';
import { PrismaService } from '../../common/prisma.service';
import {
  SystemHealthError,
  SYSTEM_HEALTH_ERROR_CODES,
} from '../../common/errors/system-health-error';
import { EVENT_NAMES } from '../../common/events';
import { ResolutionDivergedEvent } from '../../common/events/resolution-diverged.event';

function buildMockMatch(overrides: Record<string, unknown> = {}) {
  return {
    matchId: 'match-1',
    polymarketContractId: 'poly-123',
    kalshiContractId: 'kalshi-456',
    polymarketDescription: 'Will X happen?',
    kalshiDescription: 'Will X happen by date?',
    operatorApproved: true,
    operatorApprovalTimestamp: new Date('2026-03-01'),
    operatorRationale: 'looks good',
    primaryLeg: 'KALSHI',
    resolutionDate: null,
    confidenceScore: null,
    resolutionCriteriaHash: null,
    polymarketResolution: null,
    kalshiResolution: null,
    resolutionTimestamp: null,
    resolutionDiverged: null,
    divergenceNotes: null,
    createdAt: new Date('2026-03-01'),
    updatedAt: new Date('2026-03-01'),
    ...overrides,
  };
}

describe('KnowledgeBaseService', () => {
  let service: KnowledgeBaseService;
  let prisma: {
    contractMatch: {
      findUnique: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
    };
  };
  let emitter: { emit: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    prisma = {
      contractMatch: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
        update: vi.fn(),
        count: vi.fn(),
      },
    };
    emitter = { emit: vi.fn() };

    service = new KnowledgeBaseService(
      prisma as unknown as PrismaService,
      emitter as unknown as EventEmitter2,
    );
  });

  describe('updateConfidenceScore', () => {
    it('should update confidence score for existing match', async () => {
      prisma.contractMatch.findUnique.mockResolvedValue(buildMockMatch());
      prisma.contractMatch.update.mockResolvedValue(
        buildMockMatch({ confidenceScore: 85.5 }),
      );

      await service.updateConfidenceScore('match-1', 85.5);

      expect(prisma.contractMatch.update).toHaveBeenCalledWith({
        where: { matchId: 'match-1' },
        data: { confidenceScore: 85.5 },
      });
    });

    it('should update confidence score with criteria hash', async () => {
      prisma.contractMatch.findUnique.mockResolvedValue(buildMockMatch());
      prisma.contractMatch.update.mockResolvedValue(
        buildMockMatch({
          confidenceScore: 92,
          resolutionCriteriaHash: 'abc123',
        }),
      );

      await service.updateConfidenceScore('match-1', 92, 'abc123');

      expect(prisma.contractMatch.update).toHaveBeenCalledWith({
        where: { matchId: 'match-1' },
        data: { confidenceScore: 92, resolutionCriteriaHash: 'abc123' },
      });
    });

    it('should throw SystemHealthError when match not found', async () => {
      prisma.contractMatch.findUnique.mockResolvedValue(null);

      await expect(
        service.updateConfidenceScore('nonexistent', 50),
      ).rejects.toThrow(SystemHealthError);
      await expect(
        service.updateConfidenceScore('nonexistent', 50),
      ).rejects.toMatchObject({
        code: SYSTEM_HEALTH_ERROR_CODES.NOT_FOUND,
      });
    });

    it('should reject score below 0', async () => {
      await expect(
        service.updateConfidenceScore('match-1', -1),
      ).rejects.toMatchObject({
        code: SYSTEM_HEALTH_ERROR_CODES.INVALID_CONFIGURATION,
      });
      expect(prisma.contractMatch.findUnique).not.toHaveBeenCalled();
    });

    it('should reject score above 100', async () => {
      await expect(
        service.updateConfidenceScore('match-1', 101),
      ).rejects.toMatchObject({
        code: SYSTEM_HEALTH_ERROR_CODES.INVALID_CONFIGURATION,
      });
    });

    it('should reject NaN score', async () => {
      await expect(
        service.updateConfidenceScore('match-1', NaN),
      ).rejects.toMatchObject({
        code: SYSTEM_HEALTH_ERROR_CODES.INVALID_CONFIGURATION,
      });
    });

    it('should reject Infinity score', async () => {
      await expect(
        service.updateConfidenceScore('match-1', Infinity),
      ).rejects.toMatchObject({
        code: SYSTEM_HEALTH_ERROR_CODES.INVALID_CONFIGURATION,
      });
    });
  });

  describe('recordResolution', () => {
    it('should record matching resolutions without divergence', async () => {
      prisma.contractMatch.findUnique.mockResolvedValue(buildMockMatch());
      prisma.contractMatch.update.mockResolvedValue(
        buildMockMatch({
          polymarketResolution: 'yes',
          kalshiResolution: 'yes',
          resolutionDiverged: false,
        }),
      );

      await service.recordResolution('match-1', 'YES', 'YES');

      expect(prisma.contractMatch.update).toHaveBeenCalledWith({
        where: { matchId: 'match-1' },
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        data: expect.objectContaining({
          polymarketResolution: 'yes',
          kalshiResolution: 'yes',
          resolutionDiverged: false,
          divergenceNotes: null,
        }),
      });
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('should detect divergence and emit event when resolutions differ', async () => {
      prisma.contractMatch.findUnique.mockResolvedValue(buildMockMatch());
      prisma.contractMatch.update.mockResolvedValue(
        buildMockMatch({
          polymarketResolution: 'yes',
          kalshiResolution: 'no',
          resolutionDiverged: true,
        }),
      );

      await service.recordResolution(
        'match-1',
        'YES',
        'NO',
        'Platform disagreement',
      );

      expect(prisma.contractMatch.update).toHaveBeenCalledWith({
        where: { matchId: 'match-1' },
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        data: expect.objectContaining({
          polymarketResolution: 'yes',
          kalshiResolution: 'no',
          resolutionDiverged: true,
          divergenceNotes: 'Platform disagreement',
        }),
      });
      expect(emitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.RESOLUTION_DIVERGED,
        expect.any(ResolutionDivergedEvent),
      );
      const emittedEvent = emitter.emit.mock
        .calls[0]![1] as ResolutionDivergedEvent;
      expect(emittedEvent.matchId).toBe('match-1');
      expect(emittedEvent.polymarketResolution).toBe('yes');
      expect(emittedEvent.kalshiResolution).toBe('no');
      expect(emittedEvent.divergenceNotes).toBe('Platform disagreement');
    });

    it('should normalize case and whitespace and store normalized values', async () => {
      prisma.contractMatch.findUnique.mockResolvedValue(buildMockMatch());
      prisma.contractMatch.update.mockResolvedValue(buildMockMatch());

      await service.recordResolution('match-1', '  Yes  ', 'yes');

      expect(prisma.contractMatch.update).toHaveBeenCalledWith({
        where: { matchId: 'match-1' },
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        data: expect.objectContaining({
          polymarketResolution: 'yes',
          kalshiResolution: 'yes',
          resolutionDiverged: false,
        }),
      });
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('should handle re-recording resolution (idempotent update)', async () => {
      const alreadyResolved = buildMockMatch({
        polymarketResolution: 'yes',
        kalshiResolution: 'yes',
        resolutionDiverged: false,
        resolutionTimestamp: new Date('2026-03-05'),
      });
      prisma.contractMatch.findUnique.mockResolvedValue(alreadyResolved);
      prisma.contractMatch.update.mockResolvedValue(
        buildMockMatch({
          polymarketResolution: 'no',
          kalshiResolution: 'no',
          resolutionDiverged: false,
        }),
      );

      await service.recordResolution('match-1', 'NO', 'NO');

      expect(prisma.contractMatch.update).toHaveBeenCalledWith({
        where: { matchId: 'match-1' },
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        data: expect.objectContaining({
          polymarketResolution: 'no',
          kalshiResolution: 'no',
          resolutionDiverged: false,
        }),
      });
    });

    it('should not throw when event emission fails', async () => {
      prisma.contractMatch.findUnique.mockResolvedValue(buildMockMatch());
      prisma.contractMatch.update.mockResolvedValue(buildMockMatch());
      emitter.emit.mockImplementation(() => {
        throw new Error('Listener blew up');
      });

      await expect(
        service.recordResolution('match-1', 'YES', 'NO'),
      ).resolves.toBeUndefined();
    });

    it('should set divergenceNotes to null when notes not provided', async () => {
      prisma.contractMatch.findUnique.mockResolvedValue(buildMockMatch());
      prisma.contractMatch.update.mockResolvedValue(buildMockMatch());

      await service.recordResolution('match-1', 'YES', 'YES');

      expect(prisma.contractMatch.update).toHaveBeenCalledWith({
        where: { matchId: 'match-1' },
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        data: expect.objectContaining({
          divergenceNotes: null,
        }),
      });
    });

    it('should throw SystemHealthError when match not found', async () => {
      prisma.contractMatch.findUnique.mockResolvedValue(null);

      await expect(
        service.recordResolution('nonexistent', 'YES', 'YES'),
      ).rejects.toThrow(SystemHealthError);
      await expect(
        service.recordResolution('nonexistent', 'YES', 'YES'),
      ).rejects.toMatchObject({
        code: SYSTEM_HEALTH_ERROR_CODES.NOT_FOUND,
      });
    });

    it('should reject empty polyResolution string', async () => {
      await expect(
        service.recordResolution('match-1', '', 'YES'),
      ).rejects.toMatchObject({
        code: SYSTEM_HEALTH_ERROR_CODES.INVALID_CONFIGURATION,
      });
      expect(prisma.contractMatch.findUnique).not.toHaveBeenCalled();
    });

    it('should reject whitespace-only kalshiResolution string', async () => {
      await expect(
        service.recordResolution('match-1', 'YES', '   '),
      ).rejects.toMatchObject({
        code: SYSTEM_HEALTH_ERROR_CODES.INVALID_CONFIGURATION,
      });
      expect(prisma.contractMatch.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('findByResolutionStatus', () => {
    it('should query resolved matches (resolutionTimestamp not null)', async () => {
      prisma.contractMatch.findMany.mockResolvedValue([]);

      await service.findByResolutionStatus('resolved');

      expect(prisma.contractMatch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { resolutionTimestamp: { not: null } },
        }),
      );
    });

    it('should query unresolved matches (resolutionTimestamp null)', async () => {
      prisma.contractMatch.findMany.mockResolvedValue([]);

      await service.findByResolutionStatus('unresolved');

      expect(prisma.contractMatch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { resolutionTimestamp: null },
        }),
      );
    });

    it('should query diverged matches (resolutionDiverged true)', async () => {
      prisma.contractMatch.findMany.mockResolvedValue([]);

      await service.findByResolutionStatus('diverged');

      expect(prisma.contractMatch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { resolutionDiverged: true },
        }),
      );
    });

    it('should return selected fields ordered by updatedAt desc', async () => {
      const resolved = {
        matchId: 'match-1',
        polymarketContractId: 'poly-123',
        kalshiContractId: 'kalshi-456',
        polymarketResolution: 'YES',
        kalshiResolution: 'YES',
        resolutionDiverged: false,
        resolutionTimestamp: new Date('2026-03-05'),
        confidenceScore: 88.5,
      };
      prisma.contractMatch.findMany.mockResolvedValue([resolved]);

      const result = await service.findByResolutionStatus('resolved');

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(resolved);
      expect(prisma.contractMatch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { updatedAt: 'desc' },
          select: {
            matchId: true,
            polymarketContractId: true,
            kalshiContractId: true,
            polymarketResolution: true,
            kalshiResolution: true,
            resolutionDiverged: true,
            resolutionTimestamp: true,
            confidenceScore: true,
          },
        }),
      );
    });
  });

  describe('getResolutionStats', () => {
    it('should return correct aggregate counts', async () => {
      prisma.contractMatch.count
        .mockResolvedValueOnce(10) // totalResolved
        .mockResolvedValueOnce(2); // divergedCount

      const stats = await service.getResolutionStats();

      expect(stats.totalResolved).toBe(10);
      expect(stats.divergedCount).toBe(2);
      expect(stats.divergenceRate).toBeCloseTo(0.2);
    });

    it('should return 0 divergence rate when no resolutions exist', async () => {
      prisma.contractMatch.count
        .mockResolvedValueOnce(0) // totalResolved
        .mockResolvedValueOnce(0); // divergedCount

      const stats = await service.getResolutionStats();

      expect(stats.totalResolved).toBe(0);
      expect(stats.divergedCount).toBe(0);
      expect(stats.divergenceRate).toBe(0);
    });

    it('should query with correct filters', async () => {
      prisma.contractMatch.count
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(1);

      await service.getResolutionStats();

      expect(prisma.contractMatch.count).toHaveBeenCalledWith({
        where: { resolutionTimestamp: { not: null } },
      });
      expect(prisma.contractMatch.count).toHaveBeenCalledWith({
        where: { resolutionDiverged: true },
      });
    });
  });
});
