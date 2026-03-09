import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { ConfidenceScorerService } from './confidence-scorer.service';
import { KnowledgeBaseService } from './knowledge-base.service';
import { PrismaService } from '../../common/prisma.service';
import type { IScoringStrategy } from '../../common/interfaces/scoring-strategy.interface';
import { EVENT_NAMES } from '../../common/events/event-catalog';
import { MatchApprovedEvent } from '../../common/events/match-approved.event';
import { MatchAutoApprovedEvent } from '../../common/events/match-auto-approved.event';
import { MatchPendingReviewEvent } from '../../common/events/match-pending-review.event';

function buildMockMatch(overrides: Record<string, unknown> = {}) {
  return {
    matchId: 'match-1',
    polymarketContractId: 'poly-123',
    kalshiContractId: 'kalshi-456',
    polymarketDescription: 'Will Bitcoin exceed $100k?',
    kalshiDescription: 'Bitcoin above $100,000 by Dec 2026',
    operatorApproved: false,
    operatorApprovalTimestamp: null,
    operatorRationale: null,
    primaryLeg: 'KALSHI',
    resolutionDate: new Date('2026-12-31'),
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

describe('ConfidenceScorerService', () => {
  let service: ConfidenceScorerService;
  let strategy: {
    scoreMatch: ReturnType<typeof vi.fn>;
  };
  let knowledgeBase: {
    updateConfidenceScore: ReturnType<typeof vi.fn>;
  };
  let prisma: {
    contractMatch: {
      findUnique: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
  };
  let emitter: { emit: ReturnType<typeof vi.fn> };
  let configService: ConfigService;

  beforeEach(() => {
    vi.clearAllMocks();

    strategy = { scoreMatch: vi.fn() };
    knowledgeBase = {
      updateConfidenceScore: vi.fn().mockResolvedValue(undefined),
    };
    prisma = {
      contractMatch: {
        findUnique: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    emitter = { emit: vi.fn() };
    configService = {
      get: vi.fn((key: string, defaultVal?: unknown) => {
        if (key === 'LLM_AUTO_APPROVE_THRESHOLD') return 85;
        return defaultVal;
      }),
    } as unknown as ConfigService;

    service = new ConfidenceScorerService(
      strategy as unknown as IScoringStrategy,
      knowledgeBase as unknown as KnowledgeBaseService,
      prisma as unknown as PrismaService,
      emitter as unknown as EventEmitter2,
      configService,
    );
  });

  describe('auto-approve flow (score >= 85)', () => {
    it('should auto-approve and emit events when score >= 85', async () => {
      prisma.contractMatch.findUnique.mockResolvedValue(buildMockMatch());
      strategy.scoreMatch.mockResolvedValue({
        score: 92,
        confidence: 'high',
        reasoning: 'Same event',
        model: 'gemini-2.5-flash',
        escalated: false,
      });

      const result = await service.scoreMatch('match-1');

      expect(result.score).toBe(92);
      expect(knowledgeBase.updateConfidenceScore).toHaveBeenCalledWith(
        'match-1',
        92,
      );
      expect(prisma.contractMatch.updateMany).toHaveBeenCalledWith({
        where: { matchId: 'match-1', operatorApproved: false },
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        data: expect.objectContaining({
          operatorApproved: true,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          operatorRationale: expect.stringContaining('Auto-approved'),
        }),
      });

      // Should emit MatchApprovedEvent
      expect(emitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.MATCH_APPROVED,
        expect.any(MatchApprovedEvent),
      );

      // Should emit MatchAutoApprovedEvent
      expect(emitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.MATCH_AUTO_APPROVED,
        expect.any(MatchAutoApprovedEvent),
      );

      const autoEventCall = emitter.emit.mock.calls.find(
        (c: unknown[]) => c[0] === EVENT_NAMES.MATCH_AUTO_APPROVED,
      );
      const autoEvent = autoEventCall![1] as MatchAutoApprovedEvent;
      expect(autoEvent.matchId).toBe('match-1');
      expect(autoEvent.confidenceScore).toBe(92);
      expect(autoEvent.model).toBe('gemini-2.5-flash');
      expect(autoEvent.escalated).toBe(false);
    });

    it('should auto-approve when score is exactly 85 (boundary)', async () => {
      prisma.contractMatch.findUnique.mockResolvedValue(buildMockMatch());
      strategy.scoreMatch.mockResolvedValue({
        score: 85,
        confidence: 'high',
        reasoning: 'Boundary match',
        model: 'gemini-2.5-flash',
        escalated: false,
      });

      await service.scoreMatch('match-1');

      expect(prisma.contractMatch.updateMany).toHaveBeenCalled();
      expect(emitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.MATCH_AUTO_APPROVED,
        expect.any(MatchAutoApprovedEvent),
      );
    });

    it('should skip event emission when match was approved concurrently (race condition)', async () => {
      prisma.contractMatch.findUnique.mockResolvedValue(buildMockMatch());
      strategy.scoreMatch.mockResolvedValue({
        score: 92,
        confidence: 'high',
        reasoning: 'Same event',
        model: 'gemini-2.5-flash',
        escalated: false,
      });
      prisma.contractMatch.updateMany.mockResolvedValue({ count: 0 });

      const result = await service.scoreMatch('match-1');

      expect(result!.score).toBe(92);
      expect(knowledgeBase.updateConfidenceScore).toHaveBeenCalledWith(
        'match-1',
        92,
      );
      expect(prisma.contractMatch.updateMany).toHaveBeenCalled();
      // Events should NOT be emitted when updateMany.count === 0
      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('pending review flow (score < 85)', () => {
    it('should emit pending review event when score < 85', async () => {
      prisma.contractMatch.findUnique.mockResolvedValue(buildMockMatch());
      strategy.scoreMatch.mockResolvedValue({
        score: 72,
        confidence: 'medium',
        reasoning: 'Uncertain',
        model: 'gemini-2.5-flash',
        escalated: false,
      });

      const result = await service.scoreMatch('match-1');

      expect(result.score).toBe(72);
      expect(knowledgeBase.updateConfidenceScore).toHaveBeenCalledWith(
        'match-1',
        72,
      );
      expect(prisma.contractMatch.updateMany).not.toHaveBeenCalled();

      expect(emitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.MATCH_PENDING_REVIEW,
        expect.any(MatchPendingReviewEvent),
      );

      const reviewEvent = emitter.emit.mock
        .calls[0]![1] as MatchPendingReviewEvent;
      expect(reviewEvent.matchId).toBe('match-1');
      expect(reviewEvent.confidenceScore).toBe(72);
    });
  });

  describe('score persistence', () => {
    it('should persist score via KnowledgeBaseService.updateConfidenceScore', async () => {
      prisma.contractMatch.findUnique.mockResolvedValue(buildMockMatch());
      strategy.scoreMatch.mockResolvedValue({
        score: 50,
        confidence: 'low',
        reasoning: 'test',
        model: 'model',
        escalated: false,
      });

      await service.scoreMatch('match-1');

      expect(knowledgeBase.updateConfidenceScore).toHaveBeenCalledWith(
        'match-1',
        50,
      );
    });
  });

  describe('guard: match not found', () => {
    it('should throw when match not found', async () => {
      prisma.contractMatch.findUnique.mockResolvedValue(null);

      await expect(service.scoreMatch('nonexistent')).rejects.toThrow(
        /not found/i,
      );
      expect(strategy.scoreMatch).not.toHaveBeenCalled();
    });
  });

  describe('guard: already approved', () => {
    it('should skip silently when match is already approved', async () => {
      prisma.contractMatch.findUnique.mockResolvedValue(
        buildMockMatch({ operatorApproved: true }),
      );

      const result = await service.scoreMatch('match-1');

      expect(result).toBeUndefined();
      expect(strategy.scoreMatch).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('guard: null descriptions', () => {
    it('should skip with warning when polymarketDescription is null', async () => {
      prisma.contractMatch.findUnique.mockResolvedValue(
        buildMockMatch({ polymarketDescription: null }),
      );

      const result = await service.scoreMatch('match-1');

      expect(result).toBeUndefined();
      expect(strategy.scoreMatch).not.toHaveBeenCalled();
    });

    it('should skip with warning when kalshiDescription is null', async () => {
      prisma.contractMatch.findUnique.mockResolvedValue(
        buildMockMatch({ kalshiDescription: null }),
      );

      const result = await service.scoreMatch('match-1');

      expect(result).toBeUndefined();
      expect(strategy.scoreMatch).not.toHaveBeenCalled();
    });
  });

  describe('strategy error propagation', () => {
    it('should propagate scoring strategy errors', async () => {
      prisma.contractMatch.findUnique.mockResolvedValue(buildMockMatch());
      strategy.scoreMatch.mockRejectedValue(new Error('LLM exploded'));

      await expect(service.scoreMatch('match-1')).rejects.toThrow(
        'LLM exploded',
      );
    });
  });
});
